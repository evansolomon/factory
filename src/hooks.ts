import { run } from './exec.ts'
import { log } from './log.ts'

// Lifecycle hooks: at each event, factory runs the shell commands configured for
// it (in `.factory.json` "hooks"), letting the surrounding environment react —
// drive a tmux tab, send a notification, log to a dashboard — WITHOUT factory
// knowing anything about that environment. This is what lets factory be a
// standalone program: the only built-in integration (tmux) moves out into a hook.
//
// Best-effort by design: a hook's failure or timeout is logged and never affects
// the task (cosmetic integration must not crash the loop). One-directional —
// hooks observe, they don't gate; their output and exit code don't alter flow.

export type Hooks = Record<string, string[]>

export type HookEvent =
  | 'task.start' // a task begins processing
  | 'stage.change' // the active stage changed (drives the tmux window name)
  | 'attention' // attention state changed
  | 'task.needs_input' // paused for the human
  | 'task.blocked' // escalated to blocked
  | 'task.retrying' // set aside for an auto-retry
  | 'task.decomposed' // delegated into an ordered child-workstream chain
  | 'task.done' // completed (committed / shipped)
  | 'task.stale' // parked (needs-input/blocked) past the staleness window
  | 'loop.idle' // queue drained, loop waiting

const HOOK_TIMEOUT_MS = 10_000

// Flatten a payload into FACTORY_* env vars, so trivial shell hooks need no JSON
// parsing (e.g. `tmux rename-window "$FACTORY_STAGE"`). Strings pass through;
// everything else is JSON-encoded.
function flatEnv(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) {
      continue
    }
    out[`FACTORY_${key.toUpperCase()}`] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return out
}

// Fire a lifecycle event to its configured hooks. Payload is delivered both as a
// JSON object on stdin and as flat FACTORY_* env vars; cwd is the worktree root,
// and the child inherits the process env (so $TMUX_PANE etc. are available).
export async function emit(
  root: string,
  hooks: Hooks,
  event: HookEvent,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const commands = hooks[event]
  if (!commands || commands.length === 0) {
    return
  }
  const stdin = JSON.stringify({ event, ...payload })
  const env = { ...process.env, FACTORY_EVENT: event, FACTORY_ROOT: root, ...flatEnv(payload) }
  for (const command of commands) {
    try {
      const res = await run(['bash', '-lc', command], {
        cwd: root,
        stdin,
        env,
        timeout: HOOK_TIMEOUT_MS,
      })
      if (res.code !== 0) {
        log.warn(`hook ${event} (${command}) exited ${res.code}`)
      }
    } catch (err) {
      log.warn(`hook ${event} (${command}) failed: ${err instanceof Error ? err.message : err}`)
    }
  }
}
