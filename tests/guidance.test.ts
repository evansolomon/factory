import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Agent, Config, WorkContext } from '../src/config.ts'
import {
  applicableGuidance,
  createGuidanceRecord,
  deleteGuidance,
  editGuidance,
  findGuidance,
  type GuidanceRecord,
  GuidanceRecordSchema,
  GuidanceStageSchema,
  listGuidance,
  loadGuidance,
  renderGuidanceBlock,
  scopeForContext,
} from '../src/guidance.ts'

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(`${tmpdir()}/factory-${prefix}-`)
}

async function withFactoryHome<T>(work: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env['FACTORY_HOME']
  const home = await tempDir('guidance-home')
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

function testContext(repoStateDir: string, root = '/repo'): WorkContext {
  return {
    root,
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

function record(input: {
  id: string
  text: string
  stages?: GuidanceRecord['stages']
  scope?: GuidanceRecord['scope']
  status?: GuidanceRecord['status']
  updatedAt?: string
}): GuidanceRecord {
  const now = input.updatedAt ?? '2026-06-26T00:00:00.000Z'
  return GuidanceRecordSchema.parse({
    id: input.id,
    createdAt: '2026-06-25T00:00:00.000Z',
    updatedAt: now,
    source: { kind: 'manual', taskId: null, detail: null },
    scope: input.scope ?? { kind: 'global' },
    stages: input.stages ?? ['plan'],
    tags: [],
    text: input.text,
    rationale: null,
    status: input.status ?? 'active',
    deletedAt: input.status === 'deleted' ? now : null,
  })
}

async function writeRecord(home: string, value: GuidanceRecord): Promise<void> {
  const dir = `${home}/guidance/items`
  await mkdir(dir, { recursive: true })
  await Bun.write(`${dir}/${value.id}.json`, `${JSON.stringify(value, null, 2)}\n`)
}

describe('guidance storage', () => {
  test('stage schema accepts prototype', () => {
    expect(GuidanceStageSchema.safeParse('prototype').success).toBe(true)
  })

  test('missing guidance dir returns an empty list', async () => {
    await withFactoryHome(async () => {
      expect(await loadGuidance()).toEqual([])
    })
  })

  test('loads valid records and skips malformed records', async () => {
    await withFactoryHome(async (home) => {
      await writeRecord(home, record({ id: 'good', text: 'Prefer URL state.' }))
      await Bun.write(`${home}/guidance/items/bad.json`, '{"id": 1}')

      const records = await loadGuidance()

      expect(records.map((item) => item.id)).toEqual(['good'])
      expect(records[0]?.text).toBe('Prefer URL state.')
    })
  })

  test('createGuidanceRecord validates and writes one record file', async () => {
    await withFactoryHome(async (home) => {
      const ctx = testContext('/repo-state')
      const created = await createGuidanceRecord(ctx, {
        source: { kind: 'manual', taskId: null, detail: 'seed' },
        scope: scopeForContext(ctx, 'global'),
        stages: ['plan'],
        text: 'Keep marker contracts stable.',
      })

      expect(GuidanceRecordSchema.safeParse(created).success).toBe(true)
      expect(await readdir(`${home}/guidance/items`)).toEqual([`${created.id}.json`])
    })
  })
})

describe('guidance applicability', () => {
  test('global guidance applies everywhere and repo guidance only matches repoStateDir', () => {
    const ctx = testContext('/repo-a')
    const records = [
      record({ id: 'global', text: 'Global lesson.' }),
      record({
        id: 'repo-a',
        text: 'Repo A lesson.',
        scope: { kind: 'repo', repoStateDir: '/repo-a', repoRoot: '/repo/a' },
      }),
      record({
        id: 'repo-b',
        text: 'Repo B lesson.',
        scope: { kind: 'repo', repoStateDir: '/repo-b', repoRoot: '/repo/b' },
      }),
    ]

    expect(applicableGuidance(records, ctx, 'plan').map((item) => item.id)).toEqual([
      'global',
      'repo-a',
    ])
  })

  test('stage filtering includes matching stages and excludes others', () => {
    const ctx = testContext('/repo-a')
    const records = [
      record({ id: 'plan', text: 'Plan lesson.', stages: ['plan'] }),
      record({ id: 'review', text: 'Review lesson.', stages: ['review'] }),
    ]

    expect(applicableGuidance(records, ctx, 'review').map((item) => item.id)).toEqual(['review'])
  })

  test('deleted records are excluded unless requested', async () => {
    await withFactoryHome(async (home) => {
      const ctx = testContext('/repo-a')
      await writeRecord(home, record({ id: 'active', text: 'Active.' }))
      await writeRecord(home, record({ id: 'deleted', text: 'Deleted.', status: 'deleted' }))

      expect((await listGuidance(ctx)).map((item) => item.id)).toEqual(['active'])
      expect((await listGuidance(ctx, { includeDeleted: true })).map((item) => item.id)).toEqual([
        'active',
        'deleted',
      ])
    })
  })
})

describe('guidance lookup and mutation', () => {
  test('findGuidance handles exact, partial, ambiguous, and missing ids', async () => {
    await withFactoryHome(async (home) => {
      const ctx = testContext('/repo-a')
      await writeRecord(home, record({ id: 'abc111', text: 'First.' }))
      await writeRecord(home, record({ id: 'abc222', text: 'Second.' }))
      await writeRecord(home, record({ id: 'def333', text: 'Third.' }))

      expect(await findGuidance(ctx, 'def333')).toMatchObject({ record: { id: 'def333' } })
      expect(await findGuidance(ctx, 'def')).toMatchObject({ record: { id: 'def333' } })
      const ambiguous = await findGuidance(ctx, 'abc')
      expect(
        ambiguous && 'ambiguous' in ambiguous
          ? ambiguous.ambiguous.map((item) => item.id).sort()
          : []
      ).toEqual(['abc111', 'abc222'])
      expect(await findGuidance(ctx, 'missing')).toBeNull()
    })
  })

  test('deleteGuidance soft-deletes and preserves the file', async () => {
    await withFactoryHome(async (home) => {
      const ctx = testContext('/repo-a')
      await writeRecord(home, record({ id: 'abc111', text: 'First.' }))

      const result = await deleteGuidance(ctx, 'abc')

      expect(result).toMatchObject({ deleted: { id: 'abc111', status: 'deleted' } })
      expect(await Bun.file(`${home}/guidance/items/abc111.json`).exists()).toBe(true)
      expect((await listGuidance(ctx)).map((item) => item.id)).toEqual([])
      expect((await listGuidance(ctx, { includeDeleted: true }))[0]?.status).toBe('deleted')
    })
  })

  test('editGuidance updates text, scope, stages, and timestamp without changing id or source', async () => {
    await withFactoryHome(async (home) => {
      const ctx = testContext('/repo-a')
      await writeRecord(
        home,
        record({
          id: 'abc111',
          text: 'Old text.',
          updatedAt: '2026-01-01T00:00:00.000Z',
        })
      )

      const result = await editGuidance(ctx, 'abc111', {
        text: 'New text.',
        stages: ['plan', 'review'],
        scope: scopeForContext(ctx, 'repo'),
      })

      expect(result).toMatchObject({
        edited: {
          id: 'abc111',
          text: 'New text.',
          stages: ['plan', 'review'],
          scope: { kind: 'repo', repoStateDir: '/repo-a' },
          source: { kind: 'manual', taskId: null, detail: null },
        },
      })
      if (result && 'edited' in result) {
        expect(result.edited.updatedAt).not.toBe('2026-01-01T00:00:00.000Z')
      }
    })
  })
})

describe('guidance rendering', () => {
  test('render includes ids, scope labels, and text', () => {
    const block = renderGuidanceBlock([
      record({ id: 'abc123', text: 'Prefer URLs over local state.' }),
    ])

    expect(block).toContain('## Learned lessons')
    expect(block).toContain('[global abc123]')
    expect(block).toContain('Prefer URLs over local state.')
  })

  test('render deduplicates normalized text and caps records', () => {
    const records = Array.from({ length: 14 }, (_, index) =>
      record({
        id: `id${index}`,
        text: index === 13 ? 'Lesson 0' : `Lesson ${index}`,
        updatedAt: `2026-06-26T00:00:${String(index).padStart(2, '0')}.000Z`,
      })
    )

    const block = renderGuidanceBlock(records)
    const bullets = block?.split('\n').filter((line) => line.startsWith('- [')) ?? []

    expect(bullets).toHaveLength(12)
    expect(block).toContain('id13')
    expect(block).not.toContain('id0')
  })
})

import { guidanceSimilarity, recordGuidanceOutcome } from '../src/guidance.ts'

describe('guidance scoring and dedup', () => {
  test('similarity is high for near-duplicate lessons and low for unrelated ones', () => {
    const a = 'When tapioca RBI regeneration is OOM-killed, re-run with --no-regen'
    const b = 'If tapioca RBI regen gets OOM killed, rerun using the --no-regen flag'
    const c = 'Always preload associations to avoid N+1 queries in serializers'
    expect(guidanceSimilarity(a, b)).toBeGreaterThan(0.5)
    expect(guidanceSimilarity(a, c)).toBeLessThan(0.2)
    expect(guidanceSimilarity('', 'anything')).toBe(0)
  })

  test('recordGuidanceOutcome accumulates and retires sustained losers', async () => {
    await withFactoryHome(async () => {
      const ctx = testContext(await tempDir('guidance-score'))
      const record = await createGuidanceRecord(ctx, {
        source: { kind: 'postmortem', taskId: null, detail: null },
        scope: { kind: 'global' },
        stages: ['fix'],
        text: 'A lesson that keeps failing',
      })
      for (let i = 0; i < 8; i++) {
        await recordGuidanceOutcome([record.id], 'blocked')
      }
      const after = (await loadGuidance()).find((r) => r.id === record.id)
      expect(after?.applied).toBe(8)
      expect(after?.losses).toBe(8)
      expect(after?.status).toBe('retired')
    })
  })
})
