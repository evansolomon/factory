package metrics

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"time"

	_ "modernc.org/sqlite"
)

const schemaVersion = 1

type StageStat struct {
	Stage     string
	Agent     string
	InTokens  int64
	OutTokens int64
	MS        int64
}

type RunRecord struct {
	Task           string
	TS             string
	CreatedAt      *string
	Outcome        string
	Triage         *string
	Retries        int
	VerifyFirstTry *bool
	MS             int64
	InTokens       int64
	OutTokens      int64
	Stages         []StageStat
}

type ReportStage struct {
	Stage        string
	InputTokens  int64
	OutputTokens int64
	TotalTokens  int64
	MS           int64
}

type OutcomeCount struct {
	Outcome string
	Count   int
}

type Report struct {
	Tasks               int
	Runs                int
	Outcomes            []OutcomeCount
	ImplementRuns       int
	FirstPassYield      *float64
	Escalations         int
	EscalationRate      *float64
	BlockedRate         *float64
	RetryRuns           int
	RetrySuccess        *float64
	InputTokensTotal    int64
	OutputTokensTotal   int64
	TokensMedianPerTask *float64
	Stages              []ReportStage
	CycleMedianMS       *float64
}

func RecordRun(path string, record RunRecord, warn func(string)) {
	for attempt := 0; attempt < 2; attempt++ {
		err := writeRun(path, record)
		if err == nil {
			return
		}
		if warn != nil {
			if attempt == 0 {
				warn(fmt.Sprintf("telemetry: write failed - %s", err))
			} else {
				warn(fmt.Sprintf("telemetry: write failed after reset - %s", err))
			}
		}
		if attempt == 0 {
			resetDB(path)
		}
	}
}

func ReadReport(path string) (*Report, error) {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", readonlyDSN(path))
	if err != nil {
		return nil, err
	}
	defer db.Close()

	runs, err := count(db, "SELECT COUNT(*) FROM runs")
	if err != nil {
		return nil, err
	}
	if runs == 0 {
		return nil, nil
	}
	tasks, err := count(db, "SELECT COUNT(DISTINCT task) FROM runs")
	if err != nil {
		return nil, err
	}
	outcomes, err := readOutcomes(db)
	if err != nil {
		return nil, err
	}
	implementRuns, err := count(db, "SELECT COUNT(*) FROM runs WHERE outcome IN ('done','blocked')")
	if err != nil {
		return nil, err
	}
	firstPassDone, err := count(db, "SELECT COUNT(*) FROM runs WHERE outcome='done' AND retries=0")
	if err != nil {
		return nil, err
	}
	escalations, err := count(db, "SELECT COUNT(*) FROM runs WHERE outcome='needs-input'")
	if err != nil {
		return nil, err
	}
	escalatedTasks, err := count(db, "SELECT COUNT(DISTINCT task) FROM runs WHERE outcome='needs-input'")
	if err != nil {
		return nil, err
	}
	blockedRuns, err := count(db, "SELECT COUNT(*) FROM runs WHERE outcome='blocked'")
	if err != nil {
		return nil, err
	}
	retryRuns, err := count(db, "SELECT COUNT(*) FROM runs WHERE retries>0")
	if err != nil {
		return nil, err
	}
	retryDone, err := count(db, "SELECT COUNT(*) FROM runs WHERE retries>0 AND outcome='done'")
	if err != nil {
		return nil, err
	}
	inputTokens, err := count64(db, "SELECT COALESCE(SUM(in_tokens),0) FROM runs")
	if err != nil {
		return nil, err
	}
	outputTokens, err := count64(db, "SELECT COALESCE(SUM(out_tokens),0) FROM runs")
	if err != nil {
		return nil, err
	}
	perTask, err := readFloatColumn(db, "SELECT SUM(in_tokens+out_tokens) FROM runs GROUP BY task")
	if err != nil {
		return nil, err
	}
	stages, err := readStages(db)
	if err != nil {
		return nil, err
	}
	cycles, err := readCycleMS(db)
	if err != nil {
		return nil, err
	}
	return &Report{
		Tasks:               tasks,
		Runs:                runs,
		Outcomes:            outcomes,
		ImplementRuns:       implementRuns,
		FirstPassYield:      ratio(firstPassDone, implementRuns),
		Escalations:         escalations,
		EscalationRate:      ratio(escalatedTasks, tasks),
		BlockedRate:         ratio(blockedRuns, implementRuns),
		RetryRuns:           retryRuns,
		RetrySuccess:        ratio(retryDone, retryRuns),
		InputTokensTotal:    inputTokens,
		OutputTokensTotal:   outputTokens,
		TokensMedianPerTask: median(perTask),
		Stages:              stages,
		CycleMedianMS:       median(cycles),
	}, nil
}

func writeRun(path string, record RunRecord) error {
	db, err := openDB(path)
	if err != nil {
		return err
	}
	defer db.Close()
	return insertRun(db, record)
}

func openDB(path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec("PRAGMA journal_mode = WAL"); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		db.Close()
		return nil, err
	}
	if err := ensureSchema(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func ensureSchema(db *sql.DB) error {
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version == schemaVersion {
		return nil
	}
	stmts := []string{
		"DROP TABLE IF EXISTS stages",
		"DROP TABLE IF EXISTS runs",
		`CREATE TABLE runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			task TEXT NOT NULL,
			ts TEXT NOT NULL,
			created_at TEXT,
			outcome TEXT NOT NULL,
			triage TEXT,
			retries INTEGER NOT NULL,
			verify_first_try INTEGER,
			ms INTEGER NOT NULL,
			in_tokens INTEGER NOT NULL,
			out_tokens INTEGER NOT NULL
		)`,
		`CREATE TABLE stages (
			run_id INTEGER NOT NULL,
			stage TEXT NOT NULL,
			agent TEXT NOT NULL,
			in_tokens INTEGER NOT NULL,
			out_tokens INTEGER NOT NULL,
			ms INTEGER NOT NULL
		)`,
		fmt.Sprintf("PRAGMA user_version = %d", schemaVersion),
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	return nil
}

func insertRun(db *sql.DB, record RunRecord) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	verifyFirstTry := nullableBool(record.VerifyFirstTry)
	res, err := tx.Exec(
		`INSERT INTO runs
			(task, ts, created_at, outcome, triage, retries, verify_first_try, ms, in_tokens, out_tokens)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		record.Task,
		record.TS,
		nullableString(record.CreatedAt),
		record.Outcome,
		nullableString(record.Triage),
		record.Retries,
		verifyFirstTry,
		record.MS,
		record.InTokens,
		record.OutTokens,
	)
	if err != nil {
		return err
	}
	runID, err := res.LastInsertId()
	if err != nil {
		return err
	}
	for _, stage := range record.Stages {
		if _, err := tx.Exec(
			"INSERT INTO stages (run_id, stage, agent, in_tokens, out_tokens, ms) VALUES (?, ?, ?, ?, ?, ?)",
			runID,
			stage.Stage,
			stage.Agent,
			stage.InTokens,
			stage.OutTokens,
			stage.MS,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func resetDB(path string) {
	for _, candidate := range []string{path, path + "-wal", path + "-shm"} {
		_ = os.Remove(candidate)
	}
}

func readonlyDSN(path string) string {
	u := url.URL{Scheme: "file", Path: path}
	q := u.Query()
	q.Set("mode", "ro")
	u.RawQuery = q.Encode()
	return u.String()
}

func count(db *sql.DB, query string) (int, error) {
	var n int
	if err := db.QueryRow(query).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

func count64(db *sql.DB, query string) (int64, error) {
	var n int64
	if err := db.QueryRow(query).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

func readOutcomes(db *sql.DB) ([]OutcomeCount, error) {
	rows, err := db.Query("SELECT outcome, COUNT(*) FROM runs GROUP BY outcome ORDER BY COUNT(*) DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var outcomes []OutcomeCount
	for rows.Next() {
		var outcome OutcomeCount
		if err := rows.Scan(&outcome.Outcome, &outcome.Count); err != nil {
			return nil, err
		}
		outcomes = append(outcomes, outcome)
	}
	return outcomes, rows.Err()
}

func readStages(db *sql.DB) ([]ReportStage, error) {
	rows, err := db.Query(`SELECT
		stage,
		COALESCE(SUM(in_tokens), 0),
		COALESCE(SUM(out_tokens), 0),
		COALESCE(SUM(in_tokens + out_tokens), 0),
		COALESCE(SUM(ms), 0)
		FROM stages
		GROUP BY stage
		ORDER BY COALESCE(SUM(in_tokens + out_tokens), 0) DESC, stage ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var stages []ReportStage
	for rows.Next() {
		var stage ReportStage
		if err := rows.Scan(&stage.Stage, &stage.InputTokens, &stage.OutputTokens, &stage.TotalTokens, &stage.MS); err != nil {
			return nil, err
		}
		stages = append(stages, stage)
	}
	return stages, rows.Err()
}

func readFloatColumn(db *sql.DB, query string) ([]float64, error) {
	rows, err := db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var values []float64
	for rows.Next() {
		var value float64
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

func readCycleMS(db *sql.DB) ([]float64, error) {
	rows, err := db.Query("SELECT created_at, ts FROM runs WHERE outcome='done' AND created_at IS NOT NULL")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cycles []float64
	for rows.Next() {
		var createdAt string
		var ts string
		if err := rows.Scan(&createdAt, &ts); err != nil {
			return nil, err
		}
		created, err := time.Parse(time.RFC3339Nano, createdAt)
		if err != nil {
			created, err = time.Parse(time.RFC3339, createdAt)
		}
		if err != nil {
			continue
		}
		finished, err := time.Parse(time.RFC3339Nano, ts)
		if err != nil {
			finished, err = time.Parse(time.RFC3339, ts)
		}
		if err != nil {
			continue
		}
		ms := float64(finished.Sub(created).Milliseconds())
		if ms >= 0 {
			cycles = append(cycles, ms)
		}
	}
	return cycles, rows.Err()
}

func ratio(num int, denom int) *float64 {
	if denom <= 0 {
		return nil
	}
	value := float64(num) / float64(denom)
	return &value
}

func median(values []float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	sort.Float64s(values)
	mid := len(values) / 2
	if len(values)%2 == 1 {
		return &values[mid]
	}
	value := (values[mid-1] + values[mid]) / 2
	return &value
}

func nullableString(value *string) sql.NullString {
	if value == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *value, Valid: true}
}

func nullableBool(value *bool) sql.NullInt64 {
	if value == nil {
		return sql.NullInt64{}
	}
	if *value {
		return sql.NullInt64{Int64: 1, Valid: true}
	}
	return sql.NullInt64{Int64: 0, Valid: true}
}
