import { resolve } from 'node:path'
import { isStranded, pendingFeedbackCount, type Status, type Task } from './task.ts'

const TERMINAL_FEEDBACK_MAX_LINES = 40
const TERMINAL_FEEDBACK_MAX_CHARS = 6000

export function renderTerminalFeedback(feedback: string, taskId: string): string[] {
  let text = feedback.trim()
  if (!text) {
    return []
  }

  let clipped = false
  if (text.length > TERMINAL_FEEDBACK_MAX_CHARS) {
    text = text.slice(0, TERMINAL_FEEDBACK_MAX_CHARS).trimEnd()
    clipped = true
  }

  let lines = text.split('\n')
  if (lines.length > TERMINAL_FEEDBACK_MAX_LINES) {
    lines = lines.slice(0, TERMINAL_FEEDBACK_MAX_LINES)
    clipped = true
  }

  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
    lines = lines.slice(0, -1)
  }

  if (clipped) {
    lines.push(`[handoff clipped; run factory show ${taskId} for the full artifact]`)
  }

  return [...lines, '', `detail: factory show ${taskId}`]
}

export type FeedbackRouteInput = {
  status: Status
  hasPlan: boolean
  hasWorktreeDiff: boolean
  hasCommit: boolean
  pendingFeedback: boolean
  // Whether a run loop currently holds this worktree's lock — distinguishes a
  // task being actively worked from one abandoned mid-stage.
  loopActive: boolean
}

export type FeedbackRoute =
  | { kind: 'resume' }
  | { kind: 'follow-up' }
  // Append feedback only: a live loop owns the task's status right now.
  | { kind: 'record' }
  | { kind: 'reject'; message: string }

export function decideFeedbackRoute(input: FeedbackRouteInput): FeedbackRoute {
  if (input.status === 'needs-input') {
    return { kind: 'reject', message: 'task is waiting for answers; use factory add' }
  }
  if (input.status === 'done' || input.hasCommit) {
    return { kind: 'follow-up' }
  }
  const hasProgress = input.hasPlan || input.hasWorktreeDiff || input.pendingFeedback
  if (input.status === 'ready') {
    return hasProgress
      ? { kind: 'resume' }
      : {
          kind: 'reject',
          message: 'task has no progress to give feedback on; use factory add for new work',
        }
  }
  if (input.status === 'blocked' || input.status === 'retrying') {
    return hasProgress
      ? { kind: 'resume' }
      : {
          kind: 'reject',
          message: 'task has no resumable progress to give feedback on',
        }
  }
  if (input.status === 'sharpening' || input.status === 'planning') {
    return input.loopActive
      ? {
          kind: 'reject',
          message: `task is still ${input.status}; wait for progress or use factory add for new work`,
        }
      : {
          kind: 'reject',
          message: `task was interrupted during ${input.status} with no reviewable progress; use factory retry`,
        }
  }
  if (isStranded(input.status)) {
    // Aligned with `factory add` routing: live work takes feedback without a
    // requeue; abandoned work with progress resumes with the feedback pending.
    if (input.loopActive) {
      return { kind: 'record' }
    }
    const hasProgress = input.hasPlan || input.hasWorktreeDiff || input.pendingFeedback
    return hasProgress
      ? { kind: 'resume' }
      : {
          kind: 'reject',
          message: `task was interrupted during ${input.status} with no progress; use factory retry`,
        }
  }
  return {
    kind: 'reject',
    message: `task status ${input.status} cannot receive feedback yet`,
  }
}

export function isDefaultFeedbackTarget(input: FeedbackRouteInput): boolean {
  return decideFeedbackRoute(input).kind !== 'reject'
}

export function latestFeedbackTarget(
  tasks: Task[],
  facts: (task: Task) => FeedbackRouteInput
): Task | null {
  const eligible = tasks.filter((task) => isDefaultFeedbackTarget(facts(task)))
  if (eligible.length === 0) {
    return null
  }
  const stamp = (task: Task) => task.meta.updatedAt ?? task.meta.createdAt
  return eligible.reduce((a, b) => (stamp(b) > stamp(a) ? b : a))
}

export function feedbackRouteInput(
  task: Task,
  hasPlan: boolean,
  hasWorktreeDiff: boolean,
  loopActive: boolean
) {
  return {
    status: task.meta.status,
    hasPlan,
    hasWorktreeDiff,
    hasCommit: task.meta.commit !== null,
    pendingFeedback: pendingFeedbackCount(task) > 0,
    loopActive,
  }
}

export function followUpIntent(source: Task, feedback: string): string {
  return [
    `Address feedback on ${source.id}`,
    '',
    '## Source task',
    `- id: ${source.id}`,
    `- commit: ${source.meta.commit ?? '(none)'}`,
    `- task dir: ${resolve(source.dir)}`,
    `- inspect: factory show ${source.id}`,
    `- verify: ${source.meta.verify ?? '(none)'}`,
    '',
    '## Human feedback',
    feedback.trim(),
  ].join('\n')
}
