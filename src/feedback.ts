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
