// The attention hook means "a human should check in" — a re-alert for an
// already-seen question is a false positive that trains the human to ignore
// the signal. So alerts fire once per parked EPISODE of each (task, status)
// pair: a pair is marked surfaced when the idle loop first emits an alert
// covering it. An episode ends two ways: taskStarted(id) when the loop picks
// the task up to run (every loop-owned re-park passes through a run), or
// idle-scan pruning when the pair no longer matches any task's current status
// (factory close / factory retry un-park tasks without the loop running them).
// While only surfaced pairs remain parked, observeIdle returns null — HOLD,
// don't touch the alert — because the idle branch runs every poll: returning
// 'none' would clear a fresh alert after one poll interval. Per-process, like
// the run loop's staleSignaled set — a restarted loop alerting once for
// pre-existing parked tasks is desirable. Accepted false negative: an ignored
// alert cleared by a later task start won't re-raise; the 24h task.stale nudge
// is the only long-horizon re-raise.

export type AlertState = 'blocked' | 'needs-input' | 'done'
export type ParkedStatus = 'needs-input' | 'blocked'
export type ParkedTask = { id: string; status: ParkedStatus }

export type AttentionTracker = {
  /** null means: leave the current alert state untouched. */
  observeIdle(parked: ParkedTask[], allDone: boolean): AlertState | 'none' | null
  taskStarted(id: string): void
}

// NUL separator so a task id can never collide with a status suffix.
function key(id: string, status: ParkedStatus): string {
  return `${id}\u0000${status}`
}

export function createAttentionTracker(): AttentionTracker {
  const surfaced = new Set<string>()
  return {
    observeIdle(parked, allDone) {
      const current = new Set(parked.map((p) => key(p.id, p.status)))
      for (const k of surfaced) {
        if (!current.has(k)) {
          surfaced.delete(k)
        }
      }
      const fresh = parked.filter((p) => !surfaced.has(key(p.id, p.status)))
      for (const k of current) {
        surfaced.add(k)
      }
      if (fresh.length > 0) {
        // Priority among fresh pairs only — the alert reports what's new, so a
        // fresh needs-input beside an already-surfaced blocked task emits
        // needs-input; loop.idle still reports the whole-queue priority.
        return fresh.some((p) => p.status === 'blocked') ? 'blocked' : 'needs-input'
      }
      if (parked.length > 0) {
        return null
      }
      return allDone ? 'done' : 'none'
    },
    taskStarted(id) {
      surfaced.delete(key(id, 'needs-input'))
      surfaced.delete(key(id, 'blocked'))
    },
  }
}
