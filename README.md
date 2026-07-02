# factory

A self-improving, looping coding agent. You run one workstream in a git worktree;
`factory` turns the current task into a plan, implementation, review, verification,
and commit — and pauses to ask you a question only when it genuinely can't proceed.

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

Installed non-dev binaries also check GitHub Releases automatically at most once
every 7 days before recognized normal commands in an interactive terminal. Help,
version, explicit `factory upgrade`, source runs, dev builds, and non-TTY runs
skip the automatic check. Set `FACTORY_DISABLE_AUTO_UPGRADE=1` to disable only
automatic checks; manual `factory upgrade` remains available.

When a newer release is found, factory prompts before installing. Declining
suppresses further automatic checks for 7 days and continues the original
command. Accepting runs the same in-place upgrade flow as `factory upgrade`,
then exits; rerun the original command under the new binary.

### Shell completion (zsh)

The installer does not edit `.zshrc` or other shell startup files. To enable zsh
completion for the current shell after `compinit` has run:

```bash
source <(factory completion zsh)
```

For a persistent user-owned install:

```bash
mkdir -p ~/.zsh/completions
factory completion zsh > ~/.zsh/completions/_factory
```

Then add the completions directory before `compinit` in `.zshrc`:

```zsh
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit
compinit
```

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

Your job is to **keep each factory pointed at the right next piece of work**.
`factory`'s job is everything after: turn the current task into a good plan, build
it, prove it, commit it. The one place it pulls you back in is when that task is
genuinely ambiguous — it asks, you answer, it keeps going.

The durable state still uses task directories. Treat those as task records:
artifact boundaries for plans, answers, retries, feedback, proof, and history.
In normal fleet usage, each worktree is a single-lane workstream and usually has
one active task. Multiple queued task records remain supported for set-aside
answers, retries, linked follow-ups, and deliberate batching, but they are no
longer the primary mental model.

There is **one phase, not two.** Refinement isn't a separate planning session;
it's `factory` pausing mid-cycle to ask. "Good enough, proceed" is the default —
it only stops for you when it must.

## Per-task pipeline

Each task runs through this DAG. Every stage writes its artifact into the task
dir, so a crash leaves an inspectable trail and the committed queue carries the
plan + proof as provenance.

```
task.md (intent) + meta.json (verify, optional declared complexity) [+ answers.md after input]
        │
  1. TRIAGE      trivial? → fast path: skip to IMPLEMENT   (read-only)
                 also flags user-facing? → gates the UX lenses
                 skipped when meta.json declares trivial/complex
        │ (complex)
  2. SHARPEN     [pending non-trivial only] refine intent    (read-only)
        ├─ ASK  → write questions.md, status: needs-input, set task aside
        │
  3. WORKFORCE   [complex path] route read-only scouts,      (read-only)
                 review lenses, agents, and policies
  4. RESEARCH    selected scouts map relevant code, tests,   (read + optional network)
                 history, runtime/deploy, external facts,
                 and UI vocabulary, then synthesize one
                 research.md dossier
  5. PLAN        codex + claude each draft a plan           (read-only, parallel)
  6. CRITIQUE    each critiques the other's plan and        (read-only, parallel)
                 surfaces "open questions for the human"
  6.4 UX/IA      [user-facing only] claude critiques the    (read-only)
                 plan's information architecture & UX
  6.5 RECONCILE  proceed autonomously, or PAUSE and ask?    (read-only)
        │
        ├─ ASK  → write questions.md, status: needs-input, set task aside
        │
  7. REVISE      each revises its own plan w/ the critique  (read-only, parallel)
  8. SELECT      codex picks or merges the stronger plan    (read-only)
                 → clean plan written to plansDir (committed docs)
  8.5 RISK       [complex path] score plan risk and          (read-only)
                 verification focus, advisory to implement
  8.6 PROTOTYPE  [complex path] best-effort autonomous       (read-only)
                 decision: create a standalone pre-impl
                 artifact only when it materially derisks
                 UX, architecture, data flow, rollout, etc.
  ┌─ 9. IMPLEMENT     codex edits the worktree             (workspace-write)
  │  10. REVIEW PANEL selected expert finders on the diff  (read-only, parallel)
  │                   correctness + required gates +
  │                   routed optional lenses;
  │                   each reports findings, none blocks alone
  │  11. CONSOLIDATE  one judge dedupes, drops nits,        (read-only)
  │                   resolves conflicts by priority, marks
  │                   blocking vs advisory → one verdict + fix list
  │  12. VERIFY       run the task's verify command for real;       (full-access
  │                   on failure a doctor classifies it and          remediation)
  │                   REPAIRS the environment in place (install
  │                   deps/tools, build, start a service) then
  │                   re-runs — code defects fall through to auto-fix
  └──── consolidated FAIL / real code defect → auto-fix; a convergence judge keeps
        iterating while each failure is NEW, stops when it's going in circles
        (config.retries is the hard-cap backstop); rescue gets one last
        read-only strategy pass before a terminal block.
        A flake or an environment problem it can't fix → set-aside (backoff)
        │ (pass)
  commit (message from diff + author/repo history) → 13. SHIP (if configured)
        full-perms agent: MR/PR, CI, review
        → 14. FEEDBACK read-only local handoff
        │
        ├─ pass → write proof.md + feedback.md, status: done (shipped if ship set)
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

### Prototype stage

Complex tasks get one additional pre-implementation consideration after the final
plan and risk assessment are saved. The implementer decides whether a standalone
prototype would materially reduce risk or make the intended solution easier to
inspect. Complexity alone is not enough: a large dependency upgrade can be complex
without needing a prototype, while a UX flow, state machine, data-flow design, API
shape, or rollout sequence may benefit from one.

The stage is read-only with respect to the worktree and best-effort. If useful, it
writes `prototype.md`, `prototype.meta.json`, and a primary artifact under
`prototype-artifacts/` using the model-chosen basename. If not useful,
`prototype.md` records the skip decision and reason. Malformed output or stage
failure falls back to `prototype.md` and a fallback manifest, logs a warning, and
the loop continues.

There is no pre-implementation approval pause. Inspect prototypes with
`factory show <task-id>`; when a primary artifact exists, show prints a local
`file://` URL that you can open from the task directory. If you have feedback, use
the existing `factory feedback <task-id> -m "..."` workflow once the task is
eligible for feedback: blocked, retrying, ready with saved progress, has
implementation progress, or done. That feedback is consumed by the next resume or
linked follow-up path.

### The escalation valve (`needs-input`)

The reconcile step (`reconcilePrompt`) is the human-in-the-loop checkpoint. It
applies a **high bar**: only pause when proceeding on a guess would risk building
the wrong thing and there's no reasonable default — otherwise state an assumption
and proceed. This keeps `factory` hands-off while still leaning on you for the
decisions only you can make. The bar is deliberately tunable in the prompt; if it
asks too much or too little, that's the prompt to adjust (and a `LESSONS.md`
candidate — see Meta).

A `needs-input` task is **set aside, not blocking**. If you deliberately queued
other ready work in this worktree, `factory` can keep going; otherwise it waits
for your answer and picks the task back up.

## Usage

`factory` is the CLI binary.

```bash
factory add [--raw] [--trivial | --complexity trivial|complex] [--force-new] [--name <slug>] "<intent...>" [--verify "<cmd...>"]   # tell this workstream something
factory run [--once|--drain|--until-done]          # process the workstream (one lock-enforced loop per worktree)
factory retry [task-id] [-m "<note>" | --edit]     # pick a blocked task back up where it left off
factory feedback [task-id] [-m "<feedback>" | --edit]  # critique existing progress, generalized on next pass
factory correct [task-id] [-m "<note>" | --edit]   # record your manual fix of a blocked task as a lesson
factory backlog [add|rm] ...                       # repo-level backlog, drained by dispatch
factory dispatch [--limit N] [--dry-run]           # spawn one workstream per backlog item (built-in or dispatch.spawn)
factory evals [list|run [case] [--keep]]           # replay harvested eval cases against this build
factory harvest [task-id] [--all]                  # post-ship human rework + MR discussion -> feedback signal
factory close [task-id] [-m <reason>]              # terminally close a parked/superseded task
factory gc [--dry-run]                             # prune session state for torn-down worktrees
factory delivery [--task <id>] [none|'$skill'|/skill|"<policy...>"]  # inspect/override delivery
factory status                                     # catch-up dashboard
factory ask [task-id] ["<question...>"]            # interactive Q&A over saved task state
factory ask --print [task-id] "<question...>"      # one-shot/scriptable saved-state answer
factory session [--agent codex|claude] [task-id]   # realtime agent tweak session from task artifacts
factory deck [task-id] [--url]                      # open the visual one-page brief for a done task
factory show [task-id] [step]                       # drill into one task / a step's activity
factory report                                     # telemetry roll-up (manage by numbers)
factory lessons [list|show|rm|edit] ...           # inspect and manage learned lessons
factory config [edit ...]                           # show/edit effective config defaults
factory version | --version                         # print the current CLI version
factory upgrade                                     # install the latest GitHub Release
factory completion zsh                              # print the zsh completion script
```

- **`factory run`** is **long-lived by default**: when the stream is idle it polls
  (every 5s) instead of exiting, so tasks added later (`factory add`), unblocked
  later (`factory retry`), **due for an auto-retry**, or **stranded
  mid-stage by a killed loop** (Ctrl-C/crash) get picked up automatically — so
  restarting after a Ctrl-C just resumes the interrupted task. Its lifetime = the
  tmux window's lifetime.
  - `--once` — process one ready task, then exit (for proving things out).
  - `--drain` — process until no ready tasks, then exit (batch).
- **`factory add --trivial`** is shorthand for `--complexity trivial`: it skips
  sharpening, persists the declared complexity in `meta.json`, and the later run
  uses the existing trivial fast path without model triage. `--complexity complex`
  also skips model triage, but still runs the full planning ensemble. Complexity
  flags must appear before `--verify`; `--edit` still opens the editor first.
  `--raw` skips sharpening only — it does not declare runtime complexity.
- **`factory add`** is state-aware. It answers a `needs-input` task, records
  feedback on active progress, queues a linked follow-up for completed work, retries
  blocked/retrying work, or creates a new task when there is no current work. If
  you queue a second fresh task in the same worktree, factory warns but allows it;
  one active task per worktree keeps provenance easiest to reason about.
- **`factory retry`** (for **blocked**) **reuses** the saved plan + the diff
  already in the worktree and re-enters at the stage that failed — no re-planning.
  Omit the id for the latest blocked/retrying task (or one stranded mid-stage by a
  killed loop); an optional note (via `-m` or `--edit`) becomes fix-context for the
  retry. Use it for review-panel blocks (after you've looked) or to force a transient
  retry now. A running `factory run` already auto-reclaims stranded tasks, so this is
  mainly the manual equivalent when no loop is up. `factory resume` is a deprecated alias.
- **`factory feedback`** records critique after you review or test existing task
  progress. It is not new work (`add`) and it is not an ephemeral retry note
  (`retry`): feedback is appended to `human-feedback.md`, shown by `factory show`, and
  the next pass first analyzes the concrete comment into an abstract/root-cause
  pattern, searches for sibling cases, and changes only justified cases. Pass it with
  `-m`, or omit it to compose in `$EDITOR` (or pipe it via stdin). Active
  post-progress tasks are requeued in place. Done or already-committed tasks are
  left closed and get a linked follow-up task instead.
- **`factory ask`** is an interactive, read-only session over saved task state.
  `factory ask "has ship ran?"` answers that first question, then stays open for
  follow-ups; `factory ask <task-id>` opens a session scoped to that task. Each
  turn rebuilds a compact context packet from `meta.json`, the task index, and
  relevant artifacts such as `questions.md`, `failures.jsonl`, `postmortem.md`,
  `feedback.md`, `agent-session.summary.md`, `delivery.md`, `prototype.md`, `proof.md`,
  `ship.md`, and `verify.log`, then asks the configured `ask.agent` to answer
  only from that packet.
  The live session transcript is kept
  only in process memory and is used for conversational references; saved task
  state and artifacts remain the factual evidence. Empty input or `/done` exits,
  `/edit` opens a long reply in `$EDITOR`, and `/cancel` aborts. Non-TTY callers
  must use `factory ask --print [task-id] "<question...>"`, which preserves the
  one-shot scriptable behavior.
- **`factory session`** opens an interactive Codex or Claude session for realtime
  follow-up tweaks after a task is done. It runs the selected CLI in its
  permission-skipping mode because the session is already an explicit human
  handoff. It defaults to Codex and the latest `done` task; use `--agent claude`
  to choose Claude. `factory codex` and `factory claude` are shortcuts. The
  command writes `agent-session.md` as a manifest of useful artifact paths and
  asks the agent to append `agent-session.summary.md` before exiting. This is an
  escape hatch for human-in-the-loop editing; it does not change task status or
  route work back through the autonomous loop.
- **`factory deck [task-id] [--url]`** opens the visual `brief.html` generated for
  a successful `done` task. With no id it targets the latest `done` task in this
  worktree. `--url` prints the local `file://` URL instead of opening a browser.
- **`factory show`** displays the saved completion feedback near the top when a
  done task has `feedback.md`, followed by the plan, prototype summary, review,
  verify, delivery, and activity artifacts. If a prototype has a primary artifact,
  show prints a `file://` pointer instead of rendering arbitrary HTML/SVG inline.
  If `brief.html` exists, it prints the `factory deck` command instead of
  rendering the HTML inline.

### Recovery & auto-resume

A gate failure first runs the in-run auto-fix loop. Each attempt's failure is
appended to a persisted log (`failures.jsonl`, timestamped, with a failure
fingerprint and a worktree-diff hash, spanning resumes), and after each one a
**convergence judge** reads the whole history and decides whether to keep going.
Two bounds are **mechanical, not judged**: a byte-identical failure with an
unchanged worktree is never re-run (the loop asks the human instead of guessing
again), and `config.retries` (default 10) is a REAL cap — at the cap the judge's
CONTINUE is overridden and the human is asked with the failure attached. The
history also feeds the next fixer ("these approaches already failed — don't
repeat them"), and failure detail keeps both the head and tail of gate output so
the fixer actually sees the assertion diffs.

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
  growing backoff (2m → 5m → 15m → 30m → 60m), up to a cap (5); past it the judge
  may approve more retries only up to an absolute ceiling (10), after which the
  human is asked. The verify doctor can also rule **GATE-MISCONFIGURED**: the
  verify command itself is broken (nonexistent script, mangled quoting) — it
  supplies a corrected command, which is persisted and re-run, instead of the
  loop dying against a gate that could never pass. VERIFY commands are also
  sanitized at parse time (markdown backticks around a command became a command
  substitution under `bash -lc` and killed two real tasks).
- **review panel** (the code or rollout safety was judged bad — re-running churns
  code without new input) → straight to `blocked` and emits attention once no
  runnable work is left. You look (`factory show <id> review`), then
  `factory retry ["note"]` when you're ready.

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
`factory correct` does not generate completion feedback; it is a manual override
path, not a clean successful pipeline completion.
Together these close the learning loop — every block and every takeover becomes
something the factory can learn from, not just a dead end.

### Typical flow

```bash
wt add fix-upload-retry          # make a worktree (existing tooling)
factory add "Add exponential backoff to the upload client" --verify "bun test upload"
factory run                          # walk away; come back when the window alerts
# if it asks:
factory add "Cap at 5 retries, 30s max backoff"
# if it's blocked on review-panel findings, after a look:
factory retry -m "the reviewer's concern is handled by the lock in upload.ts"
# if you reviewed progress and found a concrete issue:
factory add "the mobile button wraps; check sibling controls too"
```

## Spawning & the fleet (the integration pattern)

factory is environment-agnostic: it emits lifecycle [hooks](#hooks) and writes its
state to files. *How* you spawn loops and surface their state is yours to wire —
here's the pattern that works well (tmux).

**One loop per worktree.** Run each workstream in its own git worktree, each as a
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
`retries`) so you don't repeat them per repo.

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
  **Repo-level state is keyed by repo identity, not path**: the normalized origin
  URL (e.g. `github.com/evansolomon/factory` → `github.com-evansolomon-factory`)
  under `<base>/repos/<repo-key>/` — so all clones and hosts of one repo share one
  body of lessons, metrics, eval candidates, and delivery history. Repos with no
  origin fall back to the path key. Machine-specific knowledge (the environment
  playbook) lives in a per-host layer at `repos/<repo-key>/env/<host>.md`.
- **`retries`** — hard cap on auto-fix iterations after a failed gate
  (review-panel/verify), **enforced mechanically**: at the cap the judge's
  CONTINUE is overridden and the human is asked. Two more mechanical bounds ride
  with it: a byte-identical failure with an unchanged worktree is never re-run
  (stuck → ask), and judge-approved auto-retries stop at an absolute ceiling.
  Default `10`; `0` disables auto-fix.
- **`triage`** — classify each task first; trivial ones skip the whole plan
  ensemble (research/plan/critique/reconcile/revise/select) and go straight to
  implement, still reviewed + verified (default `true`; `false` always runs the
  full flow). A per-task declared complexity from `factory add --trivial` or
  `--complexity trivial|complex` wins over this setting and skips model triage.
- **`security`** — run a dedicated red-team security gate on the implemented diff
  (every task, both paths), feeding the same auto-fix retry loop as the review
  gate (default `true`; `false` skips it).
- **`workforce`** — before complex-task planning, run a read-only workforce router
  that chooses which research scouts, optional review lenses, lens agents, and
  specialist policies fit the task (default `true`). The conductor still enforces
  required floors like correctness review and the `security`/`ux` gates; malformed
  router output falls back to the legacy single-research/fixed-review shape.
- **`rescue`** — before a task becomes terminally blocked, run a read-only rescue
  strategist that may authorize one sharper code-fix attempt, ask the human, retry
  later, or accept the block (default `true`).
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
- **`implementerAccess`** — `write` (default, sandboxed) or `full`: let the
  implement/fix stages run the repo's real checks (services, sockets, DBs) during
  implementation, so failures are discovered at the cheap stage instead of the
  verify gate. Only use `full` in repos you already trust factory to run
  unattended.
- **`autoAcceptAfterMinutes`** — opt-in: when a needs-input task's questions ALL
  carry recommended answers and nobody replies within the window, proceed with
  the recommendations (recorded as a normal, auditable answer). Default `null`
  (never): asking is a quality instrument; opt in deliberately.
- **`autoShip`** — the earned-autonomy dial: `{ "minFirstPassYield": 0.8,
  "minTasks": 10 }` lets an auto-selected side-effecting delivery skip the
  confirmation pause when the repo's rolling telemetry clears the bar — and
  reverts to confirming the moment the numbers dip. Default `null` (always
  confirm).
- **`dispatch`** — optional override for `factory dispatch`. The zero-config
  default spawns each backlog item as a sibling worktree on a `factory/<name>`
  branch running a detached `factory run --until-done` (logs under
  `$FACTORY_HOME/logs/`). Set `{ "spawn": "<command>" }` to route through your
  own tooling instead (tmux windows, custom worktree layout): one backlog item
  per spawn, `FACTORY_INTENT`/`FACTORY_NAME`/`FACTORY_VERIFY` in its env, exit 0
  removes the item. Factory never queues tasks internally or manages lanes.
- **Config cascade note:** `agents` and `specialists` **merge per key** across the
  cascade (a worktree override of one role no longer silently resets its
  siblings); `hooks` concatenates; everything else is closest-wins.
- **Delivery** is task-local, not static config. After sharpen/triage clarifies the
  task, factory chooses whether a completed task should stop after the local
  commit, run a named delivery skill, or follow a one-off policy. The selector
  reads the task spec, repo docs, available `.skills/*/SKILL.md` descriptions, and
  recent repo delivery history; if unsure, it chooses `none`. Explicit directives
  like `$ship` or `/ship` in `factory add` win and are stripped from the task text.
  Plain wording like "open a PR and auto merge" can resolve to a matching skill
  when one exists. When the selector auto-selects a side-effecting action (`skill`
  or `policy`), the task pauses at `needs-input` before the plan/implementation
  stages so you can confirm or override it. Explicit directives, manual
  `factory delivery ...` choices, and selected `none` do not pause — and with
  `autoShip` configured, earned telemetry waives the pause mechanically.
  Delivery skills are discovered in three layers, most specific name winning:
  the repo's committed `.skills/`, repo-keyed uncommitted skills at
  `$FACTORY_HOME/repos/<repo-key>/skills/` (per-repo behavior shared by all of
  that repo's worktrees, kept out of the repo), and the machine-global
  `$FACTORY_HOME/skills/`.

  Interactive `factory run` prompts inline; pressing Enter accepts the recommended
  delivery. Non-interactive runs answer through the normal state-aware path, for
  example `factory add '$ship'` to accept a `$ship` recommendation. Accepted
  answers are `none`, `$pr`, `/pr`, `$ship`, `/ship`, or a one-off policy string.
  `delivery.md` remains the raw selector output, `questions.md` / `answers.md`
  record the confirmation, and final `meta.delivery` is the confirmed or
  overridden delivery.

  Inspect or override a task with `factory delivery`: `factory delivery`, `factory
  delivery none`, `factory delivery '$ship'`, or `factory delivery "open a PR and
  do not merge"`. Delivery failure is treated like a transient gate failure: the task
  is set aside for auto-retry and only blocks after the auto-retry cap is spent.

Successful pipeline-completed tasks also get local completion artifacts after
optional delivery: `feedback.md` for the concise markdown handoff, and best-effort
`brief.html` for a visual one-page brief. Both are attempted even when delivery is
`none`, and failures log warnings without blocking `done`, telemetry, hooks, eval
capture, or delivery behavior. `factory run` prints a bounded rendering of the
handoff with `detail: factory show <task-id>` and, when a brief exists,
`brief: factory deck <task-id>`. `factory show <task-id>` displays the saved
markdown artifacts and points to the brief. Complex-path prototype artifacts are
pre-implementation artifacts, not completion briefs; they are visible through
`factory show <task-id>` and, for primary artifacts, a local `file://` pointer.
- **`ask`** — which AI answers `factory ask` questions. This is separate from
  `agents.reviewer` because asking is about assembling the right saved context, not
  participating in the task pipeline. Shape:
  `{ "agent": "claude" }` or
  `{ "agent": { "cli": "codex", "model": "gpt-5.4" } }`. Default:
  `{ "agent": "claude" }`.
- **`agents`** — which agent fills each role:
  - `planners` (list) — draft + cross-critique + revise. **≥2 different agents
    enables the cross-model ensemble**; 1 → single planner, no critique.
  - `implementer` — also runs triage, research, reconcile, and select (the "lead").
  - `reviewer` — the fresh adversarial diff review, red-team security gate, risk
    assessment, and deploy-safety review
    (best a *different* model from the implementer, to avoid self-bias).
  - `delivery` — runs task-local delivery and completion handoffs.
  - `workforce` — chooses the dynamic read-only workforce shape for complex tasks.
  - `rescue` — last-chance read-only strategist before terminal blocking.
  - `researchers` / `reviewers` — optional named maps the workforce router can
    select for specific scouts or lenses, e.g. `{ "runtime": "claude" }`.
  - `namer` — cheaply summarizes new task intents into short task ids. This is
    best-effort; if the model call fails, `factory add` falls back to the local
    prompt-prefix slug.

  Each value is `"codex"` / `"claude"` or
  `{ "cli": "codex"|"claude", "model"?: "…", "reasoningEffort"?: "low", "provider"?: "…" }`.
  Default: `{"planners": ["codex","claude"], "implementer": "codex",
  "reviewer": "claude", "delivery": "claude", "workforce": "claude", "rescue": "claude",
  "namer": {"cli": "codex", "model": "gpt-5.4-mini", "reasoningEffort": "low"}}`.
  `reasoningEffort` is codex-only and maps to Codex's `model_reasoning_effort`.
  Only `codex` and `claude` are built in (each needs an adapter — see below).

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

- **`specialists`** — user-authored markdown policy files the workforce router may
  attach to a scout or review lens. Shape:
  `{ "deploy": { "path": "policies/deploy.md", "description": "Deploy safety", "appliesTo": ["review.deploy", "research.runtime"] } }`.
  Relative paths resolve from the repo root; `appliesTo` is optional and, when set,
  limits where the policy can be injected.

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
| `task.stale` | parked (needs-input/blocked) past 24h | `task, state` |
| `loop.idle` | queue drained | `state` |

`attention.state = needs-input` means factory is waiting at an intentional human
prompt. That includes a queued task paused for answers from the sharpen or
planning stages.

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
  task.original.md       # the raw intent as first written — never overwritten
  meta.json              # machine-owned status, verify, sharpen, optional complexity, timestamps, resume/retry state
  meter.json             # live token/stage counts for the current pass
  meters.jsonl           # append-only per-pass meter history (true multi-pass cost)
  sharpen.md             # run-loop intent sharpening output
  sharpen.review.md      # reviewer gate for the sharpened spec
  sharpen.final.md       # final sharpen synthesis, when needed
  triage.md              # model triage output, when model triage runs
  research.md            # shared research dossier
  plan.<planner>.md      # first-pass planner output
  critique.<planner>.md  # cross-critique output
  ux.plan.md             # user-facing information architecture critique
  reconcile.md           # proceed vs ask decision
  questions.md           # open questions when status = needs-input (current round)
  questions.history.md   # superseded question rounds
  answers.md             # your answers, appended by factory add or the inline prompt
  human-feedback.md      # post-progress human feedback, appended by factory add/feedback
  human-feedback.analysis.md  # latest root-cause/sibling-case analysis of pending feedback
  plan.<planner>.v2.md   # revised planner output
  plan.final.md          # selected/merged plan
  plan.md                # selected plan persisted for resume
  risk.plan.md           # plan risk scores + verification focus, complex path
  prototype.md           # prototype decision summary or malformed-output fallback
  prototype.raw.md       # raw model output from the prototype stage
  prototype.meta.json    # prototype decision + primary artifact manifest
  prototype-artifacts/<artifact> # optional standalone primary prototype artifact
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
  verify.history.log     # superseded verify attempts
  quickfix.log.md        # post-PASS quick-fix pass output, when it runs
  remediate[.N].md       # verify-failure doctor: diagnosis + env repair, when it runs
  proof.md               # pass proof written before commit
  commit-message.md      # final commit subject synthesized from diff + author/repo history
  feedback.md            # completion handoff on success: summary + next verification steps
  brief.html             # visual one-page completion brief on success, best-effort
  agent-session.md       # manifest for a realtime interactive agent tweak session
  agent-session.summary.md # optional summary from that interactive session
  postmortem.md          # blocked-task diagnosis, when enabled
  delivery.md            # selector output for the task-local delivery decision
  ship.md                # delivery output, when the task chooses a skill/policy
  *.activity.jsonl       # raw agent event streams beside agent-written artifacts
```

`task.md` (yours) and `meta.json` (the machine's) are split so `factory` flips
status without rewriting your prose, except when the run-loop sharpen stage
finishes: then `task.md` is replaced with the refined spec. A complexity override
from `factory add --trivial` or `--complexity trivial|complex` lives in
`meta.json`; feedback bookkeeping lives there too as `feedbackCount`,
`feedbackConsumed`, and `feedbackSourceTaskId` for linked follow-ups. `triage.md`
exists only for model triage output. Repo-level state lives under the main
worktree's state dir, shared across linked worktrees:
`LESSONS.md`, `LESSONS.candidates.md`, `metrics.db`, `eval-candidates/`, and
`backlog/`. Structured learned lessons live in global factory state under
`$FACTORY_HOME/guidance/items/*.json`.

factory treats the **whole worktree** as the task surface. It does not refuse a
dirty worktree and it does not try to split preexisting hunks from agent-created
hunks before committing. At task start it writes `baseline.patch`; when the
worktree was already dirty, review prompts include that baseline so reviewers can
see what existed before this run. For the cleanest provenance, run one task per
worktree and start from a clean tree. The plural task directories are still the
right durable model: they preserve history, set-aside questions, retries,
follow-ups, and crash recovery without making the active workstream ambiguous.

## Meta loop and learned lessons

The self-improving part is now structured learned lessons plus the legacy repo
lesson files. Structured records live under
`$FACTORY_HOME/guidance/items/*.json`, one zod-validated JSON file per lesson.
Each record includes an id, scope, stages, source signal, status, timestamps, and
text. Global lessons apply everywhere; repo lessons apply only when the current
repo state dir matches the record.

Lessons are auto-applied to the stages they name: planning, critique/reconcile,
prototype, implementation/fix, review experts, consolidation, remediation, and postmortem.
Prompt blocks include the lesson id so bad guidance can be found and corrected.
Use `factory lessons list`, `factory lessons show <id>`,
`factory lessons rm <id>`, and `factory lessons edit <id>` to inspect, remove, or
fix records. Removal is a soft delete.

Three more loops close here. **Post-ship harvesting** (`factory harvest`): ship
records the branch and MR URL, so human rework commits (anything after factory's
recorded commit on that branch) and MR discussion become lesson candidates
instead of vanishing. **Moot detection**: a needs-input task parked past the
staleness window gets one read-only check of whether its intent already landed
through other work; likely-moot tasks are flagged for `factory close`, never
auto-closed. **Question-bar calibration**: every answer is classified
accept-vs-override, and the rolling accept rate is injected into the sharpen and
reconcile prompts — a repo where recommendations keep getting rubber-stamped
tells the asker to raise its bar, measured rather than hand-tuned.

Lessons now carry an outcome record: every terminal run increments
`applied`/`wins`/`losses` for the lessons that were actually injected, and a
lesson with a sustained losing record auto-retires. New lessons are deduped
semantically (near-duplicates refresh the existing record instead of
accumulating). And the eval corpus finally has its consumer: **`factory evals
run`** replays harvested candidates against the current build in a throwaway
worktree with an isolated `FACTORY_HOME`, scoring outcome-match and
touched-file overlap against the captured reference — the regression gate for
prompt/policy changes and for factory's changes to itself.

`LESSONS.md` remains legacy curated repo guidance at the repo-level state root,
keyed by the main worktree, and is still read into planning and critique.
`LESSONS.candidates.md` remains the raw human-curation queue for blocked runs,
needs-input events, postmortems, and manual corrections. Eval replay/scoring and
dynamic workflow DAGs are still out of scope.

## Intent sharpening (`factory run`)

The proactive complement to the reactive reconcile valve: resolve ambiguity after
triage and before planning. When state-aware `factory add` creates a new task, it
queues the raw intent immediately with `sharpen: pending`; the long-lived
`factory run` process then sharpens non-trivial pending tasks. Trivial tasks skip
sharpening and take the fast path. An agent (the configured `implementer`) turns
the raw intent into a
self-contained spec, reading the repo itself to answer what it can. The
spec is the durable handoff: problem, goal, context, verified current state,
priorities, scope, constraints, decisions and tradeoffs, rejected alternatives,
non-binding ideas, acceptance criteria, and assumptions.

The run-loop sharpener cannot hold an interactive terminal hostage. If it needs a
human decision, it writes `questions.md`, marks the task `needs-input`, and moves
on to other runnable work. State-aware `factory add` appends your answer to `answers.md`;
the next run pass sharpens again with that answer in context. `--raw` skips
sharpening and queues the intent as-is, and sharpening still auto-skips when the
intent is piped.

`--trivial` and `--complexity trivial|complex` also skip sharpening and queue the
intent as written, but they additionally declare runtime complexity. `--trivial`
is shorthand for `--complexity trivial`; `--complexity complex` means "do not ask
the model to classify this, but still do full planning." With `--edit`, the editor
still opens for intent composition before the task is queued directly.

Declared complexity is deliberately not a branch-maintenance mode. Tasks such as
fetch/rebase/fix conflicts/force-push need a separate operation model because the
normal pipeline expects implementation to create a worktree diff that factory
reviews, verifies, commits, and optionally delivers.

Before a proposed spec is shown, the configured `reviewer` agent checks it as an
autonomous-handoff artifact. Weak specs do not go straight into the queue: gaps
answerable from the repo are sent back to the sharpener as a revision request,
and only true human decisions become another question batch. This keeps
sharpening from becoming a nicer restatement of the original prompt.

The prompt borrows a recommended-answer interview discipline plus a few lenses
worth stealing from heavier plan-review skills: a **premise challenge** ("is this
the right problem?"), a **temporal check** ("what must be decided now vs.
discovered mid-build?"), a **scope lens** (narrow fix vs. an enabling refactor /
shared capability — "make the change easy, then make the easy change"), and a
**security sniff** (flag the security decision when the task touches a sensitive
surface) — every decision settled here is one fewer mid-loop escalation later.
It's grounded by a research-first rule: the agent reads relevant code and local
patterns before asking, so questions aren't ones it could have answered itself.
It preserves the human's judgment instead of flattening it: priorities,
constraints, rejected paths, and implementation ideas stay visible, with ideas
clearly labeled as non-binding. It's its own `sharpenPrompt` (not the Claude Code
`work-plan` skill), run as a normal headless factory stage.

The richer **`work-plan` skill** (`~/.claude/skills/work-plan`) remains for deep
sharpening inside a Claude Code session; the loop's reconcile valve still handles
any ambiguity that slips through, reactively.

### Statuses

Tasks usually move from `ready` into either `implementing` (trivial fast path),
`planning` (raw/skipped/already-sharpened complex tasks), or `sharpening` (pending
non-trivial tasks), then continue through `reviewing` → `verifying` → `shipping`
→ `done`. Other resting states are `needs-input` (paused for you), `retrying`
(transient verify or ship failure waiting on backoff), and `blocked` (human
attention required: no changes, review-panel failure, convergence stuck, or retry
cap exhausted).
`needs-input`, `retrying`, and `blocked` are set aside; `factory` moves on.
State-aware `factory add` returns a `needs-input` task to `ready`; `factory retry`
returns a blocked/retrying/stranded task to `ready`; due auto-retries are promoted
by the run loop. `factory add` also returns an active post-progress task to `ready` with
pending feedback analysis for the next pass. Feedback remains pending until a
reviewed, verified pass commits and consumes it; if the task is already done or
has a commit, feedback queues a linked follow-up instead of reopening it.

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

**Marker parsing** follows ONE convention everywhere: a marker is a whole line,
found anywhere in the output, last match wins — tolerant of model preamble and
trailing prose. Residual nulls fail toward safety: an unparseable reconcile is
treated as ASK (the valve fails closed), an unparseable convergence judgment asks
the human instead of terminating the task.

Each stage prints a completion line with elapsed time and token usage, plus a
per-task total (tokens + wall time). Usage parsing is lenient (`safeParse`) — if
a CLI's output format changes, the stage degrades to raw text with zeroed usage
rather than crashing the loop. (Cost isn't shown: codex's CLI doesn't report a
dollar figure, so there's no consistent number across both models.)

## Current state

- ✅ Conductor: full ensemble + reconcile valve, bounded auto-fix retry,
  `add/run/retry/status/show/report/lessons`, long-lived watcher, custom dir,
  `needs-input` escalation. Proven end-to-end on real tasks.
- ✅ **Configurable agents:** planners / implementer / reviewer / delivery roles,
  each `codex`/`claude` (+ optional model).
- ✅ **Dynamic workforce routing:** a read-only router chooses research scouts,
  optional review lenses, lens agents, and specialist policies for complex tasks.
- ✅ **Rescue strategist:** terminal blocks get one read-only last-chance pass
  before the task truly blocks.
- ✅ **Intent sharpening:** `factory run` refines default queued intents into a
  self-contained spec before planning.
- ✅ **tmux integration (via hooks):** live-stage window name, semantic attention
  states for `needs-input`/`blocked`/`done`, in-place elapsed heartbeat, and
  `(done)` when the queue finishes.
- ✅ **Meta loop:** structured learned lessons auto-applied by stage, legacy
  `LESSONS.md` compatibility, and SQLite telemetry via `factory report`.
- ✅ **Delivery:** task-local delivery selection, explicit skills, and history-backed defaults.

## Files

- `cli.ts` — arg parsing + the long-lived run loop
- `conductor.ts` — the per-task pipeline + live stage updates
- `agents.ts` — headless codex/claude wrappers
- `prompts.ts` — stage prompts (incl. the high-bar reconcile/critique prompts)
- `sharpen.ts` — intent sharpening parser and prompts for add/backlog/run flows
- `task.ts` — task dir format, status, answers
- `ask.ts` — context packet + AI answer for `factory ask`
- `view.ts` — `status` dashboard + `show` drill-down + `report` rendering
- `guidance.ts` — structured learned lesson storage, filtering, and rendering
- `lessons.ts` — legacy LESSONS.md read + raw candidate capture
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
