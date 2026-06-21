// Minimal logger for the factory CLI. console is allowed here via biome override
// (mirrors the carve-out for src/Logger.ts) since this is the program's output surface.

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

// A single in-place status line (the stage heartbeat) can sit at the bottom while
// permanent lines print above it. We track its plain text so every permanent
// print clears the line first and redraws it after — otherwise the carriage
// return leaves the two interleaved. Kept plain (no ANSI) so its length is its
// on-screen width, which we use to blank it.
let statusText = ''

function emit(line: string): void {
  if (statusText) {
    process.stdout.write(`\r${' '.repeat(statusText.length)}\r`)
  }
  console.log(line)
  if (statusText) {
    process.stdout.write(statusText)
  }
}

export const log = {
  step(message: string): void {
    emit(`${cyan('▸')} ${message}`)
  },
  ok(message: string): void {
    emit(`${green('✓')} ${message}`)
  },
  fail(message: string): void {
    emit(`${red('✗')} ${message}`)
  },
  warn(message: string): void {
    emit(`${yellow('⚠')} ${message}`)
  },
  info(message: string): void {
    emit(dim(message))
  },
  // Indented completion line under a stage header (e.g. "  ✓ codex 38s").
  done(message: string): void {
    emit(`  ${green('✓')} ${dim(message)}`)
  },
  log(message: string): void {
    emit(message)
  },
  // Overwrite the single in-place status line (no newline), e.g. a live heartbeat.
  // TTY only — a no-op when piped, so logs/files don't fill with carriage returns.
  status(text: string): void {
    if (!process.stdout.isTTY) {
      return
    }
    const pad = Math.max(0, statusText.length - text.length)
    process.stdout.write(`\r${text}${' '.repeat(pad)}`)
    statusText = text
  },
  clearStatus(): void {
    if (!statusText) {
      return
    }
    process.stdout.write(`\r${' '.repeat(statusText.length)}\r`)
    statusText = ''
  },
}
