package metrics

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRecordRunAndReadReport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "metrics.db")
	created := time.Date(2026, 6, 23, 10, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	doneAt := time.Date(2026, 6, 23, 10, 2, 0, 0, time.UTC).Format(time.RFC3339Nano)
	complex := "complex"
	verifyFirstTry := true

	RecordRun(path, RunRecord{
		Task:           "task-one",
		TS:             doneAt,
		CreatedAt:      &created,
		Outcome:        "done",
		Triage:         &complex,
		Retries:        0,
		VerifyFirstTry: &verifyFirstTry,
		MS:             5000,
		InTokens:       100,
		OutTokens:      50,
		Stages: []StageStat{
			{Stage: "plan", Agent: "codex", InTokens: 40, OutTokens: 10, MS: 1000},
			{Stage: "implement", Agent: "codex", InTokens: 60, OutTokens: 40, MS: 4000},
		},
	}, func(message string) {
		t.Fatal(message)
	})
	RecordRun(path, RunRecord{
		Task:      "task-two",
		TS:        doneAt,
		CreatedAt: &created,
		Outcome:   "needs-input",
		Retries:   0,
		MS:        1000,
	}, func(message string) {
		t.Fatal(message)
	})
	RecordRun(path, RunRecord{
		Task:      "task-two",
		TS:        doneAt,
		CreatedAt: &created,
		Outcome:   "done",
		Retries:   2,
		MS:        7000,
		InTokens:  10,
		OutTokens: 20,
		Stages: []StageStat{
			{Stage: "implement", Agent: "claude", InTokens: 10, OutTokens: 20, MS: 7000},
		},
	}, func(message string) {
		t.Fatal(message)
	})
	RecordRun(path, RunRecord{
		Task:      "task-three",
		TS:        doneAt,
		CreatedAt: &created,
		Outcome:   "blocked",
		Retries:   1,
		MS:        3000,
	}, func(message string) {
		t.Fatal(message)
	})

	report, err := ReadReport(path)
	if err != nil {
		t.Fatal(err)
	}
	if report == nil {
		t.Fatal("expected report")
	}
	if report.Tasks != 3 || report.Runs != 4 {
		t.Fatalf("unexpected counts: tasks=%d runs=%d", report.Tasks, report.Runs)
	}
	if report.ImplementRuns != 3 {
		t.Fatalf("unexpected implement runs: %d", report.ImplementRuns)
	}
	if report.FirstPassYield == nil || *report.FirstPassYield != 1.0/3.0 {
		t.Fatalf("unexpected first pass yield: %v", report.FirstPassYield)
	}
	if report.EscalationRate == nil || *report.EscalationRate != 1.0/3.0 {
		t.Fatalf("unexpected escalation rate: %v", report.EscalationRate)
	}
	if report.BlockedRate == nil || *report.BlockedRate != 1.0/3.0 {
		t.Fatalf("unexpected blocked rate: %v", report.BlockedRate)
	}
	if report.RetrySuccess == nil || *report.RetrySuccess != 0.5 {
		t.Fatalf("unexpected retry success: %v", report.RetrySuccess)
	}
	if report.InputTokensTotal != 110 || report.OutputTokensTotal != 70 {
		t.Fatalf("unexpected tokens: input=%d output=%d", report.InputTokensTotal, report.OutputTokensTotal)
	}
	if report.TokensMedianPerTask == nil || *report.TokensMedianPerTask != 30 {
		t.Fatalf("unexpected median tokens: %v", report.TokensMedianPerTask)
	}
	if report.CycleMedianMS == nil || *report.CycleMedianMS != 120000 {
		t.Fatalf("unexpected cycle median: %v", report.CycleMedianMS)
	}
	if len(report.Stages) != 2 {
		t.Fatalf("unexpected stage count: %d", len(report.Stages))
	}
	if report.Stages[0].Stage != "implement" || report.Stages[0].TotalTokens != 130 {
		t.Fatalf("unexpected first stage: %+v", report.Stages[0])
	}
	if report.Outcomes[0].Outcome != "done" || report.Outcomes[0].Count != 2 {
		t.Fatalf("unexpected outcomes: %+v", report.Outcomes)
	}
}

func TestReadReportMissingDB(t *testing.T) {
	report, err := ReadReport(filepath.Join(t.TempDir(), "missing.db"))
	if err != nil {
		t.Fatal(err)
	}
	if report != nil {
		t.Fatalf("expected nil report, got %+v", report)
	}
}

func TestRecordRunResetsBrokenDB(t *testing.T) {
	path := filepath.Join(t.TempDir(), "metrics.db")
	if err := os.WriteFile(path, []byte("not sqlite"), 0o644); err != nil {
		t.Fatal(err)
	}
	var warnings []string
	RecordRun(path, RunRecord{
		Task:    "task-one",
		TS:      time.Now().UTC().Format(time.RFC3339Nano),
		Outcome: "done",
		MS:      10,
	}, func(message string) {
		warnings = append(warnings, message)
	})
	if len(warnings) == 0 {
		t.Fatal("expected warning on broken db")
	}
	report, err := ReadReport(path)
	if err != nil {
		t.Fatal(err)
	}
	if report == nil || report.Runs != 1 {
		t.Fatalf("expected rebuilt report with one run, got %+v", report)
	}
}
