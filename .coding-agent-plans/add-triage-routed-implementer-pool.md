All the load-bearing source facts check out (normAgent passes object specs through, `ComplexityDecision.source` exists, the implement loop's single `lead` call site at src/conductor.ts:2344-2354, the triage block at 2057-2098). Here is the final plan:

---

# Plan: Dynamic implementer pool (`agents.implementers`)

Repos can declare a named pool of alternative implementers. When the pool is non-empty, the existing triage stage additionally picks one (or DEFAULT) via an `IMPLEMENTER:` marker; the chosen agent runs the attempt-0 implement stage only. Empty pool (the default) means zero routing/prompt/marker behavior change. The plan follows the `researchers`/`reviewers` pool precedent throughout.

## Design decisions

1. **Normalization site: use-site, not `RoleAgents`.** The pool is consumed raw from `ctx.config.agents.implementers` and normalized with `normAgent` where used — exactly how `researchers`/`reviewers` work today. `RoleAgents` is untouched; prompt-only metadata stays out of the core role model.
2. **`description` goes on both the object spec and the resolved `Agent` type** (optional). `normAgent` (src/config.ts:68) passes object specs through, so the runtime value already carries it — declaring it on `Agent` keeps the type honest and lets use sites read `agent.description` after normalizing instead of string/object-narrowing raw specs.
3. **Parse vs resolve separation.** `parseTriage` stays a pure marker extractor returning the raw value; a pure exported `resolveImplementer` in conductor.ts (mirroring `decideComplexity`) owns resolution against the pool. Both halves are independently unit-testable without a `runTask` harness.
4. **Exact pool-name matching.** `AgentMapSchema` is a plain `z.record`, so `quick` and `Quick` can coexist — a forgiving match could silently pick the wrong agent. Only the `DEFAULT` sentinel is compared case-insensitively (it's our sentinel, not a user key); pool names match exactly after trimming. Anything unresolvable → `null` (= default implementer), never an error, never a block.
5. **Meta invariant: `meta.implementer` is the most recent fresh run's routing decision** (the pool *name*, nullable). Triage writes the resolved name (possibly null); a fresh run that skips triage (declared complexity or `triage: false`) *clears* any stale value — otherwise a task triaged in a past run could route a later declared-complexity run. Resume reads it as-is and re-resolves against the current pool, so pool edits between runs degrade safely to the default.
6. **Escalation: fix passes (attempt > 0) always use `agents.implementer`.** A failed gate is direct evidence the "easy" call was wrong; this one rule makes routing self-correcting. The existing resume paths that re-enter with notes/feedback already set `attempt ≥ 1` (src/conductor.ts:2288-2291), which composes correctly.
7. **`stats.implementer` is set-once per pass** (`??=`) — the agent label of the *first* implement stage this pass ran. A routed run that later fix-passes keeps the pool agent's label (that's the attribution first-pass yield needs; overwriting would re-attribute every routed-then-fixed run to the default, inverting the metric). A pass that never implements (gates-only resume, delivery-only) stays `null`.
8. **Routing is complexity-independent.** A COMPLEX verdict carrying `IMPLEMENTER: <name>` still routes the post-ensemble attempt-0 implement; the conservative prompt guidance is the control. Tasks that skip triage never consult the pool.
9. **Blast radius: only the code-writing implement stage.** Triage, quickfix, sharpen, reconcile, select, prototype, remediate, commit-message, rescue, and all other lead duties stay on `agents.implementer`.

## Files and changes

### 1. `src/config.ts`

- **`AgentSpecSchema` object form** (lines 17-26): add `description: z.string().optional()` with a comment (human-authored routing/policy hint shown in the triage prompt; valid for both clis — no refine). Update the union error string at lines 29-31 to include `"description"?: string`. The existing `reasoningEffort`/`provider` refinements are untouched and automatically apply to pool entries.
- **`Agent` type** (lines 53-58): add `description?: string`.
- **`AgentsSchema`** (lines 78-96): after `reviewers`, add
  ```ts
  // Optional named pool of alternative implementers. When non-empty, triage
  // additionally picks one (or DEFAULT) for the attempt-0 implement stage;
  // fix passes always escalate to `implementer`. Empty = feature off.
  implementers: AgentMapSchema.default({}),
  ```
- **`AgentsConfig` type** (lines 110-120): add `implementers: Record<string, AgentSpec>`.
- **Default literal in `ConfigSchema`**: add `implementers: {}`.
- **Cascade merge** (line 466): `mergeObjectKey(prior['agents'], raw.agents, ['researchers', 'reviewers', 'implementers'])` — without this, a child `.factory.json` touching `agents` would silently wipe a parent's pool. Update the comment near line 400 that names the merged pools.

### 2. `src/markers.ts`

- **`TriageResult`** (lines 26-31): add `implementer: string | null` — the raw marker value, no validation.
- **`parseTriage`** (lines 74-90): extract with the existing last-match-wins convention, following `parseGateFix`:
  ```ts
  const implementer = lastMarkerMatch(text, /^IMPLEMENTER:\s*(.+)$/i)?.[1]?.trim() ?? null
  ```
  `DEFAULT` and unknown names pass through as raw strings; missing marker → `null`. The required-marker semantics of COMPLEXITY/USER-FACING are unchanged.

### 3. `src/prompts.ts`

- **`triagePrompt`** (lines 560-591): new third parameter of pre-shaped plain data (mirrors `deliverySelectPrompt`'s menu pattern; prompts.ts stays import-free):
  ```ts
  export type ImplementerOption = { name: string; label: string; description: string | null }
  export function triagePrompt(intent: string, verify: string | null, implementers: ImplementerOption[]): string
  ```
- Structure the change as interpolation slots in the existing template so the empty-pool output is byte-identical to today's *by construction*: an optional section that renders to `''` for an empty pool, and a closing sentence reading `Output ONLY these two final lines:` (verbatim, empty pool) or `Output ONLY these three final lines:` (non-empty). The surrounding template text is unchanged in the diff.
- Non-empty pool → insert an IMPLEMENTER section after the USER-FACING examples: explain the named agents are cheaper/faster alternatives for the code-writing stage only; list each entry as `- ${name} — ${label}${description ? `: ${description}` : ''}`; conservative guidance in the style of the existing calibration paragraph — pick a pool agent only when the task is clearly easy AND low-risk; genuinely torn → DEFAULT; note that review/verify gates and default-model fix passes are the safety net either way (the analogue of the COMPLEX-as-hedge warning, so the pool actually gets used). Add 2-3 examples mirroring the trivial/complex examples at lines 574-583. Third output line: `IMPLEMENTER: <name>|DEFAULT`.

### 4. `src/task.ts`

- **`MetaSchema`** (near `complexity`, ~line 107):
  ```ts
  // Pool name of the implementer the most recent fresh run chose
  // (agents.implementers key), or null for the default. Written by triage,
  // cleared by triage-skipped fresh runs, re-resolved against the current pool
  // on resume — a deleted entry falls back to the default implementer.
  implementer: z.string().nullable().default(null),
  ```
  Existing meta files parse unchanged via the zod default.

### 5. `src/conductor.ts`

- **New exported pure resolver** (near `decideComplexity`, ~line 654):
  ```ts
  // Resolve a raw IMPLEMENTER marker value (or a meta-persisted pool name)
  // against the current pool. Returns the pool key, or null meaning "use the
  // default implementer". Fail-safe: DEFAULT (any case), unknown names, and
  // empty pools all resolve to null — routing can never crash or block a task.
  // Pool keys match exactly (after trimming the input): AgentMapSchema allows
  // case-variant sibling keys, so a forgiving match could pick the wrong agent.
  export function resolveImplementer(raw: string | null, pool: Record<string, AgentSpec>): string | null
  ```
  Logic: `null`/whitespace-only → `null`; trimmed value case-insensitively equal to `DEFAULT` → `null`; trimmed value an exact pool key → that key; else `null`.
- **Triage call site** (lines 2064-2098):
  - Build options before the call:
    ```ts
    const pool = ctx.config.agents.implementers
    const implementerOptions = Object.entries(pool).map(([name, spec]) => {
      const agent = normAgent(spec)
      return { name, label: agentLabel(agent), description: agent.description ?? null }
    })
    ```
  - Pass to `triagePrompt(intent, verify, implementerOptions)` (sole caller).
  - After `parseTriage`, only when the pool is non-empty: `const routedName = resolveImplementer(triage.implementer, pool)`. Log at the resolution site (the block check at 2078-2090 gains no new requirement): marker missing → `log.warn` "triage output missing IMPLEMENTER marker; using the default implementer"; marker present but unresolved and not `DEFAULT` → `log.warn` "unknown implementer '<raw>' — using the default"; resolved to a pool name → `log.info` the routing decision. Set `task.meta.implementer = routedName` inside the existing meta-save block (lines 2096-2098) — persisted before implement runs. When the pool is empty, do not inspect or persist `triage.implementer`.
- **Stale-decision clearing** (fresh path, immediately after the triage if/else, ~line 2100):
  ```ts
  // A triage-skipped fresh run (declared complexity or triage off) never
  // consults the pool — clear a routing decision left by an earlier triaged run
  // so it can't leak into this run or a later resume of it.
  if (complexityDecision.source !== 'triage' && task.meta.implementer !== null) {
    task.meta.implementer = null
    await saveMeta(task)
  }
  ```
- **Implement loop** (before `while (true)` at line 2292):
  ```ts
  const implementerPool = ctx.config.agents.implementers
  const routedImplementerName = resolveImplementer(task.meta.implementer, implementerPool)
  const routedImplementer = routedImplementerName
    ? normAgent(implementerPool[routedImplementerName])
    : lead
  ```
  Reading `task.meta.implementer` covers both the fresh path (just written or cleared above) and the resume-re-implement-at-attempt-0 path (resume never re-triages, so meta is the only signal) with one expression, re-resolving against the current pool each run.
- **The `agentStep('implement', …)` call** (lines 2344-2354):
  ```ts
  const implementAgent = fixing ? lead : routedImplementer
  ```
  Substitute `implementAgent` for `lead` in both the `agentLabel(...)` argument and the `runAgent(...)` call — the *only* `lead` call site that changes. Explicitly untouched: triage (2069), quickfix, sharpen, reconcile, select, prototype, remediate, commit-message, rescue, feedback analysis, planning ensemble.
- **`RunStats`** (lines 643-647): add `implementer: string | null` with a comment: agent label of this pass's *first* implement stage; null if this pass ran none. Initialize to `null` at both construction sites (`runTask` line 2010 and the `deliverTask` stats literal). Set in the implement branch after computing `implementAgent`: `stats.implementer ??= agentLabel(implementAgent)` — never overwritten by fix passes.
- **`recordTask`** (lines 689-708): pass `implementer: stats.implementer`.

### 6. `src/metrics.ts`

- **`RunRecord`**: add `implementer: string | null` (required field — tsc surfaces every construction site) with a comment fixing the semantics: resolved agent label of this pass's first implement stage (the routing decision for attempt-0 passes); null when the pass ran no implement stage (gates-only resume, delivery-only). Grouping a task's terminal outcome by its first implementer joins passes on `task`; the `stages` table already labels every stage's agent.
- **`SCHEMA_VERSION`**: `1` → `2` (telemetry is disposable; mismatch drops and rebuilds).
- **`runs` table**: add nullable `implementer TEXT` column.
- **`insertRun`**: add the column to the INSERT and `r.implementer` to the values.
- No read-path changes (`readReport` etc. untouched — per-implementer reporting is out of scope). Writes stay best-effort/never-throw.

### 7. Docs

- **README.md** (~620-642): add an `implementers` bullet after `researchers`/`reviewers`: named pool of cheaper/faster alternatives; triage routes clearly-easy, low-risk tasks to one for the attempt-0 implement stage; fix passes escalate to `implementer`; declared complexity and `triage: false` always use the default; missing/unknown/`DEFAULT` resolves to `agents.implementer`; empty `{}` = feature off. Extend the object agent shape with `"description"?: "…"` and a sentence that it's shown to triage as the routing policy. Note the cascade merges nested agent pools per key, including `implementers`.
- **AGENTS.md**: add `IMPLEMENTER: <name|DEFAULT>` to the marker-line invariant list alongside `COMPLEXITY:`/`USER-FACING:`.

## Tests (all in existing files, following existing templates)

- **tests/markers.test.ts**: extend the existing full-object `toEqual` assertions with `implementer: null` (back-compat tripwire). New cases: `IMPLEMENTER: quick` → `'quick'`; `IMPLEMENTER: DEFAULT` → `'DEFAULT'` (passthrough, not null); unknown-name passthrough; last-match-wins (two IMPLEMENTER lines); quoted line (`> IMPLEMENTER: quick`) rejected consistently with existing marker parsing; missing → `null`.
- **tests/prompts.test.ts**: new `triagePrompt` describe. Empty pool: contains the verbatim closing block `Output ONLY these two final lines:` plus both marker lines, and contains no `IMPLEMENTER` substring anywhere. Non-empty pool: contains each entry's name, label, and description; contains the conservative-default guidance; contains `IMPLEMENTER: <name>|DEFAULT` and the three-line contract; still contains both original marker lines. No full-prompt literal duplicated into the test — empty-pool byte-identity is guaranteed structurally by the interpolation-slot diff.
- **tests/config.test.ts**:
  - Parse `implementers` with a string entry and an object entry carrying `description`; assert `description` round-trips.
  - Refine-through-record proof: `implementers: { quick: { cli: 'claude', reasoningEffort: 'low' } }` rejects with the existing error message.
  - Cascade test with the pool in the lower layer and an unrelated `agents` override in the worktree file, mirroring the existing researchers cascade test — the only proof of the merge-list change (tsc can't catch it).
- **tests/conductor.test.ts**: `resolveImplementer` unit tests (the `decideComplexity` test pattern): `null` → `null`; whitespace-only → `null`; `'DEFAULT'`/`'default'`/`' Default '` → `null`; exact name → name; whitespace-padded valid name → name; case-mismatched name (`'Quick'` vs pool key `quick`) → `null` (exact matching is the fail-safe contract); unknown name → `null`; empty pool → `null`.
- **tests/metrics.test.ts**: add `implementer: null` to the `run()` builder defaults. New test: `recordRun` with `implementer: 'codex:gpt-5.4-mini'`, assert via direct `bun:sqlite` read that the column holds the value (no read path exists, so this is the only proof of the write). Version-rebuild test: create a DB at `user_version = 1` with the old shape, `recordRun`, assert the write succeeded and the `implementer` column exists.
- **tests/task.test.ts**: meta round-trip — save a task with `meta.implementer = 'quick'`, reload, assert the field; assert an old meta (field absent) parses to `null`.
- **Fixture sweep** (mechanical, tsc-driven): full `Config` literals in tests/{task, agent-session, ask, complete, deck, evals, guidance, lessons-curate, prototype, view}.test.ts gain `implementers: {}` in their `agents` objects. `RoleAgents` literals are unchanged.

Deliberately not tested (no `runTask` harness exists, matching the current exposure of the triage wiring): the call-site substitution, the `stats.implementer ??=` line, and the stale-meta clearing branch. The proof there is the pure resolver's tests plus a small reviewed diff — three localized, grep-able edits.

## Implementation order

1. **src/config.ts** — `description` on spec + `Agent`, `implementers` pool (schema, `AgentsConfig`, default literal, merge list, comments). Then tests/config.test.ts.
2. **src/markers.ts** — `TriageResult.implementer` + extraction. Then tests/markers.test.ts.
3. **src/prompts.ts** — `ImplementerOption` + slot-based `triagePrompt` extension. Then tests/prompts.test.ts.
4. **src/task.ts** — `MetaSchema.implementer`. Then tests/task.test.ts round-trip.
5. **src/conductor.ts** — `resolveImplementer` (+ tests), triage wiring (options, resolve, logs, persist), stale-decision clearing, implement-loop wiring (`routedImplementer`, `implementAgent`, `stats.implementer ??=`), `RunStats` field + both initializers + `recordTask` pass-through.
6. **src/metrics.ts** — `RunRecord` + semantics comment, schema v2, insert. Then tests/metrics.test.ts.
7. **Fixture sweep** — run `tsc --noEmit`, add `implementers: {}` to every flagged `Config` literal.
8. **Docs** — README agents section, AGENTS.md marker list.
9. **`bun run test`** (biome + tsc + bun test) full gate; `bun run fix` for formatting if needed.

## Verification

```
bun install --frozen-lockfile   # fresh worktree only
bun run test
```

Key acceptance checks the suite proves: empty-pool prompt back-compat (structural identity + substring tripwires), `parseTriage` back-compat (`toEqual` tripwires), resolver fail-safes including exact-match-only, cascade merge of the pool, spec refinements inside the pool, metrics column write + version rebuild, meta round-trip and legacy-meta defaulting.

## Scope guardrails

- Do not route triage, quickfix, sharpen, plan/reconcile/select, prototype, remediate, rescue, commit-message, delivery, namer, workforce, researcher, or reviewer stages.
- Do not add a new selection stage, per-implementer reporting, case-insensitive pool matching, `implementers` in `RoleAgents`, or cross-pass label propagation onto gates-only rows.
- Do not make a missing or malformed `IMPLEMENTER` marker a blocking prompt-contract failure.
- Do not change `researchers`/`reviewers` behavior.
