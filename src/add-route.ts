import { isStranded, type Status } from './task.ts'

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

export function selectAddRoute(
  tasks: AddRouteTask[],
  hasWorktreeDiff: boolean,
  loopActive: boolean
): AddRoute {
  const needsInput = latest(tasks.filter((task) => task.status === 'needs-input'))
  if (needsInput) {
    return { kind: 'answer', taskId: needsInput.id, reason: 'task needs input' }
  }

  const current = latest(
    tasks.filter(
      (task) =>
        task.hasCommit ||
        task.status === 'blocked' ||
        task.status === 'retrying' ||
        task.status === 'done' ||
        isStranded(task.status) ||
        (task.status === 'ready' && (task.hasPlan || hasWorktreeDiff || task.pendingFeedback))
    )
  )
  if (!current) {
    return { kind: 'new-task' }
  }

  if (current.hasCommit || current.status === 'done') {
    return {
      kind: 'follow-up',
      taskId: current.id,
      reason: current.status === 'done' ? 'latest task is done' : 'task already has a commit',
      recordOnSource: true,
    }
  }
  if (current.status === 'blocked' || current.status === 'retrying') {
    return { kind: 'retry', taskId: current.id, reason: `task is ${current.status}` }
  }
  if (isStranded(current.status)) {
    // A live-stage status means either "a loop is working it right now" or
    // "abandoned by a killed loop" — the run lock tells them apart. Live work
    // gets feedback appended without touching its status; abandoned work is
    // requeued as a resume with the message as its note, exactly like blocked.
    return loopActive
      ? {
          kind: 'feedback-live',
          taskId: current.id,
          reason: `a run loop is actively working this task (${current.status})`,
        }
      : {
          kind: 'retry',
          taskId: current.id,
          reason: `task was interrupted during ${current.status}`,
        }
  }
  return {
    kind: 'feedback',
    taskId: current.id,
    reason: 'task has existing progress',
  }
}
