import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { addBacklog, loadBacklog, removeBacklog } from '../src/backlog.ts'
import type { Config, RepoContext, RoleAgents, WorkContext } from '../src/config.ts'
import { addTask, loadTasks, nextRunnable, saveMeta, type Task } from '../src/task.ts'

const config: Config = {
  retries: 10,
  triage: true,
  security: true,
  ux: true,
  plansDir: null,
  captureEvals: false,
  postmortem: false,
  remediate: true,
  onComplete: null,
  hooks: {},
  agents: {
    planners: ['codex', 'claude'],
    implementer: 'codex',
    reviewer: 'claude',
    delivery: 'claude',
  },
}

const agents: RoleAgents = {
  planners: [{ cli: 'codex' }, { cli: 'claude' }],
  implementer: { cli: 'codex' },
  reviewer: { cli: 'claude' },
  delivery: { cli: 'claude' },
}

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(`${tmpdir()}/factory-${prefix}-`)
}

async function workContext(): Promise<WorkContext> {
  const root = await tempDir('work')
  const stateDir = `${root}/state`
  return {
    root,
    config,
    stateDir,
    tasksDir: `${stateDir}/tasks`,
    plansDir: null,
    agents,
    repoStateDir: stateDir,
    metricsPath: `${stateDir}/metrics.db`,
  }
}

function repoContext(root: string): RepoContext {
  const stateDir = `${root}/state`
  return {
    mainRoot: root,
    config,
    backlogDir: `${stateDir}/backlog`,
    metricsPath: `${stateDir}/metrics.db`,
    agents,
  }
}

async function saveTask(task: Task): Promise<void> {
  await saveMeta(task)
}

describe('task state transitions', () => {
  test('ready tasks take priority over due retries', async () => {
    const ctx = await workContext()
    const retry = await addTask(ctx, 'Retry later', null)
    retry.meta.status = 'retrying'
    retry.meta.retryAt = new Date(1_000).toISOString()
    await saveTask(retry)
    const ready = await addTask(ctx, 'Ready now', null)

    const next = await nextRunnable(ctx, 2_000)

    expect(next?.id).toBe(ready.id)
    expect(next?.meta.status).toBe('ready')
  })

  test('stranded planning tasks restart planning instead of resuming work', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Plan from scratch', null, 'planning')

    const next = await nextRunnable(ctx, 2_000)

    expect(next?.id).toBe(task.id)
    expect(next?.meta.status).toBe('ready')
    expect(next?.meta.resume).toBe(false)
    expect(next?.meta.resumeKind).toBeNull()
    expect(next?.meta.note).toContain('recovered after interrupted planning stage')
  })

  test('stranded later-stage tasks resume from saved artifacts', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Resume review', null, 'reviewing')

    const next = await nextRunnable(ctx, 2_000)

    expect(next?.id).toBe(task.id)
    expect(next?.meta.status).toBe('ready')
    expect(next?.meta.resume).toBe(true)
    expect(next?.meta.resumeKind).toBe('stranded')
    expect(next?.meta.resumeNote).toContain('interrupted reviewing stage')
  })

  test('due retries resume as auto-retry', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Retry now', null)
    task.meta.status = 'retrying'
    task.meta.retryAt = new Date(1_000).toISOString()
    await saveTask(task)

    const next = await nextRunnable(ctx, 2_000)

    expect(next?.id).toBe(task.id)
    expect(next?.meta.status).toBe('ready')
    expect(next?.meta.resume).toBe(true)
    expect(next?.meta.resumeKind).toBe('auto-retry')
    expect(next?.meta.retryAt).toBeNull()
  })

  test('legacy task metadata receives defaults', async () => {
    const ctx = await workContext()
    const dir = `${ctx.tasksDir}/legacy`
    await mkdir(dir, { recursive: true })
    const legacyMeta = {
      id: 'legacy',
      slug: 'legacy',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    await Bun.write(`${dir}/meta.json`, `${JSON.stringify(legacyMeta, null, 2)}\n`)

    const tasks = await loadTasks(ctx)
    const task = tasks[0]

    expect(task?.meta.status).toBe('ready')
    expect(task?.meta.verify).toBeNull()
    expect(task?.meta.resume).toBe(false)
    expect(task?.meta.resumeKind).toBeNull()
    expect(task?.meta.autoRetries).toBe(0)
  })
})

describe('backlog removal', () => {
  test('removes an exact match', async () => {
    const ctx = repoContext(await tempDir('backlog'))
    const entry = await addBacklog(ctx, 'Exact task', null)

    const result = await removeBacklog(ctx, entry.id)

    if (!result || 'ambiguous' in result) {
      throw new Error('expected an exact removal')
    }
    expect(result.removed.id).toBe(entry.id)
    expect(await loadBacklog(ctx)).toEqual([])
  })

  test('removes a single partial match', async () => {
    const ctx = repoContext(await tempDir('backlog'))
    const entry = await addBacklog(ctx, 'Partial alpha', null)
    await addBacklog(ctx, 'Different beta', null)

    const result = await removeBacklog(ctx, 'alpha')

    if (!result || 'ambiguous' in result) {
      throw new Error('expected one partial removal')
    }
    expect(result.removed.id).toBe(entry.id)
    expect((await loadBacklog(ctx)).map((remaining) => remaining.id)).toEqual(['different-beta'])
  })

  test('does not remove ambiguous partial matches', async () => {
    const ctx = repoContext(await tempDir('backlog'))
    await addBacklog(ctx, 'Ambiguous alpha', null)
    await addBacklog(ctx, 'Ambiguous beta', null)

    const result = await removeBacklog(ctx, 'ambiguous')

    if (!result || !('ambiguous' in result)) {
      throw new Error('expected ambiguous matches')
    }
    expect(result.ambiguous.map((entry) => entry.id)).toEqual(['ambiguous-alpha', 'ambiguous-beta'])
    expect((await loadBacklog(ctx)).map((entry) => entry.id)).toEqual([
      'ambiguous-alpha',
      'ambiguous-beta',
    ])
  })

  test('returns null when no backlog entry matches', async () => {
    const ctx = repoContext(await tempDir('backlog'))
    await addBacklog(ctx, 'Existing task', null)

    expect(await removeBacklog(ctx, 'missing')).toBeNull()
  })
})
