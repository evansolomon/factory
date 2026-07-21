import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { addBacklog, loadBacklog, removeBacklog } from '../src/backlog.ts'
import type { Config, RepoContext, RoleAgents, WorkContext } from '../src/config.ts'
import {
  addTask,
  answeredQuestionRounds,
  appendFeedback,
  latestAnswerValue,
  latestAnswerValueAfter,
  loadTasks,
  markFeedbackConsumed,
  matchAnsweredQuestion,
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
  workforce: true,
  rescue: true,
  autoAcceptAfterMinutes: null,
  implementerAccess: 'write',
  autoShip: null,
  dispatch: null,
  specialists: {},
  hooks: {},
  agents: {
    planners: ['codex', 'claude'],
    implementer: 'codex',
    reviewer: 'claude',
    delivery: 'claude',
    workforce: 'claude',
    rescue: 'claude',
    researchers: {},
    reviewers: {},
    implementers: {},
    namer: { cli: 'codex', model: 'gpt-5.4-mini', reasoningEffort: 'low' },
  },
  ask: { agent: 'claude' },
}

const agents: RoleAgents = {
  planners: [{ cli: 'codex' }, { cli: 'claude' }],
  implementer: { cli: 'codex' },
  reviewer: { cli: 'claude' },
  delivery: { cli: 'claude' },
  namer: { cli: 'codex', model: 'gpt-5.4-mini', reasoningEffort: 'low' },
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
    envPlaybookPath: `${stateDir}/env/test-host.md`,
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
  test('legacy queues run the oldest live runnable task first', async () => {
    // There is at most one live task per worktree now; a legacy multi-task
    // queue drains deterministically oldest-first, with no category priority.
    const ctx = await workContext()
    const retry = await addTask(ctx, 'Retry later', null)
    retry.meta.status = 'retrying'
    retry.meta.retryAt = new Date(1_000).toISOString()
    retry.meta.createdAt = '2026-01-01T00:00:00.000Z'
    await saveTask(retry)
    const ready = await addTask(ctx, 'Ready now', null)
    ready.meta.createdAt = '2026-01-02T00:00:00.000Z'
    await saveTask(ready)

    const next = await nextRunnable(ctx, 2_000)

    expect(next?.id).toBe(retry.id)
    expect(next?.meta.resumeKind).toBe('auto-retry')
  })

  test('a retry still on backoff does not block a newer ready task', async () => {
    const ctx = await workContext()
    const retry = await addTask(ctx, 'Retry later', null)
    retry.meta.status = 'retrying'
    retry.meta.retryAt = new Date(10_000).toISOString()
    retry.meta.createdAt = '2026-01-01T00:00:00.000Z'
    await saveTask(retry)
    const ready = await addTask(ctx, 'Ready now', null)
    ready.meta.createdAt = '2026-01-02T00:00:00.000Z'
    await saveTask(ready)

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

  test('legacy grilling tasks are reclaimed instead of fossilizing', async () => {
    // 'grilling' used to be a settled status the loop never picked up and never
    // reclaimed — real tasks froze there forever. It now recovers like an
    // interrupted sharpening stage.
    const ctx = await workContext()
    const task = await addTask(ctx, 'Still grilling', null, { status: 'grilling' })

    const next = await nextRunnable(ctx, 2_000)

    expect(next?.id).toBe(task.id)
    expect(next?.meta.status).toBe('ready')
    expect(next?.meta.resume).toBe(false)
    expect(next?.meta.note).toContain('recovered after interrupted grilling stage')
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
    expect(task?.meta.strategyEpoch).toBe(0)
    expect(task?.meta.strategyBudget).toBeNull()
    expect(task?.meta.executionOverride).toBeNull()
    expect(task?.meta.complexity).toBeNull()
    expect(task?.meta.implementer).toBeNull()
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

  test('round-trips the triage-chosen implementer pool name', async () => {
    const ctx = await workContext()
    const added = await addTask(ctx, 'Fix typo', null)

    expect(added.meta.implementer).toBeNull()

    added.meta.implementer = 'quick'
    await saveMeta(added)

    const task = (await loadTasks(ctx)).find((t) => t.id === added.id)

    expect(task?.meta.implementer).toBe('quick')
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

  test('latestAnswerValue reads the latest raw answer body', () => {
    const answers = [
      '## Answer (2026-01-01T00:00:00.000Z)',
      'Use the first option.',
      '',
      '## Answer (2026-01-02T00:00:00.000Z)',
      'Use the second option.',
    ].join('\n')

    expect(latestAnswerValue(answers)).toBe('Use the second option.')
  })

  test('latestAnswerValue extracts the final formatted answer value', () => {
    const answers = [
      '## Answer (2026-01-01T00:00:00.000Z)',
      'Q: Which delivery?',
      'Recommended: $pr',
      'A: none',
      '',
      '## Answer (2026-01-02T00:00:00.000Z)',
      'Q: Run delivery?',
      'Recommended: $ship',
      'A: $ship',
    ].join('\n')

    expect(latestAnswerValue(answers)).toBe('$ship')
  })

  test('latestAnswerValueAfter ignores answers before the boundary', () => {
    const answers = [
      '## Answer (2026-01-01T00:00:00.000Z)',
      'Q: Earlier clarification?',
      'Recommended: $ship',
      'A: $ship',
      '',
      '## Answer (2026-01-01T00:00:02.000Z)',
      'Q: Confirm delivery?',
      'Recommended: $ship',
      'A: none',
    ].join('\n')

    expect(latestAnswerValueAfter(answers, '2026-01-01T00:00:01.000Z')).toBe('none')
    expect(latestAnswerValueAfter(answers, '2026-01-01T00:00:02.000Z')).toBeNull()
    expect(latestAnswerValueAfter(answers, null)).toBeNull()
  })

  test('latestAnswerValue returns null for missing or blank answers', () => {
    expect(latestAnswerValue('')).toBeNull()
    expect(latestAnswerValue('## Answer (2026-01-01T00:00:00.000Z)\n')).toBeNull()
  })

  test('task delivery proposal survives status writes before confirmation', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Confirm ship', null)
    task.meta.deliveryProposal = {
      mode: 'skill',
      skill: 'ship',
      source: 'selected',
      confidence: 'high',
      reason: 'Similar tasks shipped.',
    }
    task.meta.deliveryProposalAt = '2026-01-01T00:00:00.000Z'
    await saveTask(task)

    await setStatus(task, 'needs-input')

    const latest = (await loadTasks(ctx)).find((t) => t.id === task.id)
    expect(latest?.meta.delivery).toEqual({ mode: 'pending' })
    expect(latest?.meta.deliveryProposal).toEqual({
      mode: 'skill',
      skill: 'ship',
      source: 'selected',
      confidence: 'high',
      reason: 'Similar tasks shipped.',
    })
    expect(latest?.meta.deliveryProposalAt).toBe('2026-01-01T00:00:00.000Z')
  })

  test('manual delivery clears a pending proposal', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Confirm ship', null)
    task.meta.deliveryProposal = {
      mode: 'skill',
      skill: 'ship',
      source: 'selected',
      confidence: 'high',
      reason: 'Similar tasks shipped.',
    }
    task.meta.deliveryProposalAt = '2026-01-01T00:00:00.000Z'
    await saveTask(task)

    await setTaskDelivery(task, {
      mode: 'none',
      source: 'manual',
      confidence: 'high',
      reason: 'User manually disabled delivery.',
    })

    const latest = (await loadTasks(ctx)).find((t) => t.id === task.id)
    expect(latest?.meta.deliveryProposal).toBeUndefined()
    expect(latest?.meta.deliveryProposalAt).toBeNull()
    expect(latest?.meta.delivery).toEqual({
      mode: 'none',
      source: 'manual',
      confidence: 'high',
      reason: 'User manually disabled delivery.',
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

describe('phase-0 measurement contracts', () => {
  test('addTask preserves the raw intent and sharpening never destroys it', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Original raw intent', null)

    expect(await readArtifact(task, 'task.original.md')).toBe('Original raw intent')

    const { readySharpenedTask, readIntent } = await import('../src/task.ts')
    await readySharpenedTask(task, 'Refined spec', 'bun test')

    expect(await readIntent(task)).toBe('Refined spec')
    expect(await readArtifact(task, 'task.original.md')).toBe('Original raw intent')
  })

  test('readySharpenedTask backfills task.original.md for pre-existing tasks', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Legacy intent', null)
    const { rm } = await import('node:fs/promises')
    await rm(`${task.dir}/task.original.md`)

    const { readySharpenedTask } = await import('../src/task.ts')
    await readySharpenedTask(task, 'Refined spec', null)

    expect(await readArtifact(task, 'task.original.md')).toBe('Legacy intent')
  })

  test('appendFailure stamps a timestamp and legacy lines still parse', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Failing task', null)
    const { appendFailure } = await import('../src/task.ts')
    // Legacy line without `at`
    await writeArtifact(
      task,
      'failures.jsonl',
      `${JSON.stringify({ attempt: 0, gate: 'verify', summary: 'old', detail: 'old' })}\n`
    )
    await appendFailure(task, {
      attempt: 1,
      strategyEpoch: 0,
      gate: 'review',
      summary: 'new',
      detail: 'new',
      remediation: 'code-fix',
    })

    const failures = await readFailures(task)
    expect(failures).toHaveLength(2)
    expect(failures[0]?.at).toBeUndefined()
    expect(failures[0]?.strategyEpoch).toBe(0)
    expect(typeof failures[1]?.at).toBe('string')
  })

  test('appendPassMeter accumulates passes and dedupes by startedAt', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Metered task', null)
    const { appendPassMeter, readPassMeters } = await import('../src/task.ts')
    const pass = (startedAt: string, inputTokens: number) => ({
      startedAt,
      updatedAt: startedAt,
      inputTokens,
      outputTokens: 1,
      stages: [],
    })

    await appendPassMeter(task, pass('2026-07-01T00:00:00Z', 100), 'retrying')
    await appendPassMeter(task, pass('2026-07-01T01:00:00Z', 200), 'done')
    // Same pass swept again as interrupted → no-op
    await appendPassMeter(task, pass('2026-07-01T01:00:00Z', 999), 'interrupted')

    const meters = await readPassMeters(task)
    expect(meters).toHaveLength(2)
    expect(meters.map((m) => m.outcome)).toEqual(['retrying', 'done'])
    expect(meters[1]?.inputTokens).toBe(200)
  })

  test('rollArtifactHistory preserves superseded artifact content', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'History task', null)
    const { rollArtifactHistory } = await import('../src/task.ts')

    await rollArtifactHistory(task, 'questions.md') // no file yet → no-op
    expect(await readArtifact(task, 'questions.history.md')).toBeNull()

    await writeArtifact(task, 'questions.md', 'Round 1 questions')
    await rollArtifactHistory(task, 'questions.md')
    await writeArtifact(task, 'questions.md', 'Round 2 questions')
    await rollArtifactHistory(task, 'questions.md')
    await writeArtifact(task, 'questions.md', 'Round 3 questions')

    const history = await readArtifact(task, 'questions.history.md')
    expect(history).toContain('Round 1 questions')
    expect(history).toContain('Round 2 questions')
    expect(history).not.toContain('Round 3 questions')
    expect(await readArtifact(task, 'questions.md')).toBe('Round 3 questions')
  })
})

describe('answered question rounds', () => {
  // Mirrors a real incident: the converge judge asked the same security question
  // three times, reworded, after the human had answered it twice.
  const HISTORY = [
    '--- questions.md (superseded 2026-07-02T06:53:22.614Z) ---',
    'Should we re-key all read flags onto the host?',
    '  Recommended: Yes — key all three flag checks on the host.',
    '',
    '--- questions.md (superseded 2026-07-02T07:12:03.501Z) ---',
    'Factory needs human input before it can continue:',
    '',
    'Should inbound sync persist Google Calendar slot edits only after we switch to a per-host/app-mediated edit source that can prove the editor is the slot host, or should this task disable inbound persistence for the shared office_hours calendar?',
  ].join('\n')
  const CURRENT = [
    'Factory needs human input before it can continue:',
    '',
    'Should inbound sync persist Google Calendar slot edits only after we can prove the editor is authorized for that slot, or should inbound persistence remain disabled for the shared office_hours calendar?',
  ].join('\n')
  const ANSWERS = [
    '## Answer (2026-07-02T04:03:21.165Z)',
    'Yes — key all three flag checks on the host.',
    '',
    '## Answer (2026-07-02T06:55:01.620Z)',
    'We do want to sync inbound changes. Try to do it in the safest way possible. If there are unavoidable risks, call them out in the commit message and MR description.',
    '',
    '## Answer (2026-07-02T07:13:51.355Z)',
    'go with your best idea',
  ].join('\n')

  test('pairs each answer with the round it responded to', () => {
    const rounds = answeredQuestionRounds(HISTORY, CURRENT, ANSWERS)
    expect(rounds).toHaveLength(3)
    expect(rounds[0]?.question).toContain('re-key all read flags')
    expect(rounds[0]?.answer).toContain('key all three flag checks')
    expect(rounds[1]?.question).toContain('per-host/app-mediated edit source')
    expect(rounds[1]?.answer).toContain('sync inbound changes')
    expect(rounds[2]?.question).toContain('authorized for that slot')
    expect(rounds[2]?.answer).toBe('go with your best idea')
  })

  test('a reworded variant of an answered question matches', () => {
    const rounds = answeredQuestionRounds(HISTORY, CURRENT, ANSWERS)
    const reasked =
      'Factory needs human input before it can continue:\n\n' +
      'Should inbound sync persist Google Calendar slot edits only after verified host attribution/audit-log authorization exists, or should inbound persistence be disabled for the shared office_hours calendar?'
    const match = matchAnsweredQuestion(rounds, reasked)
    // Best-similarity wins: either inbound-sync round is a legitimate standing
    // answer; the unrelated flag-keying round must not be the match.
    expect(match).not.toBeNull()
    expect(match?.question).toContain('inbound sync persist')
  })

  test('an unrelated question does not match', () => {
    const rounds = answeredQuestionRounds(HISTORY, CURRENT, ANSWERS)
    const unrelated =
      'Factory needs human input before it can continue:\n\n' +
      'Which Postgres version should the new analytics warehouse target, and do we need a read replica?'
    expect(matchAnsweredQuestion(rounds, unrelated)).toBeNull()
  })

  test('no answers means no rounds', () => {
    expect(answeredQuestionRounds(HISTORY, CURRENT, null)).toEqual([])
    expect(matchAnsweredQuestion([], 'anything at all?')).toBeNull()
  })

  test('an answer with no open round is dropped', () => {
    const rounds = answeredQuestionRounds(null, null, ANSWERS)
    expect(rounds).toEqual([])
  })
})
