# Plan: `brief.html` Completion Briefs and `factory deck`

## Goal

Successful pipeline-completed `done` tasks should best-effort produce a visual one-page HTML brief at `brief.html`, beside the existing `feedback.md`. The new `factory deck [task-id] [--url]` command opens that brief for a specified done task, or for the latest done task when no id is provided.

Keep this small, file-based, and non-blocking. The HTML is intentionally arbitrary agent-authored output, with prompt guardrails against secrets, raw logs, raw diffs, large blobs, invented commands, invented URLs, and ungrounded deployment claims.

## Design Decisions

Generate `brief.html` during the existing successful completion path, after `feedback.md`, because that is where the task intent, plan, committed diff, proof, verify log, ship output, and handoff all exist.

Keep `feedback.md` and `brief.html` independent best-effort artifacts. A feedback failure should not prevent deck generation, and a deck failure should never prevent the task from becoming `done`.

Use arbitrary agent-generated HTML rather than a deterministic renderer. The value is a customized, scannable page for the exact completed project. Apply only minimal output hygiene: trim, unwrap one accidental surrounding HTML markdown fence, and reject output that does not start like HTML.

Do not auto-open a browser when a task completes. Completion output should only include a pointer when `brief.html` exists:

```text
brief: factory deck <task-id>
```

Browser opening happens only through the explicit `factory deck` command.

## Implementation

### `src/prompts.ts`

Add a deck prompt beside `feedbackPrompt`.

```ts
export type DeckPromptInput = FeedbackPromptInput & {
  feedback: string | null
}

export function deckPrompt(input: DeckPromptInput): string
```

The prompt should require:

- one complete HTML document only
- start with `<!doctype html>`
- no markdown fences
- inline CSS allowed
- no external CSS or JS except optional Mermaid 11 from jsDelivr
- stable top header containing task id, one-line intent/result, and exact verify command when known
- concise sections for what changed, how to verify, risks to inspect, and useful artifacts/commands
- no raw diffs, raw logs, secrets, large blobs, invented URLs, invented commands, or ungrounded deployment status
- optional `feedback.md` content included as context when available

Use the same optional context pattern as `feedbackPrompt`.

### `src/deck.ts`

Add a new module for deck helpers and command behavior.

Key exports:

```ts
export type DeckRequest = {
  taskQuery: string | null
  urlOnly: boolean
}

export type DeckOpenResult =
  | { ok: true }
  | { ok: false; message: string }

export type DeckOpener = (url: string) => Promise<DeckOpenResult>

export function normalizeDeckHtml(text: string): string | null

export async function buildDeckHtml(
  run: () => Promise<string>
): Promise<string | null>

export function parseDeckArgs(
  args: string[]
): { ok: true; request: DeckRequest } | { ok: false; message: string }

export function deckPath(task: Task): string

export function deckUrl(path: string): string

export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string
): string[] | null

export async function defaultDeckOpener(url: string): Promise<DeckOpenResult>

export async function openDeck(
  ctx: WorkContext,
  args: string[],
  opts?: { opener?: DeckOpener }
): Promise<number>
```

Argument behavior:

- accepts `factory deck`
- accepts `factory deck <task-id>`
- accepts `factory deck --url`
- accepts `factory deck --url <task-id>`
- accepts `factory deck <task-id> --url`
- rejects unknown options
- rejects more than one positional
- usage string: `usage: factory deck [task-id] [--url]`

Task selection:

- explicit id uses `findTask(ctx, query)`
- omitted id uses `latestTask(ctx, ['done'])`
- explicit task must be `done`
- omitted task must find a latest done task
- require `brief.html` before opening or printing

Error copy:

```text
no task matching <query>
no done task in this worktree
<task-id> is <status>; deck is only available for done tasks
no brief for <task-id> - deck generation is best-effort and may have been skipped; try: factory show <task-id>
```

Open behavior:

- `--url` prints only the `file://` URL and returns `0`
- default behavior opens the `file://` URL
- macOS: `open <url>`
- Linux: `xdg-open <url>`
- Windows: `cmd /c start "" <url>`
- unsupported platform or opener failure prints a clear warning plus the URL and returns `0`
- missing task, non-done task, and missing deck return `1`

Use `pathToFileURL(path).href` for URLs. No direct `console`.

### `src/conductor.ts`

Add `writeCompletionDeck`, called immediately after the existing `writeCompletionFeedback` call and before the task is recorded as done.

The deck step should:

1. call `progress(ctx, task, 'deck', 'building brief')`
2. gather the same core context used by feedback
3. read `feedback.md` if present
4. run the delivery agent with `access: 'read'`
5. pass the returned output through `buildDeckHtml`
6. write `brief.html` only when valid normalized HTML is returned
7. catch all errors and log a warning without throwing

Warning shape:

```text
<task-id>: deck unavailable (task still done) - <message>
```

Invalid HTML warning:

```text
<task-id>: deck unavailable (task still done) - no valid HTML produced
```

Do not change retry, verify, ship, telemetry, hooks, `recordTask`, or status behavior.

### `src/cli.ts`

Import and dispatch `openDeck`.

Add help entry:

```text
factory deck [task-id] [--url]
                         Open the visual one-page brief for a done task.
                         Defaults to the latest done task; --url prints the
                         file URL instead.
```

Add dispatch near `session` / `show`:

```ts
if (cmd === 'deck') {
  const ctx = await loadContext(process.cwd())
  return openDeck(ctx, rest)
}
```

When terminal completion feedback is rendered, append this line only if `brief.html` exists:

```text
brief: factory deck <task-id>
```

Do not preview the HTML and do not auto-open the browser.

### `src/view.ts`

Keep `factory show` markdown/log-oriented. Do not add `brief.html` to inline rendered artifacts.

When `brief.html` exists, print a pointer:

```text
brief available: factory deck <task-id>
```

### `src/commands.ts`

Add command metadata near `session` / `show`:

```ts
{
  name: 'deck',
  description: 'Open the visual one-page brief for a done task',
  autoUpgrade: true,
  options: [
    {
      name: '--url',
      description: 'Print the deck file URL instead of opening a browser',
    },
  ],
}
```

Add `deck` to `AUTO_UPGRADE_COMMAND_ORDER`.

### `src/completion.ts`

Add static zsh completion for `deck` and its `--url` option.

Do not add dynamic task-id completion.

### `src/agent-session.ts`

Add `brief.html` to `ARTIFACT_ORDER` immediately after `feedback.md`, so follow-up agent sessions can see the completion brief when present.

### `README.md`

Update user-facing docs:

- add `factory deck [task-id] [--url]` to the command list
- document `brief.html` beside `feedback.md` in task layout
- explain that successful pipeline-completed tasks best-effort generate both `feedback.md` and `brief.html`
- explain that `factory deck` opens the latest done task by default
- explain that `--url` prints the local file URL

## Tests

Add or update focused tests only.

### Prompt tests

Cover `deckPrompt`:

- asks for one complete HTML document
- requires `<!doctype html>`
- forbids markdown fences
- allows Mermaid CDN
- forbids raw diffs, raw logs, secrets, and large blobs
- requires stable header details
- includes optional feedback block only when provided

### `tests/deck.test.ts`

Cover:

- `normalizeDeckHtml` trims, unwraps one surrounding HTML fence, preserves valid HTML, rejects prose
- `buildDeckHtml` returns `null` on runner throw and invalid output
- `parseDeckArgs` accepts supported forms and rejects invalid forms
- `deckUrl` uses encoded `file://` URLs
- `browserOpenCommand` maps `darwin`, `linux`, and `win32`; unsupported returns `null`
- `openDeck(ctx, ['--url'])` selects latest done task and does not call opener
- explicit done task opens through injected opener
- non-done task returns `1`
- missing `brief.html` returns `1`
- no latest done task returns `1`
- opener failure returns `0`

### Existing tests

Update:

- command list / completion expectations to include `deck`
- zsh completion to include `--url`
- auto-upgrade eligibility to include `deck`
- agent-session manifest to include `brief.html` after `feedback.md`
- show tests to verify the deck pointer appears when `brief.html` exists and HTML is not rendered inline

## Verification

Final verification command, with permission:

```bash
bun run test
```

This should cover Biome, TypeScript, Bun tests, prompt guardrails, deck command behavior, command metadata, completion, and session/show discoverability.
