# Plan: First-Class Learned Lessons

## Summary

Add structured, file-backed learned lessons as the first-class learning system for factory. Lessons are stored globally, can be scoped globally or to a repo, are tagged with the pipeline stages where they apply, and are automatically injected into relevant prompts across the existing hard-coded conductor pipeline.

Keep `LESSONS.md` and `LESSONS.candidates.md` working as legacy repo-level context. Do not build a dynamic workflow engine in this task.

Use the existing `factory lessons` command as the user-facing management surface. Internally, the implementation may use `guidance.ts` and “guidance records,” but the CLI and docs should consistently describe these as learned lessons.

## Design Decisions

- Store structured learned lessons under global factory state: `$FACTORY_HOME/guidance/items/*.json`.
- Use one JSON file per lesson record, validated with zod on read.
- Each record has a stable id, timestamps, source signal, scope, stage applicability, text, optional tags/rationale, and active/deleted status.
- Default uncertain scope to global.
- Apply lessons automatically without per-use approval.
- Soft-delete records so removal is recoverable and auditable.
- Keep legacy `LESSONS.md` as curated repo guidance and keep `LESSONS.candidates.md` as a raw human-curation queue.
- Inject learned lessons into existing prompts instead of changing the conductor DAG.
- Bound per-stage injection to prevent prompt bloat.
- Include lesson ids in rendered prompt blocks so bad guidance can be corrected from artifacts.

## Structured Record Model

Add `src/guidance.ts`.

### Stage Schema

Only include stages that are actually injected in v1:

```ts
export const GuidanceStageSchema = z.enum([
  'plan',
  'critique',
  'reconcile',
  'implement',
  'fix',
  'review',
  'security',
  'deploy-safety',
  'ux-review',
  'consolidate',
  'remediate',
  'postmortem',
])
```

### Scope Schema

```ts
const GuidanceScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({
    kind: z.literal('repo'),
    repoStateDir: z.string().min(1),
    repoRoot: z.string().min(1),
  }),
])
```

Use `repoStateDir` as the matching key for repo-scoped records.

### Source Schema

```ts
const GuidanceSourceSchema = z.object({
  kind: z.enum(['postmortem', 'correction', 'manual']),
  taskId: z.string().nullable().default(null),
  detail: z.string().nullable().default(null),
})
```

Manual creation is not required in v1, but the schema can support records edited or introduced later.

### Record Schema

```ts
export const GuidanceRecordSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  source: GuidanceSourceSchema,
  scope: GuidanceScopeSchema,
  stages: z.array(GuidanceStageSchema).min(1),
  tags: z.array(z.string()).default([]),
  text: z.string().min(1),
  rationale: z.string().nullable().default(null),
  status: z.enum(['active', 'deleted']).default('active'),
  deletedAt: z.string().nullable().default(null),
})
```

## Storage API

Add these public functions in `src/guidance.ts`:

```ts
export async function loadGuidance(): Promise<GuidanceRecord[]>

export function applicableGuidance(
  records: GuidanceRecord[],
  ctx: WorkContext,
  stage: GuidanceStage,
): GuidanceRecord[]

export function renderGuidanceBlock(records: GuidanceRecord[]): string | null

export async function createGuidanceRecord(
  ctx: WorkContext,
  input: {
    source: GuidanceRecord['source']
    scope: GuidanceRecord['scope']
    stages: GuidanceStage[]
    tags?: string[]
    text: string
    rationale?: string | null
  },
): Promise<GuidanceRecord>

export async function listGuidance(
  ctx: WorkContext,
  opts?: {
    includeDeleted?: boolean
    scope?: 'global' | 'repo'
    stage?: GuidanceStage
  },
): Promise<GuidanceRecord[]>

export async function findGuidance(
  ctx: WorkContext,
  query: string,
  opts?: { includeDeleted?: boolean },
): Promise<{ record: GuidanceRecord } | { ambiguous: GuidanceRecord[] } | null>

export async function deleteGuidance(
  ctx: WorkContext,
  query: string,
): Promise<{ deleted: GuidanceRecord } | { ambiguous: GuidanceRecord[] } | null>

export async function editGuidance(
  ctx: WorkContext,
  query: string,
  patch: {
    text?: string
    stages?: GuidanceStage[]
    scope?: GuidanceRecord['scope']
  },
): Promise<{ edited: GuidanceRecord } | { ambiguous: GuidanceRecord[] } | null>
```

Implementation requirements:

- Directory: `${guidanceDir()}/items/`
- File name: `<id>.json`
- Validate every read with zod.
- Skip malformed records with `log.warn`.
- Missing guidance directory returns `[]`.
- Writes use temp file plus rename.
- Delete is soft-delete: set `status: 'deleted'`, `deletedAt`, and `updatedAt`.
- Exact id lookup wins; otherwise allow a single partial id match; ambiguous partials fail with matching ids.

## Config

In `src/config.ts`, add:

```ts
export function guidanceDir(): string {
  return `${factoryHome()}/guidance`
}
```

Do not expose `factoryHome()` unless another caller genuinely needs it.

## Applicability

A lesson applies when:

- `status === 'active'`
- stage exactly matches the requested stage
- scope is global, or scope is repo and `scope.repoStateDir === ctx.repoStateDir`

Sort applicable lessons by `updatedAt` descending.

## Rendering

`renderGuidanceBlock` should:

- Deduplicate exact normalized text.
- Cap rendered records per stage, for example 12 most recent active records.
- Include ids and scope labels.
- Return `null` when empty.
- Log a warning when records are dropped by cap or dedup, but never fail the task.

Rendered prompt block:

```md
## Learned lessons (auto-applied; edit with `factory lessons edit <id>`)
- [global abc123] Prefer URLs over local component state for navigation state.
- [repo def456] In factory, keep marker-line prompt contracts unchanged.
```

## Prompt Changes

Keep the existing legacy `lessonsBlock` for `LESSONS.md`.

Add a separate helper for structured learned lessons:

```ts
function learnedLessonsBlock(guidance: string | null): string
```

Do not merge legacy markdown into structured bullets.

### Prompt Signature Updates

Add structured guidance parameters to prompts that consume it:

```ts
planPrompt(..., lessons: string | null, guidance: string | null, ...)
critiquePrompt(..., lessons: string | null, guidance: string | null, ...)
reconcilePrompt(..., guidance: string | null)
implementPrompt(..., guidance: string | null, feedbackAnalysis?: string | null)
fixPrompt(..., guidance: string | null, feedbackAnalysis?: string | null)
reviewPrompt(..., guidance: string | null)
securityPrompt(..., guidance: string | null)
deploySafetyPrompt(..., guidance: string | null)
uxReviewPrompt(..., guidance: string | null)
consolidatePrompt(..., guidance: string | null)
remediatePrompt(..., guidance: string | null)
postmortemPrompt(..., guidance: string | null)
```

Be careful with positional parameters, especially `implementPrompt` and `fixPrompt`, so existing `feedbackAnalysis` behavior remains intact.

### Capture Prompt Markers

Extend `postmortemPrompt` and `correctionPrompt` so the same reviewer call emits structured metadata.

Keep existing markers unchanged:

```md
CATEGORY:
LESSON:
```

Add:

```md
ACTIONABLE: YES|NO
SCOPE: GLOBAL|REPO
STAGES: plan,implement,review
```

Rules:

- `ACTIONABLE: NO` means do not create a structured learned lesson.
- `SCOPE` defaults to `GLOBAL` when uncertain.
- `STAGES` must use only known `GuidanceStageSchema` values.
- Invalid metadata should not block the task; keep the raw candidate and log a warning.

## Conductor Integration

In `src/conductor.ts`:

- Load structured guidance before the resume branch so resumed runs also receive guidance.
- Loading failures must log warnings and continue with `[]`.
- Continue reading legacy lessons separately via `readLessons(ctx)`.

Add a helper near `runTask`:

```ts
const stageGuidance = (stage: GuidanceStage): string | null => {
  const matched = applicableGuidance(guidance, ctx, stage)
  return renderGuidanceBlock(matched)
}
```

Inject:

- `planPrompt`: `plan`
- `critiquePrompt`: `critique`
- `reconcilePrompt`: `reconcile`
- `implementPrompt`: `implement`
- `fixPrompt`: `fix`
- correctness review prompt: `review`
- security review prompt: `security`
- deploy safety review prompt: `deploy-safety`
- UX review prompt: `ux-review`
- `consolidatePrompt`: `consolidate`
- `remediatePrompt`: `remediate`
- `postmortemPrompt`: `postmortem`

Do not rely on critique guidance indirectly reaching reconcile.

Trivial-task fast paths still receive implementation guidance.

## Capture

### Postmortems

In the existing postmortem flow:

- Keep appending raw lessons to `LESSONS.candidates.md`.
- Parse `ACTIONABLE`, `SCOPE`, and `STAGES` from the same postmortem output.
- If actionable and valid, create a structured guidance record.
- If invalid, keep only the raw candidate and warn.
- Capture is best-effort and must never change task outcome.

Source:

```ts
{
  kind: 'postmortem',
  taskId: task.id,
  detail: category,
}
```

### Corrections

In `src/evals.ts`, after existing correction distillation:

- Keep eval candidate capture unchanged.
- Keep raw lesson candidate behavior unchanged.
- Parse `ACTIONABLE`, `SCOPE`, and `STAGES`.
- If actionable and valid, create a structured guidance record.
- If invalid, fall back to raw candidate only and warn.

Source:

```ts
{
  kind: 'correction',
  taskId: task.id,
  detail: category,
}
```

### Needs Input

Leave needs-input as raw candidates in v1. Do not promote it to structured guidance until all pause sites are explicitly wired and the signal is proven useful.

## Legacy Lessons

In `src/lessons.ts`:

- Preserve current behavior.
- Clarify comments:
  - `LESSONS.md` is legacy curated repo guidance.
  - `LESSONS.candidates.md` is a raw human-curation queue.
  - Structured learned lessons live under global factory state.
- Make `readLessons` and `readCandidates` tolerant if they are not already: warn and return `null` on read failure.

## CLI

Expand `factory lessons` into the management surface.

Supported commands:

```bash
factory lessons
factory lessons list [--all] [--scope global|repo] [--stage <stage>]
factory lessons show <id>
factory lessons rm <id>
factory lessons edit <id> [-m "<text>" | --message "<text>" | --scope global|repo | --stage <stage>... | --edit]
```

Do not add a `delete` alias. Use `rm`, matching `factory backlog rm`.

Behavior:

- `factory lessons` defaults to `list`.
- Structured records appear first.
- Legacy `LESSONS.md` and candidates appear below under clear read-only labels.
- Empty structured state:

```text
no learned lessons yet - corrections become lessons automatically
```

- `show <id>` accepts exact id or one unambiguous partial id.
- `rm <id>` soft-deletes exact or one unambiguous partial id.
- `edit <id>` can update text, scope, and stages.
- Ambiguous partial ids fail with matching ids.
- Missing ids fail with usage.
- Write failures fail nonzero with explicit messages.

Success output:

```text
lessons -abc123 (removed)
lessons abc123 (updated)
```

Legacy section labels:

```md
## Legacy LESSONS.md (read-only here; edit the file directly)
## Raw candidates (read-only here; edit the file directly)
```

## Command Metadata And Completion

In `src/commands.ts`:

- Update `lessons` description to: `Learned lessons, legacy lessons, and raw candidates`
- Add subcommands:
  - `list`
  - `show`
  - `rm`
  - `edit`
- Add options:
  - list: `--all`, `--scope`, `--stage`
  - edit: `-m`, `--message`, `--edit`, `--scope`, `--stage`
- Keep `lessons` in `AUTO_UPGRADE_COMMAND_ORDER`.

In `src/completion.ts`, add completion for:

- subcommands: `list`, `show`, `rm`, `edit`
- list options: `--all`, `--scope`, `--stage`
- edit options: `-m`, `--message`, `--edit`, `--scope`, `--stage`
- scopes: `global`, `repo`
- stages from `GuidanceStageSchema`

## README

Update usage:

```bash
factory lessons [list|show|rm|edit] ...       # inspect and manage learned lessons
```

Replace the meta-loop section with “Meta loop and learned lessons.”

Document:

- Structured learned lessons live under `$FACTORY_HOME/guidance/items/*.json`.
- Records include id, scope, stages, source signal, status, timestamps, and text.
- Global records apply everywhere.
- Repo records apply only when the current repo state dir matches.
- Lessons are auto-applied to relevant stages.
- `LESSONS.md` remains legacy curated planning/critique context.
- `LESSONS.candidates.md` remains a raw human-curation queue.
- Use `factory lessons list/show/rm/edit` to inspect, remove, or fix records.
- Eval replay/scoring and dynamic workflow DAGs remain out of scope.

## Tests

### `tests/guidance.test.ts`

Cover:

- valid record parsing
- malformed records skipped while valid records still load
- missing guidance dir returns `[]`
- global guidance applies everywhere
- repo guidance applies only on matching `repoStateDir`
- stage filtering includes and excludes correctly
- deleted records excluded unless requested
- exact, single partial, ambiguous, and missing id lookup
- soft delete preserves the file
- edit updates text, scope, stages, and timestamps without changing id/source
- render includes ids, scope labels, and text
- render deduplicates and caps records

### `tests/prompts.test.ts`

Cover guidance injection into:

- plan
- critique
- reconcile
- implement
- fix
- review
- security
- deploy safety
- UX review
- consolidate
- remediate
- postmortem

Also cover:

- legacy lessons and structured learned lessons appear as separate blocks
- `feedbackAnalysis` still appears correctly in `implementPrompt` and `fixPrompt`
- `postmortemPrompt` and `correctionPrompt` still require `CATEGORY:` and `LESSON:`
- `postmortemPrompt` and `correctionPrompt` now require `ACTIONABLE:`, `SCOPE:`, and `STAGES:`

### `tests/evals.test.ts`

Cover correction parsing:

- valid actionable correction creates structured guidance
- invalid stages fall back to raw candidate only
- `ACTIONABLE: NO` does not create structured guidance
- raw candidate capture still happens

### CLI Tests

Add CLI-level tests if stable helpers exist:

- `factory lessons list` exits 0 on empty guidance
- `factory lessons show <id>` prints one record
- `factory lessons rm <partial>` refuses ambiguous matches
- `factory lessons edit <id> -m <text>` updates text
- `factory lessons edit <id> --scope repo` updates scope
- `factory lessons edit <id> --stage plan --stage review` updates stages

If CLI capture helpers are weak, cover mutation behavior in `guidance.test.ts` and command discoverability in metadata/completion tests.

### Completion And Auto-Upgrade Tests

Update expectations for:

- `lessons` subcommands
- `list`, `show`, `rm`, `edit`
- `--all`, `--scope`, `--stage`, `--message`, `--edit`
- command ordering if exact order is asserted

## Implementation Order

1. Add `guidanceDir()` in `config.ts`.
2. Add `src/guidance.ts` with schemas, storage, filtering, rendering, lookup, delete, and edit.
3. Extend postmortem and correction prompts with actionable/scope/stage markers.
4. Add structured marker parsing helpers.
5. Add learned lesson prompt block while keeping legacy lessons block.
6. Update prompt signatures and call sites.
7. Load structured guidance in `conductor.ts`.
8. Inject stage-filtered guidance into plan, critique, reconcile, implement, fix, review experts, consolidate, remediate, and postmortem.
9. Add structured capture from postmortems.
10. Add structured capture from corrections in `evals.ts`.
11. Expand `factory lessons` CLI with list/show/rm/edit.
12. Update command metadata and completion.
13. Update README.
14. Add and update tests.
15. Run verification with permission.

## Verification

Run, with permission:

```bash
bun run test
```

The verification should prove:

- structured records validate and malformed files are tolerated
- guidance filtering respects scope, repo, stage, deletion, dedup, and cap
- legacy `LESSONS.md` still applies separately
- guidance is injected into every required prompt site
- postmortem and correction metadata creates structured records without a second reviewer call
- CLI list/show/rm/edit is targeted and recoverable
- command metadata/help/completion stay discoverable
- existing marker contracts remain intact where parsers depend on them
