# Plan: First-Class Task Feedback

## Goal

Add `factory feedback [task-id] <feedback...>` as a first-class path for post-progress human critique. Feedback is durable, visible, distinct from `add`/`answer`/`resume`, and causes the next autonomous pass to generalize from the concrete comment before changing code.

## Design

Feedback routes by actual task state, not by loose status checks.

- Active post-progress task: append feedback to the task, requeue it, and run a feedback-analysis stage before the fix pass.
- Done or committed task: do not reopen it. Queue a linked follow-up task that references the source task and contains the feedback.
- Fresh queued, `needs-input`, pre-plan stranded, or live-running task: reject with a clear message.

Use durable task-local files:

- `feedback.md`: raw human feedback entries.
- `feedback.analysis.md`: the agent’s latest root-cause and sibling-case analysis.

Use metadata only for small machine state:

- `feedbackCount`
- `feedbackConsumed`
- `feedbackSourceTaskId`

Feedback remains pending until the normal review, verify, and commit path succeeds. Failed or interrupted runs must not silently consume feedback.

## Routing Semantics

Add `src/feedback.ts` with pure helpers for parsing, routing, default-target eligibility, and follow-up intent generation.

### Argument Parsing

`factory feedback <task-id> <feedback...>`:

- If the first argument matches an existing task id, use it as the target and treat the rest as feedback.
- If the first argument does not match a task id, treat all arguments as feedback and choose the latest eligible feedback target.
- No arguments: `usage: factory feedback [task-id] <feedback...>`
- Explicit task id with no feedback text: same usage error.

### Route Decision

Inputs:

- `status`
- `hasPlan`
- `hasWorktreeDiff`
- `hasCommit`
- `pendingFeedback`

Routes:

- `needs-input`: reject with `task is waiting for answers; use factory answer`.
- `done`: queue linked follow-up.
- Any task with `meta.commit`: queue linked follow-up, even if status is `blocked` or `retrying`.
- `blocked` / `retrying` with saved plan or worktree diff: resume in place.
- `ready` with saved plan or worktree diff: resume in place.
- Fresh `ready` with no plan and no diff: reject with `task has no progress to give feedback on; use factory add for new work`.
- Pre-plan stranded or live-running statuses with no resumable progress: reject clearly.

Default target selection must use a filtered latest-feedback-target helper, not raw `latestTask(ctx)`. Eligible defaults are pending-feedback tasks, done/committed tasks, and resumable post-progress tasks. Exclude `needs-input`, fresh queued tasks, and live/pre-plan statuses.

## Task State

Update `src/task.ts`.

Add metadata defaults through zod:

```ts
feedbackCount: z.number().int().nonnegative().default(0)
feedbackConsumed: z.number().int().nonnegative().default(0)
feedbackSourceTaskId: z.string().nullable().default(null)
```

Extend `addTask` options:

```ts
feedbackSourceTaskId?: string | null
```

Add helpers:

```ts
pendingFeedbackCount(task): number
readFeedback(task): Promise<string | null>
readPendingFeedback(task): Promise<string | null>
appendFeedback(task, text): Promise<void>
markFeedbackConsumed(task, count): void
```

Storage format in `feedback.md`:

```md
## Feedback (2026-06-23T...)

<text>
```

Rules:

- `appendFeedback` appends the raw text, increments `feedbackCount`, updates metadata, and persists.
- `readPendingFeedback` returns only entries after `feedbackConsumed`.
- `markFeedbackConsumed` mutates metadata in memory only.
- The conductor persists the consumed counter after a verified commit succeeds.
- Feedback appended during a run must remain pending for a later pass.

## CLI

Update `src/cli.ts`.

Add:

```bash
factory feedback [task-id] <feedback...>
```

Same-task resume path:

1. Append feedback.
2. Set:
   - `resume = true`
   - `resumeKind = 'manual'`
   - `resumeNote = null`
   - `autoRetries = 0`
   - `retryAt = null`
3. Set status to `ready`.
4. Log: `<id>: feedback recorded — back in queue`.

Done/committed follow-up path:

1. Do not reopen or mutate the source task except for appending traceable feedback.
2. Queue a follow-up task with:
   - title `Address feedback on <source-id>`
   - source task id
   - source commit or `(none)`
   - absolute source task dir
   - `factory show <source-id>`
   - verify command or `(none)`
   - raw feedback
3. Set `feedbackSourceTaskId` on the follow-up.
4. Log: `<source-id>: done — queued follow-up <followup-id> for feedback`.

Reject paths must not write `feedback.md` or mutate task state.

## Prompts

Update `src/prompts.ts`.

Add:

```ts
feedbackAnalysisPrompt(intent, feedback, currentDiff, finalPlan)
```

This is a read-only markdown prompt with no marker-line contract. It must require the agent to report:

- concrete observation
- inferred abstract problem or root cause
- repo and diff surfaces inspected
- other applicable concrete instances
- non-applicable look-alikes
- specific required changes
- instruction to change only cases justified by the abstraction

Add a helper for injecting analysis as a distinct section:

```ts
feedbackAnalysisBlock(feedbackAnalysis: string | null)
```

Thread feedback analysis into:

- `fixPrompt`
- `implementPrompt`

For linked follow-up tasks, the raw feedback is already embedded in the intent; no broad planning-surface churn is needed unless the existing prompt signatures make this cheap and useful.

## Conductor

Update `src/conductor.ts`.

Add a feedback context:

```ts
type FeedbackContext = {
  count: number
  raw: string
  analysis: string
}
```

Add helper:

```ts
analyzeFeedbackIfPending(ctx, task, meter, intent, finalPlan)
```

Behavior:

1. If `pendingFeedbackCount(task) === 0`, return `null`.
2. Read only pending feedback.
3. Emit progress: `feedback — generalizing your feedback`.
4. Run the feedback-analysis prompt read-only.
5. Write output to `feedback.analysis.md`.
6. Return `{ count: task.meta.feedbackCount, raw, analysis }`.
7. Do not mark feedback consumed yet.

Pipeline placement:

- For resume tasks, load the saved plan first, then analyze feedback.
- Run analysis before any implementation or fix pass caused by feedback.
- Keep `resumeNote` separate from feedback analysis.

Preserve auto-retry behavior:

- Note-less auto-retry with no feedback still skips code churn and retries the failed gate.
- Manual resume note forces a fix pass.
- Pending feedback also forces a fix pass.

Consumption rule:

- After review passes, verify passes, and `commitAll` records `task.meta.commit`, call `markFeedbackConsumed(task, feedbackContext.count)`.
- Persist through the existing metadata save path.
- If the task blocks, retries, crashes, or fails verification, feedback stays pending.

## Status, Show, Ask

Update `src/view.ts`.

`factory status`:

- Add a dedicated `feedback pending` section.
- Partition feedback-pending tasks out of normal `ready` output so ids do not double-list.
- Keep rows concise, e.g. `<task-id> — <first feedback line>`.

`factory show`:

- Show pending feedback count in the metadata summary.
- If `feedbackSourceTaskId` exists, render `↩ feedback on <source-id>`.
- Add artifacts:
  - `feedback.md` as `## Feedback`
  - `feedback.analysis.md` as `## Feedback analysis (last pass)`

Update `src/ask.ts` artifact allowlist:

- `feedback.md`
- `feedback.analysis.md`

## Documentation

Update CLI help and `README.md`.

Document the four human-input commands together:

- `add`: queue new work.
- `answer`: answer questions for `needs-input`.
- `resume`: retry blocked/retrying/stranded work with optional guidance.
- `feedback`: after reviewing or testing existing work, record critique that should be generalized across applicable cases.

Update task layout docs for:

- `feedback.md`
- `feedback.analysis.md`
- `feedbackCount`
- `feedbackConsumed`
- `feedbackSourceTaskId`

Document lifecycle rules:

- Active post-progress feedback requeues the same task.
- Done or committed feedback queues a linked follow-up.
- Feedback remains pending until a verified commit consumes it.
- Existing `add`, `answer`, and `resume` behavior is unchanged.

## Tests

Add focused tests for the contracts that matter.

### `tests/feedback.test.ts`

Cover:

- argument parsing with and without explicit task id
- missing feedback text errors
- `done` routes to follow-up
- any `hasCommit` routes to follow-up
- `needs-input` rejects with `factory answer` guidance
- fresh `ready` rejects
- `ready` with diff routes to resume
- `blocked` with plan routes to resume
- `retrying` with diff routes to resume
- default-target predicate excludes fresh, needs-input, and live/pre-plan tasks
- follow-up intent includes source id, commit, absolute dir, `factory show <id>`, verify command, and raw feedback

### `tests/task.test.ts`

Cover:

- legacy metadata defaults
- `appendFeedback` writes `feedback.md` and increments `feedbackCount`
- pending count drops after `markFeedbackConsumed`
- new feedback after consumption is the only pending feedback read
- `addTask(..., { feedbackSourceTaskId })` persists the backlink

### `tests/prompts.test.ts`

Cover:

- `feedbackAnalysisPrompt` requires abstract/root-cause inference
- it requires inspecting other applicable instances
- it requires non-applicable cases
- it requires changing only justified concrete cases
- `fixPrompt` and `implementPrompt` include a distinct human feedback analysis section

### CLI-Level Tests

Add helper-level or existing harness tests for:

- feedback on done task queues linked follow-up and does not reopen source
- feedback on committed retrying task queues follow-up
- feedback on `needs-input` fails and points to `factory answer`
- feedback without id chooses latest filtered target, not raw latest task
- pending feedback requeues a resumable task without setting `resumeNote`

## Verification

After implementation, run the normal gate if permitted:

```bash
bun run test
```

Run `bun run fix` first if formatting or lint output indicates it is needed.
