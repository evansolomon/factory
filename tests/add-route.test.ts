import { describe, expect, test } from 'bun:test'
import { type AddRouteTask, selectAddRoute } from '../src/add-route.ts'

function task(id: string, overrides: Partial<AddRouteTask> = {}): AddRouteTask {
  return {
    id,
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: null,
    hasPlan: false,
    hasCommit: false,
    pendingFeedback: false,
    ...overrides,
  }
}

describe('selectAddRoute', () => {
  test('answers the live needs-input task', () => {
    // The second live task is a legacy-queue leftover; the latest-touched live
    // task is the lane's task.
    expect(
      selectAddRoute(
        [
          task('blocked', { status: 'blocked', updatedAt: '2026-01-02T00:00:00.000Z' }),
          task('question', { status: 'needs-input', updatedAt: '2026-01-03T00:00:00.000Z' }),
        ],
        false,
        false
      )
    ).toEqual({ kind: 'answer', taskId: 'question', reason: 'task needs input' })
  })

  test('retries blocked and retrying tasks', () => {
    expect(selectAddRoute([task('blocked', { status: 'blocked' })], false, false)).toEqual({
      kind: 'retry',
      taskId: 'blocked',
      reason: 'task is blocked',
    })
  })

  test('queues a follow-up when stopped work already has a commit', () => {
    expect(
      selectAddRoute([task('ship-failed', { status: 'retrying', hasCommit: true })], false, false)
    ).toEqual({
      kind: 'follow-up',
      taskId: 'ship-failed',
      reason: 'task already has a commit',
      recordOnSource: true,
    })
  })

  test('routes ready tasks with progress to feedback', () => {
    expect(selectAddRoute([task('progress', { hasPlan: true })], false, false)).toEqual({
      kind: 'feedback',
      taskId: 'progress',
      reason: 'task has existing progress',
    })
  })

  test('records live feedback when a run loop is actively working the task', () => {
    expect(selectAddRoute([task('running', { status: 'implementing' })], false, true)).toEqual({
      kind: 'feedback-live',
      taskId: 'running',
      reason: 'a run loop is actively working this task (implementing)',
    })
  })

  test('retries a task abandoned mid-stage when no loop is running', () => {
    expect(selectAddRoute([task('running', { status: 'implementing' })], false, false)).toEqual({
      kind: 'retry',
      taskId: 'running',
      reason: 'task was interrupted during implementing',
    })
  })

  test('uses the latest plausible current task after needs-input', () => {
    expect(
      selectAddRoute(
        [
          task('blocked', { status: 'blocked', updatedAt: '2026-01-02T00:00:00.000Z' }),
          task('running', { status: 'implementing', updatedAt: '2026-01-03T00:00:00.000Z' }),
        ],
        false,
        false
      )
    ).toEqual({
      kind: 'retry',
      taskId: 'running',
      reason: 'task was interrupted during implementing',
    })
  })

  test('queues a recorded follow-up for completed work', () => {
    expect(
      selectAddRoute([task('done', { status: 'done', hasCommit: true })], false, false)
    ).toEqual({
      kind: 'follow-up',
      taskId: 'done',
      reason: 'latest task is done',
      recordOnSource: true,
    })
  })

  test('creates a new task when there is no current work', () => {
    expect(selectAddRoute([], false, false)).toEqual({ kind: 'new-task' })
    expect(selectAddRoute([task('fresh')], false, false)).toEqual({ kind: 'new-task' })
  })
})
