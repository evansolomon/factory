import { isStranded, isTerminal, type Status } from './task.ts'

export type AddRouteTask = {
  id: string
  status: Status
  createdAt: string
  updatedAt: string | null
  hasPlan: boolean
  hasCommit: boolean
  pendingFeedback: boolean
}

export type AddRoute =
  | { kind: 'answer'; taskId: string; reason: string }
  | { kind: 'retry'; taskId: string; reason: string }
  | { kind: 'feedback'; taskId: string; reason: string }
  // Record feedback on a task a live run loop is working RIGHT NOW: append
  // only, no requeue — the loop consumes it on its next pass.
  | { kind: 'feedback-live'; taskId: string; reason: string }
  | { kind: 'follow-up'; taskId: string; reason: string; recordOnSource: boolean }
  | { kind: 'new-task' }

function latest(tasks: AddRouteTask[]): AddRouteTask | null {
  if (tasks.length === 0) {
    return null
  }
  const stamp = (task: AddRouteTask) => task.updatedAt ?? task.createdAt
  return tasks.reduce((a, b) => (stamp(b) > stamp(a) ? b : a))
}

// Route human input by the live task's state. `factory add` enforces at most
// one non-terminal task per worktree, so this is a state machine over that
// task, not a selection over a queue; `latest` only disambiguates legacy
// multi-task queues, most recently touched record winning.
export function selectAddRoute(
  tasks: AddRouteTask[],
  hasWorktreeDiff: boolean,
  loopActive: boolean
): AddRoute {
  const live = latest(tasks.filter((task) => !isTerminal(task.status)))
  if (live) {
    if (live.status === 'needs-input') {
      return { kind: 'answer', taskId: live.id, reason: 'task needs input' }
    }
    if (live.hasCommit) {
      // Committed work is settled even while the task finishes shipping; new
      // input is a follow-up, not a change to the committed pass.
      return {
        kind: 'follow-up',
        taskId: live.id,
        reason: 'task already has a commit',
        recordOnSource: true,
      }
    }
    if (live.status === 'blocked' || live.status === 'retrying') {
      return { kind: 'retry', taskId: live.id, reason: `task is ${live.status}` }
    }
    if (isStranded(live.status)) {
      // A live-stage status means either "a loop is working it right now" or
      // "abandoned by a killed loop" — the run lock tells them apart. Live work
      // gets feedback appended without touching its status; abandoned work is
      // requeued as a resume with the message as its note, exactly like blocked.
      return loopActive
        ? {
            kind: 'feedback-live',
            taskId: live.id,
            reason: `a run loop is actively working this task (${live.status})`,
          }
        : {
            kind: 'retry',
            taskId: live.id,
            reason: `task was interrupted during ${live.status}`,
          }
    }
    // ready: existing progress takes the input as feedback; a still-fresh task
    // falls through to new-task, where add enforces the one-live-task error.
    if (live.hasPlan || hasWorktreeDiff || live.pendingFeedback) {
      return { kind: 'feedback', taskId: live.id, reason: 'task has existing progress' }
    }
    return { kind: 'new-task' }
  }

  const done = latest(tasks.filter((task) => task.status === 'done'))
  if (done) {
    return {
      kind: 'follow-up',
      taskId: done.id,
      reason: 'latest task is done',
      recordOnSource: true,
    }
  }
  return { kind: 'new-task' }
}
