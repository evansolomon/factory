import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Agent, Config, WorkContext } from '../src/config.ts'
import { captureCorrectionGuidance } from '../src/evals.ts'
import { listGuidance } from '../src/guidance.ts'

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(`${tmpdir()}/factory-${prefix}-`)
}

async function withFactoryHome<T>(work: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env['FACTORY_HOME']
  const home = await tempDir('eval-guidance-home')
  process.env['FACTORY_HOME'] = home
  try {
    return await work(home)
  } finally {
    if (previous === undefined) {
      delete process.env['FACTORY_HOME']
    } else {
      process.env['FACTORY_HOME'] = previous
    }
  }
}

const agent = { cli: 'codex' } satisfies Agent

function testConfig(): Config {
  return {
    retries: 10,
    triage: true,
    security: true,
    ux: true,
    plansDir: '.coding-agent-plans',
    captureEvals: true,
    postmortem: true,
    remediate: true,
    hooks: {},
    agents: {
      planners: [agent],
      implementer: agent,
      reviewer: agent,
      delivery: agent,
    },
    ask: { agent },
  }
}

function testContext(repoStateDir: string): WorkContext {
  return {
    root: '/repo',
    config: testConfig(),
    stateDir: `${repoStateDir}/worktree`,
    tasksDir: `${repoStateDir}/worktree/tasks`,
    plansDir: null,
    agents: {
      planners: [agent],
      implementer: agent,
      reviewer: agent,
      delivery: agent,
    },
    askAgent: agent,
    repoStateDir,
    metricsPath: `${repoStateDir}/metrics.db`,
  }
}

describe('correction guidance capture', () => {
  test('valid actionable correction creates structured guidance', async () => {
    await withFactoryHome(async () => {
      const ctx = testContext('/repo-a')
      const result = await captureCorrectionGuidance(ctx, {
        taskId: 'task-1',
        category: 'implementation',
        lesson: 'Prefer the existing parser instead of duplicating parsing logic.',
        distillation: [
          'CATEGORY: implementation',
          'LESSON: Prefer the existing parser instead of duplicating parsing logic.',
          'ACTIONABLE: YES',
          'SCOPE: REPO',
          'STAGES: plan,implement,review',
        ].join('\n'),
      })

      const records = await listGuidance(ctx)

      expect(result).toBe('created')
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        source: { kind: 'correction', taskId: 'task-1', detail: 'implementation' },
        scope: { kind: 'repo', repoStateDir: '/repo-a' },
        stages: ['plan', 'implement', 'review'],
        text: 'Prefer the existing parser instead of duplicating parsing logic.',
      })
    })
  })

  test('invalid stages fall back to raw candidate only', async () => {
    await withFactoryHome(async () => {
      const ctx = testContext('/repo-a')
      const result = await captureCorrectionGuidance(ctx, {
        taskId: 'task-1',
        category: 'implementation',
        lesson: 'Use valid stage names.',
        distillation: [
          'CATEGORY: implementation',
          'LESSON: Use valid stage names.',
          'ACTIONABLE: YES',
          'SCOPE: GLOBAL',
          'STAGES: plan,unknown',
        ].join('\n'),
      })

      expect(result).toBe('invalid')
      expect(await listGuidance(ctx)).toEqual([])
    })
  })

  test('ACTIONABLE: NO does not create structured guidance', async () => {
    await withFactoryHome(async () => {
      const ctx = testContext('/repo-a')
      const result = await captureCorrectionGuidance(ctx, {
        taskId: 'task-1',
        category: 'other',
        lesson: 'No reusable lesson.',
        distillation: [
          'CATEGORY: other',
          'LESSON: No reusable lesson.',
          'ACTIONABLE: NO',
          'SCOPE: GLOBAL',
          'STAGES: plan',
        ].join('\n'),
      })

      expect(result).toBe('not-actionable')
      expect(await listGuidance(ctx)).toEqual([])
    })
  })
})
