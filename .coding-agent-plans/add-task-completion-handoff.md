# ## Problem

# Plan: Successful-task completion feedback

## Objective

Add an always-on, best-effort completion handoff for successful pipeline-completed tasks. Each successful task should save `feedback.md`, print a concise bounded version in the terminal, and show the artifact in `factory show <task-id>`.

The handoff is local and read-only. It must not change verify, commit, `onComplete`, hooks, telemetry, eval capture, or task status behavior.

## Approach

Generate completion feedback inside the existing successful delivery path, after optional `onComplete` succeeds and before the task is recorded as done. This lets the handoff reference `ship.md` when delivery ran, while still producing feedback when `onComplete` is disabled.

Use the existing `agents.delivery` agent with `access: 'read'` and `outFile: feedback.md`. Do not add a new config option, agent role, marker line, parser, or session digest.

Feedback generation is non-blocking. If it fails, log a warning and continue marking the task done.

## Artifact

Create a new task artifact:

```txt
feedback.md
```

Expected structure:

```md
## Summary

2-3 concise sentences describing what changed and why.

## What to verify next

- Include the verify command that already passed, when present.
- Include concrete manual/UI/code review checks only when grounded in the task, plan, diff, proof, verify output, or ship output.
- If no UI/manual check is identifiable, say so plainly.

## Useful artifacts

- Point users to `factory show <task-id>` for proof, verify output, delivery output, and related artifacts.
```

Do not include a top-level `# Feedback` heading. `factory show` provides the outer section title.

## Implementation

### `src/task.ts`

Promote the existing private `readArtifact` helper from `conductor.ts` into `task.ts`:

```ts
export async function readArtifact(task: Task, name: string): Promise<string | null>
```

Behavior:

- Return trimmed text when the artifact exists.
- Return `null` when absent.
- Do not parse or validate markdown.

Update the task layout comment to include `feedback.md`.

### `src/prompts.ts`

Add `feedbackPrompt`.

Inputs should include:

- `taskId`
- `intent`
- final plan, if present
- verify command, if present
- committed diff
- `proof.md`, if present
- `verify.log`, if present
- `ship.md`, if present

Prompt requirements:

- Output markdown only.
- Start with `## Summary`.
- Use exactly these sections:
  - `## Summary`
  - `## What to verify next`
  - `## Useful artifacts`
- Summary must be 2-3 sentences.
- Include the verify command that already passed when available.
- Do not invent URLs, UI paths, commands, deployment status, or manual checks.
- Do not paste raw diffs, raw logs, secrets, or large blobs.
- Refer users to `factory show <taskId>` for saved artifacts.
- No marker lines and no parser contract.

### `src/conductor.ts`

Import:

- `readArtifact` from `task.ts`
- `feedbackPrompt` from `prompts.ts`
- existing `commitDiff` from `git.ts`

Add a private helper, roughly:

```ts
async function writeCompletionFeedback(ctx: WorkContext, task: Task, meter: Meter): Promise<void>
```

Behavior:

1. Wrap the entire function in `try/catch`.
2. Read `intent`, final plan, `proof.md`, `verify.log`, optional `ship.md`, `task.meta.verify`, and committed diff via `commitDiff(ctx.root, task.meta.commit)` when present.
3. Clip large prompt inputs before sending them to the agent.
4. Emit progress with a wrap-up label such as `summarizing handoff`.
5. Run `agents.delivery` with `access: 'read'` and `outFile: ${task.dir}/feedback.md`.
6. On failure, warn without throwing:

```txt
<task-id>: handoff unavailable (task still done) — <message>
```

Call this from `shipAndFinish` after optional `onComplete` and before `recordTask`.

### `src/cli.ts`

After the existing successful completion line:

```ts
log.ok(`${task.id}: done`)
```

read `feedback.md` and print it when present.

Use a small pure helper to render bounded terminal output:

- Trim surrounding blank lines.
- Preserve headings and bullets.
- Do not truncate normal handoffs.
- Cap pathological output around 40 lines / 6000 chars.
- Append a clipped marker when truncated.
- Print a persistent pointer:

```txt
detail: factory show <task-id>
```

Do not generate or print feedback for `factory correct`.

### `src/view.ts`

Extract the artifact display ordering into an exported constant if useful for testing, for example:

```ts
export const SHOW_ARTIFACTS = [
  ['feedback.md', '## Completion feedback'],
  ...
]
```

Place `feedback.md` near the top, directly after intent and before plan/review/verify artifacts.

Old tasks without `feedback.md` should render unchanged.

### `src/ask.ts`

Optionally include `feedback.md` in `taskArtifacts(...)` so future `factory ask` answers can use the saved handoff.

Keep this narrow; do not otherwise refactor ask behavior.

### `README.md`

Document:

- Successful flow becomes:

```txt
verify -> commit -> optional onComplete -> feedback
```

- `feedback.md` is generated for successful pipeline-completed tasks even when `onComplete` is disabled.
- Feedback is local, read-only, best-effort, and never blocks `done`.
- Terminal output prints a bounded handoff plus `factory show <task-id>`.
- `factory show` displays completion feedback when present.
- `factory correct` does not generate feedback because it is a manual override path, not a clean successful pipeline completion.

Update the task layout with:

```txt
feedback.md            # concise completion handoff: summary + next verification steps
```

## Tests

Add focused deterministic tests.

Cover:

- `feedbackPrompt` includes the verify command when provided.
- `feedbackPrompt` includes the real task id and `factory show <task-id>`.
- Prompt guardrails forbid invented URLs, commands, UI paths, and raw diff/log dumps.
- Optional context blocks are omitted when inputs are absent.
- `readArtifact` returns `null` for missing artifacts and trims existing artifact contents.
- Terminal feedback rendering preserves normal handoffs and clips pathological output.
- `SHOW_ARTIFACTS` includes `feedback.md` before plan artifacts with heading `## Completion feedback`.

Do not test model prose. Do not build a heavy end-to-end run harness just to test the best-effort failure path; verify structurally that feedback errors are caught and `shipAndFinish` still records done.

## Verification

Recommended gate:

```sh
bun run test
```

Run only with explicit permission.
