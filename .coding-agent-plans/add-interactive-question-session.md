# ## Problem

# Plan: Make `factory ask` Interactive By Default

## Intent

Make `factory ask` a factory-owned terminal session for follow-up questions, while preserving the current one-turn behavior behind:

```bash
factory ask --print [task-id] <question...>
```

The session stays inside factory’s saved-task-state boundary. It must not hand off to native Codex/Claude interactive modes, inspect files directly, run commands, write artifacts, or persist transcripts.

## Behavior

### One-Shot Mode

`factory ask --print [task-id] <question...>` preserves today’s behavior:

- Parse the optional task id using existing task-id matching semantics.
- Require a non-empty question.
- Build the same saved task-state packet.
- Call `runAgent` once with `access: 'read'`.
- Print the answer and exit.
- Do not persist anything.

`--print` is recognized only as the leading argument. A later literal `--print` remains part of the question.

### Interactive Mode

`factory ask [task-id] [question...]` becomes the default terminal experience:

- Requires stdin and stdout to be TTYs.
- If not TTY, fail clearly:

```text
factory ask is interactive and needs a terminal. For a scriptable one-shot answer use: factory ask --print [task-id] <question...>
```

- If a question is provided, answer it as the first turn, then prompt for follow-ups.
- If only a task id is provided, open an empty prompt scoped to that task.
- If no task id is provided, ask across saved tasks using the existing selection heuristics.
- Use `you>` as the prompt label.
- Empty input or `/done` exits cleanly with status `0`.
- `/cancel` exits with status `1`.
- `/edit` opens the existing editor composition flow if it fits cleanly.
- Each successful turn appends `{ question, answer }` to an in-memory transcript.
- Failed turns are not appended to the transcript.

On session start, print a short header before any seeded answer:

```text
ask — <agent> [· task <task-id>]
ask a question · Enter or /done to exit · /edit long reply · /cancel abort
```

Per turn, print a lightweight `…thinking` line rather than repeating the agent name.

## Context And Grounding

Each ask turn should be one headless agent call over a freshly rebuilt context packet.

For every turn:

1. Reload tasks from disk.
2. If the session is scoped, find the exact resolved full task id.
3. If the scoped task disappeared, fail clearly and end the session nonzero. Do not silently widen to all tasks.
4. Select detailed artifacts using the current question plus prior user questions.
5. Carry forward task ids selected by earlier successful turns, then re-resolve those ids from fresh task state.
6. Build the prompt from current task state, selected artifacts, the latest question, and the live transcript.
7. Call `runAgent(ctx.askAgent, { access: 'read', ... })`.

The transcript is continuity, not evidence. Add explicit prompt rules:

- Use the transcript only to resolve references like “why?”, “that one”, or “the second issue”.
- Answer factual questions only from the current task index and artifact excerpts.
- If the transcript conflicts with current saved state, current saved state wins.
- If the saved context does not contain enough information, say so.

Do not write transcripts to task artifacts, repo state, metrics, config, or logs beyond normal terminal output.

## Implementation Shape

### `src/ask.ts`

Refactor around a reusable one-turn primitive.

Export focused helpers for tests:

```ts
export type AskMode = 'session' | 'print'

export type AskRequest = {
  mode: AskMode
  taskId: string | null
  question: string
}

export type AskTranscriptTurn = {
  question: string
  answer: string
}
```

Add or expose:

- `parseAskRequest(args, tasks)`
  - Leading `--print` only.
  - Resolves task-id substrings to the full task id once at session start.
  - Preserves literal `--print` elsewhere in the question.

- `buildAskPrompt(...)`
  - Keeps the current one-shot packet compatible when transcript is empty.
  - Adds transcript and grounding rules when transcript is non-empty.

- `answerAskQuestion(...)`
  - Reloads tasks each turn.
  - Enforces exact scoped task lookup.
  - Selects artifacts from current question, prior questions, and carried task ids.
  - Calls `runAgent` with `access: 'read'`.
  - Returns answer text plus selected task ids.

- `runAskSession(...)`
  - Testable session driver with injectable read/write/turn functions.
  - Sends seeded first question before reading follow-up input.
  - Handles `/done`, empty input, `/cancel`, and turn failures.
  - Keeps transcript in process memory only.

Use `node:readline` for the real terminal session. Close readline in `finally`.

Use existing conversational conventions from `sharpen.ts`: `you>`, `/done`, `/edit`, `/cancel`, and a short hint line. Do not use `setActivePrompt`; ask is a foreground loop, not a concurrent prompt surface.

For interactive answer rendering, reuse the existing dim-gutter agent rendering from `sharpen.ts` by extracting/exporting the helper if that is small and behavior-preserving. Keep `--print` output plain so it remains script-friendly.

### `src/cli.ts`

Update help to show both forms explicitly:

```text
factory ask [task-id] [question...]
                         Interactive Q&A over saved factory task state (TTY).
factory ask --print [task-id] <question...>
                         One-shot, scriptable answer (required in non-TTY).
```

### `README.md`

Document:

- `factory ask` is interactive by default.
- `factory ask "question"` answers first, then remains open for follow-ups.
- `factory ask <task-id>` opens a scoped session.
- `--print` is the one-shot/scriptable mode.
- Non-TTY usage requires `--print`.
- Context is rebuilt every turn.
- Session transcripts are ephemeral and are used only for conversational continuity.
- Saved task state and artifacts remain the only factual evidence.
- Exit commands: empty input, `/done`, `/edit`, `/cancel`.

## Tests

Add focused tests without invoking real agents or requiring a real terminal.

Cover:

- Leading `--print` selects print mode.
- Non-leading `--print` remains part of the question.
- `--print <task-substring> question` resolves the full task id.
- `<task-id>` with no question opens a scoped session request.
- Empty transcript prompt preserves one-shot structure and omits conversation history.
- Non-empty transcript prompt includes history and the evidence-boundary rules.
- One-shot mode calls the fake agent once with `access: 'read'`.
- Follow-up turns receive prior transcript.
- Follow-up selection carries previous task ids while reloading tasks.
- Scoped task disappearance fails instead of widening scope.
- Seeded interactive question is sent before reading follow-up input.
- Empty input and `/done` exit `0`.
- `/cancel` exits nonzero.
- Turn failure reports an error, does not append the failed question, and re-prompts.
- Non-TTY session mode rejects with `--print` guidance.

## Verification

Do not run tests without permission. With permission, run:

```bash
bun run test
```

Expected proof:

- Biome passes.
- TypeScript strict mode passes.
- Unit tests pass.
- `factory ask --print ...` remains one-shot.
- `factory ask ...` opens a TTY session.
- No ask-session transcript files, task artifacts, config writes, or metrics writes are created.
