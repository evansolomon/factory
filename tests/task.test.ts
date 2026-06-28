import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { addBacklog, loadBacklog, removeBacklog } from '../src/backlog.ts'
import type { Config, RepoContext, RoleAgents, WorkContext } from '../src/config.ts'
import {
  addTask,
  appendFeedback,
  loadTasks,
  markFeedbackConsumed,
  nextRunnable,
  pendingFeedbackCount,
  readArtifact,
  readFailures,
  readFeedback,
  readPendingFeedback,
  refreshFeedbackState,
  saveMeta,
  setStatus,
  setTaskDelivery,
  type Task,
  writeArtifact,
} from '../src/task.ts'

const config: Config = {
  retries: 10,
  triage: true,
  security: true,
  ux: true,
  plansDir: null,
  captureEvals: false,
  postmortem: false,
  remediate: true,
  hooks: {},
  agents: {
    planners: ['codex', 'claude'],
    implementer: 'codex',
    reviewer: 'claude',
    delivery: 'claude',
    namer: { cli: 'codex', model: 'gpt-5-nano' },
  },
  ask: { agent: 'claude' },
}

const agents: RoleAgents = {
  planners: [{ cli: 'codex' }, { cli: 'claude' }],
  implementer: { cli: 'codex' },
  reviewer: { cli: 'claude' },
  delivery: { cli: 'claude' },
  namer: { cli: 'codex', model: 'gpt-5-nano' },
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
    askAgent: { cli: 'claude' },
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

  test('uses a sanitized suggested slug for new task ids', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Can we make the task names better?', null, {
      suggestedSlug: 'Improve Task Names!!!',
    })

    expect(task.id).toBe('improve-task-names')
    expect(task.meta.slug).toBe('improve-task-names')
    expect(await Bun.file(`${task.dir}/task.md`).text()).toBe(
      'Can we make the task names better?\n'
    )
  })

  test('falls back to the intent when the suggested slug is empty', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Fix upload retry behavior', null, {
      suggestedSlug: '!!!',
    })

    expect(task.id).toBe('fix-upload-retry-behavior')
    expect(task.meta.slug).toBe('fix-upload-retry-behavior')
  })

  test('stranded planning tasks restart planning instead of resuming work', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Plan from scratch', null, { status: 'planning' })

    const next = await nextRunnable(ctx, 2_000)

    expect(next?.id).toBe(task.id)
    expect(next?.meta.status).toBe('ready')
    expect(next?.meta.resume).toBe(false)
    expect(next?.meta.resumeKind).toBeNull()
    expect(next?.meta.note).toContain('recovered after interrupted planning stage')
  })

  test('stranded planning tasks resume when a selected plan exists', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Prototype after planning', null, { status: 'planning' })
    await writeArtifact(task, 'plan.md', 'Use the saved plan.')

    const next = await nextRunnable(ctx, 2_000)

    expect(next?.id).toBe(task.id)
    expect(next?.meta.status).toBe('ready')
    expect(next?.meta.resume).toBe(true)
    expect(next?.meta.resumeKind).toBe('stranded')
    expect(next?.meta.resumeNote).toContain('interrupted planning stage')
  })

  test('stranded later-stage tasks resume from saved artifacts', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Resume review', null, { status: 'reviewing' })

    const next = await nextRunnable(ctx, 2_000)

    expect(next?.id).toBe(task.id)
    expect(next?.meta.status).toBe('ready')
    expect(next?.meta.resume).toBe(true)
    expect(next?.meta.resumeKind).toBe('stranded')
    expect(next?.meta.resumeNote).toContain('interrupted reviewing stage')
  })

  test('interrupted sharpening tasks restart the sharpen stage', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Still sharpening', null, {
      status: 'sharpening',
      sharpen: 'pending',
    })

    const next = await nextRunnable(ctx, 2_000)

    expect(next?.id).toBe(task.id)
    expect(next?.meta.status).toBe('ready')
    expect(next?.meta.sharpen).toBe('pending')
    expect(next?.meta.resume).toBe(false)
    expect(next?.meta.note).toContain('recovered after interrupted sharpening stage')
  })

  test('legacy interactive grilling tasks are not reclaimed as stranded work', async () => {
    const ctx = await workContext()
    await addTask(ctx, 'Still grilling', null, { status: 'grilling' })

    expect(await nextRunnable(ctx, 2_000)).toBeNull()
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
    expect(task?.meta.sharpen).toBe('done')
    expect(task?.meta.resume).toBe(false)
    expect(task?.meta.resumeKind).toBeNull()
    expect(task?.meta.autoRetries).toBe(0)
    expect(task?.meta.complexity).toBeNull()
    expect(task?.meta.delivery).toEqual({ mode: 'pending' })
    expect(task?.meta.feedbackCount).toBe(0)
    expect(task?.meta.feedbackConsumed).toBe(0)
    expect(task?.meta.feedbackSourceTaskId).toBeNull()
  })

  test('legacy failure records count as code-fix failures', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Legacy failure', null)
    const legacyFailure = {
      attempt: 0,
      gate: 'review',
      summary: 'old failure',
      detail: 'old detail',
    }
    await Bun.write(`${task.dir}/failures.jsonl`, `${JSON.stringify(legacyFailure)}\n`)

    const failures = await readFailures(task)

    expect(failures[0]?.remediation).toBe('code-fix')
  })

  test('persists declared trivial task complexity', async () => {
    const ctx = await workContext()
    const added = await addTask(ctx, 'Fix typo', null, { complexity: 'trivial' })

    const task = (await loadTasks(ctx)).find((t) => t.id === added.id)

    expect(task?.meta.complexity).toBe('trivial')
  })

  test('persists declared complex task complexity', async () => {
    const ctx = await workContext()
    const added = await addTask(ctx, 'Refactor parser', null, { complexity: 'complex' })

    const task = (await loadTasks(ctx)).find((t) => t.id === added.id)

    expect(task?.meta.complexity).toBe('complex')
  })

  test('parallel adds with the same slug claim distinct task ids', async () => {
    const ctx = await workContext()

    const tasks = await Promise.all([
      addTask(ctx, 'Same task', null, { sharpen: 'pending' }),
      addTask(ctx, 'Same task', null, { sharpen: 'pending' }),
      addTask(ctx, 'Same task', null, { sharpen: 'pending' }),
    ])

    expect(tasks.map((t) => t.id).sort()).toEqual(['same-task', 'same-task-2', 'same-task-3'])
    expect(tasks.every((t) => t.meta.sharpen === 'pending')).toBe(true)
  })

  test('readArtifact trims existing artifacts and returns null for missing files', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Read artifact', null)

    expect(await readArtifact(task, 'feedback.md')).toBeNull()

    await writeArtifact(task, 'feedback.md', '\n\n## Summary\nDone.\n\n')

    expect(await readArtifact(task, 'feedback.md')).toBe('## Summary\nDone.')
  })

  test('appendFeedback writes feedback and increments count', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Improve layout', null)

    await appendFeedback(task, 'The button wraps on mobile.')

    expect(task.meta.feedbackCount).toBe(1)
    expect(task.meta.feedbackConsumed).toBe(0)
    expect(await readFeedback(task)).toContain('The button wraps on mobile.')
  })

  test('pending feedback count drops after markFeedbackConsumed', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Improve layout', null)
    await appendFeedback(task, 'First note.')
    await appendFeedback(task, 'Second note.')

    markFeedbackConsumed(task, 1)

    expect(pendingFeedbackCount(task)).toBe(1)
    expect(await readPendingFeedback(task)).toContain('Second note.')
    expect(await readPendingFeedback(task)).not.toContain('First note.')
  })

  test('new feedback after consumption is the only pending feedback read', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Improve layout', null)
    await appendFeedback(task, 'Old note.')
    markFeedbackConsumed(task, task.meta.feedbackCount)
    await appendFeedback(task, 'New note.')

    const pending = await readPendingFeedback(task)

    expect(pending).toContain('New note.')
    expect(pending).not.toContain('Old note.')
  })

  test('refreshFeedbackState preserves feedback appended by another task object', async () => {
    const ctx = await workContext()
    const stale = await addTask(ctx, 'Improve layout', null)
    await appendFeedback(stale, 'Analyzed note.')
    const latest = (await loadTasks(ctx)).find((t) => t.id === stale.id)
    if (!latest) {
      throw new Error('expected task to reload')
    }
    await appendFeedback(latest, 'Later note.')

    await refreshFeedbackState(stale)
    markFeedbackConsumed(stale, 1)

    expect(stale.meta.feedbackCount).toBe(2)
    expect(stale.meta.feedbackConsumed).toBe(1)
    expect(pendingFeedbackCount(stale)).toBe(1)
  })

  test('addTask persists feedback source backlink', async () => {
    const ctx = await workContext()
    const added = await addTask(ctx, 'Address feedback on source', null, {
      feedbackSourceTaskId: 'source-task',
    })

    const task = (await loadTasks(ctx)).find((t) => t.id === added.id)

    expect(task?.meta.feedbackSourceTaskId).toBe('source-task')
  })

  test('task delivery choice survives status writes from a stale task object', async () => {
    const ctx = await workContext()
    const stale = await addTask(ctx, 'Make PR only', null)
    const latest = (await loadTasks(ctx)).find((t) => t.id === stale.id)
    if (!latest) {
      throw new Error('expected task to reload')
    }

    await setTaskDelivery(latest, {
      mode: 'policy',
      policy: 'Make a PR and do not merge',
      source: 'manual',
      confidence: 'high',
      reason: 'Manual policy.',
    })
    await setStatus(stale, 'reviewing')

    const task = (await loadTasks(ctx)).find((t) => t.id === stale.id)
    expect(task?.meta.status).toBe('reviewing')
    expect(task?.meta.delivery).toEqual({
      mode: 'policy',
      policy: 'Make a PR and do not merge',
      source: 'manual',
      confidence: 'high',
      reason: 'Manual policy.',
    })
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
