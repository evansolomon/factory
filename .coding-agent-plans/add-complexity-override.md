# ## Problem

# Plan: Add explicit task complexity overrides

## Goal

Add deterministic complexity control to `factory add`:

- `factory add --trivial ...`
- `factory add --complexity trivial ...`
- `factory add --complexity complex ...`

The override is persisted in task metadata and consumed by `runTask`. Declared complexity skips model triage but does not create a new execution mode: implement, review, verify, commit, and configured delivery still run normally.

## Design

Use task metadata as the single source of truth.

A declared `trivial` task uses the existing trivial path: `finalPlan = intent`, no planning ensemble, no risk plan, no plansDir artifact.

A declared `complex` task skips the triage classifier but runs the existing full planning path.

Tasks without an override behave exactly as they do today.

Do not support this in `factory backlog add`. Do not add branch-maintenance, rebase, force-push, new delivery permissions, new marker lines, or new agent access modes.

## Metadata

In `src/task.ts`, add:

```ts
export const TaskComplexitySchema = z.enum(['trivial', 'complex'])
export type TaskComplexity = z.infer<typeof TaskComplexitySchema>
```

Extend `MetaSchema` with:

```ts
// Explicit complexity declared by `factory add`; null means runtime triage decides.
complexity: TaskComplexitySchema.nullable().default(null),
```

This preserves legacy task loading because old `meta.json` files default to `null`.

Refactor `addTask` to use an options object instead of adding another positional argument:

```ts
export type AddTaskOptions = {
  status?: Status
  complexity?: TaskComplexity | null
}

export async function addTask(
  ctx: WorkContext,
  intent: string,
  verify: string | null,
  options: AddTaskOptions = {}
): Promise<Task>
```

Persist `complexity` into `meta.json`.

Update all existing `addTask` call sites and tests to the new options shape.

## CLI Parsing

Add a small import-safe parser module, `src/add-options.ts`, so parser tests do not import `src/cli.ts`.

Export:

```ts
import type { TaskComplexity } from './task.ts'

export type ParsedAddOptions = {
  args: string[]
  raw: boolean
  complexity: TaskComplexity | null
}

export type ParseAddOptionsResult =
  | { ok: true; options: ParsedAddOptions }
  | { ok: false; message: string }

export function parseAddOptions(args: string[]): ParseAddOptionsResult
```

Parser behavior:

- Recognize `--raw`, `--trivial`, and `--complexity trivial|complex`.
- Parse complexity flags only before the first `--verify`.
- Preserve the verify command tail byte-for-byte after `--verify`.
- Preserve `--edit` in `args`; `resolveIntent` still owns editor behavior.
- `--trivial` means `complexity: 'trivial'`.
- `--trivial --complexity trivial` is accepted.
- `--trivial --complexity complex` fails clearly.
- Missing or invalid `--complexity` fails clearly.
- If `--trivial` or `--complexity` appears after `--verify`, fail clearly instead of treating it as part of the verify command.

Usage error copy should be direct, for example:

```text
usage: factory add [--raw] [--trivial | --complexity trivial|complex] [intent...] [--verify <cmd...>] [--edit]
complexity flags must appear before --verify
conflicting complexity flags: --trivial and --complexity complex
invalid complexity "foo" (expected trivial or complex)
--complexity needs a value: trivial or complex
```

## CLI Wiring

In `src/cli.ts`, wire the parser only into the `add` command.

Flow:

1. Parse add options.
2. On parse error, print `log.fail(message)` and return nonzero.
3. Resolve intent from the cleaned args.
4. Compute:

```ts
const skipSharpen =
  parsed.options.raw || parsed.options.complexity !== null || !process.stdin.isTTY
```

5. If `skipSharpen`, queue directly:

```ts
await addTask(ctx, base.intent, base.verify, {
  complexity: parsed.options.complexity,
})
```

6. If sharpening still applies, create the temporary sharpening task as today:

```ts
await addTask(ctx, base.intent, base.verify, { status: 'sharpening' })
```

Success output should keep the existing single-parenthetical style:

```text
queued fix-typo (trivial)
queued parser-refactor (complex, verify: bun test parser)
```

Update CLI help to show ordering clearly:

```text
factory add [--raw] [--trivial | --complexity trivial|complex] [intent...] [--verify <cmd...>] [--edit]
```

Add adjacent help text:

```text
--raw skips sharpening only; runtime triage still decides complexity.
--trivial / --complexity skip sharpening and use the declared runtime complexity.
```

Do not add rebase or force-push caveats to CLI help; keep that in README.

## Runtime Decision

In `src/conductor.ts`, add a pure helper:

```ts
export type ComplexityDecision =
  | { source: 'declared'; trivial: boolean; complexity: TaskComplexity }
  | { source: 'triage' }
  | { source: 'none' }

export function decideComplexity(
  declared: TaskComplexity | null,
  triageEnabled: boolean
): ComplexityDecision
```

Rules:

- Declared `trivial` returns declared/trivial.
- Declared `complex` returns declared/not-trivial.
- No declaration with triage enabled returns `triage`.
- No declaration with triage disabled returns `none`.

Use this helper before model triage in the fresh-run branch.

For declared complexity:

```ts
trivial = decision.trivial
log.info(`${task.id}: ${decision.complexity} — using declared complexity (skipping triage)`)
```

Do not call the triage agent. Do not write synthetic `triage.md`; that artifact remains model-triage output only. Do not set `stats.triage` for declared overrides unless the metrics type is deliberately broadened, because “model classified” and “user declared” are different facts.

Everything downstream should continue to depend on the existing `trivial` boolean.

## Show Output

In `src/view.ts`, surface declared complexity in `factory show`.

When `task.meta.complexity` is set, append it to the metadata line:

```text
complexity: trivial (declared)
```

This makes the override inspectable before the task runs.

## Tests

Add `tests/add-options.test.ts` for the parser:

- `--trivial Fix typo` returns `complexity: 'trivial'`.
- `--complexity trivial Fix typo` matches `--trivial`.
- `--complexity complex Refactor parser` returns `complexity: 'complex'`.
- `--trivial --complexity trivial Fix typo` is accepted.
- `--trivial --complexity complex Fix typo` fails.
- `--complexity` with no value fails.
- `--complexity maybe` fails.
- Complexity flags before `--verify` are parsed and removed.
- Complexity flags after `--verify` fail with the ordering error.
- Normal verify tokens after `--verify` remain untouched.

Update `tests/task.test.ts`:

- Migrate existing `addTask` calls to the options object.
- Assert new tasks persist declared `trivial`.
- Assert new tasks persist declared `complex`.
- Assert legacy metadata without `complexity` parses as `null`.

Add focused conductor tests for `decideComplexity`:

- Declared `trivial` wins regardless of `config.triage`.
- Declared `complex` wins regardless of `config.triage`.
- No declaration with triage enabled returns `triage`.
- No declaration with triage disabled returns `none`.

A full `runTask` integration harness is not necessary for this change; the useful seam is the pure decision helper plus parser and metadata tests.

## README

Update the README sections covering `factory add`, sharpening, triage, and task metadata.

Document:

- `--trivial` is shorthand for `--complexity trivial`.
- `--complexity complex` skips model triage but runs full planning.
- Complexity flags skip interactive sharpening and queue the intent as written.
- `--edit` still opens the editor first.
- `--raw` skips sharpening only; it does not declare runtime complexity.
- Complexity flags must appear before `--verify`.
- `triage.md` exists only when model triage runs; declared complexity lives in `meta.json`.
- Branch maintenance like fetch/rebase/force-push is not solved by this feature because normal tasks still expect implementation to produce a worktree diff that factory commits.

Do not document backlog support.

## Implementation Order

1. Add `TaskComplexitySchema`, `TaskComplexity`, metadata defaulting, and `AddTaskOptions`.
2. Update all `addTask` call sites.
3. Add `src/add-options.ts` and parser tests.
4. Wire parsed options into `factory add`.
5. Update CLI help and queue success output.
6. Add `decideComplexity` and its tests.
7. Use `decideComplexity` in `runTask`.
8. Show declared complexity in `factory show`.
9. Update README.
10. Ask before running the repo gate.

## Verification

Suggested command, pending permission:

```bash
bun run test
```

Expected coverage:

- Biome passes.
- TypeScript catches all migrated call sites.
- Parser tests cover valid, invalid, missing, conflicting, and post-`--verify` cases.
- Metadata tests prove persistence and legacy defaulting.
- Decision-helper tests prove declared complexity bypasses model triage selection.
