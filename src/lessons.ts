import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WorkContext } from './config.ts'
import { log } from './log.ts'

// The meta loop. LESSONS.md is human-curated, high-signal, and read into the
// plan/critique stages every iteration so past mistakes shape future plans.
// LESSONS.candidates.md is machine-appended raw signal (blocks, questions) that
// you periodically distill into LESSONS.md (e.g. via the /learn skill). Keeping
// them separate keeps the curated file high-signal.
//
// Both live at the REPO level (repoStateDir, keyed by the main worktree), not
// per-worktree — so lessons accumulate across all the repo's (short-lived)
// worktrees instead of resetting each time you start a task on a new branch.

function lessonsPath(ctx: WorkContext): string {
  return `${ctx.repoStateDir}/LESSONS.md`
}

function candidatesPath(ctx: WorkContext): string {
  return `${ctx.repoStateDir}/LESSONS.candidates.md`
}

export async function readLessons(ctx: WorkContext): Promise<string | null> {
  const file = Bun.file(lessonsPath(ctx))
  if (!(await file.exists())) {
    return null
  }
  return (await file.text()).trim() || null
}

export async function readCandidates(ctx: WorkContext): Promise<string | null> {
  const file = Bun.file(candidatesPath(ctx))
  if (!(await file.exists())) {
    return null
  }
  return (await file.text()).trim() || null
}

const CANDIDATES_HEADER =
  '# Lesson candidates\n\n' +
  'Raw signals from blocks and questions. Curate the recurring ones into\n' +
  'LESSONS.md (which the planner reads every run); delete the noise.\n\n'

export async function appendCandidate(ctx: WorkContext, signal: string): Promise<void> {
  try {
    const path = candidatesPath(ctx)
    await mkdir(dirname(path), { recursive: true })
    const file = Bun.file(path)
    const existing = (await file.exists()) ? await file.text() : CANDIDATES_HEADER
    await Bun.write(path, `${existing}- ${new Date().toISOString()} · ${signal}\n`)
  } catch (err) {
    log.warn(`lesson candidate capture failed: ${err instanceof Error ? err.message : err}`)
  }
}
