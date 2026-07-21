import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ModelEffort } from './effort.ts'
import { log } from './log.ts'

// Telemetry store. One repo-level metrics.db; one row per task PASS (a task that
// escalates and resumes produces several rows sharing `task`), plus a child row
// per pipeline stage. Reports group by task to reconstruct each task's life.
//
// Iron rule: telemetry must NEVER fail a task. Every write is best-effort —
// on any error (corrupt db, schema drift, lock) we reset the db (deleting
// telemetry is acceptable) and try once more, then give up quietly. The schema
// is versioned and rebuilt on any mismatch; we never carefully migrate it.

// Rolling autonomy readiness: over the most recent `limit` tasks whose latest
// pass was terminal (done/blocked), the fraction that completed first-pass
// (done, zero fix retries). Best-effort like everything here — null on any
// error so a broken db can never gate behavior open OR closed unexpectedly.
export function recentFirstPassYield(
  path: string,
  limit: number
): { tasks: number; firstPassYield: number } | null {
  try {
    const db = new Database(path, { readonly: true })
    try {
      const rows = db
        .query<{ outcome: string; retries: number }, [number]>(
          `SELECT outcome, retries FROM runs r
           WHERE ts = (SELECT MAX(ts) FROM runs r2 WHERE r2.task = r.task)
             AND outcome IN ('done', 'blocked')
           ORDER BY ts DESC LIMIT ?`
        )
        .all(limit)
      if (rows.length === 0) {
        return { tasks: 0, firstPassYield: 0 }
      }
      const firstPass = rows.filter((r) => r.outcome === 'done' && r.retries === 0).length
      return { tasks: rows.length, firstPassYield: firstPass / rows.length }
    } finally {
      db.close()
    }
  } catch (err) {
    log.warn(`autonomy readiness read failed: ${errMsg(err)}`)
    return null
  }
}

export type StageStat = {
  stage: string
  agent: string
  effort?: ModelEffort | null
  inTok: number
  outTok: number
  ms: number
}

export type RunRecord = {
  task: string
  ts: string
  createdAt: string | null
  outcome: 'done' | 'blocked' | 'needs-input' | 'retrying' | 'decomposed'
  triage: 'trivial' | 'complex' | null
  retries: number
  verifyFirstTry: boolean | null
  // Resolved agent label of this pass's first implement stage (the routing
  // decision for attempt-0 passes — a pool agent's label when triage routed,
  // the default implementer's otherwise). Null when the pass ran no implement
  // stage (gates-only resume, delivery-only). Grouping a task's terminal
  // outcome by its first implementer joins passes on `task`; the stages table
  // already labels every stage's agent.
  implementer: string | null
  ms: number
  inTokens: number
  outTokens: number
  stages: StageStat[]
}

const SCHEMA_VERSION = 3

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  // WAL lets parallel workers write concurrently; busy_timeout makes a contending
  // writer wait briefly rather than erroring on a lock.
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA busy_timeout = 5000')
  ensureSchema(db)
  return db
}

function ensureSchema(db: Database): void {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
  if (row?.user_version === SCHEMA_VERSION) {
    return
  }
  // Any mismatch — fresh (0), older, or newer — is rebuilt from scratch. Telemetry
  // is disposable, so we never risk failing on a schema we don't recognize.
  db.run('DROP TABLE IF EXISTS stages')
  db.run('DROP TABLE IF EXISTS runs')
  db.run(`CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    ts TEXT NOT NULL,
    created_at TEXT,
    outcome TEXT NOT NULL,
    triage TEXT,
    retries INTEGER NOT NULL,
    verify_first_try INTEGER,
    implementer TEXT,
    ms INTEGER NOT NULL,
    in_tokens INTEGER NOT NULL,
    out_tokens INTEGER NOT NULL
  )`)
  db.run(`CREATE TABLE stages (
    run_id INTEGER NOT NULL,
    stage TEXT NOT NULL,
    agent TEXT NOT NULL,
    effort TEXT,
    in_tokens INTEGER NOT NULL,
    out_tokens INTEGER NOT NULL,
    ms INTEGER NOT NULL
  )`)
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

function insertRun(db: Database, r: RunRecord): void {
  const insert = db.transaction(() => {
    const res = db
      .query(
        `INSERT INTO runs
           (task, ts, created_at, outcome, triage, retries, verify_first_try, implementer, ms, in_tokens, out_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        r.task,
        r.ts,
        r.createdAt,
        r.outcome,
        r.triage,
        r.retries,
        r.verifyFirstTry === null ? null : r.verifyFirstTry ? 1 : 0,
        r.implementer,
        r.ms,
        r.inTokens,
        r.outTokens
      )
    const runId = Number(res.lastInsertRowid)
    const stage = db.query(
      `INSERT INTO stages (run_id, stage, agent, effort, in_tokens, out_tokens, ms) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const s of r.stages) {
      stage.run(runId, s.stage, s.agent, s.effort ?? null, s.inTok, s.outTok, s.ms)
    }
  })
  insert()
}

// Delete the db (and its WAL/SHM sidecars). Used to recover from a broken db —
// losing telemetry is acceptable; failing the task is not.
function resetDb(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      rmSync(p, { force: true })
    } catch {
      // Nothing more we can do; the caller's next open will surface any problem.
    }
  }
}

// Best-effort write. Never throws — a telemetry failure must not break the loop.
export function recordRun(path: string, record: RunRecord): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    let db: Database | null = null
    try {
      db = openDb(path)
      insertRun(db, record)
      return
    } catch (err) {
      log.warn(
        `telemetry: ${attempt === 0 ? 'write failed' : 'write failed after reset'} — ${errMsg(err)}`
      )
      db?.close()
      db = null
      if (attempt === 0) {
        resetDb(path)
      }
    } finally {
      db?.close()
    }
  }
}

export type ReportStage = {
  stage: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  ms: number
}

export type Report = {
  tasks: number
  runs: number
  outcomes: { outcome: string; count: number }[]
  implementRuns: number
  firstPassYield: number | null
  escalations: number
  escalationRate: number | null
  blockedRate: number | null
  retryRuns: number
  retrySuccess: number | null
  inputTokensTotal: number
  outputTokensTotal: number
  tokensMedianPerTask: number | null
  stages: ReportStage[]
  cycleMedianMs: number | null
}

function median(xs: number[]): number | null {
  if (xs.length === 0) {
    return null
  }
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? null
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function ratio(num: number, denom: number): number | null {
  return denom > 0 ? num / denom : null
}

// Read-side aggregation. Returns null if there's no db / no data yet. Unlike the
// write path it does NOT reset on error (a report failing is recoverable and we
// don't want a glitchy read to nuke real data) — it lets the caller handle it.
//
// With `taskId`, every aggregate is scoped to that one task's runs (a task can
// have several runs if it escalated and resumed); without it, the report rolls up
// the whole repo. Each query carries the same single `?` filter so one bound
// param works for both shapes.
export function readReport(path: string, taskId?: string): Report | null {
  const db = new Database(path, { readonly: true })
  try {
    const p: string[] = taskId ? [taskId] : []
    const and = taskId ? ' AND task = ?' : ''
    const where = taskId ? ' WHERE task = ?' : ''
    const count = (sql: string): number => db.query<{ c: number }, string[]>(sql).get(...p)?.c ?? 0

    const runs = count(`SELECT COUNT(*) c FROM runs${where}`)
    if (runs === 0) {
      return null
    }

    const tasks = count(`SELECT COUNT(DISTINCT task) c FROM runs${where}`)
    const outcomes = db
      .query<{ outcome: string; count: number }, string[]>(
        `SELECT outcome, COUNT(*) count FROM runs${where} GROUP BY outcome ORDER BY count DESC`
      )
      .all(...p)
    const implementRuns = count(
      `SELECT COUNT(*) c FROM runs WHERE outcome IN ('done','blocked')${and}`
    )
    const firstPassDone = count(
      `SELECT COUNT(*) c FROM runs WHERE outcome='done' AND retries=0${and}`
    )
    const escalations = count(`SELECT COUNT(*) c FROM runs WHERE outcome='needs-input'${and}`)
    const escalatedTasks = count(
      `SELECT COUNT(DISTINCT task) c FROM runs WHERE outcome='needs-input'${and}`
    )
    const blockedRuns = count(`SELECT COUNT(*) c FROM runs WHERE outcome='blocked'${and}`)
    const retryRuns = count(`SELECT COUNT(*) c FROM runs WHERE retries>0${and}`)
    const retryDone = count(`SELECT COUNT(*) c FROM runs WHERE retries>0 AND outcome='done'${and}`)
    const inputTokensTotal = count(`SELECT COALESCE(SUM(in_tokens),0) c FROM runs${where}`)
    const outputTokensTotal = count(`SELECT COALESCE(SUM(out_tokens),0) c FROM runs${where}`)

    const perTask = db
      .query<{ t: number }, string[]>(
        `SELECT SUM(in_tokens+out_tokens) t FROM runs${where} GROUP BY task`
      )
      .all(...p)
      .map((r) => r.t)
    // Stages have no task column, so a scoped report joins back to runs to filter.
    const stages = db
      .query<ReportStage, string[]>(
        `SELECT
           stage,
           COALESCE(SUM(stages.in_tokens), 0) inputTokens,
           COALESCE(SUM(stages.out_tokens), 0) outputTokens,
           COALESCE(SUM(stages.in_tokens + stages.out_tokens), 0) totalTokens,
           COALESCE(SUM(stages.ms), 0) ms
         FROM stages${taskId ? ' JOIN runs ON runs.id = stages.run_id WHERE runs.task = ?' : ''}
         GROUP BY stage
         ORDER BY totalTokens DESC, stage ASC`
      )
      .all(...p)
    const cycles = db
      .query<{ created_at: string; ts: string }, string[]>(
        `SELECT created_at, ts FROM runs WHERE outcome='done' AND created_at IS NOT NULL${and}`
      )
      .all(...p)
      .map((r) => new Date(r.ts).getTime() - new Date(r.created_at).getTime())
      .filter((ms) => Number.isFinite(ms) && ms >= 0)

    return {
      tasks,
      runs,
      outcomes,
      implementRuns,
      firstPassYield: ratio(firstPassDone, implementRuns),
      escalations,
      escalationRate: ratio(escalatedTasks, tasks),
      blockedRate: ratio(blockedRuns, implementRuns),
      retryRuns,
      retrySuccess: ratio(retryDone, retryRuns),
      inputTokensTotal,
      outputTokensTotal,
      tokensMedianPerTask: median(perTask),
      stages,
      cycleMedianMs: median(cycles),
    }
  } finally {
    db.close()
  }
}
