const GENERIC_HEADINGS = new Set([
  'background',
  'context',
  'goal',
  'implementation',
  'intent',
  'overview',
  'plan',
  'problem',
  'requirements',
  'solution',
  'summary',
  'task',
])

function normalizeSubject(line: string): string {
  return line
    .trim()
    .replace(/^(commit message|subject):\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
}

function isGenericMarkdownLine(line: string): boolean {
  const withoutHeadingMarker = line
    .replace(/^#{1,6}\s+/, '')
    .trim()
    .toLowerCase()
  return GENERIC_HEADINGS.has(withoutHeadingMarker)
}

function firstUsableLine(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('```') || line.startsWith('- ') || isGenericMarkdownLine(line)) {
      continue
    }
    const withoutMarkdownMarker = line.replace(/^#{1,6}\s+/, '').trim()
    const subject = normalizeSubject(withoutMarkdownMarker)
    if (subject) {
      return subject
    }
  }
  return null
}

export function fallbackCommitMessage(intent: string): string {
  return firstUsableLine(intent) ?? 'Apply task'
}

export function cleanCommitMessage(output: string, fallback: string): string {
  const subject = firstUsableLine(output)
  return subject ?? fallback
}
