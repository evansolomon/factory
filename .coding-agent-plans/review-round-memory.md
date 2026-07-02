# Plan: give review rounds memory (answers + prior verdict reach the reviewers)

Line references verified against the working tree (HEAD `bf6fe26`).

## The failure this fixes

A real episode (`hour-slot-migration-plan`, yc-code, 2026-07-02) burned 10 fix attempts /
~84M input tokens before the mechanical cap fired. The loop was never mechanically stuck —
every round's blockers were novel (the fingerprint guard can't fire) and every fix pass
resolved the previous round's findings. The churn had three information-architecture causes,
not judgment causes:

1. **Reviewers never see human answers.** Only the consolidator (conductor.ts:2556) and the
   converge judge (conductor.ts:877) receive `answers.md`. The human's answer — "sync inbound
   in the safest way possible; if there are unavoidable risks, call them out in the commit
   message and MR description" — explicitly accepted documented residual risk, but the
   security lens never saw it and kept enumerating an open-ended threat model (5 rounds of
   novel blockers on the subsystem its own earlier feedback demanded).
2. **Reviewers never see the prior round.** The prior consolidated verdict goes only to the
   consolidator (conductor.ts:2528-2536). Fresh eyes each round produced a direct
   contradiction: round 4 advised moving authorization to the delegated slot host; round 9
   issued a BLOCKING finding demanding the exact reverse. A missing Gemfile dep sat invisible
   for four rounds for the same reason.
3. **The consolidator has no reversal rule.** It has "human answers are settled"
   (prompts.ts:1318) but nothing prevents a blocking finding that silently flips guidance a
   prior round gave.

Plus a small human-experience gap: at the cap, `stuckQuestions` (conductor.ts:1033) shows
only the latest failure — the attempt trend the human needs to answer well has to be
reconstructed by hand from failures.jsonl.

**Deliberately not added: a mechanical churn/plateau detector.** The cap fired correctly;
the defect was the rounds churning, which these changes attack directly. "All-novel blockers
per round" also describes healthy convergence (this episode's rounds 0-2 went 6→3→2
blockers), so a trigger would risk stopping productive loops. Revisit only if evals/report
data show churn persisting after this change.

## 1. `src/prompts.ts` — reviewer-facing settled-decisions and prior-round blocks

Two new module-local block helpers next to `humanAnswersBlock` (prompts.ts:780):

- `reviewerAnswersBlock(answers)` — `humanAnswersBlock`'s header plus the reviewer-specific
  rule: settled decisions are constraints, not review targets; a finding about a decided
  approach is valid only when that approach is implemented defectively; when an answer
  explicitly accepts a class of residual risk, restating that risk is ADVISORY at most and
  should be routed to documentation (commit message / MR description), not a fix demand.
- `priorReviewBlock(priorReview)` — renders the previous round's `consolidated.md` under
  "## Prior review round (the diff has since been revised to address it)", with the rule:
  verify the fixes rather than re-adjudicating; do not reverse prior-round guidance unless
  you name the concrete defect that guidance causes, and prefix such findings `REVERSAL:`.

Signature additions (trailing params, `= null` defaults, matching `consolidatePrompt`'s
`answers` pattern):

- `reviewPrompt(…, guidance, answers = null, priorReview = null)` (prompts.ts:1066)
- `securityPrompt(…, guidance, answers = null, priorReview = null)` (prompts.ts:1187)
- `uxReviewPrompt(…, guidance, answers = null, priorReview = null)` (prompts.ts:1267)
- `deploySafetyPrompt(…, guidance, answers = null)` (prompts.ts:1222) — answers only: deploy
  can BLOCK on the first pass (where pre-implementation answers already exist) but never runs
  on fix passes (conductor.ts:2402-2410), so it has no prior round to see.
- `riskReviewPrompt` unchanged — advisory-only by design, cannot block, and adding context
  it can't act on is noise.

`consolidatePrompt` (prompts.ts:1302) gains two rules in the "Do this:" list:

- Reversal rule: a finding that reverses guidance a prior round gave (whether or not the
  expert marked it `REVERSAL:`) is BLOCKING only when it names the concrete defect that
  guidance causes; otherwise drop or demote it, and state the contradiction explicitly.
- Accepted-risk extension to the existing human-answers bullet (prompts.ts:1318): when an
  answer explicitly accepts a class of residual risk, a finding restating that risk is
  ADVISORY at most — route it to commit-message/MR documentation, not another fix pass.

## 2. `src/conductor.ts` — plumbing

- Hoist the prior-verdict read above panel construction: `const priorReview = attempt > 0 ?
  await readArtifact(task, 'consolidated.md') : null` (replacing the read at 2528-2536,
  which keeps appending `priorReview` to the consolidator's `reports` exactly as today).
- Pass `answers` (already in scope, conductor.ts:2011) and `priorReview` at the panel build
  sites: correctness 2421, security 2438, ux 2483; `answers` only at deploy 2467.
- `stuckQuestions(gate, reason, detail)` (conductor.ts:1033) gains a `history: string[]`
  param rendered as "How the attempts trended (oldest first)" one-liners. Both call sites
  are inside `assessFailure` (1091-1098 identical-failure, 1117-1120 cap) and pass
  `failures.map(f => \`${f.gate}: ${f.summary}\`)` — at both sites the latest failure has
  already been `record()`ed, so the trend includes it.

## 3. Tests — `tests/prompts.test.ts`

Match the existing threading-test style (assert `.toContain`): the four lens prompts thread
`answers`; the three gating lens prompts thread `priorReview`; absent params leave the
blocks out. No test for `stuckQuestions` (module-local trivial rendering) and no assertions
on rule prose (brittle, no behavior).

## 4. Verification

`bun run test` (`biome check . && tsc --noEmit && bun test`) — tsc proves every call site
handles the new signatures. Follow-up (not this change): replay `factory evals run` on the
harvested corpus to compare outcome/file-set drift, per the earned-autonomy program's
prompt-change gate.
