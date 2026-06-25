import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { type RunRecord, readReport, recordRun } from '../src/metrics.ts'

async function metricsPath(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/factory-metrics-`)
  return `${dir}/metrics.db`
}

function run(record: Omit<RunRecord, 'ts' | 'createdAt' | 'verifyFirstTry' | 'ms'>): RunRecord {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    verifyFirstTry: null,
    ms: 1_000,
    ...record,
  }
}

describe('metrics report aggregation', () => {
  test('aggregates report token totals and combined stage rows', async () => {
    const path = await metricsPath()

    recordRun(
      path,
      run({
        task: 'task-a',
        outcome: 'needs-input',
        triage: 'complex',
        retries: 0,
        inTokens: 100,
        outTokens: 50,
        stages: [{ stage: 'plan', agent: 'codex', inTok: 100, outTok: 50, ms: 1_000 }],
      })
    )
    recordRun(
      path,
      run({
        task: 'task-a',
        outcome: 'done',
        triage: 'complex',
        retries: 0,
        inTokens: 1_000,
        outTokens: 200,
        stages: [
          { stage: 'implement', agent: 'codex', inTok: 500, outTok: 100, ms: 4_000 },
          { stage: 'implement', agent: 'claude', inTok: 300, outTok: 50, ms: 2_000 },
          { stage: 'verify', agent: 'codex', inTok: 0, outTok: 0, ms: 1_000 },
        ],
      })
    )
    recordRun(
      path,
      run({
        task: 'task-b',
        outcome: 'done',
        triage: 'complex',
        retries: 1,
        inTokens: 2_000,
        outTokens: 500,
        stages: [
          { stage: 'review', agent: 'claude', inTok: 1_000, outTok: 300, ms: 3_000 },
          { stage: 'alpha', agent: 'codex', inTok: 0, outTok: 0, ms: 2_000 },
          { stage: 'verify', agent: 'codex', inTok: 0, outTok: 0, ms: 3_000 },
        ],
      })
    )
    recordRun(
      path,
      run({
        task: 'task-c',
        outcome: 'blocked',
        triage: 'complex',
        retries: 0,
        inTokens: 3_000,
        outTokens: 1_000,
        stages: [{ stage: 'plan', agent: 'claude', inTok: 2_500, outTok: 900, ms: 5_000 }],
      })
    )

    const report = readReport(path)

    if (!report) {
      throw new Error('expected report')
    }
    expect(report.inputTokensTotal).toBe(6_100)
    expect(report.outputTokensTotal).toBe(1_750)
    expect(report.inputTokensTotal + report.outputTokensTotal).toBe(7_850)
    expect(report.tokensMedianPerTask).toBe(2_500)
    expect(report.firstPassYield).toBeCloseTo(1 / 3)
    expect(report.outcomes.find((o) => o.outcome === 'done')?.count).toBe(2)

    expect(report.stages).toEqual([
      {
        stage: 'plan',
        inputTokens: 2_600,
        outputTokens: 950,
        totalTokens: 3_550,
        ms: 6_000,
      },
      {
        stage: 'review',
        inputTokens: 1_000,
        outputTokens: 300,
        totalTokens: 1_300,
        ms: 3_000,
      },
      {
        stage: 'implement',
        inputTokens: 800,
        outputTokens: 150,
        totalTokens: 950,
        ms: 6_000,
      },
      { stage: 'alpha', inputTokens: 0, outputTokens: 0, totalTokens: 0, ms: 2_000 },
      { stage: 'verify', inputTokens: 0, outputTokens: 0, totalTokens: 0, ms: 4_000 },
    ])
  })

  test('scopes the report to a single task', async () => {
    const path = await metricsPath()
    recordRun(
      path,
      run({
        task: 'task-a',
        outcome: 'needs-input',
        triage: 'complex',
        retries: 0,
        inTokens: 100,
        outTokens: 50,
        stages: [{ stage: 'plan', agent: 'codex', inTok: 100, outTok: 50, ms: 1_000 }],
      })
    )
    recordRun(
      path,
      run({
        task: 'task-a',
        outcome: 'done',
        triage: 'complex',
        retries: 1,
        inTokens: 1_000,
        outTokens: 200,
        stages: [{ stage: 'implement', agent: 'codex', inTok: 800, outTok: 150, ms: 4_000 }],
      })
    )
    recordRun(
      path,
      run({
        task: 'task-b',
        outcome: 'done',
        triage: 'complex',
        retries: 0,
        inTokens: 9_999,
        outTokens: 9_999,
        stages: [{ stage: 'plan', agent: 'claude', inTok: 9_999, outTok: 9_999, ms: 9_000 }],
      })
    )

    const report = readReport(path, 'task-a')
    if (!report) {
      throw new Error('expected report')
    }
    // task-b's runs, tokens, and stages are excluded entirely.
    expect(report.tasks).toBe(1)
    expect(report.runs).toBe(2)
    expect(report.inputTokensTotal).toBe(1_100)
    expect(report.outputTokensTotal).toBe(250)
    expect(report.retrySuccess).toBe(1)
    expect(report.stages.map((s) => s.stage).sort()).toEqual(['implement', 'plan'])
    expect(report.stages.find((s) => s.stage === 'plan')?.totalTokens).toBe(150)
  })

  test('returns null for a task with no telemetry', async () => {
    const path = await metricsPath()
    recordRun(
      path,
      run({
        task: 'task-a',
        outcome: 'done',
        triage: null,
        retries: 0,
        inTokens: 10,
        outTokens: 10,
        stages: [],
      })
    )
    expect(readReport(path, 'missing')).toBeNull()
  })
})
