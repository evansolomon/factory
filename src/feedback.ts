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

export type FeedbackArgs =
  | { ok: true; task: Task | null; text: string }
  | { ok: false; message: string }

export type FeedbackRouteInput = {
  status: Status
  hasPlan: boolean
  hasWorktreeDiff: boolean
  hasCommit: boolean
  pendingFeedback: boolean
}

export type FeedbackRoute =
  | { kind: 'resume' }
  | { kind: 'follow-up' }
  | { kind: 'reject'; message: string }

function matchesTask(task: Task, query: string): boolean {
  return task.id === query || task.id.includes(query)
}

export function parseFeedbackArgs(args: string[], tasks: Task[]): FeedbackArgs {
  const [first, ...rest] = args
  if (!first) {
    return { ok: false, message: 'usage: factory feedback [task-id] <feedback...>' }
  }
  const task = tasks.find((candidate) => matchesTask(candidate, first)) ?? null
  if (task) {
    const text = rest.join(' ').trim()
    if (!text) {
      return { ok: false, message: 'usage: factory feedback [task-id] <feedback...>' }
    }
    return { ok: true, task, text }
  }
  const text = args.join(' ').trim()
  return text
    ? { ok: true, task: null, text }
    : { ok: false, message: 'usage: factory feedback [task-id] <feedback...>' }
}

export function decideFeedbackRoute(input: FeedbackRouteInput): FeedbackRoute {
  if (input.status === 'needs-input') {
    return { kind: 'reject', message: 'task is waiting for answers; use factory answer' }
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
    return {
      kind: 'reject',
      message: `task is still ${input.status}; wait for progress or use factory add for new work`,
    }
  }
  if (isStranded(input.status)) {
    return {
      kind: 'reject',
      message: `task was interrupted during ${input.status}; use factory resume first`,
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

export function feedbackRouteInput(task: Task, hasPlan: boolean, hasWorktreeDiff: boolean) {
  return {
    status: task.meta.status,
    hasPlan,
    hasWorktreeDiff,
    hasCommit: task.meta.commit !== null,
    pendingFeedback: pendingFeedbackCount(task) > 0,
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
