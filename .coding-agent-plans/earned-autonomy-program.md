# Earned Autonomy Program

*The full improvement program for factory: from empirical baseline to earned autonomy.
Decisions locked 2026-07-01 with Evan: all phases (0-4) executed in order, hand-built (not
dogfooded through factory), fresh-start state migration, one PR. Full analysis corpus
(per-task forensic reports, thematic syntheses, data-miner reports — contains private
yc-code task content, kept out of this public repo) archived at
`~/code/factory/analysis-2026-07-01/`.*


**Execution status (2026-07-01):** all five phases implemented in one PR by hand.
One deliberate deferral: automatic post-ship feedback harvesting (Phase 3) — local
git authorship cannot reliably distinguish human rework from factory's own
commits, so a naive version would generate false feedback; it needs GitHub/GitLab
API integration and is left as an explicit follow-up. The deterministic CI poller
(Phase 2) shipped as a prompt-level contract (single long blocking waits) rather
than a factory-side poller; revisit if ship-stage token share stays high.

## North star

Factory's job is to convert intent into shipped, verified work with minimal human attention.
The most ambitious version of that is a **fleet that has earned full autonomy** — backlog in,
merged MRs out, the human consulted only on genuine product forks — where "earned" means the
system can *prove* its trustworthiness with numbers rather than ask for it with vibes.

The baseline says the raw material is already there: the code factory produces is good (the
critique/review stages catch shipping-grade bugs; 12+ real features landed with 0–1 touches),
and the failures are overwhelmingly plumbing — gate configuration, retry policy, interruption
contract, measurement. So the plan is not "make the agent smarter." It is: **stop losing
finished work, make cost proportional to task size, close the learning loops that already
exist in embryo, and then let the measured numbers unlock autonomy.**

Three numbers govern everything, all computable from telemetry today (once telemetry is
honest):

1. **Delivered-work rate** — tasks reaching done+delivered without human rescue.
   Baseline: ~68% eventual-done, but with rescues, stranded commits, and 60% of documented
   spend in runs that delivered nothing at snapshot.
2. **Attention efficiency** — human touches per task × information content per touch.
   Baseline: median 1 touch, but ~⅓ of questions carried near-zero information while the
   costliest failures never asked at all.
3. **Cost per delivered task** — with the tail, not the median, as the target. Baseline:
   median ~7–21M tokens; tail 611M for zero output.

Every workstream below names the number it moves. Anything that moves none of them is out.

## The workstream model (decision, 2026-07-01)

Factory's original data model assumed many queued tasks per worktree. Real usage (Evan's
bootstrap tool: spawn tmux window + worktree + factory per task, tear down on done) is **one
active task per workstream**, and the session data confirms it (30/33 worktrees held exactly
one task). Consequences adopted into the phases below:

- **One active task, enforced.** A second fresh `factory add` is an error with an explicit
  `--follow-up` escape; add/feedback routing collapses accordingly. Task *dirs* remain as
  records (retries, follow-ups, question rounds, crash recovery) — records, not a queue.
- **Worktree session state is disposable debris after teardown.** Durable value lives at repo
  level (Phase 0 re-key). `factory gc` prunes session dirs for worktrees that no longer
  exist; the teardown contract is documented for spawner tools.
- **`factory run --until-done`** exits when the workstream's task completes (non-zero on
  blocked), so spawners can sequence teardown without hook plumbing.
- **`factory add --name <slug>`** lets the spawner pass the task name (it already named the
  worktree), skipping the namer model call.
- **The Phase 4 dispatcher spawns workstreams, it does not queue tasks.** It drives a
  configurable spawn command (the bootstrap integration) — one backlog item = one worktree =
  one lifecycle — and reaps on done. Factory stays environment-agnostic.

## Design principles (constraints on all phases)

- **Keep the architecture.** CLI orchestration of peer agents, markdown artifacts, marker
  contracts, hooks, files-over-DB. The baseline vindicates it; nothing here requires a
  from-scratch agent loop or unified LLM client.
- **Mechanical backstops, semantic judgment.** LLM judges decide *within* budgets; code
  enforces the budgets. Today termination, caps, and stuck-detection are all delegated to
  model judgment — that inversion caused every catastrophic loss.
- **Never re-run identical work expecting different results.** If the failing command and the
  worktree diff are unchanged since the last failure, re-running is forbidden by code, not
  discouraged by prompt. (Factory itself distilled this lesson — then never applied it.)
- **A question is cheaper than a death loop; a default is cheaper than a question.** Answered
  questions cost 2–20 minutes. Silent loops cost hundreds of millions of tokens. Blocking on
  self-answered questions costs the whole task.
- **Fix measurement before trusting any claim of improvement.** Current meters are 2–5×
  wrong; the plan's own success criteria depend on them.

---

## Phase 0 — Honest measurement (prerequisite, small, do first)

Everything later is judged by numbers the system currently cannot produce.

- Persist per-pass meters (append, never overwrite); attribute ship/verify usage correctly
  (verify rows record 0 today); make attempt counters coherent across resumes; timestamp
  failures.jsonl entries.
- Preserve the raw human intent forever (sharpen writes a new file; it stops destroying
  `task.md`'s original). This also makes sharpening fidelity auditable and eval candidates
  trustworthy.
- Stop overwriting `questions.md` / `verify.log` in place; version them per round/attempt.
- Fix `proof.md` truncation and the stale `meta.commit` after ship appends commits.
- **Make the repo a first-class concept, keyed by normalized origin URL** (e.g.
  `github.com/evansolomon/factory` — protocol/credentials/`.git` stripped) instead of the
  main-worktree path. Today the same repo's state fragments across hosts and paths (factory's
  own lessons/metrics/evals are split between two keys in the baseline corpus). Repo-level
  state moves to `$FACTORY_HOME/repos/<origin-key>/`; within it, portable layers (lessons,
  metrics, eval candidates, delivery history) sit at the repo level, while machine-specific
  layers (the env playbook) live in a per-host sub-key. No remote → fall back to the path
  key; multiple remotes → `origin` wins. The layout must *support* cross-host sharing; nothing
  syncs automatically (SQLite over a synced filesystem is explicitly out).

*Moves: nothing directly; makes every other claim in this plan verifiable.*

## Phase 1 — Stop losing finished work (reliability floor)

The baseline's three never-finished yc-code tasks share one anatomy: blind implementer →
verify as the only feedback channel → channel lossy or misconfigured → non-adaptive loop →
judge never escalates. Break every link:

1. **Mechanical stuck detection.** Hash (failing command, failure output, worktree diff). An
   unchanged hash means the next action must be *different*: change strategy, remediate, or
   ask — never re-run. Enforce `config.retries` as a real cap in code (today it's a note
   passed to the judge). Same for the auto-retry cap (today the judge can retry hourly
   forever).
2. **Full-fidelity failure context.** Feed the fixer and the convergence judge the actual
   expected/actual diffs and stack traces, not head-truncated summaries. `elevate-comments`
   made 84 blind guesses because the loop literally could not see the assertion diff.
3. **The verify gate becomes repairable.** Sanitize VERIFY lines at parse time (the backtick
   corruption is a one-line fix that cost ~22h); add a third remediation verdict —
   **GATE-MISCONFIGURED** — that authorizes editing the verify *command* (never the code, never
   weakening a real check) with the change logged to the task; allow verify to grow to cover
   files the implementation added.
4. **Asking for help becomes a first-class failure action.** When the loop is stuck *and holds
   a concrete candidate fix* (the `we-recently-merged` case: a reviewer-written, pasteable
   shim), it asks one specific question — "apply this?" — instead of dying at the cap. When
   it's stuck with no candidate, it asks with its best diagnosis attached. Silence is no
   longer an option past a mechanical token/attempt threshold.
5. **needs-input gets a lifecycle.** (a) *Proceed-with-defaults*: when every question carries
   a recommendation, factory records the recommendations as explicit assumptions and
   continues after a configurable soft window (or immediately, per config); the questions
   remain visible and reversible via feedback. (b) *Staleness*: a parked task emits escalating
   attention hooks and, past a threshold, checks whether its intent has landed elsewhere (the
   auto-upgrade task was mooted by a manual commit 53 minutes in — factory never noticed) and
   proposes closing itself. (c) Answering resumes **at the paused stage**, not with a full
   replan.
6. **Structural safety debt from the briefing, now evidence-backed:** worktree locking (one
   loop per worktree, enforced); commit/meta crash-ordering; `Promise.allSettled` with a
   quorum floor for panels and planners; unified last-line marker parsing (reconcile currently
   fails *open* on preamble); deep-merge for `agents`/`specialists` config; migrate the
   `grilling` fossil status.

*Moves: delivered-work rate (the three lost tasks were all ship-worthy), tail cost, attention
efficiency.*

## Phase 2 — Cost proportional to work

The median task is healthy; the structure spends like every task is the worst task.

1. **Sandbox parity for the implementer.** Let the implementer run the verify command (or a
   scoped subset) during implementation in the yc environment. This moves discovery from the
   expensive gate to the cheap stage and is the single highest-leverage economic change —
   the death-loop anatomy starts with a blind implementer. Where full parity is impossible,
   remediation runs *before* first verify on repos with a known env playbook (see Phase 3).
2. **Calibrate triage.** It classified 42/42 tasks COMPLEX, so the trivial fast path
   effectively doesn't exist; 3.65M tokens to add ` --minify` five times. Recalibrate the
   prompt against the 34-task corpus (several were objectively trivial), and let a confident
   sharpen downgrade complexity.
3. **Scoped re-review.** After a fix pass, re-run only the lenses implicated by the fix delta,
   with the consolidator re-checking the rest against the prior verdict. A 3-line lint fix
   re-triggering a 5-agent panel (and 84 panels costing 240M tokens on one task) is the
   second-largest waste mechanism.
4. **Ship stops polling CI with a language model.** A deterministic poller (shell loop) waits
   on pipeline state and wakes the agent only on transitions. CI waiting is 27% of all tokens
   today; it should be ~0.
5. **Advisories get a cheap fix lane.** One scoped fix pass (no full panel re-run) for
   consolidated advisories the consolidator marks "cheap and safe," before commit. Eight tasks
   shipped reviewer-confirmed defects that later cost external review round-trips and human
   follow-up commits.
6. **Review the real change.** Include untracked files in `diff.patch` (`git add -N`
   equivalent); exclude factory's own scratch artifacts from the commit (the plans-dir sweep
   put a 333-line scratch file into master).

*Moves: cost per delivered task (median and tail), delivered-work rate (advisory lane,
real-diff review).*

## Phase 3 — Close the learning loops (the "self-improving" promise, made real)

Everything here already exists as write-only infrastructure. Close each loop:

1. **Per-repo environment playbook.** A durable, factory-maintained artifact stored in the
   machine-specific layer of repo state (`$FACTORY_HOME/repos/<origin-key>/env/<host>.md` —
   see Phase 0) — *not* committed to the repo and *not* shared across hosts, because its
   content is repo×machine (container memory limits, daemon sockets, local test DBs):
   provisioning steps, known quirks with fixes (tapioca OOM → `--no-regen` / memory bump,
   daemon.sock, test DBs), refreshed by every remediation. Remediation reads it before
   diagnosing; new worktrees provision from it before first verify. The RBI-OOM lesson was
   rediscovered ≥4 times and re-paid at multi-million tokens each — this converts the most
   expensive recurring failure class into a lookup.
2. **Guidance store goes live, with a quality gate.** Postmortem/correction lessons are
   validated (does the lesson reference a real, reproducible cause?), semantically deduped,
   scoped, and — critically — *scored*: each injected lesson records whether the run it
   touched succeeded, and lessons that never help decay out. Curation becomes an exception
   flow, not a prerequisite (0 of 45 candidates were ever promoted under the manual model).
3. **Eval replay runner.** Replay harvested candidates (spec + baseCommit + verify + reference
   diff — ~half are already well-formed) against a factory build; score pass/fail and
   diff-similarity. This is the regression gate that makes it safe to tune prompts, triage
   calibration, and convergence budgets — including letting factory run improvement tasks on
   itself with confidence. It is the keystone of the ambitious goal: without it, every prompt
   change is a guess; with it, the system can improve itself measurably.
4. **Feedback flows backward automatically.** Post-ship, factory watches its own branches: human
   follow-up commits and MR review threads on factory-authored MRs are harvested into
   feedback/lesson candidates (goals-draft-saving's 8 human follow-up commits and the
   i-recently-added relitigation were pure signal, and feedbackCount stayed 0).
5. **Context hygiene.** Pipeline agents run with a factory-owned instruction set, not the
   user's interactive CLAUDE.md (autonomous implementers were asking an absent human for
   permission to run tests); research must not read private memory files outside the repo.

*Moves: tail cost (env playbook), delivered-work rate (fewer env deaths), and unlocks Phase 4.*

## Phase 4 — Earned autonomy (the ambitious end state)

With reliability floors, proportional cost, and closed loops, the numbers themselves become
the control system:

1. **The interruption contract, fully inverted.** Factory asks only questions it cannot
   answer, always with an apply-by-default recommendation; it *always* asks when stuck with a
   candidate fix; and every question is measured (answered? overridden? rubber-stamped?) so
   the asking bar auto-tunes. Target: needs-input as a terminal state disappears.
   **Asking is not a cost to minimize** — a question that legitimately unblocks missing
   information is the cheapest quality instrument the system has (the baseline's override
   cases saved factory from confidently shipping the wrong thing). The goal is maximum
   information per interruption and zero silent failures; autonomy is never bought at the
   expense of quality.
2. **Delivery by default.** Register delivery skills on every machine factory runs on (7 of 8
   delivery selections chose "none" for lack of skills, stranding 33-hour tasks at
   unadvertised local commits). Every done task ends at an MR or an explicit, recorded
   decision not to.
3. **Auto-ship gated by measured yield.** When a repo's rolling first-pass yield and
   post-ship-rework rate clear thresholds, delivery escalates from "open MR" to "auto-merge
   on green" — and de-escalates automatically when the numbers dip. Autonomy is a dial the
   telemetry turns, not a config the human hopes about.
4. **The dispatcher.** A repo-level queue that assigns backlog items to worktrees/lanes,
   spawns loops, and load-balances — the existing `backlog` grown into the fleet's front
   door. The human's job compresses to: write intent, adjudicate genuine forks, review the
   weekly numbers.
5. **Factory develops factory, provably.** Improvement tasks to factory itself run through the
   eval replay gate: a prompt or policy change lands only if the regression set doesn't
   degrade. The self-improvement loop becomes compounding and safe — the original aspiration,
   with teeth.

## Success criteria (measured against the baseline)

| Metric | Baseline | Target |
|---|---|---|
| needs-input as share of pass outcomes | 49% | <10% *as a consequence of defaults absorbing rubber-stamps — never by suppressing legitimate asks*; none terminal |
| Documented spend in runs delivering nothing | ~60% | <10% |
| Runs exceeding 3× median tokens without human contact | multiple (worst 611M/17h silent) | zero — mechanically impossible |
| Reviewer-confirmed defects shipped as advisories | ≥8 tasks | ~0 (cheap-fix lane) |
| Recurring env failure re-diagnosed from scratch | ≥4× for one lesson | ~0 (playbook hit) |
| Trivial/fast path usage | 0/42 | matches actual task mix (~25–35%) |
| Ship-stage token share | 27% | <5% |
| Lessons promoted / applied | 0 | continuous, scored, decaying |
| Questions rubber-stamped verbatim | ~⅓ | <10% (defaults absorb them) |
| Eval regression set | write-only corpus | replayable gate on every factory change |

## Sequencing rationale

Phase 0 is first because every later claim is unverifiable without it, and it is small.
Phase 1 before Phase 2: reliability failures destroy entire tasks while cost failures only
inflate them — and several Phase 1 items (stuck detection, failure fidelity) are prerequisites
for trusting cheaper loops. Phase 3's eval runner is the keystone investment: it converts all
subsequent tuning (including the ambitious Phase 4 dials) from guesswork into measurement.
Phase 4 is deliberately last and deliberately mechanical — autonomy expands exactly as fast as
the numbers earn it, which is what makes "most ambitious" and "most reliable" the same plan
rather than a tradeoff.

---

# Appendix A: Empirical Baseline (2026-07-01)


*2026-07-01. Synthesized from 34 real recorded task runs (all sessions on yc-remote-dev-evan,
~12 days of usage, June 2026) analyzed by 34 per-task forensic agents + 2 data miners +
4 thematic aggregators. Supporting detail: `theme-wins.md`, `theme-failures.md`,
`theme-humanLoop.md`, `theme-economics.md`, `miner-metrics.md`, `miner-stores.md`,
`task-reports.json` (all in this directory). Raw session data: `/tmp/factory-sessions/`
(copied from `ubuntu@yc-remote-dev-evan:~/.factory/sessions`). Analysis only — no planning.*

## The corpus

34 tasks across two codebases: 22 in `yc-code` (real product work — Rails monorepo, printers,
meetups, Slack SAML, digests) and 12 on factory itself. Telemetry records 59 passes / 28 tasks;
per-task meters document **≥1.18B input tokens** (the DB says 582M — both are known
undercounts). Resting states: 21 done, 4 abandoned at needs-input, 1 blocked, 1 fossilized in
legacy `grilling`, and several in-flight/stranded snapshots.

## Scoreboard

| Metric | Value |
|---|---|
| Tasks eventually done | 21/31 non-in-flight (~68%) |
| Pass outcomes | done 32% · needs-input 49% · blocked 19% |
| Passes with zero retries | 30/49 (yc-code) |
| Median tokens per done task | ~7–13M (factory-self) · ~21M (yc-code) |
| Clean single-pass feature | 27–47 min end-to-end |
| Questions asked | 106 across 21 tasks; 62% good, 32% answerable-from-repo or noise |
| Median human touches per task | 1 (one batched Q&A round) |
| Tokens sunk in runs that delivered nothing | ~725M documented (~60% of documented spend); ~96M permanently dead excluding in-flight |
| Worst single run | `elevate-comments-content`: 611M input tokens, ~17h, 84 identical verify failures, never committed |
| Lessons promoted to LESSONS.md | 0 of 45 captured candidates |
| Guidance records created | 0 (the store doesn't exist on the server) |

## What is going well (evidence-ranked)

1. **Sharpen produces faithful, repo-grounded specs** (~15 tasks verified, zero fidelity
   counterexamples). It preserves human overrides, flags typos as assumptions instead of
   silently fixing them, and repeatedly found real design traps in 1–2 minutes. Sharpen-review
   caught ≥5 spec-level bugs before any code existed (e.g. a spec contradiction that "will
   cause the implementer to reintroduce the bug this task exists to fix").
2. **The critique ensemble is the highest value-per-token stage in the system** (~3% of
   tokens). Standout: claude *built and ran binaries* to prove `strip` corrupts Bun
   executables while exiting 0 — which would have shipped corrupted release assets to every
   user. Also: a plan that wouldn't compile, a ~60MB memory pin, a metric that "lies" on
   queue-full, six-file merge conflicts found via an actual `git merge-tree` dry run.
3. **The review panel finds real, test-invisible, blocking defects** (8+ tasks): a compiled
   binary that was a silent no-op, a fail-open `$ship` authorization, a MissingTemplate that
   would break every digest send, an out-of-scope docker memory hack blocked as a workaround.
   Consolidation genuinely adjudicates (refutes false blockers with in-repo precedent) rather
   than vote-counting.
4. **Real end-to-end autonomy happens.** 12+ done runs with 0–1 human touches, including
   production features the human immediately built on (add-snmp-telemetry: two follow-up MRs
   within a day; m-add-prometheus: one-line intent → shipped green MR in 38.5 min; a-while-back:
   13 answers in 20 min, then 10.5 unattended hours to a green 236-example verify).
5. **Ship shows senior-engineer CI judgment where delivery skills exist**: classifying infra
   vs code failures by comparing against master's own pipeline, mutation-testing its own new
   test, clearing an unrelated CVE, declining to self-assign reviewers, refusing to ship over
   a new Bugbot finding.
6. **The remediation doctor's env-vs-code triage is usually right and fast** (8+ clean
   ENV-FIXED cycles: missing test DBs, stale node_modules, tapioca OOM → container memory).
7. **Mid-run reconcile honors the high bar**: ~10 correct PROCEED-with-defaults runs whose
   assumptions all held.

## What is going badly (taxonomy, ranked by frequency × severity)

### Tier 1 — run-killers

1. **Non-adaptive fix/verify loops.** The system re-runs byte-identical failing commands and
   recycles stale diagnoses; converge narrates the churn but keeps voting CONTINUE.
   `elevate-comments-content` took 84 consecutive verify failures (~17h, 611M tokens, 240M on
   re-review alone) with converge admitting "the root cause never changed"; rescue fired at
   attempt 81 and made it worse. Compounded by **lossy failure summaries** — the loop strips
   the RSpec expected/actual diffs that would have ended it.
2. **Factory corrupts or freezes its own verify gate and has no repair path.** Sharpen-*review*
   wrapped VERIFY commands in markdown backticks → bash exit 127 forever, on two tasks
   (~22h, ~27.5M tokens, two ship-worthy diffs stranded). Factory asked the human to fix a
   value that was literally in its own question text. Verify commands are frozen at sharpen
   time and can't grow to cover files the implementation adds.
3. **needs-input is a terminal state masquerading as dialogue.** 49% of passes end there; no
   nudge, timeout, or proceed-with-defaults. Every abandoned question carried a confident
   self-recommendation. The purest case: auto-upgrade blocked on 3 self-answered questions;
   the human hand-built the identical feature 53 minutes later. Humans answer parked questions
   by re-spawning the task in another worktree, leaving originals to rot.
4. **The implementer sandbox can't run the gate it must satisfy** (≥12 yc-code tasks:
   daemon.sock EPERM, read-only fs, missing gems). Implementers ship blind on syntax+rubocop,
   pushing all discovery to the expensive verify gate — the structural cause of #1.

### Tier 2 — chronic and expensive

5. **Environment lessons are never learned.** The tapioca RBI-regen OOM was independently
   rediscovered ≥4 times, written to LESSONS.candidates.md each time (with a wiki-link to a
   LESSONS.md that doesn't exist), and re-paid at multi-million tokens per run. The learning
   loop is fully inert: 0 candidates promoted, 0 guidance records, feedbackCount 0 everywhere.
6. **PASS-with-advisories has no fix lane; known defects ship.** ≥8 tasks shipped
   reviewer-confirmed bugs (one previously BLOCKING, demoted across passes). Measured cost:
   a thrice-flagged advisory bounced back as an external Bugbot block (two full CI
   round-trips); shipped races cost ~8 human follow-up commits.
7. **The reviewed diff omits untracked new files** (`git diff HEAD`) in ~10 tasks — the new
   module that *is* the change gets reviewed blind or via reviewer improvisation. Sibling:
   `git add -A` swept a 333-line scratch plan into master.
8. **No effort tiering; everything is COMPLEX.** Triage never once said trivial (42/42 model
   calls). 3.65M tokens to add ` --minify` five times; full 5-agent panel re-runs after every
   1-line fix; answering one question restarts the whole pipeline (17.3M tokens to re-hit the
   identical wall); ship burns 27% of all tokens mostly LLM-polling CI on 30s turns (47.9M on
   one task).

### Tier 3 — pervasive observability rot

9. **Artifacts lie or vanish**: proof.md is a truncated stub in ~11 runs; the raw human intent
   is destroyed by the sharpen overwrite in ≥10 tasks; meter.json keeps only the last pass
   (true costs off by 2–5×); verify rows always record 0 tokens; attempt counters are
   incoherent; questions.md and verify.log are overwritten in place.
10. **Context leakage**: the user's interactive CLAUDE.md permission rules ("don't run tests
    without permission") contaminate autonomous pipeline agents in ≥5 runs; research grepped
    the user's private global memory file.

## The core inversion (single most important finding)

**Factory interrupts the human for decisions it has already made, and stays silent through the
failures only the human can break.** ~a third of questions transmitted near-zero information
(verbatim rubber-stamps of factory's own recommendations; second rounds are systematically
worse than first), and blocking on self-answered questions killed real tasks. Meanwhile
`elevate-comments` burned 611M tokens over 17 hours without once asking for help, and
`we-recently-merged` sat blocked holding a reviewer-written, copy-pasteable one-file fix that
the retry architecture was structurally unable to apply ("a one-question interrupt would
likely have shipped the task"). Answered questions cost 2–20 minutes; unasked questions cost
hundreds of millions of tokens; asked-but-undelegatable questions cost the whole task.

## Economics in one paragraph

Output is 0.67% of input — the bill is context re-ingestion, heavily cache-served. The median
is healthy (a clean feature: ~7–21M tokens, under an hour); **the tail sets the bill**: one
stuck loop cost more than every factory-self task combined, and loops + CI-polling-as-LLM +
full-panel re-runs account for the large majority of marginal spend. Value density is
inverted: sharpen+critique (~9% of tokens) produced most of the prevented defects;
ship+re-review (~40%+) produced most of the waste. Long tails are almost never compute — they
are parking (needs-input, backoff on deterministic failures) and polling. True total spend is
unknowable from the artifacts; every number above is a floor.

## Cross-cutting observations

- The three never-finished yc-code tasks share one anatomy: blind sandbox → verify as the only
  feedback channel → that channel lossy or misconfigured → non-adaptive loop → converge never
  escalates. Fixing any single link would have saved all of them.
- Factory's failures are mostly **plumbing, not code quality**. The diffs are good; the gate
  configuration, retry policy, artifact capture, environment provisioning, and the
  human-interaction contract are what fail. Every yc-code run over 1h of wall clock that
  stayed engaged ended done (except one).
- The feedback economy is one-way: humans absorb and rescue factory's output (lockfile
  repairs, 8 follow-up commits, next-day manual MRs), but nothing flows back — 0 lessons
  promoted, 0 feedback entries, delivery-history bootstrapping a self-reinforcing
  "mode: none" default because no delivery skills are registered on the server.
- Self-referential defects recur: the commit-message bug spawned a task that re-triggered the
  same bug; the completion-handoff task ended without a handoff; the trivial-flag task ran the
  full ceremony it was built to skip.
