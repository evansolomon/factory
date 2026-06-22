# factory

A self-improving, looping coding agent. You queue tasks; `factory` drains them
autonomously — planning with a **codex + claude ensemble**, implementing,
adversarially reviewing, verifying, and committing — and pauses to ask you a
question only when it genuinely can't proceed.

Built to run one instance per git worktree (a "fleet"), each in its own tmux
window. Factory emits lifecycle and attention hooks; your environment decides
whether those become colors, bells, notifications, or something else.

## Install

Prebuilt binaries are published on GitHub Releases for macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/evansolomon/factory/master/install.sh | bash
```

By default the installer writes `factory` to `$HOME/.local/bin`. Make sure that
directory is on `PATH`, or override it with:

```bash
curl -fsSL https://raw.githubusercontent.com/evansolomon/factory/master/install.sh | \
  FACTORY_INSTALL_DIR="/usr/local/bin" bash
```

Check the installed CLI version with:

```bash
factory --version
```

Upgrade to the latest GitHub Release with:

```bash
factory upgrade
```

When `factory upgrade` is run from an installed `factory` binary, it preserves
that binary's directory. When run from source or through another executable, it
uses the installer default; custom installs can set `FACTORY_INSTALL_DIR`.

You can also run from a clone:

```bash
bun install
bun run src/cli.ts
```

Or build a local executable for this machine:

```bash
bun run build:local
./dist/factory
./dist/factory --version # 0.1.1-dev.20260621010203

# or choose the executable path
bun run build:local -- /path/to/factory
/path/to/factory
```

For development, run `bun run test` (`biome check` + `tsc --noEmit` + `bun test`);
run `bun run fix` to autofix.

- **Runtime requirement:** the `codex` and `claude` CLIs on `PATH`. Those are the
  two built-in agent adapters; adding a third (e.g. gemini) is a small adapter in
  `agents.ts` plus an enum entry, not config (see Configuration).

## Mental model

Your job is to **feed vetted tasks faster than `factory` drains them** — shovel
coal into a running engine. `factory`'s job is everything after: turn each task
into a good plan, build it, prove it, commit it. The one place it pulls you back
in is when a task is genuinely ambiguous — it asks, you answer, it resumes.

There is **one phase, not two.** Refinement isn't a separate planning session;
it's `factory` pausing mid-cycle to ask. "Good enough, proceed" is the default —
it only stops for you when it must.

## Per-task pipeline

Each task runs through this DAG. Every stage writes its artifact into the task
dir, so a crash leaves an inspectable trail and the committed queue carries the
plan + proof as provenance.

```
task.md (intent) + meta.json (verify) [+ answers.md on resume]
        │
  0. TRIAGE      trivial? → fast path: skip to IMPLEMENT   (read-only)
                 also flags user-facing? → gates the UX lenses
        │ (complex)
  1. RESEARCH    one subagent maps the relevant code,       (read + network)
                 patterns, git history & prior plans; may
                 look up external data; for user-facing
                 work also the UI vocabulary (components,
                 tokens, where features are exposed)
  2. PLAN        codex + claude each draft a plan           (read-only, parallel)
  3. CRITIQUE    each critiques the other's plan and        (read-only, parallel)
                 surfaces "open questions for the human"
  3.6 UX/IA      [user-facing only] claude critiques the    (read-only)
                 plan's information architecture & UX
  3.5 RECONCILE  proceed autonomously, or PAUSE and ask?    (read-only)
        │
        ├─ ASK  → write questions.md, status: needs-input, set task aside
        │
  4. REVISE      each revises its own plan w/ the critique  (read-only, parallel)
  5. SELECT      codex picks or merges the stronger plan    (read-only)
                 → clean plan written to plansDir (committed docs)
  5.5 RISK       [complex path] score plan risk and          (read-only)
                 verification focus, advisory to implement
  ┌─ 6. IMPLEMENT     codex edits the worktree             (workspace-write)
  │  7. REVIEW PANEL  parallel expert finders on the diff  (read-only, parallel)
  │                   correctness + security + risk +
  │                   deploy safety + ux (if UI);
  │                   each reports findings, none blocks alone
  │  8. CONSOLIDATE   one judge dedupes, drops nits,        (read-only)
  │                   resolves conflicts by priority, marks
  │                   blocking vs advisory → one verdict + fix list
  │  9. VERIFY        run the task's verify command for real;       (full-access
  │                   on failure a doctor classifies it and          remediation)
  │                   REPAIRS the environment in place (install
  │                   deps/tools, build, start a service) then
  │                   re-runs — code defects fall through to auto-fix
  └──── consolidated FAIL / real code defect → auto-fix; a convergence judge keeps
        iterating while each failure is NEW, stops when it's going in circles
        (config.retries is the hard-cap backstop), then block / set-aside.
        A flake or an environment problem it can't fix → set-aside (backoff)
        │ (pass)
  commit → 10. SHIP (if configured) full-perms agent: MR/PR, CI, review
        │
        ├─ pass → write proof.md, status: done (shipped if ship set)
        └─ fail → status: retrying (auto-resume), then blocked if the cap is spent
```

### Why two CLIs

codex and claude are **peers** — neither hosts the other. A neutral conductor
(`conductor.ts`) shells out to both headless and passes markdown artifacts
between stages. codex researches, selects + implements; claude is the fresh
adversarial reviewer and red-team. Cross-model review beats a model grading its
own homework.

### The review panel (swarm of experts, without the thrash)

Review is a **panel, not a chain of gates** — the same shape as the planning
ensemble. Independent expert finders (correctness, security, risk, deploy safety,
ux-when-relevant) run **in parallel** against the diff; each only *reports
findings* — none blocks on its own. A single **consolidator** then dedupes them,
drops nits, resolves conflicts by a fixed priority (correctness > security >
deploy safety > test integrity > stated requirements > consistency > simplicity >
performance > UX polish > docs), and classifies each finding **blocking vs
advisory**, emitting one verdict + one fix list. Only blocking findings drive a
single fix pass; advisory ones live in
`consolidated.md` (read with `factory show <id> consolidate`) and never block.
This keeps one consolidated fix per cycle instead of separate gates ping-ponging,
and makes a new expert a one-prompt addition that can't independently thrash.

The risk lens is deliberately advisory: it answers "0 to 10, how risky is this?"
with concrete drivers and verification focus. Deploy safety is more concrete: it
checks mixed-version compatibility, migrations/backfills, config/env requirements,
queued/event payloads, and rollback safety. A deploy-safety finding may block when
it names a real unsafe rollout path.

### The escalation valve (`needs-input`)

The reconcile step (`reconcilePrompt`) is the human-in-the-loop checkpoint. It
applies a **high bar**: only pause when proceeding on a guess would risk building
the wrong thing and there's no reasonable default — otherwise state an assumption
and proceed. This keeps `factory` hands-off while still leaning on you for the
decisions only you can make. The bar is deliberately tunable in the prompt; if it
asks too much or too little, that's the prompt to adjust (and a `LESSONS.md`
candidate — see Meta).

A `needs-input` task is **set aside, not blocking** — `factory` keeps going on other
ready tasks (never idle). You answer async; the running instance picks it back up.

## Usage

`factory` is the CLI binary.

```bash
factory add "<intent...>" [--verify "<cmd...>"]   # queue a task (also reads intent from stdin)
factory run [--once|--drain]                       # process tasks
factory answer [task-id] "<answer...>"             # answer a needs-input task, requeue it
factory resume [task-id] [note...]                 # pick a blocked task back up where it left off
factory correct [task-id] [note...]                # record your manual fix of a blocked task as a lesson
factory backlog [add|rm] ...                       # experimental repo-level backlog
factory status                                     # catch-up dashboard
factory show [task-id] [step]                       # drill into one task / a step's activity
factory report                                     # telemetry roll-up (manage by numbers)
factory lessons                                    # curated lessons + raw candidates
factory config [edit ...]                           # show/edit effective config
factory version | --version                         # print the current CLI version
factory upgrade                                     # install the latest GitHub Release
```

- **`factory run`** is **long-lived by default**: when the queue drains it polls
  (every 5s) instead of exiting, so tasks added later (`factory add`), unblocked
  later (`factory resume`/`answer`), **due for an auto-retry**, or **stranded
  mid-stage by a killed loop** (Ctrl-C/crash) get picked up automatically — so
  restarting after a Ctrl-C just resumes the interrupted task. Its lifetime = the
  tmux window's lifetime.
  - `--once` — process one ready task, then exit (for proving things out).
  - `--drain` — process until no ready tasks, then exit (batch).
- **`factory answer`** (for **needs-input**) appends to `answers.md` and flips the
  task back to `ready`; the resumed run **re-plans** with your answer threaded in
  (stateless — no held session). Omit the id for the latest needs-input task.
- **`factory resume`** (for **blocked**) **reuses** the saved plan + the diff
  already in the worktree and re-enters at the stage that failed — no re-planning.
  Omit the id for the latest blocked/retrying task (or one stranded mid-stage by a
  killed loop); an optional note becomes fix-context for the retry. Use it for
  review-panel blocks (after you've looked) or to force a transient retry now.
  A running `factory run` already auto-reclaims stranded tasks, so this is mainly
  the manual equivalent when no loop is up. (`answer` re-plans; `resume` continues.)

### Recovery & auto-resume

A gate failure first runs the in-run auto-fix loop. Each attempt's failure is
appended to a persisted log (`failures.jsonl`, spanning resumes), and after each
one a **convergence judge** reads the whole history and decides whether to keep
going: *CONTINUE* while failures are genuinely new ground (fixing one thing
surfacing the next real problem is progress), *STUCK* when the same root cause
recurs or it's oscillating among problems already seen. `config.retries` (default
10) is only the hard-cap backstop. The history also feeds the next fixer ("these
approaches already failed — don't repeat them").

A **verify** failure is triaged before any of that. A full-access doctor
(`remediate` config, default on) reads the failure and classifies it: a genuine
**code** defect feeds the auto-fix loop above; a **flake** or an **environment**
problem it can't fix is set aside to back off; an **environment/setup** problem it
*can* fix (missing deps, an uninstalled tool — verify exits 127 — an un-run build,
a service that's down) it repairs in place — installing, building, starting
services — then re-runs verify, without touching your code or spending a fix
attempt. This is why a fresh worktree that's missing `node_modules` self-heals
instead of burning the whole fix budget re-implementing code that was never the
problem. It is allowed env-only changes; it never edits source or weakens a check
to make verify pass. When the loop does give up, what happens next depends on the
gate:

- **verify / ship** (transient — env, CI, network) → the task is set **aside**
  (status `retrying`, no attention event) and the loop **auto-resumes** it on a
  growing backoff (2m → 5m → 15m → 30m → 60m), up to a cap (5). An env flake
  recovers with no action from you. Only after the cap does it escalate to `blocked`.
- **review panel** (the code or rollout safety was judged bad — re-running churns
  code without new input) → straight to `blocked` and emits attention once no
  runnable work is left. You look (`factory show <id> review`), then
  `factory resume ["note"]` when you're ready.

Either way, resuming reuses prior work: committed already → just re-runs ship;
uncommitted diff → re-runs the gates on that diff, skipping the initial implement
and only doing a fix pass if a gate genuinely fails.

When a task finally blocks, a **postmortem** agent (`postmortem` config) diagnoses
the root cause — classifying it (spec / plan / implementation / test / environment)
into `postmortem.md` for fast triage, and distilling a generalizable **lesson
candidate** richer than the raw reason. And when *you* take over and fix it,
**`factory correct`** captures the highest-signal lesson there is: it pairs the
agent's failed attempt with your in-worktree fix (the answer key), distills what it
should have done, saves a lesson + a paired eval case, and marks the task done.
Together these close the learning loop — every block and every takeover becomes
something the factory can learn from, not just a dead end.

### Typical flow

```bash
wt add fix-upload-retry          # make a worktree (existing tooling)
factory add "Add exponential backoff to the upload client" --verify "bun test upload"
factory run                          # walk away; come back when the window alerts
# if it asks:
factory answer "Cap at 5 retries, 30s max backoff"
# if it's blocked on review-panel findings, after a look:
factory resume "the reviewer's concern is handled by the lock in upload.ts"
```

## Spawning & the fleet (the integration pattern)

factory is environment-agnostic: it emits lifecycle [hooks](#hooks) and writes its
state to files. *How* you spawn loops and surface their state is yours to wire —
here's the pattern that works well (tmux).

**One loop per worktree.** Run each task stream in its own git worktree, each as a
long-lived `factory run` in its own tmux window — a "fleet." Spawn them however you
already create worktrees; the only requirement is the window ends up running
`factory run`. Nice touch: open `$EDITOR` for the first task as the window opens
(`factory add` with no intent does this), so you write the real task, save, and walk
away. ($EDITOR must block until close — `nano`/`vim` do; a GUI editor needs a wait
flag, e.g. `code --wait`.)

**The window as a dashboard.** A `stage.change` + `attention` hook (see [Hooks](#hooks))
makes each window legible at a glance:

- **window name = live stage** (e.g. `billing (implement)`), plus a `▶` "an agent is
  working here" marker while a stage is computing.
- **attention state** when the tab is waiting on you (`needs-input`, `blocked`,
  or `done`, plus `none` to clear). The tmux hook can map those states to colors,
  bells, or jump targets, but factory only emits the semantic state.

This is the *only* environment integration factory has — core emits events and never
touches tmux; it all lives in your hook script.

### Prompt segment (optional)

Because state is in files, a shell prompt precmd can show a compact per-worktree
status — e.g. `factory ⟳implement ⚠1 ✗1` (current stage · needs-input · blocked) — by
reading `meta.json` directly, with no `factory` process per prompt. Render nothing
outside a factory worktree or when there's no outstanding work. (Keep its
worktree-key derivation in sync with `config.ts`.)

## Configuration

Config lives in **`.factory.json`** files and **cascades**: resolution walks
from the worktree root up the directory tree, merging every file it finds, with
the **closest (deepest) winning** — like git/eslint config (`config.ts`). So you
can drop one file at `~/repos/code/` that covers every worktree of that repo
(uncommitted, per-machine), and a different repo gets its own — while a committed
file at a worktree root can still override per-branch.

Beneath the whole tree sits one **global base**, `~/.factory/config.json` (or
`$FACTORY_HOME/config.json` when `FACTORY_HOME` is set) — the **lowest priority**
layer, applied to every repo regardless of where it lives, and overridden by any
`.factory.json` in the cascade. Use it for machine-wide defaults (agents,
`onComplete`, `retries`) so you don't repeat them per repo.

Fields:

- **`dir`** — where state lives.
  - **relative** (`docs/agent`) → in-repo at `<root>/<dir>`, committed with the branch.
  - **absolute / `~`** (`~/.factory`) → global base; state under `<base>/<worktree-key>/`.
  - omitted → **`~/.factory/sessions/<worktree-key>/`** (or
    `$FACTORY_HOME/sessions/<worktree-key>/` when set). The `sessions/` namespace
    keeps per-worktree state out of the factory home root, which holds `config.json`
    + `hooks/`.
  `<worktree-key>` is the worktree's path with `/`→`-`. The default keeps runtime
  state out of repos; the tradeoff is plans/proof don't travel with the branch.
- **`retries`** — hard-cap backstop on auto-fix iterations after a failed gate
  (review-panel/verify). The convergence judge normally decides when the loop
  is stuck; this only bounds runaway fixing. Default `10`; `0` disables auto-fix.
- **`triage`** — classify each task first; trivial ones skip the whole plan
  ensemble (research/plan/critique/reconcile/revise/select) and go straight to
  implement, still reviewed + verified (default `true`; `false` always runs the
  full flow).
- **`security`** — run a dedicated red-team security gate on the implemented diff
  (every task, both paths), feeding the same auto-fix retry loop as the review
  gate (default `true`; `false` skips it).
- **`remediate`** — on a verify failure, run a **full-access doctor** that
  classifies the failure and, for **environment/setup** problems (missing deps, an
  uninstalled tool, an un-run build/codegen step, a service that's down), repairs
  the environment in place and re-runs — so the loop self-unblocks instead of
  burning the fix budget re-implementing code that was never the problem. Code
  defects still route to the auto-fix loop; flakes and unfixable env problems are
  set aside (default `true`; `false` sends every verify failure to the auto-fix
  loop). It makes env-only changes; it never edits source or weakens a check.
- **`ux`** — the **UI/UX lenses** for user-facing work (default `true`; `false`
  disables). Auto-gated per task — triage flags a task user-facing, and the review
  gate also fires whenever the diff touches UI files (`.tsx/.jsx/.vue/.svelte/.css/
  .erb/…`). When active it adds three things: research surfaces the repo's **UI
  vocabulary** (component library, design tokens, where features are exposed); an
  **information-architecture critique** of the plan (claude, a design perspective
  independent of the code critique) that flows into reconcile/revise/select; design
  context for the implementer; and a **design-consistency review gate** on the diff
  (reuse vs. hand-rolled, idiomatic styling, states, labeling, a11y basics) on the
  same auto-fix loop. Text-grounded only — no rendering/screenshots.
- **`plansDir`** — where the clean final plan per task is written, one file per
  task, no meta (default `.coding-agent-plans/`, committed as docs; `null` off).
- **`onComplete`** — deliver each completed task via a **full-permission agent**.
  `{ "skill": "name" }` runs that skill; `{ "policy": "text" }` follows a
  free-text policy (opens MR/PR, iterates CI, replies to review). `null`
  (default) = don't ship. Outward-facing, so opt-in; runs only after all gates
  pass. Delivery failure is treated like a transient gate failure: the task is set
  aside for auto-retry and only blocks after the auto-retry cap is spent. Examples —
  `{"skill": "ship"}`, or
  `{"policy": "open a GitLab MR, no reviewers, iterate CI to green, never merge"}`.
- **`agents`** — which agent fills each role:
  - `planners` (list) — draft + cross-critique + revise. **≥2 different agents
    enables the cross-model ensemble**; 1 → single planner, no critique.
  - `implementer` — also runs triage, research, reconcile, and select (the "lead").
  - `reviewer` — the fresh adversarial diff review, red-team security gate, risk
    assessment, and deploy-safety review
    (best a *different* model from the implementer, to avoid self-bias).
  - `delivery` — runs `onComplete`.

  Each value is `"codex"` / `"claude"` or
  `{ "cli": "codex"|"claude", "model"?: "…", "provider"?: "…" }`.
  Default: `{"planners": ["codex","claude"], "implementer": "codex",
  "reviewer": "claude", "delivery": "claude"}`. Only `codex` and `claude` are
  built in (each needs an adapter — see below).

  **Other models via `provider` (codex only).** codex is an OpenAI-API harness,
  so any OpenAI-compatible backend — xAI/Grok, or local/hosted OSS (Ollama, vLLM,
  OpenRouter, Together) — runs *inside codex's loop* without a new adapter. Add a
  `provider` to a codex agent; it's passed through as `-c model_provider=<name>`,
  selecting a provider block you've defined in `~/.codex/config.toml`. `provider`
  requires an explicit `model` (a custom backend won't know codex's default model
  name) and is rejected on `claude` (claude selects backends via env/Bedrock/Vertex,
  not a CLI flag). Example — a cross-model planner ensemble of OpenAI + Grok:

  ```jsonc
  // .factory.json
  { "agents": { "planners": [
      "codex",
      { "cli": "codex", "model": "grok-4", "provider": "xai" }
  ] } }
  ```
  ```toml
  # ~/.codex/config.toml
  [model_providers.xai]
  name = "xAI"
  base_url = "https://api.x.ai/v1"
  env_key = "XAI_API_KEY"
  wire_api = "chat"
  ```

  This keeps **model** diversity (the point of cross-model review) while sharing
  one **harness**; a model with its own agentic CLI (e.g. gemini) is still a new
  adapter, not a `provider` (see below). Local OSS needs no special `--oss` flag —
  point a `provider` at `http://localhost:11434/v1` and it's the same mechanism.

`$FACTORY_HOME` is the easy "all repos, state out of the tree" switch;
`.factory.json` (cascading) is for per-repo/per-tree rules like `ship`.

## Hooks

Factory knows nothing about your environment. Instead it **emits lifecycle
events**, and you map each event to shell commands in config (`hooks.ts`). This is
what makes factory a standalone program: the tmux integration is just a hook you
own, not compiled-in behavior.

```jsonc
// ~/.factory/config.json (global) or any .factory.json
{
  "hooks": {
    "stage.change":     ["~/.factory/hooks/tmux-state.sh"],
    "attention":        ["~/.factory/hooks/tmux-state.sh"],
    "loop.idle":        ["~/.factory/hooks/tmux-state.sh"],
    "task.done":        ["osascript -e 'display notification \"done\"'"]
  }
}
```

Events and their payloads:

| Event | Fires when | Payload |
|---|---|---|
| `task.start` | loop picks up a task | `task` |
| `stage.change` | active stage changes (drives the window name) | `task, stage, active` |
| `attention` | attention state changes | `state` (`blocked`/`needs-input`/`done`/`none`) |
| `task.needs_input` | paused for the human | `task` |
| `task.blocked` | escalated to blocked | `task, reason` |
| `task.retrying` | set aside for auto-retry | `task, reason, retryAt` |
| `task.done` | committed/shipped | `task, commit` |
| `loop.idle` | queue drained | `state` |

`attention.state = needs-input` means factory is waiting at an intentional human
prompt. That includes a queued task paused for answers and the interactive
sharpen step waiting at `you>`.

Each command gets the payload as **JSON on stdin** *and* as flat `FACTORY_*` env
vars (`FACTORY_EVENT`, `FACTORY_TASK`, `FACTORY_STAGE`, `FACTORY_STATE`, …), runs
with cwd = the worktree root, and inherits the process env (so `$TMUX_PANE` is
available). Hooks are **best-effort**: a failure or 10s timeout is logged and never
affects the task; output and exit code are ignored (hooks observe, they don't
gate). Across the cascade, hooks for an event **concatenate** (global + repo), so a
global tmux hook applies everywhere while a repo can add its own.

An example tmux hook (e.g. `~/.factory/hooks/tmux-state.sh`, wired in
`~/.factory/config.json`) dispatches on `$FACTORY_EVENT`: it renames the window for
`stage.change`/`loop.idle` and maps `attention` states to whichever color, bell,
or jump-target behavior you want.

## Task layout

```
<state-dir>/tasks/<slug>[-N]/
  task.md                # human-owned intent/spec
  meta.json              # machine-owned status, verify, timestamps, resume/retry state
  triage.md              # trivial/complex + user-facing classification
  research.md            # shared research dossier
  plan.<planner>.md      # first-pass planner output
  critique.<planner>.md  # cross-critique output
  ux.plan.md             # user-facing information architecture critique
  reconcile.md           # proceed vs ask decision
  questions.md           # open questions when status = needs-input
  answers.md             # your answers, appended by factory answer
  plan.<planner>.v2.md   # revised planner output
  plan.final.md          # selected/merged plan
  plan.md                # selected plan persisted for resume
  risk.plan.md           # plan risk scores + verification focus, complex path
  implement.log.md       # implementer final message
  diff.patch             # latest worktree diff under review
  review.md              # correctness expert report
  security.md            # red-team report, when enabled
  risk.md                # advisory merge-risk scores for the implemented diff
  deploy.md              # deploy-safety report: compatibility/migrations/rollback
  ux.md                  # UX/design report, when applicable
  consolidated.md        # consolidated review verdict + fix list
  converge.md            # latest convergence-judge output
  failures.jsonl         # persisted gate-failure history
  verify.log             # latest verify output
  remediate[.N].md       # verify-failure doctor: diagnosis + env repair, when it runs
  proof.md               # pass proof written before commit
  postmortem.md          # blocked-task diagnosis, when enabled
  ship.md                # delivery output, when onComplete is configured
  *.activity.jsonl       # raw agent event streams beside agent-written artifacts
```

`task.md` (yours) and `meta.json` (the machine's) are split so `factory` flips
status without rewriting your prose, except when interactive sharpening finishes:
then `task.md` is replaced with the refined spec you accepted. Repo-level state
lives under the main worktree's state dir, shared across linked worktrees:
`LESSONS.md`, `LESSONS.candidates.md`, `metrics.db`, `eval-candidates/`, and
`backlog/`.

factory treats the **whole worktree** as the task surface. It does not refuse a
dirty worktree and it does not try to split preexisting hunks from agent-created
hunks before committing. At task start it writes `baseline.patch`; when the
worktree was already dirty, review prompts include that baseline so reviewers can
see what existed before this run. For the cleanest provenance, run one task per
worktree and start from a clean tree.

## Meta loop (LESSONS.md)

The self-improving part. `LESSONS.md` (at the repo-level state root, keyed by the
main worktree) is **human-curated** and read into the plan + critique stages
**every run**, so past mistakes shape future plans. `LESSONS.candidates.md` is
**machine-appended** raw signal — one line per `blocked` / `needs-input` outcome
and manual correction — that you periodically distill into `LESSONS.md` (e.g. via
the `/learn` skill) and prune. Keeping them separate keeps the curated file
high-signal. `factory lessons` prints both.

## Intent sharpening (`factory add`)

The proactive complement to the reactive reconcile valve: resolve ambiguity at
the *front door*, before a task ever enters the loop. By default `factory add` and
`factory backlog add` **sharpen** the raw intent — an agent (the configured
`implementer`) asks about it until it becomes a self-contained, high-confidence goal spec,
reading the repo itself to answer what it can. Each agent turn is a slow research
pass, so it **batches its questions** — then the CLI **walks you through them one
at a time** (Enter accepts its recommended answer, `/skip` skips one) with no
per-question latency, and sends all your answers back at once. It's two-way — you
can `/edit` a long reply or ask it questions back. Once a spec is proposed, **Enter
queues it** (`/done` works too); sharpening also proposes the verify command.
`/cancel` aborts. `--raw` skips it and queues the intent as-is, and the
sharpen step auto-skips when the intent is piped (non-interactive — no human to ask).

The prompt borrows a recommended-answer interview discipline plus a few lenses
worth stealing from heavier plan-review skills: a **premise challenge** ("is this
the right problem?"), a **temporal check** ("what must be decided now vs.
discovered mid-build?"), a **scope lens** (narrow fix vs. an enabling refactor /
shared capability — "make the change easy, then make the easy change"), and a
**security sniff** (flag the security decision when the task touches a sensitive
surface) — every decision settled here is one fewer mid-loop escalation later.
It's grounded by a research-first rule: the agent reads the code and recent git
history before asking, so questions aren't ones it could have answered itself.
It's its own `sharpenPrompt` (not the Claude Code `work-plan` skill): the CLI
mediates the turn-taking around headless agent calls, which a one-shot `claude
-p` can't do.

The richer **`work-plan` skill** (`~/.claude/skills/work-plan`) remains for deep
sharpening inside a Claude Code session; the loop's reconcile valve still handles
any ambiguity that slips through, reactively.

### Statuses

Tasks usually move through `ready` → `planning` → `implementing` → `reviewing` →
`verifying` → `shipping` → `done`. Other resting states are `sharpening` (interactive
intent sharpening in progress), `needs-input` (paused for you), `retrying` (transient verify
or ship failure waiting on backoff), and `blocked` (human attention required:
no changes, review-panel failure, convergence stuck, or retry cap exhausted).
`needs-input`, `retrying`, and `blocked` are set aside; `factory` moves on.
`factory answer` returns a `needs-input` task to `ready`; `factory resume` returns
a blocked/retrying/stranded task to `ready`; due auto-retries are promoted by the
run loop.

## Telemetry (`factory report`)

The quantitative meta loop — "manage by numbers." Every task pass writes one row
to a repo-level SQLite db (`metrics.db`, keyed by the main worktree like the
backlog), plus a child row per pipeline stage. `factory report` rolls it up:
**first-pass yield** (done with no retries, of implement attempts),
**escalation rate**, **blocked rate**, **retry success**, a token-cost proxy
(total input tokens, total output tokens, combined total tokens, and median total
tokens per task), median cycle time, and one per-stage table combining token usage
with wall-clock time.
These are the numbers that tell you whether the loop is trustworthy enough to
step back from (auto-ship, or a future dispatcher) and which stage to tune when it
isn't.

SQLite, not files, because telemetry is relational (task → passes → stages) and
read analytically (group-by, per-stage share, medians) — SQL is the simpler tool.
Artifacts (plans, reviews, prose) stay files.

The db is **disposable**: telemetry must never break the loop, so any open/schema
error (corruption, a version bump) resets the db rather than failing a task —
losing past metrics is acceptable, failing work is not. Schema is versioned
(`PRAGMA user_version`) and rebuilt on any mismatch.

## Eval capture (toward a regression set)

Every terminal task is snapshotted as a reproducible **eval candidate** under the
repo's `eval-candidates/` (`evals.ts`, `captureEvals` config, default on). Normal
terminal captures store `{spec, verify, baseCommit, diff, outcome, reason}`: a
clean `done` is a positive case (the committed diff, based on its parent), and a
`blocked` task is a negative case (the uncommitted attempt + why it failed).
Manual `factory correct` captures store a paired correction case with the agent
attempt and the human fix. Diffs are stored **inline** because worktrees are
short-lived and their branches may be deleted — so each normal case stays
runnable: check out `baseCommit`, run factory on `spec`, score against `verify` +
the reference diff. Best-effort — capture never breaks the loop.

The point is to **harvest** a golden regression set from real use rather than
hand-author one: the corpus accrues automatically; you periodically curate the
trustworthy cases into an eval set, which is the precondition for safely tuning the
system against itself.

## How the agents are invoked (read this when a stage misbehaves)

These headless flags are the contract with the two CLIs (`agents.ts`). They're
the most likely thing to need tuning:

- **codex** (read-only stages):
  `codex exec -C <root> -s read-only -c approval_policy="never" --json -o <file> -`
  (prompt on stdin; final message to `<file>`; the `--json` event stream on stdout
  is read for token usage). `-s` governs filesystem access — `workspace-write` for
  implement, `danger-full-access` for ship; `approval_policy="never"` prevents an
  interactive hang in an unattended run. An agent with a `provider` set (see
  Configuration) adds `-c model_provider="<name>"`, routing to a non-default
  OpenAI-compatible backend. Heads-up: codex's `turn.completed` usage may be empty
  for some non-OpenAI providers — usage parsing degrades to zero (the loop never
  breaks), so `factory report` token figures can read low for those models.
- **claude** (read-only stages):
  `claude -p --add-dir <root> --output-format stream-json --verbose --permission-mode bypassPermissions --disallowedTools Edit Write NotebookEdit`
  (bypass prompts so it can't hang; disallow Claude's dedicated edit tools and
  keep Bash available for `git log`, `rg`, and other high-value read-only shell
  work; `stream-json` emits the event stream). Unlike codex's filesystem sandbox,
  this is not an OS-level read-only boundary: a shell command can still mutate if
  the model ignores the prompt.

Each step's **raw agent event stream** (reasoning summaries + tool calls, line by
line) is teed live to `<step>.activity.jsonl` in the task dir as the step runs.
Read a rendered view with **`factory show <id> <step>`** (e.g. `factory show
<id> implement`), or watch it live with `tail -f <task-dir>/<step>.activity.jsonl`;
the raw JSONL is also there for `jq`. `factory show <id>` lists the steps available.

The **verify** command runs as `bash -lc "<verify>"` in the worktree root.

**Adding another agent (e.g. gemini):** roles are CLI-agnostic — a stage just
needs `runAgent(agent, {prompt, access}) → {text, usage}`. But each CLI has its
own flags, output format, sandbox model, and usage reporting, so a new one is an
**adapter** (a `runX` in `agents.ts` wired into `runAgent` + added to the `cli`
enum), not a config string. `codex` and `claude` are the two built-in adapters.

Each stage prints a completion line with elapsed time and token usage, plus a
per-task total (tokens + wall time). Usage parsing is lenient (`safeParse`) — if
a CLI's output format changes, the stage degrades to raw text with zeroed usage
rather than crashing the loop. (Cost isn't shown: codex's CLI doesn't report a
dollar figure, so there's no consistent number across both models.)

## Current state

- ✅ Conductor: full ensemble + reconcile valve, bounded auto-fix retry,
  `add/run/answer/status/show/report/lessons`, long-lived watcher, custom dir,
  `needs-input` escalation. Proven end-to-end on real tasks.
- ✅ **Configurable agents:** planners / implementer / reviewer / delivery roles,
  each `codex`/`claude` (+ optional model).
- ✅ **Intent sharpening:** `factory add` / `backlog add` refine the intent into a
  self-contained spec before queuing.
- ✅ **tmux integration (via hooks):** live-stage window name, semantic attention
  states for `needs-input`/`blocked`/`done`, in-place elapsed heartbeat, and
  `(done)` when the queue finishes.
- ✅ **Meta loop:** `LESSONS.md` read into planning + `factory lessons`; SQLite
  telemetry via `factory report`.
- ✅ **Ship:** opt-in `onComplete` delivery, validated against a real remote.

## Files

- `cli.ts` — arg parsing + the long-lived run loop
- `conductor.ts` — the per-task pipeline + live stage updates
- `agents.ts` — headless codex/claude wrappers
- `prompts.ts` — stage prompts (incl. the high-bar reconcile/critique prompts)
- `sharpen.ts` — interactive intent sharpening loop for `factory add` / `backlog add`
- `task.ts` — task dir format, status, answers
- `view.ts` — `status` dashboard + `show` drill-down + `report` rendering
- `lessons.ts` — LESSONS.md read + candidate capture (the meta loop)
- `metrics.ts` — SQLite telemetry store + `report` aggregation (defensive/disposable)
- `evals.ts` — eval-candidate and correction capture
- `hooks.ts` — lifecycle hook emission
- `backlog.ts` — repo-level backlog entries
- `editor.ts` — blocking editor helpers for compose/edit flows
- `config.ts` — `.factory.json` loading + path resolution
- `git.ts` — diff / commit / repo root
- `exec.ts` — subprocess helper
- `log.ts` — CLI output

## Security

factory is an autonomous coding loop that shells out to agent CLIs in your
worktree. Implementation stages run with write access, and delivery can run with
full permissions so it can perform the configured ship policy, such as pushing a
branch, opening a PR or MR, and iterating on CI or review feedback. It also sets
non-interactive approval modes (`approval_policy="never"` for codex and
`bypassPermissions` for claude) so unattended runs do not hang waiting for prompts.

Run factory only in repositories and worktrees you trust, with verify and delivery
commands you are willing to execute unattended. Treat `.factory.json`,
`~/.factory/config.json` / `$FACTORY_HOME/config.json`, and hook scripts as
executable automation inputs. factory commits the current worktree with
`git add -A`; use a dedicated worktree for each task if you do not want unrelated
local edits included.

**Integration is yours, not the tool's.** factory only emits [hooks](#hooks) and
writes state files — the tmux hook script and its `~/.factory/config.json` wiring
live in your own dotfiles/environment, not in this package. Nothing in `src/` knows
about tmux or the shell.
