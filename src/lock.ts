import { mkdir, open, rm } from 'node:fs/promises'
import { z } from 'zod'
import { log } from './log.ts'

// ONE run loop per worktree, enforced — not assumed. Task selection and the
// stranded-task reclaim are only safe because a single sequential loop looks for
// work *between* tasks (task.ts); a second concurrent loop would see the first
// loop's in-flight task as "stranded mid-stage" and steal it. The lock lives in
// the worktree's state dir, names its owner pid, and is only ever stolen from a
// process that is no longer alive.

export class RunLockError extends Error {
  override readonly name = 'RunLockError'
  constructor(pid: number) {
    super(
      `another factory run loop (pid ${pid}) already owns this worktree — ` +
        'one loop per worktree; stop it first or wait for it to exit'
    )
  }
}

const LockSchema = z.object({ pid: z.number().int(), startedAt: z.string() })

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function lockPath(stateDir: string): string {
  return `${stateDir}/run.lock`
}

async function tryCreate(path: string): Promise<boolean> {
  try {
    // O_EXCL: creation is the atomic acquisition — no check-then-write race.
    const handle = await open(path, 'wx')
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`
    )
    await handle.close()
    return true
  } catch (err) {
    const code = z.object({ code: z.string() }).safeParse(err)
    if (code.success && code.data.code === 'EEXIST') {
      return false
    }
    throw err
  }
}

// The pid of the live run loop holding this worktree's lock, or null when no
// loop is running (no lock, or a stale lock from a dead process). This is what
// lets add/feedback routing distinguish a task that is actively being worked
// (a loop is on it right now) from one abandoned mid-stage by a killed loop.
export async function runLockHolder(stateDir: string): Promise<number | null> {
  try {
    const lock = LockSchema.parse(await Bun.file(lockPath(stateDir)).json())
    return lock.pid !== process.pid && processAlive(lock.pid) ? lock.pid : null
  } catch {
    return null
  }
}

// Returns a release function. Throws RunLockError when a live loop holds the lock.
export async function acquireRunLock(stateDir: string): Promise<() => Promise<void>> {
  await mkdir(stateDir, { recursive: true })
  const path = lockPath(stateDir)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await tryCreate(path)) {
      return async () => {
        await rm(path, { force: true })
      }
    }
    let holder: number | null = null
    try {
      holder = LockSchema.parse(await Bun.file(path).json()).pid
    } catch {
      // Unreadable lock file → treat as stale debris.
    }
    if (holder !== null && holder !== process.pid && processAlive(holder)) {
      throw new RunLockError(holder)
    }
    if (holder !== null) {
      log.warn(`removing stale run.lock from dead pid ${holder}`)
    }
    await rm(path, { force: true })
  }
  throw new Error('could not acquire the run lock (contended twice); try again')
}
