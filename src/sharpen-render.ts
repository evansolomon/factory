export const DIM = '\x1b[2m'
export const BOLD = '\x1b[1m'
export const CYAN = '\x1b[36m'
export const GREEN = '\x1b[32m'
export const RESET = '\x1b[0m'

// Small terminal renderer for the markdown subset the sharpen prompt emits.
// Unsupported markdown stays readable as plain text.
function styleInlineMarkdown(line: string, restore = ''): string {
  return line
    .replace(
      /^(\s*)([A-Z][A-Za-z ]{1,38}):/,
      (_m, sp, label) => `${sp}${BOLD}${label}:${RESET}${restore}`
    )
    .replace(/`([^`]+)`/g, `${CYAN}$1${RESET}${restore}`)
    .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}${restore}`)
}

export function styleSharpenMarkdownLine(line: string): string {
  const heading = /^(\s{0,3})(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line)
  if (heading) {
    const sp = heading[1]
    const marks = heading[2]
    const text = heading[3]
    if (sp === undefined || marks === undefined || text === undefined) {
      return styleInlineMarkdown(line)
    }
    const color = marks === '##' ? GREEN : CYAN
    const headingStyle = `${color}${BOLD}`
    return `${sp}${headingStyle}${styleInlineMarkdown(text, headingStyle)}${RESET}`
  }

  const bullet = /^(\s*)([-*]|\d+[.)])(\s+)(.+)$/.exec(line)
  if (bullet) {
    const sp = bullet[1]
    const marker = bullet[2]
    const gap = bullet[3]
    const text = bullet[4]
    if (sp === undefined || marker === undefined || gap === undefined || text === undefined) {
      return styleInlineMarkdown(line)
    }
    return `${sp}${DIM}${marker}${RESET}${gap}${styleInlineMarkdown(text)}`
  }

  return styleInlineMarkdown(line)
}

export function renderAgentMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) => `${DIM}│${RESET} ${styleSharpenMarkdownLine(line)}`)
    .join('\n')
}
