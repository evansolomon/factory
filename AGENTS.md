# AGENTS.md — working on factory

factory is a self-improving, per-task coding loop: queue a task in a git worktree
and a cross-model **codex + claude** ensemble plans, implements, reviews, verifies,
and commits it, pausing only when it genuinely can't proceed. This file is the
working guide for anyone (human or agent) changing factory itself; `README.md` has
the full design — read it before proposing architectural changes.

factory works on *itself* (it's self-improving), so these conventions are also what
its own agents must follow when the repo is the target.

## Runtime & prerequisites

- **Bun** runs the TypeScript directly — no build step.
- On `PATH` at runtime: **`codex`** and **`claude`** (the two agent adapters),
  **`git`**, **`bash`**. factory shells out to them; it does not call model APIs.

## Develop

- **`bun run test`** — `biome check .` + `tsc --noEmit` + `bun test`. This is the
  gate; nothing lands red.
- **`bun run fix`** — biome autofix (formatting + safe lints).
- Unit tests are for deterministic contracts: parser marker lines, config cascade,
  task-state transitions, and similar pure behavior. Keep broad agent workflows in
  manual evals or the task's own `verify`; don't add tests just to have them.

## Code style (what actually bites)

- TypeScript strict. **Never `any`.** Avoid `as` and non-null assertions — reach
  for proper types, type guards, or zod instead.
- **zod for all runtime validation at boundaries** (config, parsed JSON, agent
  output). Validate at the edge; trust internal code. Required values fail
  explicitly, they don't silently default.
- `.ts` import extensions (`verbatimModuleSyntax`); single quotes, no semicolons,
  ~100 cols — biome enforces all of it, so just run `bun run fix`.
- **No `console`** anywhere except `src/log.ts` — use the `log` helper.
- Simplicity first: reduce **state, coupling, complexity, code**, in that order.
  Comments explain *why*, not *what*. Match the surrounding patterns; names reflect
  semantics. Stay in scope — fix X without refactoring Y.

## Factory invariants (do not break these)

- **Side effects are best-effort.** Telemetry, hooks, eval capture, postmortems —
  none may ever break the task loop. Wrap them in try/catch, `log.warn`, and fall
  back. This is why the loop survives a flaky environment; preserve it for anything
  new that writes state or shells out for non-essential reasons.
- **Marker-line contract.** Read-only stages output *only* markdown (saved verbatim
  as the artifact). Stages the conductor parses must keep their exact marker lines:
  `DECISION: PROCEED|ASK`, `COMPLEXITY: TRIVIAL|COMPLEX`, `USER-FACING: YES|NO`,
  `IMPLEMENTER: <name|DEFAULT>` (optional; only requested when
  `agents.implementers` is non-empty),
  `DELIVERY: NONE|SKILL|POLICY`,
  `VERDICT: PASS|FAIL`,
  `VERDICT: CONTINUE_CODE_FIX|RETRY_LATER|ASK_HUMAN|TERMINAL`,
  `VERDICT: ENV-FIXED|ENV-BLOCKED|CODE|FLAKE|GATE-MISCONFIGURED` (+ `GATE-FIX:`),
  `SHIP: OK|FAILED`, `SPEC READY`, `SHARPEN: PASS|REVISE`, and
  `CATEGORY:` / `LESSON:` / `SUMMARY:`.
  Parsing is ONE convention (`markers.ts`): whole line, anywhere in the output,
  last match wins; residual nulls fail toward safety (reconcile → ASK,
  convergence → ask the human). If you change a marker, change **both** the
  prompt (`prompts.ts`) and its parser.
- **codex and claude are peers, shelled out headless.** Do **not** add a
  from-scratch agent loop or a unified LLM client — orchestrating the CLIs is the
  whole point. A new agent CLI is a small adapter in `agents.ts` plus an enum
  entry, not a config surface.
- **Storage rule:** prose and artifacts you read → **files** (task-dir artifacts,
  `LESSONS.md`, `LESSONS.candidates.md`, `eval-candidates/`, `failures.jsonl`).
  Small durable records (task metadata, config, backlog entries) are JSON files.
  Analytics-style telemetry → **SQLite** (`metrics.db`, treated as disposable).
  Never put prose in DB blobs.
- **Config** is zod-validated and **cascades** (global `~/.factory/config.json` or
  `$FACTORY_HOME/config.json` < ancestor `.factory.json` < worktree). New options
  go in `ConfigSchema` with a sensible default and a comment. `hooks` is the one
  key that *concatenates* across the cascade instead of closest-wins.
- **State layout:** per-worktree task state lives under the resolved state dir:
  `~/.factory/sessions/<worktree-key>` (or `$FACTORY_HOME/sessions/<worktree-key>`)
  when `dir` is omitted, `<absolute-dir>/<worktree-key>` for absolute/`~` `dir`,
  or an in-repo relative dir otherwise. Repo-level state (`backlog/`, `metrics.db`,
  `LESSONS.md`, `LESSONS.candidates.md`, `eval-candidates/`) is keyed by the main
  worktree and shared across its linked worktrees.
- **The loop is environment-agnostic.** It reflects state to the outside world only
  by emitting lifecycle **hooks** (`hooks.ts`); nothing in core knows about tmux,
  window state, notifications, or any host-specific integration. Keep it that way —
  new integration is a hook, not core.
- **Re-enterability.** `runTask` resumes by reusing the saved plan + worktree diff;
  answering a mid-loop question resumes at the gates (`answerTask`), not with a
  replan. The fix loop terminates by the convergence judge WITHIN mechanical
  bounds enforced in code: identical failure + unchanged worktree is never
  re-run, `config.retries` is a real cap, and auto-retries have an absolute
  ceiling — all bounds fail toward asking the human, never silent churn or
  silent death. Keep new gates on the same auto-fix path, and route transient
  failures (verify/ship) to the backoff auto-resume rather than a block.
- **One loop, one active task.** `factory run` holds a lock per worktree; a second
  fresh `factory add` errors without `--force-new`. The workstream model is one
  task per worktree (spawner tools create/tear down worktrees per task); task
  dirs are durable records, not a queue.
- **Repo state is keyed by origin.** Repo-level stores live under
  `$FACTORY_HOME/repos/<normalized-origin>/` (path-key fallback without a
  remote); the env playbook is per-host inside it. Per-worktree session state
  stays path-keyed and is disposable (`factory gc`).
- **Gate your changes with the replay runner.** For changes to prompts, markers,
  or loop policy, run `factory evals run` (or a filtered case) when the repo has
  captured candidates — that is the regression gate that makes self-modification
  safe.

## Map

- `cli.ts` — command dispatch + the long-lived run loop.
- `conductor.ts` — the per-task pipeline (the heart): triage → plan ensemble →
  review panel + consolidator → verify → commit → ship, with the auto-fix loop.
- `prompts.ts` — every stage prompt (the marker contracts live here).
- `agents.ts` — the codex/claude headless adapters.
- `config.ts` · `task.ts` · `git.ts` · `exec.ts` · `log.ts` — config cascade, task
  state, git, subprocess, output.
- `lessons.ts` · `metrics.ts` · `evals.ts` · `hooks.ts` · `sharpen.ts` · `view.ts` ·
  `backlog.ts` · `editor.ts` — meta loop, telemetry, eval capture, lifecycle hooks,
  intent sharpening, rendering, backlog, editor compose.

Full file-by-file map and design rationale: `README.md`.
