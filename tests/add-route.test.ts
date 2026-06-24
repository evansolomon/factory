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
  test('answers the latest needs-input task first', () => {
    expect(
      selectAddRoute(
        [
          task('blocked', { status: 'blocked', updatedAt: '2026-01-03T00:00:00.000Z' }),
          task('question', { status: 'needs-input', updatedAt: '2026-01-02T00:00:00.000Z' }),
        ],
        false
      )
    ).toEqual({ kind: 'answer', taskId: 'question', reason: 'task needs input' })
  })

  test('retries blocked and retrying tasks', () => {
    expect(selectAddRoute([task('blocked', { status: 'blocked' })], false)).toEqual({
      kind: 'retry',
      taskId: 'blocked',
      reason: 'task is blocked',
    })
  })

  test('queues a follow-up when stopped work already has a commit', () => {
    expect(
      selectAddRoute([task('ship-failed', { status: 'retrying', hasCommit: true })], false)
    ).toEqual({
      kind: 'follow-up',
      taskId: 'ship-failed',
      reason: 'task already has a commit',
      recordOnSource: true,
    })
  })

  test('routes ready tasks with progress to feedback', () => {
    expect(selectAddRoute([task('progress', { hasPlan: true })], false)).toEqual({
      kind: 'feedback',
      taskId: 'progress',
      reason: 'task has existing progress',
    })
  })

  test('queues a follow-up for a currently running task', () => {
    expect(selectAddRoute([task('running', { status: 'implementing' })], false)).toEqual({
      kind: 'follow-up',
      taskId: 'running',
      reason: 'task is currently implementing',
      recordOnSource: false,
    })
  })

  test('uses the latest plausible current task after needs-input', () => {
    expect(
      selectAddRoute(
        [
          task('blocked', { status: 'blocked', updatedAt: '2026-01-02T00:00:00.000Z' }),
          task('running', { status: 'implementing', updatedAt: '2026-01-03T00:00:00.000Z' }),
        ],
        false
      )
    ).toEqual({
      kind: 'follow-up',
      taskId: 'running',
      reason: 'task is currently implementing',
      recordOnSource: false,
    })
  })

  test('queues a recorded follow-up for completed work', () => {
    expect(selectAddRoute([task('done', { status: 'done', hasCommit: true })], false)).toEqual({
      kind: 'follow-up',
      taskId: 'done',
      reason: 'latest task is done',
      recordOnSource: true,
    })
  })

  test('creates a new task when there is no current work', () => {
    expect(selectAddRoute([], false)).toEqual({ kind: 'new-task' })
    expect(selectAddRoute([task('fresh')], false)).toEqual({ kind: 'new-task' })
  })
})
