use std::fs;
use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageStat {
    pub stage: String,
    pub agent: String,
    pub in_tok: i64,
    pub out_tok: i64,
    pub ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunRecord {
    pub task: String,
    pub ts: String,
    pub created_at: Option<String>,
    pub outcome: String,
    pub triage: Option<String>,
    pub retries: i64,
    pub verify_first_try: Option<bool>,
    pub ms: i64,
    pub in_tokens: i64,
    pub out_tokens: i64,
    pub stages: Vec<StageStat>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportStage {
    pub stage: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub tasks: i64,
    pub runs: i64,
    pub outcomes: Vec<OutcomeCount>,
    pub implement_runs: i64,
    pub first_pass_yield: Option<f64>,
    pub escalations: i64,
    pub escalation_rate: Option<f64>,
    pub blocked_rate: Option<f64>,
    pub retry_runs: i64,
    pub retry_success: Option<f64>,
    pub input_tokens_total: i64,
    pub output_tokens_total: i64,
    pub tokens_median_per_task: Option<f64>,
    pub stages: Vec<ReportStage>,
    pub cycle_median_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutcomeCount {
    pub outcome: String,
    pub count: i64,
}

fn open_db(path: &str) -> rusqlite::Result<Connection> {
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent)
            .map_err(|err| rusqlite::Error::ToSqlConversionFailure(Box::new(err)))?;
    }
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version == SCHEMA_VERSION {
        return Ok(());
    }
    conn.execute_batch(
        r#"
        DROP TABLE IF EXISTS stages;
        DROP TABLE IF EXISTS runs;
        CREATE TABLE runs (
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
        );
        CREATE TABLE stages (
          run_id INTEGER NOT NULL,
          stage TEXT NOT NULL,
          agent TEXT NOT NULL,
          in_tokens INTEGER NOT NULL,
          out_tokens INTEGER NOT NULL,
          ms INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
        "#,
    )?;
    Ok(())
}

fn insert_run(conn: &mut Connection, record: &RunRecord) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        r#"INSERT INTO runs
           (task, ts, created_at, outcome, triage, retries, verify_first_try, ms, in_tokens, out_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        params![
            record.task,
            record.ts,
            record.created_at,
            record.outcome,
            record.triage,
            record.retries,
            record.verify_first_try.map(i64::from),
            record.ms,
            record.in_tokens,
            record.out_tokens,
        ],
    )?;
    let run_id = tx.last_insert_rowid();
    {
        let mut stmt = tx.prepare(
            "INSERT INTO stages (run_id, stage, agent, in_tokens, out_tokens, ms) VALUES (?, ?, ?, ?, ?, ?)",
        )?;
        for stage in &record.stages {
            stmt.execute(params![
                run_id,
                stage.stage,
                stage.agent,
                stage.in_tok,
                stage.out_tok,
                stage.ms
            ])?;
        }
    }
    tx.commit()
}

fn reset_db(path: &str) {
    for path in [
        path.to_string(),
        format!("{path}-wal"),
        format!("{path}-shm"),
    ] {
        let _ = fs::remove_file(path);
    }
}

pub fn record_run(path: &str, record: &RunRecord) {
    for attempt in 0..2 {
        match open_db(path).and_then(|mut conn| insert_run(&mut conn, record)) {
            Ok(()) => return,
            Err(err) => {
                eprintln!(
                    "warning: telemetry: {} — {}",
                    if attempt == 0 {
                        "write failed"
                    } else {
                        "write failed after reset"
                    },
                    err
                );
                if attempt == 0 {
                    reset_db(path);
                }
            }
        }
    }
}

fn count(conn: &Connection, sql: &str) -> rusqlite::Result<i64> {
    conn.query_row(sql, [], |row| row.get::<_, i64>(0))
}

fn median(mut xs: Vec<f64>) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    xs.sort_by(|a, b| a.total_cmp(b));
    let mid = xs.len() / 2;
    if xs.len() % 2 == 1 {
        Some(xs[mid])
    } else {
        Some((xs[mid - 1] + xs[mid]) / 2.0)
    }
}

fn ratio(num: i64, denom: i64) -> Option<f64> {
    (denom > 0).then_some(num as f64 / denom as f64)
}

pub fn read_report(path: &str) -> rusqlite::Result<Option<Report>> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let runs = count(&conn, "SELECT COUNT(*) FROM runs")?;
    if runs == 0 {
        return Ok(None);
    }

    let tasks = count(&conn, "SELECT COUNT(DISTINCT task) FROM runs")?;
    let outcomes = {
        let mut stmt = conn.prepare(
            "SELECT outcome, COUNT(*) count FROM runs GROUP BY outcome ORDER BY count DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(OutcomeCount {
                    outcome: row.get(0)?,
                    count: row.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let implement_runs = count(
        &conn,
        "SELECT COUNT(*) FROM runs WHERE outcome IN ('done','blocked')",
    )?;
    let first_pass_done = count(
        &conn,
        "SELECT COUNT(*) FROM runs WHERE outcome='done' AND retries=0",
    )?;
    let escalations = count(
        &conn,
        "SELECT COUNT(*) FROM runs WHERE outcome='needs-input'",
    )?;
    let escalated_tasks = count(
        &conn,
        "SELECT COUNT(DISTINCT task) FROM runs WHERE outcome='needs-input'",
    )?;
    let blocked_runs = count(&conn, "SELECT COUNT(*) FROM runs WHERE outcome='blocked'")?;
    let retry_runs = count(&conn, "SELECT COUNT(*) FROM runs WHERE retries>0")?;
    let retry_done = count(
        &conn,
        "SELECT COUNT(*) FROM runs WHERE retries>0 AND outcome='done'",
    )?;
    let input_tokens_total = count(&conn, "SELECT COALESCE(SUM(in_tokens),0) FROM runs")?;
    let output_tokens_total = count(&conn, "SELECT COALESCE(SUM(out_tokens),0) FROM runs")?;

    let per_task = {
        let mut stmt = conn.prepare("SELECT SUM(in_tokens+out_tokens) FROM runs GROUP BY task")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, i64>(0))?
            .map(|result| result.map(|n| n as f64))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let stages = {
        let mut stmt = conn.prepare(
            r#"SELECT
                 stage,
                 COALESCE(SUM(in_tokens), 0) input_tokens,
                 COALESCE(SUM(out_tokens), 0) output_tokens,
                 COALESCE(SUM(in_tokens + out_tokens), 0) total_tokens,
                 COALESCE(SUM(ms), 0) ms
               FROM stages
               GROUP BY stage
               ORDER BY total_tokens DESC, stage ASC"#,
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ReportStage {
                    stage: row.get(0)?,
                    input_tokens: row.get(1)?,
                    output_tokens: row.get(2)?,
                    total_tokens: row.get(3)?,
                    ms: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let cycles = {
        let mut stmt = conn.prepare(
            "SELECT created_at, ts FROM runs WHERE outcome='done' AND created_at IS NOT NULL",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|result| {
                let (created_at, ts) = result.ok()?;
                let created = ::time::OffsetDateTime::parse(
                    &created_at,
                    &::time::format_description::well_known::Rfc3339,
                )
                .ok()?;
                let ts = ::time::OffsetDateTime::parse(
                    &ts,
                    &::time::format_description::well_known::Rfc3339,
                )
                .ok()?;
                let ms = (ts - created).whole_milliseconds();
                (ms >= 0).then_some(ms as f64)
            })
            .collect::<Vec<_>>();
        rows
    };

    Ok(Some(Report {
        tasks,
        runs,
        outcomes,
        implement_runs,
        first_pass_yield: ratio(first_pass_done, implement_runs),
        escalations,
        escalation_rate: ratio(escalated_tasks, tasks),
        blocked_rate: ratio(blocked_runs, implement_runs),
        retry_runs,
        retry_success: ratio(retry_done, retry_runs),
        input_tokens_total,
        output_tokens_total,
        tokens_median_per_task: median(per_task),
        stages,
        cycle_median_ms: median(cycles),
    }))
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    fn run(record: RunRecord) -> RunRecord {
        RunRecord {
            ts: "2026-01-01T00:00:00Z".to_string(),
            created_at: Some("2026-01-01T00:00:00Z".to_string()),
            verify_first_try: None,
            ms: 1_000,
            ..record
        }
    }

    #[test]
    fn aggregates_report_token_totals_and_combined_stage_rows() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("metrics.db");
        let path = path.to_string_lossy();

        record_run(
            &path,
            &run(RunRecord {
                task: "task-a".to_string(),
                outcome: "needs-input".to_string(),
                triage: Some("complex".to_string()),
                retries: 0,
                in_tokens: 100,
                out_tokens: 50,
                stages: vec![StageStat {
                    stage: "plan".to_string(),
                    agent: "codex".to_string(),
                    in_tok: 100,
                    out_tok: 50,
                    ms: 1_000,
                }],
                ts: String::new(),
                created_at: None,
                verify_first_try: None,
                ms: 0,
            }),
        );
        record_run(
            &path,
            &run(RunRecord {
                task: "task-a".to_string(),
                outcome: "done".to_string(),
                triage: Some("complex".to_string()),
                retries: 0,
                in_tokens: 1_000,
                out_tokens: 200,
                stages: vec![
                    StageStat {
                        stage: "implement".to_string(),
                        agent: "codex".to_string(),
                        in_tok: 500,
                        out_tok: 100,
                        ms: 4_000,
                    },
                    StageStat {
                        stage: "implement".to_string(),
                        agent: "claude".to_string(),
                        in_tok: 300,
                        out_tok: 50,
                        ms: 2_000,
                    },
                    StageStat {
                        stage: "verify".to_string(),
                        agent: "codex".to_string(),
                        in_tok: 0,
                        out_tok: 0,
                        ms: 1_000,
                    },
                ],
                ts: String::new(),
                created_at: None,
                verify_first_try: None,
                ms: 0,
            }),
        );
        record_run(
            &path,
            &run(RunRecord {
                task: "task-b".to_string(),
                outcome: "done".to_string(),
                triage: Some("complex".to_string()),
                retries: 1,
                in_tokens: 2_000,
                out_tokens: 500,
                stages: vec![
                    StageStat {
                        stage: "review".to_string(),
                        agent: "claude".to_string(),
                        in_tok: 1_000,
                        out_tok: 300,
                        ms: 3_000,
                    },
                    StageStat {
                        stage: "alpha".to_string(),
                        agent: "codex".to_string(),
                        in_tok: 0,
                        out_tok: 0,
                        ms: 2_000,
                    },
                    StageStat {
                        stage: "verify".to_string(),
                        agent: "codex".to_string(),
                        in_tok: 0,
                        out_tok: 0,
                        ms: 3_000,
                    },
                ],
                ts: String::new(),
                created_at: None,
                verify_first_try: None,
                ms: 0,
            }),
        );
        record_run(
            &path,
            &run(RunRecord {
                task: "task-c".to_string(),
                outcome: "blocked".to_string(),
                triage: Some("complex".to_string()),
                retries: 0,
                in_tokens: 3_000,
                out_tokens: 1_000,
                stages: vec![StageStat {
                    stage: "plan".to_string(),
                    agent: "claude".to_string(),
                    in_tok: 2_500,
                    out_tok: 900,
                    ms: 5_000,
                }],
                ts: String::new(),
                created_at: None,
                verify_first_try: None,
                ms: 0,
            }),
        );

        let report = read_report(&path).unwrap().unwrap();
        assert_eq!(report.input_tokens_total, 6_100);
        assert_eq!(report.output_tokens_total, 1_750);
        assert_eq!(report.tokens_median_per_task, Some(2_500.0));
        assert_eq!(report.first_pass_yield, Some(1.0 / 3.0));
        assert_eq!(
            report
                .outcomes
                .iter()
                .find(|outcome| outcome.outcome == "done")
                .map(|outcome| outcome.count),
            Some(2)
        );
        assert_eq!(
            report.stages,
            vec![
                ReportStage {
                    stage: "plan".to_string(),
                    input_tokens: 2_600,
                    output_tokens: 950,
                    total_tokens: 3_550,
                    ms: 6_000,
                },
                ReportStage {
                    stage: "review".to_string(),
                    input_tokens: 1_000,
                    output_tokens: 300,
                    total_tokens: 1_300,
                    ms: 3_000,
                },
                ReportStage {
                    stage: "implement".to_string(),
                    input_tokens: 800,
                    output_tokens: 150,
                    total_tokens: 950,
                    ms: 6_000,
                },
                ReportStage {
                    stage: "alpha".to_string(),
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0,
                    ms: 2_000,
                },
                ReportStage {
                    stage: "verify".to_string(),
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0,
                    ms: 4_000,
                },
            ]
        );
    }
}
