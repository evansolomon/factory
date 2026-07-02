All line references verified against the working tree (HEAD `c3f50a1`). Here is the final plan.

# Plan: once-per-episode attention alerts + SIGINT-safe interactive sharpen

Two independent fixes: (a) the run loop's `attention` alert becomes once-per-parked-episode instead of re-derived from the whole queue on every idle poll; (b) Ctrl-C at an interactive sharpen readline prompt resolves as `/cancel` so the existing `finally` cleanup emits `attention: none`.

One property drives the design of fix (a): the idle branch runs on **every** 5-second poll (`Bun.sleep(POLL_MS); continue` at src/cli.ts:1196-1197), not just on busy→idle transitions, and `setAlert` is invoked each iteration. So the tracker's idle decision must be tri-state — a design that returned `'none'` for surfaced-only parked queues would emit `attention: none` one poll after raising a fresh alert, clearing the orange after 5 seconds before any human could see it. The tracker therefore returns `null` ("hold — don't touch the alert") when only already-surfaced parked pairs remain, and the idle branch skips `setAlert` on `null`. The Goal's "surfaced-only queues emit `none`" is still satisfied on the path that motivated it — the queue-drain scenario — because the task start already emitted `attention: none` (src/cli.ts:1202) and the hold preserves it. During continuous idle right after a fresh alert, holding orange is what the settled design requires: the accepted false negative is explicitly "an ignored orange **cleared by a later task start** won't return," which presumes the orange persists through idle until a task start or window visit. The hold also means nothing at idle fights the moot-check's direct `attention: needs-input` re-nudge (src/cli.ts:824).

## 1. New file: `src/attention.ts` — the episode tracker

A small module holding the alert-decision logic so it is unit-testable (today it's closure-local inside the `run` command, and cli.ts exports only `main`/`runCli`). A factory-closure returning an object literal matches the repo's style (`setAlert` closure, `staleSignaled` set precedent) — no class.

```ts
// Header comment: the attention hook means "a human should check in"; a re-alert
// for an already-seen question is a false positive that trains the human to
// ignore the signal. So alerts fire once per parked EPISODE of each (task,
// status) pair: marked surfaced when the idle loop first emits an alert
// covering it. An episode ends two ways: taskStarted(id) when the loop picks
// the task up to run (every loop-owned re-park passes through a run), or
// idle-scan pruning when the pair no longer matches any task's current status
// (factory close / factory retry un-park tasks without the loop running them).
// While surfaced pairs remain parked, observeIdle returns null — HOLD, don't
// touch the alert — because the idle branch runs every poll: returning 'none'
// would clear a fresh orange after one 5s poll interval. Per-process, like
// staleSignaled — a restarted loop alerting once for pre-existing parked tasks
// is desirable. Accepted false negative: an ignored alert cleared by a later
// task start won't re-raise; the 24h task.stale nudge is the only long-horizon
// re-raise.

export type AlertState = 'blocked' | 'needs-input' | 'done'
export type ParkedStatus = 'needs-input' | 'blocked'
export type ParkedTask = { id: string; status: ParkedStatus }

export type AttentionTracker = {
  /** null means: leave the current alert state untouched. */
  observeIdle(parked: ParkedTask[], allDone: boolean): AlertState | 'none' | null
  taskStarted(id: string): void
}

export function createAttentionTracker(): AttentionTracker
```

Implementation of `createAttentionTracker`:

- Internal state: `const surfaced = new Set<string>()`, keyed by `` `${id}\u0000${status}` `` (NUL separator so a task id can never collide with a status suffix).
- `observeIdle(parked, allDone)`:
  1. **Prune**: delete every surfaced key not present in the current parked set (covers `factory close` and `factory retry`, which un-park a task without the loop ever running it; deleting from a `Set` while iterating it is safe). A pruned pair that reappears is a new episode.
  2. `fresh` = parked pairs whose key is not in `surfaced`.
  3. Mark **all** currently parked pairs surfaced (per the settled assumption: one check-in covers everything visible in the window; when `fresh` is empty this is a no-op).
  4. Return:
     - `fresh` non-empty → `fresh.some(p => p.status === 'blocked') ? 'blocked' : 'needs-input'`. Priority among *fresh* pairs only — a fresh needs-input alongside an already-surfaced blocked task emits `needs-input`, because the alert reports what's new; `loop.idle` still reports the whole-queue priority. (One-line comment in the tracker, since this deliberately diverges from `queueState`'s global priority.)
     - `fresh` empty, `parked` non-empty → `null` (hold: surfaced-only queue; after a raise, orange persists through continuous idle; after a drain, the task-start `'none'` persists).
     - `parked` empty → `allDone ? 'done' : 'none'`. (This preserves today's behavior where closing the last parked task clears the alert at the next poll, and keeps `done` reserved for genuinely all-done — `allDone` true implies `parked` is empty, so `done` can never be masked by a surfaced pair.)
- `taskStarted(id)`: delete both `key(id, 'needs-input')` and `key(id, 'blocked')`. Called when the loop picks a task up, so answered→re-parked between two idle observations alerts fresh.

## 2. `src/cli.ts` — wire the tracker into the run loop

1. **Line 373**: delete the local `type AlertState = 'blocked' | 'needs-input' | 'done'`; add `import { type AlertState, createAttentionTracker } from './attention.ts'` to the imports.
2. **`queueState` (lines 666-673)**: make it pure over a task snapshot so the idle branch loads tasks once and both the alert decision and the `loop.idle` label see the same snapshot:
   ```ts
   function queueState(tasks: Task[]): AlertState | null
   ```
   (drop `async` and the internal `loadTasks(ctx)` call; body otherwise identical — `blocked > needs-input > done > null`. `Task` is already imported in cli.ts. The idle branch is the only call site, verified by `rg` — no orphan helper, no unused import.)
3. **Alert setup (~line 1163)**: next to the `setAlert` closure, add `const attention = createAttentionTracker()`. Keep `setAlert` and its `alerted` dedup exactly as-is. Update the comment block at 1159-1162 to state the episode semantics (alerts mean "something new is parked since you last heard from me"; the tracker decides *whether* to alert, `setAlert` still dedups identical consecutive emits).
4. **Idle branch (lines 1185-1186)** becomes:
   ```ts
   const tasks = await loadTasks(ctx)
   const remaining = queueState(tasks)
   const parked = tasks.flatMap((t) =>
     t.meta.status === 'needs-input' || t.meta.status === 'blocked'
       ? [{ id: t.id, status: t.meta.status }]
       : []
   )
   const next = attention.observeIdle(parked, remaining === 'done')
   if (next !== null) {
     await setAlert(next)
   }
   ```
   (`flatMap` with the ternary narrows `t.meta.status` to `ParkedStatus` — no assertion needed. `null` = hold: skip `setAlert` entirely, so a fresh alert persists through continuous idle polls and nothing fights the moot-check's direct emit.) Everything after is byte-identical: the `once || drain` break at 1187, `emit('loop.idle', { state: remaining ?? 'idle' })` at 1190, the `tendParkedTasks` try/catch, `Bun.sleep(POLL_MS)`. Rewrite the comment at 1179-1184 to describe the episode dedup and the hold semantics (the old "drive attention from what's left" wording would be actively misleading).
5. **Task start (~line 1202)**: alongside the existing `await setAlert('none')`, add `attention.taskStarted(task.id)`. Every task the loop runs flows through `nextRunnable` into this one spot, so this call plus idle-scan pruning covers every episode-ending path.

**Untouched, per constraints**: `tendParkedTasks` (including the `staleSignaled` set, the `task.stale` emit, and the direct `emit(... 'attention', { state: 'needs-input' })` moot-check re-nudge at cli.ts:824 — it bypasses `setAlert` today and continues to), src/hooks.ts, src/prompt.ts, all hook payload shapes, `loop.idle` emission and payload.

## 3. `src/sharpen.ts` — SIGINT-as-cancel at readline prompts

1. **Replace `ask` (lines 175-177)** with a mirror of src/ask.ts:367-382, returning `Promise<string | null>`:
   ```ts
   // Ctrl-C at a prompt resolves null (treated as /cancel by callers) instead of
   // killing the process: readline forwards SIGINT to the process default when the
   // interface has no listener, which would skip the finally cleanup and strand
   // the attention hook at needs-input.
   function ask(rl: Interface, question: string): Promise<string | null> {
     return new Promise((resolve) => {
       let settled = false
       const finish = (answer: string | null): void => {
         if (settled) return
         settled = true
         rl.off('SIGINT', onInterrupt)
         resolve(answer)
       }
       const onInterrupt = (): void => finish(null)
       rl.once('SIGINT', onInterrupt)
       rl.question(question, finish)
     })
   }
   ```
2. **`readReply` (line 186)** — handle the null before `.trim()`:
   ```ts
   const raw = await ask(rl, 'you> ')
   if (raw === null) return { kind: 'cancel' }
   const input = raw.trim()
   ```
3. **`readQuestionAnswers` (line 218)** — same shape:
   ```ts
   const raw = await waitingForInput(opts, () => ask(rl, 'you> '))
   if (raw === null) return { kind: 'cancel' }
   const input = raw.trim()
   ```

These are the only two `ask(rl, …)` call sites (rg-verified). Cancel then flows through the existing control flow: `sharpen()` returns `null` at :322-324/:355-357 (question walk) or :379-381 (free reply), the top-level `finally` (:389-396) closes the readline, emits `attention: none` and `stage.change {stage: '', active: false}`, and the `backlog add` caller prints "sharpen cancelled — nothing queued" and exits 0 — identical end state to typing `/cancel`. Note the SIGINT arriving inside `waitingForInput` also runs *its* `finally` (`attention: none` at :251) before the top-level one — a duplicate-state emit that `emit()` doesn't dedup, but that is exactly what typing `/cancel` produces today, so no behavior divergence.

**Deliberately not extracted**: ask.ts, sharpen.ts, and prompt.ts each have a private `ask` wrapper. Sharing one helper would be the DRY move, but it would touch src/ask.ts (out of scope, zero behavior change) and could not serve prompt.ts anyway (its SIGINT lifecycle is explicitly deferred and owned by the run command's process handler). The ~15-line mirror stands; revisit extraction only if a third SIGINT-aware readline site appears.

## 4. New file: `tests/attention.test.ts`

Pure `bun:test` unit tests on `createAttentionTracker` (matching the repo's pure-function test style; no fixtures needed). One tracker instance per test, driven through observeIdle/taskStarted sequences — exercising both entry points together, since re-alert correctness depends on task-start clearing. Cases, mapped to acceptance criteria:

1. **Once per episode, then hold**: `observeIdle([A:needs-input], false)` → `'needs-input'`; same call again → `null` (hold — the orange must persist through continuous idle, not clear after one poll). Same pair of tests for `blocked`.
2. **Independent per (id, status)**: A needs-input alerts → `taskStarted('A')` → `observeIdle([A:blocked], false)` → `'blocked'`.
3. **Answered and re-parked alerts fresh**: A alerts → `taskStarted('A')` → `observeIdle([A:needs-input], false)` → `'needs-input'` again.
4. **One emit covers all visible**: `observeIdle([A:needs-input, B:needs-input], false)` → one `'needs-input'`; next observation → `null`.
5. **Fresh-pair priority**: fresh A:blocked + fresh B:needs-input → `'blocked'`; surfaced A:blocked + fresh B:needs-input → `'needs-input'`.
6. **Drain case (surfaced-only after other work)**: A alerts → `taskStarted('B')` (loop ran an unrelated task; task start emitted `'none'` externally) → `observeIdle([A:needs-input], false)` → `null` — the task-start `'none'` holds, satisfying "surfaced-only queues show none" without a fresh emit.
7. **`done` vs `none`**: `observeIdle([], true)` → `'done'`; `observeIdle([], false)` → `'none'` (empty queue, nothing parked — clears); surfaced-only parked with `allDone === false` → `null`, never `'done'` or `'none'`.
8. **Pruning**: A alerts → `observeIdle([], false)` → `'none'` (task closed out-of-band; alert clears at the next poll, preserving today's `factory close` behavior) → `observeIdle([A:needs-input], false)` → `'needs-input'` (the stale mark was pruned; a reappearing pair is a new episode).

No new tests for fix (b): the mirrored wrapper's cancel-kinds already flow through `sharpen()`'s existing paths, sharpen.ts has no DI seam for its readline, and the src/ask.ts original is itself untested (production-proven via `factory ask`) — a faithful mirror tested at this level matches repo norms. No PTY/e2e test; it would be more brittle than the behavior requires. tests/prompt.test.ts and tests/conductor.test.ts serve as regression canaries for the constrained-unchanged surfaces; existing tests/sharpen.test.ts (parsers only) is unaffected.

## 5. Implementation order

1. `bun install --frozen-lockfile` (a fresh worktree has no `node_modules`; without it `bun test` fails on missing packages), then `bun run test` to confirm the green baseline.
2. Create `src/attention.ts` (tracker + `AlertState` export).
3. Create `tests/attention.test.ts`; run `bun test tests/attention.test.ts` until green.
4. Edit `src/cli.ts`: swap the `AlertState` local type for the import, make `queueState` pure, wire `createAttentionTracker` / `observeIdle` (with the `null`-skip) / `taskStarted` into the run loop, rewrite the two comment blocks.
5. Edit `src/sharpen.ts`: SIGINT-aware `ask` + null handling at both call sites.
6. Full gate: `bun run test` (`biome check . && tsc --noEmit && bun test`).

## 6. Verification

- **Command**: `bun run test` — biome catches style drift and unused symbols; `tsc --noEmit` proves the `Promise<string | null>` change is handled at every call site, that the tri-state `observeIdle` return is handled at the idle branch, and that no assertion or `any` snuck in; `bun test` runs the new tracker suite plus all existing tests.
- The acceptance criteria for fix (a) are proven directly by the test cases in §4, including the poll-persistence property (case 1's hold) that an emit-`'none'` design would have violated. Fix (b)'s SIGINT→null step rests on the established ask.ts pattern; everything downstream of the null — nothing queued, `finally` emits — is existing, exercised control flow.
