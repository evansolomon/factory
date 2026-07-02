import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { log } from './log.ts'

// The environment playbook: this repo's known environment quirks and their
// fixes ON THIS MACHINE, accumulated from remediation runs. The single most
// expensive recurring waste in real usage was re-diagnosing the same
// environment failure from scratch (one OOM quirk was independently
// rediscovered four times at multi-million-token cost each) — this converts
// that class of failure into a lookup. Best-effort everywhere: the playbook
// must never break the loop.

const PLAYBOOK_MAX_CHARS = 24_000

export async function readEnvPlaybook(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) {
      return null
    }
    const text = (await file.text()).trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

export async function appendEnvPlaybook(path: string, entry: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const file = Bun.file(path)
    const existing = (await file.exists()) ? await file.text() : ''
    let next = `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}- ${new Date().toISOString()} · ${entry.trim().replace(/\s+/g, ' ')}\n`
    // Trim from the head when oversized: recent entries are the live knowledge.
    if (next.length > PLAYBOOK_MAX_CHARS) {
      next = next.slice(next.length - PLAYBOOK_MAX_CHARS)
      next = next.slice(next.indexOf('\n') + 1)
    }
    await Bun.write(path, next)
  } catch (err) {
    log.warn(`env playbook append failed: ${err instanceof Error ? err.message : err}`)
  }
}
