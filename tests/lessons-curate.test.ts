import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Agent, Config, WorkContext } from '../src/config.ts'
import { GuidanceRecordSchema } from '../src/guidance.ts'
import { applyLessonCuration, parseLessonCandidates, planLessonCuration } from '../src/lessons.ts'

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(`${tmpdir()}/factory-${prefix}-`)
}

async function withFactoryHome<T>(work: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env['FACTORY_HOME']
  const home = await tempDir('lessons-curate-home')
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
    workforce: true,
    rescue: true,
    autoAcceptAfterMinutes: null,
    implementerAccess: 'write',
    autoShip: null,
    dispatch: null,
    specialists: {},
    hooks: {},
    agents: {
      planners: [agent],
      implementer: agent,
      reviewer: agent,
      delivery: agent,
      workforce: agent,
      rescue: agent,
      researchers: {},
      reviewers: {},
      namer: agent,
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
      namer: agent,
    },
    askAgent: agent,
    repoStateDir,
    metricsPath: `${repoStateDir}/metrics.db`,
    envPlaybookPath: `${repoStateDir}/env/test-host.md`,
  }
}

function postmortem(lesson: string): string {
  return [
    'CATEGORY: implementation',
    `LESSON: ${lesson}`,
    'ACTIONABLE: YES',
    'SCOPE: REPO',
    'STAGES: implement, fix',
    '## Analysis',
    'The repeated signal is actionable.',
  ].join('\n')
}

describe('lesson candidate curation', () => {
  test('parses timestamped lesson candidate lines', () => {
    const candidates = parseLessonCandidates(
      [
        '# Lesson candidates',
        '',
        '- 2026-07-01T00:00:00.000Z · blocked · task-a · [implementation] Prefer parser APIs.',
      ].join('\n')
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      kind: 'blocked',
      taskId: 'task-a',
      category: 'implementation',
      lessonText: 'Prefer parser APIs.',
    })
  })

  test('promotes recurring actionable candidates from task artifacts', async () => {
    await withFactoryHome(async (home) => {
      const repoStateDir = await tempDir('lessons-curate-repo-state')
      const ctx = testContext(repoStateDir)
      await Bun.write(
        `${repoStateDir}/LESSONS.candidates.md`,
        [
          '# Lesson candidates',
          '',
          [
            '- 2026-07-01T00:00:00.000Z · blocked · task-a · [implementation]',
            'Prefer parser APIs for config edits.',
          ].join(' '),
          [
            '- 2026-07-01T00:01:00.000Z · blocked · task-b · [implementation]',
            'Prefer parser APIs for config edits.',
          ].join(' '),
          '',
        ].join('\n')
      )
      await mkdir(`${home}/sessions/session-a/tasks/task-a`, { recursive: true })
      await mkdir(`${home}/sessions/session-b/tasks/task-b`, { recursive: true })
      await Bun.write(
        `${home}/sessions/session-a/tasks/task-a/postmortem.md`,
        postmortem('Prefer parser APIs for config edits.')
      )
      await Bun.write(
        `${home}/sessions/session-b/tasks/task-b/postmortem.md`,
        postmortem('Prefer parser APIs for config edits.')
      )

      const plan = await planLessonCuration(ctx)

      expect(plan.promotions).toHaveLength(1)
      expect(plan.promotions[0]?.text).toBe('Prefer parser APIs for config edits.')
      expect(plan.promotions[0]?.capture.scope).toBe('repo')
      expect(plan.promotions[0]?.capture.stages).toEqual(['implement', 'fix'])
    })
  })

  test('apply writes guidance and drains the active queue into the archive', async () => {
    await withFactoryHome(async (home) => {
      const repoStateDir = await tempDir('lessons-curate-repo-state')
      const ctx = testContext(repoStateDir)
      await Bun.write(
        `${repoStateDir}/LESSONS.candidates.md`,
        [
          '# Lesson candidates',
          '',
          [
            '- 2026-07-01T00:00:00.000Z · blocked · task-a · [implementation]',
            'Prefer parser APIs for config edits.',
          ].join(' '),
          [
            '- 2026-07-01T00:01:00.000Z · blocked · task-b · [implementation]',
            'Prefer parser APIs for config edits.',
          ].join(' '),
          '',
        ].join('\n')
      )
      await mkdir(`${home}/sessions/session-a/tasks/task-a`, { recursive: true })
      await mkdir(`${home}/sessions/session-b/tasks/task-b`, { recursive: true })
      await Bun.write(
        `${home}/sessions/session-a/tasks/task-a/postmortem.md`,
        postmortem('Prefer parser APIs for config edits.')
      )
      await Bun.write(
        `${home}/sessions/session-b/tasks/task-b/postmortem.md`,
        postmortem('Prefer parser APIs for config edits.')
      )

      const plan = await planLessonCuration(ctx)
      const applied = await applyLessonCuration(ctx, plan)
      const stored = GuidanceRecordSchema.parse(
        await Bun.file(`${home}/guidance/items/${applied.created[0]?.id}.json`).json()
      )
      const queue = await Bun.file(`${repoStateDir}/LESSONS.candidates.md`).text()
      const archive = await Bun.file(`${repoStateDir}/LESSONS.candidates.archive.md`).text()

      expect(applied.created).toHaveLength(1)
      expect(stored.scope.kind).toBe('repo')
      expect(queue).not.toContain('Prefer parser APIs')
      expect(archive).toContain('Prefer parser APIs for config edits.')
    })
  })
})
