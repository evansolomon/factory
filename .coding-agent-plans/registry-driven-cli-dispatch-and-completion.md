All the load-bearing behavior claims check out against the source: `ask --print` is recognized only at position 0 (ask.ts:488), `report` skips any `-`-prefixed token including lone `-` (cli.ts:2054), `session` rejects only `--`-prefixed tokens (agent-session.ts:94), `deck` rejects anything starting with `-` (deck.ts:45), delivery directives accept `$name`/`/name` sigils with `$name` as the canonical recommendation form (delivery.ts:106,143), and `config set/get/unset/inherit` are rejected at cli.ts:1945.

Here is the final plan:

---

# Plan: Registry-driven dispatch + full zsh completion for `factory`

## Design summary

One typed registry in `src/commands.ts` becomes the single source of truth for command names, subcommands, options (including value sources and tail options), positional value sources, freeform grammar markers, `autoUpgrade`, and `hidden`. Three consumers derive from it:

1. **Dispatch** (`src/cli.ts`): `main()` resolves `cmd` via a typed registry lookup and calls `HANDLERS[name]`, where `HANDLERS: Record<CommandName, CommandHandler>` and `CommandName = (typeof COMMANDS)[number]['name']`. A command in the registry without a handler (or vice versa) is a compile error, via `as const satisfies readonly CommandSpec[]` keeping literal name types.
2. **Flag parsing** (`src/args.ts`, new): a declaration-driven scanner `scanArgs(spec.options, args, policy)` whose result type is mapped from the declared option tuple — code can only read flags that exist in the registry (`flags['--until-done']` fails to typecheck if undeclared). `main()` runs the scan at the dispatch boundary and passes handlers the typed result. Token classification is **per-command policy**, reproducing each existing parser's exact rule — no runtime behavior deltas from parsing.
3. **Completion**: cobra-style. `factory completion zsh` emits a thin fixed shim that invokes a hidden `factory __complete` helper (via `${words[1]}`, so the completed binary completes itself) at TAB time; ALL candidates — command names, flags, static values, dynamic values — are computed in TypeScript by walking the registry (`src/complete.ts`, new). Unit-testable without zsh; the hand-enumerated per-command zsh renderer is deleted.

### Enforcement (stated precisely)

- **Commands**: dispatch is a registry lookup into an exhaustive, excess-checked `HANDLERS` record. A command cannot exist in the CLI without a registry entry — compile error.
- **Flags**: every flag read goes through `scanArgs`, whose result type is mapped from the registry's option tuple. An undeclared flag has no typed field to read — compile error at the read site. Handlers for scanner-grammar commands receive only the scan result, never raw argv.
- **Residual, by declaration**: commands with declared freeform positionals (`add` intent, `ask` question, `delivery` policy, `--verify` tails) receive that text as opaque positionals. Four battle-tested parser modules (`add-options.ts`, `input.ts`, `agent-session.ts`, `deck.ts`) keep their raw-`args` exported signatures because their behavior and tests are frozen, but internally they parse exclusively through the registry-typed scanner — a flag spelling cannot exist there without a registry declaration. This is the strongest guarantee compatible with unchanged behavior, and it is what this plan claims — no more.

### Declared behavior changes (exactly two, both flagged)

- `dispatch`, `harvest`, `close`, `gc`, `delivery`, `skills`, `evals` become `autoUpgrade: true`. Today they skip the weekly upgrade check only because they're absent from the metadata — the same drift this task fixes. These are normal live commands, not bootstrap commands; the exempt set remains only `help`, `version`, `upgrade`, `completion`, and the new `__complete`. Isolated in its own commit unit and called out in the PR description as a user-visible change.
- The completion script text changes wholesale (allowed by Assumptions); the dual-mode `#compdef` + `funcstack` frame and both README install flows are preserved.

There are **no** parsing behavior deltas: per-command token policies reproduce today's classification exactly, verified by parity tests.

---

## Files and changes

### 1. `src/commands.ts` — rewrite as the typed registry

New/changed types (replacing `CompletionOption`/`CompletionSubcommand`/`CommandSpec`):

```ts
export type CompletionChoice = { name: string; description: string }

// Descriptor, not function — keeps this module import-light (startup-sensitive).
export type ValueSource =
  | { kind: 'static'; choices: readonly CompletionChoice[] }
  | { kind: 'task-id' }
  | { kind: 'show-step'; task: 'latest' | 'arg1' }
  | { kind: 'lesson-id' }
  | { kind: 'backlog-id' }
  | { kind: 'eval-case' }
  | { kind: 'skill-name'; insert: 'bare' | 'directive' } // directive ⇒ complete as $name
  | { kind: 'none' } // freeform: intent text, -m messages, --dir paths

export type OptionSpec = {
  name: string            // canonical: '--message', '--limit', '--force-new'
  alias?: string          // '-m'
  description: string
  value?: ValueSource     // absent ⇒ boolean flag
  equals?: boolean        // also accepts/completes --name=value
  repeat?: boolean        // may appear multiple times (lessons edit --stage)
  tail?: boolean          // consumes ALL remaining tokens as its value (--verify);
                          // completion offers nothing after it
}

export type PositionalSpec = {
  name: string                          // display only ('task-id', 'intent…')
  sources: readonly ValueSource[]       // show pos 1 = [task-id, show-step:latest]
  variadic?: boolean                    // trailing freeform
}

export type SubcommandSpec = {
  name: string
  description: string
  options?: readonly OptionSpec[]
  positionals?: readonly PositionalSpec[]
  subcommands?: readonly SubcommandSpec[]
}

export type CommandSpec = SubcommandSpec & { autoUpgrade: boolean; hidden?: boolean }
```

`COMMANDS` declared **`as const satisfies readonly CommandSpec[]`**, exporting:

```ts
export type CommandName = (typeof COMMANDS)[number]['name']
// Typed lookup preserving the literal-name union — NOT ReadonlyMap<string, CommandSpec>,
// which would widen spec.name to string and break HANDLERS[spec.name] indexing.
export function resolveCommand(name: string): (typeof COMMANDS)[number] | undefined
export type SubcommandNames<C extends CommandName> = /* extract from const tuple */
```

Full corrected metadata (current commands, nothing removed, plus `dispatch`, `harvest`, `close`, `gc`, `delivery`, `skills`, `evals`, `__complete`):

- `add`: adds `--force-new`, `--name <slug>`; `--verify` declared with `tail: true`; positional = variadic intent (`none`).
- `run`: adds `--until-done`, `--no-prompt`.
- `retry`/`resume`/`answer`/`feedback`/`correct`/`close`: shared `MESSAGE_OPTIONS` (`--message` with `alias: '-m'`, `equals: true`, plus `--edit`) + positional 1 = `task-id`. `answer` and `resume` stay hidden.
- `backlog`: `add` (existing flags, `--verify` as `tail: true`), `rm` with positional = `backlog-id`.
- `config`: **subcommands = `edit` only** (drops `set/get/unset/inherit` from completion; the runtime rejection message at cli.ts:1945 is preserved); `edit` adds `--repo`, keeps the legacy positional directory (source `none`) and the current `--global` fallthrough behavior via the `ignore` policy; `--dir` value `none`.
- `show`: positional 1 `sources: [task-id, show-step:latest]`, positional 2 `sources: [show-step:arg1]`. `SHOW_STEP_CHOICES` deleted as a candidate source; a small `SHOW_STEP_DESCRIPTIONS: Record<string, string>` decorates dynamic step names only.
- `ask`: `--print` declared (for completion) + positional 1 = `task-id` + variadic question. Parsing stays bespoke: `--print` is recognized only at args[0], exactly as today (ask.ts:488).
- `session`: `--agent` (`equals: true`, static `codex|claude` values) + positional `task-id`. `codex`/`claude`: positional `task-id`.
- `deck` (`--url` kept), `report` (adds `--all`), `harvest` (adds `--all`): each with positional `task-id`.
- `dispatch`: `--dry-run`, `--limit <n>` (value `none`). `gc`: `--dry-run`. `status`: no args.
- `delivery`: `--task` (value `task-id`) + positional 1 `sources: [static 'none' choice, skill-name(insert: 'directive')]` + variadic policy text. Completion inserts `$<name>` — the canonical directive form (`deliveryRecommendation` emits `$name`; a bare name would be parsed as a policy, not a skill). The parser also accepts `/name`, but only one spelling completes to avoid doubling every skill in the candidate list.
- `skills`: `list`, `edit` (positional `skill-name(insert: 'bare')`, flags `--repo/--global/--committed`).
- `evals`: `list`, `run` (`--keep`; positional = `eval-case`).
- `lessons`: existing subs; `show/rm/edit` positional = `lesson-id`; `curate --eval-case` value = `eval-case`; collapse duplicated `--flag`/`--flag=` pairs into single entries with `equals: true`; `edit --stage` gets `repeat: true`.
- `version` (alias `--version`), `upgrade`, `completion` (subcommand `zsh`), `help` (aliases `-h`, `--help`): `autoUpgrade: false`, dispatched before `maybeAutoUpgrade` as today.
- `__complete`: `hidden: true`, `autoUpgrade: false`, dispatched before `maybeAutoUpgrade`.

`AUTO_UPGRADE_COMMAND_NAMES` becomes a pure derivation — `COMMANDS.filter(c => c.autoUpgrade).map(c => c.name)` — deleting `AUTO_UPGRADE_COMMAND_ORDER` and the import-time throw. `activeCommandChoices()` unchanged in behavior (filters `hidden`; now also hides `__complete`). `auto-upgrade.ts` untouched.

### 2. `src/args.ts` — new declaration-driven scanner

```ts
export type ScanPolicy = {
  // 'error':   undeclared flag-ish tokens fail (input.ts-style commands, lessons, session, deck)
  // 'ignore':  undeclared flag-ish tokens are dropped (run, dispatch, harvest, gc, report,
  //            evals run, skills edit, config edit, backlog add — today's tolerance)
  // 'collect': flag-ish tokens that aren't declared options are positionals
  //            (add intent, delivery policy text)
  unknown: 'error' | 'ignore' | 'collect'
  // Token classification, set per command to reproduce the existing parser EXACTLY:
  // 'dash': -x and --x are flag-ish (default). 'double-dash': only --x (session:
  //         `factory session -x` is a positional task query today).
  flagish?: 'dash' | 'double-dash'
  // deck treats lone '-' as an unknown option; report ignores it; default: positional.
  loneDash?: 'positional' | 'flagish'
}
export type ScanError =
  | { kind: 'unknown-option'; option: string }
  | { kind: 'missing-value'; option: string }

type FlagValues<Spec extends readonly OptionSpec[]> = {
  [O in Spec[number] as O['name']]:
    O extends { tail: true } ? string[] | undefined   // the raw tail tokens, if present
    : O extends { value: ValueSource } ? string[]
    : boolean
}

export function scanArgs<const Spec extends readonly OptionSpec[]>(
  options: Spec,
  args: string[],
  policy: ScanPolicy
):
  | { ok: true; flags: FlagValues<Spec>; positionals: string[] }
  | { ok: false; error: ScanError }
```

Semantics: valued flags collect `string[]` (callers pick first-wins/last-wins/reject-repeat to match today); `equals` recognized only when declared; a `tail` option consumes every remaining token verbatim into its value (the `--verify` split). Callers format `ScanError` into their existing exact error strings.

### 3. `src/cli.ts` — dispatch rewrite

- `type CommandHandler = (inv: Invocation) => number | Promise<number>` where `Invocation` carries `command: CommandName`, `opts: MainOptions`, and the **scan result** (`flags` + `positionals`) computed by `main()` against the command's registry spec and policy. Handlers for scanner-grammar commands never see raw argv. The bespoke-parser commands (`add`, the six message commands, `ask`, `session`/`codex`/`claude`, `deck`) forward their tail to the frozen parser-module signatures — those modules parse internally via `scanArgs` with the registry spec (§4–6), so flag reads remain registry-typed there too.
- Each `if (cmd === '…')` block becomes a named `async function xCommand(inv)` — bodies moved verbatim except parsing. Shared handlers: `retry`/`resume` → one function reading `inv.command`; `codex`/`claude` → one function passing `inv.command` as `defaultAgent`/`commandName`.
- `const HANDLERS: Record<CommandName, CommandHandler>` — exhaustive and excess-checked.
- New `main()`:
  ```ts
  const [cmd, ...rest] = opts.argv ?? process.argv.slice(2)
  const name = normalizeCommand(cmd) // undefined→'help', '-h'/'--help'→'help', '--version'→'version'
  const spec = name ? resolveCommand(name) : undefined
  if (!spec) { log.fail(`unknown command: ${cmd}`); log.log(HELP); return 1 }
  if (spec.autoUpgrade) {
    const r = await (opts.autoUpgrade ?? maybeAutoUpgrade)({ command: spec.name })
    if (r.kind === 'exit') return r.code
  }
  return HANDLERS[spec.name](buildInvocation(spec, rest, opts))
  ```
  Preserves the exact exemption set (`help`/`version`/`upgrade`/`completion` never hit `opts.autoUpgrade` — the auto-upgrade.test.ts spy assertions) and adds `__complete` to it. The pre-branch handlers keep the `opts.upgrade`/`opts.completion` injection seams. `MainOptions` unchanged.
- Per-command policies (each reproducing today's exact token rule): `run`/`dispatch`/`harvest`/`gc`/`evals run`/`skills edit`/`config edit`/`backlog add` → `ignore`; `report` → `ignore` with `loneDash: 'flagish'` (lone `-` ignored, as `rest.find(a => !a.startsWith('-'))` does today); `delivery` → `collect` (policy text — including flag-looking words — is never dropped or errored); `lessons` loops → `error` (scope/stage/min-cluster validation stays local, same thrown usage strings); `session` → `error` with `flagish: 'double-dash'`; `deck` → `error` with `loneDash: 'flagish'`. `dispatch --limit` keeps first-value + same NaN/≤0 error; `-m` last-wins; repeated `delivery --task` → same usage error.
- `ask`: the one grammar the scanner can't express without dedicated machinery — `--print` only at args[0], anywhere else it's question text. Kept bespoke and byte-identical; the flag is registry-declared for completion. The single accepted exception.
- Subcommand dispatch inside `backlog`/`lessons`/`skills`/`evals`/`config` uses the same mapped-type pattern one level down (`Record<SubcommandNames<'lessons'>, …>`), with default-subcommand quirks (`evals`→list, `skills`→list, `lessons` unknown-first-arg→list-args, bare `config`→print) handled before lookup, exactly as today. `config set/get/unset/inherit` still hit the existing rejection message.
- `HELP` string: untouched.

### 4. `src/add-options.ts` — scanner adoption, signature frozen

`parseAddOptions` keeps its exported signature and all `ADD_USAGE`-prefixed messages; internally it scans with the registry's `add` spec (`collect` policy — unknown flags flow into intent, as today; `--verify` as the declared `tail` option). The complexity-after-verify rejection inspects the tail tokens from the scan result, preserving the current error. `tests/add-options.test.ts` passes unmodified.

### 5. `src/input.ts` — `parseInputArgs` on the scanner

Consumes the shared `MESSAGE_OPTIONS` spec (`error` policy). Preserved: `-m`/`--message` last-wins, `--message=`, `--edit`, `unknown option ${arg}\n${usage}`, >1 positional → usage + "the message is set with…". `resolveMessage` untouched.

### 6. `src/agent-session.ts`, `src/deck.ts` — same treatment

Rebuilt on `scanArgs` with their registry specs and the per-command policies above (`session`: `double-dash`; `deck`: lone `-` flag-ish). Agent-value validation and all message strings stay local and identical.

### 7. `src/view.ts` — one-line change

`export` the existing `activitySteps(task)` (view.ts:289). No behavior change.

### 8. `src/eval-run.ts` — silence-able warnings

`listEvalCases(repoStateDir, opts?: { onSkip?: (message: string) => void })`, default `log.warn` (behavior unchanged for current callers). The completion helper passes a no-op so malformed cases can't leak warnings into the candidate stream.

### 9. `src/complete.ts` — new: candidate computation + helper entry

```ts
export type Candidate = { name: string; description: string }
export type SourceResolver = (source: ValueSource, ctx: { words: string[] }) => Promise<Candidate[]>

export async function completeCandidates(
  words: string[], cword: number, resolve: SourceResolver
): Promise<Candidate[]>                       // pure registry walk — unit-testable

export function defaultResolver(cwd: string): SourceResolver
export async function runComplete(args: string[], io: CompletionIo): Promise<number> // ALWAYS 0
```

Walk logic: at `cword === 0` offer `activeCommandChoices()` (plus `--help/--version/-h` when the partial starts with `-`); otherwise resolve the command (hidden ones included — `resume`/`answer` still complete their flags), descend through subcommands, then: past a `tail` option → no candidates; previous word is a declared valued flag → its source; partial is `--x=p` for an `equals` option → full `--x=value` strings; partial starts with `-` → the level's option names (canonical + alias) with descriptions; else → the Nth positional's `sources` in order. No prefix filtering — zsh's `_describe` matches the partial.

`defaultResolver`: lazily `loadContext(cwd)` / `loadRepoContext(cwd)`, each source individually wrapped in try/catch → `[]`. Mappings:

- `task-id` → **tolerant per-task read**: enumerate task dirs, parse each `meta.json` in its own try/catch, skip corrupt entries — one bad task must not disable the source; description = status.
- `show-step:latest` → `latestTask` + `activitySteps`, description from `SHOW_STEP_DESCRIPTIONS` or "agent activity step".
- `show-step:arg1` → `findTask(ctx, words[1])` + `activitySteps` (no static fallback — a task with no activity files yields no step candidates, matching what `showActivity` would accept).
- `lesson-id` → `listGuidance`, description = truncated text. `backlog-id` → `loadBacklog`. `eval-case` → `listEvalCases(dir, { onSkip: noop })`. `skill-name` → `listDeliverySkills`, name emitted per `insert` (`bare` or `$name`). `static` → choices. `none` → `[]`.

`runComplete` protocol: `argv = [cwordIndex, ...words]` (0-based; index ≥ words.length ⇒ empty partial). Output: one `name\tdescription\n` per candidate. **Sanitization**: names and descriptions have `\t`/`\n`/`\r` replaced with spaces and descriptions truncated (~80 chars) before emission — user-authored lesson text, backlog intents, and skill frontmatter must not corrupt the line protocol. Whole body in try/catch; on any error emit nothing; never write stderr, never exit nonzero, never prompt, no model calls, no state creation.

### 10. `src/completion.ts` — thin-shim rewrite

`renderZshCompletionScript()` emits a fixed script (per-command `_factory_*` functions and `mustCommandSpec`/`mustSubcommandSpec` deleted):

- Same `#compdef factory` header and dual-mode `funcstack`/`compdef` footer (the frame `tests/completion.test.ts` asserts), so both README install flows keep working unchanged.
- `_factory()` invokes the completed program itself — `${words[1]} __complete $((CURRENT - 2)) "${(@)words[2,-1]}"` — reads tab-separated lines into a `name:description` array, **escaping `:` in both fields** before feeding `_describe` (with TS-side sanitization, `:` is the only remaining special character). Empty or malformed output → no matches, silently.

`runCompletion` and `completionUsage` unchanged (zsh-only guard, same usage strings, injectable `CompletionIo`).

### 11. Tests

**`tests/completion.test.ts`** — update:
- Keep verbatim: dual-mode frame test, `runCompletion` stdout/stderr/exit tests, `zsh -n` parse, source-mode and fpath-mode registration, the no-state safety test.
- Replace the per-command script-text assertions and `config set` cases with assertions that the script contains the `__complete` invocation and the colon-escaping conversion.
- Update the exact `activeCommandChoices()` list: current commands + the seven new ones (registry order); still excludes `answer`, `resume`, `__complete`.
- zpty harness: put a `factory` wrapper script (`#!/bin/sh\nexec bun <abs cli.ts> "$@"`) on `PATH` so `${words[1]}` resolves; keep the `factory ve\t` → `version` and `backlog`/`lessons` subcommand smokes; add one dynamic smoke (temp repo + fabricated task dir + `triage.activity.jsonl` → `factory show tri\t` → `triage`) — skip-silent without zsh.

**`tests/complete.test.ts`** — new, the CI-guaranteed proof layer (zsh-independent):
- `completeCandidates` with a fake resolver: command position (hidden excluded), option position per command (the seven new commands and new flags complete; `config` offers only `edit`), flag-value position (`--task`, `--agent`, `--scope`, equals form), positional sources, **nothing after `--verify`**, delivery positional yields `none` + `$name` forms.
- Motivating case with a real fixture (pattern from `tests/view.test.ts` + `addTask`): task with `triage.activity.jsonl` → `show` pos 1 = task ids (status descriptions) ∪ latest steps incl. `triage`; pos 2 with `words[1]=<task>` = that task's steps; no activity files → empty, no static fallback.
- `runComplete` hardening: subprocess `bun src/cli.ts __complete 0` from a non-git temp cwd with temp `FACTORY_HOME` → exit 0, stdout has command candidates, empty stderr, `FACTORY_HOME` untouched; malformed `meta.json` fixture → exit 0, other tasks' ids still complete; candidate with embedded `\t`/`\n`/`:` in lesson text → emitted lines still parse as exactly two tab-separated fields.

**`tests/auto-upgrade.test.ts`** — update the expected `AUTO_UPGRADE_COMMAND_NAMES` list (registry order, plus the seven — the declared behavior change); keep the consistency loop; add `__complete` to the "returns before auto-upgrade" spy test.

**`tests/args.test.ts`** — new: policies (`error`/`ignore`/`collect`), `flagish` variants, `loneDash` variants, equals/alias/repeat, missing-value, tail consumption.

**`tests/dispatch-parity.test.ts`** — new: one focused `main({argv})` or subprocess case per rewritten parsing style, pinning today's exact output and exit codes (reusing the lessons-cli.test.ts temp-repo/`FACTORY_HOME` pattern):
1. `add --verify … --complexity high` → complexity-after-verify error; `add foo --json bar` → `--json` lands in intent.
2. Message parser: `retry <id> -m a -m b` last-wins; `retry <id> --wat` → `unknown option --wat` + usage.
3. `session -x` → treated as positional query (not an option error); `session --wat` → error.
4. `deck -` → unknown-option error; `deck --wat` → unknown-option error.
5. `report -` → ignored (behaves as today); `run --bogus` → still runs (tolerance preserved).
6. `delivery keep --it simple` → full text becomes policy (flag-looking word not dropped); repeated `--task` → usage error.
7. `config edit <dir>` legacy positional accepted; `config edit --global` unchanged; `config set` → the existing "task delivery moved out of config" rejection.
8. `dispatch --limit x` → positive-number error; `--limit 2 --limit 5` → first wins.
9. `lessons edit <id> --wat` → thrown usage string; `evals wat` / `skills wat` / `backlog rm` (missing id) → usage, exit 1.
10. `ask --print <id> q` works; `ask <id> what does --print do` → `--print` is question text.

`tests/add-options.test.ts`, `tests/lessons-cli.test.ts`, `tests/version.test.ts` pass unmodified.

---

## Verification

```
cd /Users/evan.solomon/code/factory/factory-kfa_f-autocomplete && bun run test
```

(`biome check . && tsc --noEmit && bun test`; run `bun install --frozen-lockfile` first if node_modules is absent.) Compile-time criterion self-check during review: temporarily add a dummy handler key, and read an undeclared flag in a handler and in a parser module — confirm `tsc` rejects all three.

Manual smoke in zsh if available: `factory show tri<TAB>` offers `triage` from the latest task's real activity files; `factory <TAB>` shows the seven previously missing commands and hides `answer`/`resume`/`__complete`; `factory config <TAB>` offers only `edit`; `factory dispatch --<TAB>` offers `--dry-run`/`--limit`; `factory delivery <TAB>` offers `none` and `$skill` forms.

## Order

1. `bun install --frozen-lockfile` if needed; confirm green baseline.
2. `src/args.ts` + `tests/args.test.ts` (standalone).
3. `src/commands.ts` registry rewrite: types (incl. `tail`, `skill-name.insert`), `as const satisfies` COMMANDS with full corrected metadata, `CommandName`, `resolveCommand`, derived `AUTO_UPGRADE_COMMAND_NAMES`; update `tests/auto-upgrade.test.ts`. The auto-upgrade flag flip for the seven commands is its own commit unit, labeled as a behavior change. (Steps 3–7 form one compile unit — `completion.ts` compiles against the new types only after step 7's rewrite, so keep them on the branch together before running the gate.)
4. Parser modules onto the scanner: `input.ts`, `agent-session.ts`, `deck.ts`, `add-options.ts`; `view.ts` export; `eval-run.ts` `onSkip`.
5. `cli.ts`: extract handlers, `HANDLERS`, new `main()` with boundary scanning + per-command policies, lessons loops → `scanArgs`, wire `__complete`.
6. `src/complete.ts` + `tests/complete.test.ts`.
7. `src/completion.ts` thin-shim rewrite + `tests/completion.test.ts` update.
8. `tests/dispatch-parity.test.ts`.
9. Full gate; manual zsh smoke of the acceptance flows.
