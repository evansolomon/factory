// Stage prompts for the per-task ensemble. Read-only stages must output only
// markdown (it's saved verbatim as the artifact). Stages parsed by the conductor
// or sharpen loop must keep their exact marker lines
// (DECISION/COMPLEXITY/VERDICT/SHIP/SPEC READY/SHARPEN).

// Prior human answers, threaded into every pre-implementation stage so a resumed
// run doesn't re-ask what's already been settled.
function answersBlock(answers: string | null): string {
  return answers ? `\n\n## Answers already provided by the human\n${answers}` : ''
}

// Curated lessons from past runs (the meta loop). Threaded into planning and
// critique so prior mistakes shape the plan.
function lessonsBlock(lessons: string | null): string {
  return lessons ? `\n\n## Lessons from past runs (apply these)\n${lessons}` : ''
}

function verifyBlock(verify: string | null): string {
  return verify ? `\n\n## Verification command\n\`${verify}\`` : ''
}

// The research dossier from the RESEARCH stage, threaded into planning and
// critique so the whole ensemble reasons from the same grounded facts about the
// code, its history, and its conventions.
function researchBlock(research: string | null, framing: string): string {
  return research ? `\n\n## Repository research (${framing})\n${research}` : ''
}

function baselineBlock(baselineDiff: string | null): string {
  return baselineDiff
    ? `\n\n## Worktree diff before this factory run\nThe worktree already had changes before this run began. Treat factory as operating on the whole current worktree, but use this baseline to distinguish preexisting context from new changes when reviewing scope.\n\n\`\`\`diff\n${baselineDiff}\n\`\`\``
    : ''
}

function riskBlock(riskAssessment: string | null): string {
  return riskAssessment
    ? `\n\n## Risk assessment (advisory)\nUse this to calibrate implementation and verification effort. Do not expand scope beyond the plan just because a score is high; use the rationale to make the planned change safer and better proven.\n${riskAssessment}`
    : ''
}

export function feedbackAnalysisBlock(feedbackAnalysis: string | null): string {
  return feedbackAnalysis
    ? `\n\n## Human feedback analysis\n${feedbackAnalysis}\n\nApply this as post-progress feedback: change only the concrete cases justified by the inferred abstract problem or root cause.`
    : ''
}

export function feedbackAnalysisPrompt(
  intent: string,
  feedback: string,
  currentDiff: string,
  finalPlan: string
): string {
  return `Interpret the human feedback below as post-progress critique on an existing task. Do not make code changes. Generalize from the concrete comment before deciding what should change.

Report:
- Concrete observation: what the human specifically pointed at.
- Inferred abstract problem or root cause: the broader issue that explains the comment.
- Repo and diff surfaces inspected: files, artifacts, and current diff areas you checked.
- Other applicable concrete instances: sibling cases where the same abstraction applies.
- Non-applicable look-alikes: similar-looking cases you inspected and intentionally excluded.
- Specific required changes: the exact cases that should change.

Rules:
- First infer the abstraction/root cause, then search downward for concrete affected cases.
- Change only cases justified by that abstraction; do not expand into unrelated cleanup.
- If the feedback is too narrow to generalize, say that explicitly and still list what you inspected.

## Task
${intent}

## Final plan
${finalPlan}

## Human feedback
${feedback}

## Current diff
\`\`\`diff
${currentDiff}
\`\`\`

Output ONLY markdown under the report headings above. Make no code changes.`
}

// The dedicated research subagent. Runs before planning and gathers the factual
// groundwork — relevant code, existing patterns, history of the target areas,
// prior plans, conventions, gotchas — so plans are grounded, not assumed. It
// does NOT propose a solution; its dossier feeds the planners and critics.
export function researchPrompt(
  intent: string,
  verify: string | null,
  plansDir: string | null,
  userFacing: boolean
): string {
  const plansLine = plansDir
    ? `\n- Prior plans: read the most recent files under \`${plansDir}\` — they show how past changes here were scoped and the conventions and pitfalls they surfaced.`
    : ''
  const uiLine = userFacing
    ? '\n- UI vocabulary (this task is user-facing): the component library / design system in use and where it lives, the styling approach (design tokens, CSS framework, conventions), the closest existing user-facing feature to mirror, and how features like this are currently exposed to users (navigation / information architecture). Cite concrete components and files.'
    : ''
  return `Research the repository at your working directory to build the factual groundwork for planning the task below. You are NOT planning or proposing a solution — you are gathering what a planner must know to avoid blind spots. Read code and run read-only git commands. You also have network access: when the task depends on facts that live outside the repo — a live API or data source, an external schema, upstream/library docs — look them up and report what you find. Make no code changes regardless.

Investigate and report:
- Relevant code: the files, modules, functions, and types this task will touch or depend on (full paths). Quote the key signatures as they exist now.
- Existing patterns: how this codebase already solves similar problems — the task should follow these, not invent new ones. Cite concrete examples (file:line).
- Recent history: \`git log\` for the areas you'll touch — recent commits to the relevant files, what changed and why, and any reverts or follow-up fixes that hint at fragility.${plansLine}
- Conventions & constraints: error handling, testing, naming, and library choices in the neighborhood (don't assume a library is available — confirm it's already used in package.json or sibling files).
- Gotchas: hidden coupling, invariants, N+1 risks, or non-obvious state a naive plan would miss.${uiLine}

## Task
${intent}${verifyBlock(verify)}

Output ONLY a markdown research dossier under the headings above. Report facts grounded in the actual code (cite file:line), not a plan or a recommendation. Make no code changes.`
}

export function planPrompt(
  intent: string,
  verify: string | null,
  answers: string | null,
  lessons: string | null,
  research: string | null,
  userFacing: boolean
): string {
  const uxBlock = userFacing
    ? `\n\nThis task is USER-FACING — the plan must address the user experience, not just the code:
- Exposure / information architecture: where and how the feature is surfaced (entry points, navigation, placement) and how a user discovers and reaches it.
- Flow & states: the interaction steps, plus the loading / empty / error / success / no-permission states.
- Consistency: reuse existing components and design tokens and mirror the closest existing feature — do not invent new UI patterns. Name the ones to use.
- Affordances & labeling: copy and labels that match the product's voice and the user's mental model.`
    : ''
  return `Plan how to implement the task below in the repository at your working directory. Explore the codebase first and base the plan on what actually exists, not assumptions.

Produce a concrete, interface-level plan another engineer could execute without re-deciding the design. Cover:
- Files: each file to change (full path) and the specific change.
- Interfaces: the key functions/types/signatures added or changed.
- Verification: how the change is proven — the verify command, and any tests to add.
- Order: the implementation steps in sequence.

Follow the existing patterns surfaced in the research — match how the codebase already solves similar problems rather than introducing a new approach.${uxBlock}

Scope it deliberately. Default to the simplest design that meets the requirements. But if the change is awkward to bolt onto the current structure, a focused preparatory refactor that makes it easy — "make the change easy, then make the easy change" — is in scope when it leaves the code simpler overall; and if the task clearly points at a general capability, weigh extracting a small shared abstraction now. The line is speculation: do NOT build for hypothetical futures, fold in unrelated cleanups, or add abstraction this change won't use. When narrow-vs-enabling-refactor is a real investment tradeoff, state your recommendation and reasoning explicitly so it's a visible decision, not a silent scope expansion.

## Task
${intent}${verifyBlock(verify)}${answersBlock(answers)}${lessonsBlock(lessons)}${researchBlock(research, 'ground the plan in these facts')}

Output ONLY the plan as markdown. Make no code changes.`
}

export function critiquePrompt(
  intent: string,
  otherPlan: string,
  answers: string | null,
  lessons: string | null,
  research: string | null
): string {
  return `You are a skeptical staff engineer reviewing another engineer's implementation plan for the task below. You did not write it. Read the codebase to check the plan against reality.

List the plan's problems as a ranked list, most to least serious: correctness errors, wrong assumptions about the code, cases the requirements actually need but the plan misses, or a materially simpler/more-correct approach. Cite specific files and functions. If the plan is sound, say so plainly.

Also run a reviewer pre-mortem: imagine this plan is now a merge request on your desk — what would a careful reviewer block it for? Convention violations, missing or weak tests, breaking changes to callers, unclear naming, migration/rollout/backfill concerns, or behavior that's hard to revert. Surface those now, while they're cheap to fix.

Challenge scope in both directions. Flag over-engineering (speculative abstraction, gold-plating, unrelated cleanups) — but also flag the opposite: a plan that wedges the change in as a one-off hack where a focused enabling refactor ("make the change easy, then make the easy change") or a shared abstraction the task clearly calls for would be simpler and more correct. Distinguish justified enabling refactoring (paid for by this change) from speculation (serving only hypothetical futures); endorse the former, reject the latter.

Flag only problems that affect correctness, the stated requirements, scope, or would genuinely block merge. Do NOT raise style nits or tests for cases that cannot happen — manufacturing gaps just drives churn.

Separately, surface anything only the human can resolve: genuinely ambiguous requirements, product/UX/priority calls, missing acceptance criteria, or context absent from the codebase. Put these under "## Open questions for the human", each phrased for a one-line answer and each with your recommended default. Apply a HIGH bar: first try to resolve it from the codebase; only ask when a wrong guess would build the wrong thing and no reasonable default exists. Otherwise state the assumption you'd make and move on.

## Task
${intent}${answersBlock(answers)}${lessonsBlock(lessons)}${researchBlock(research, 'check the plan against these facts')}

## Plan under review
${otherPlan}

Output ONLY your critique as markdown (with the Open questions section if any). Make no code changes.`
}

// A labeled plan or critique, so prompts can present an arbitrary-size ensemble.
export type Labeled = { label: string; text: string }

function labeledBlocks(heading: string, items: Labeled[]): string {
  return items.map((i) => `## ${heading} (${i.label})\n${i.text}`).join('\n\n')
}

// The UI/UX + information-architecture critique of the plan(s), for user-facing
// tasks only. An independent design perspective (separate from the code critique)
// that shapes how the feature is exposed and experienced before any code exists.
// Its output flows into reconcile / revise / select like the other critiques.
export function uxPlanCritiquePrompt(
  intent: string,
  plans: Labeled[],
  research: string | null
): string {
  return `You are a senior product designer and UX engineer reviewing the plan(s) below for a USER-FACING task — strictly through the lens of user experience and information architecture, NOT code correctness or security (others cover those). Read the repo to ground every point in how this product's UI actually works today.

Assess, and where weak say concretely how to fix:
- Information architecture: is the feature exposed in the right place? does a user discover and reach it naturally? does it fit the existing navigation and structure?
- Flow & states: is the interaction flow clear and minimal? are the loading / empty / error / success / no-permission states all accounted for?
- Consistency: does it reuse existing components, patterns, and design tokens, and mirror the closest existing feature — rather than inventing new UI? Name the components/patterns it should use.
- Affordances & labeling: are the labels and copy clear and consistent with the product's voice and the user's mental model?

Apply a HIGH bar — raise only issues that materially hurt usability, consistency, or discoverability; do not manufacture polish nits, that just drives churn. If a choice is genuinely a product/UX call only the human can make, and a wrong guess would build the wrong experience, put it under "## Open questions for the human", each with your recommended default.

## Task
${intent}${researchBlock(research, 'ground the UX review in this product')}

${labeledBlocks('Plan', plans)}

Output ONLY your UX/IA critique as markdown (with the Open questions section if any). Make no code changes.`
}

// The escalation valve. Sits after cross-critique (pre-implementation, so a
// question is cheap to act on) and decides: proceed autonomously, or pause for
// the human. Output leads with a machine-parseable DECISION line.
export function reconcilePrompt(
  intent: string,
  plans: Labeled[],
  critiques: Labeled[],
  answers: string | null
): string {
  const critiqueSection = critiques.length ? `\n\n${labeledBlocks('Critique', critiques)}` : ''
  return `Decide whether this task is clear enough to implement autonomously, or must pause for the human. You have the task, the plan(s), and any critiques (which may raise open questions).

Default to PROCEED. Pause only for a genuine blocker: the requirement is ambiguous in a way that changes what gets built, the work is destructive/irreversible, or no reasonable default exists. Test each candidate question — would a competent engineer also have to ask, or could they pick a sensible default and move on? If they'd proceed, so do you: state the assumption instead of asking. Drop anything already answered below or answerable from the codebase, and consolidate duplicates.

## Task
${intent}${answersBlock(answers)}

${labeledBlocks('Plan', plans)}${critiqueSection}

On the FIRST line output exactly one of:
DECISION: PROCEED
DECISION: ASK
If ASK, follow it with a concise markdown list of only the blocking questions, each with your recommended default. Make no code changes.`
}

export function revisePrompt(intent: string, ownPlan: string, critique: string): string {
  return `Below is your implementation plan and a critique of it. Revise the plan: fix the valid problems, and explicitly ignore critique points that are style-only, speculative, or out of scope — do not add complexity the requirements don't need.

## Task
${intent}

## Your plan
${ownPlan}

## Critique
${critique}

Output ONLY the revised plan as markdown. Make no code changes.`
}

export function selectPrompt(intent: string, plans: Labeled[], uxCritique: string | null): string {
  const intro =
    plans.length > 1
      ? 'Several independent plans for the task below are given. Internally choose the strongest, or merge the best of them into one coherent plan.'
      : 'A plan for the task below is given. Refine it into the final plan to implement.'
  const uxBlock = uxCritique
    ? `\n\n## UX / information-architecture review (fold these into the final plan)\n${uxCritique}`
    : ''
  return `${intro} Favor correctness first, then the simplest plan that meets the requirements — don't make it larger than the task needs.

## Task
${intent}

${labeledBlocks('Plan', plans)}${uxBlock}

Output ONLY the final plan, as a single self-contained markdown document written as if authored from scratch — this text is committed as the plan and handed to the implementer. Do NOT mention the candidate plans, their labels, that there were multiple plans, or how you chose or merged them; no meta-commentary about the process. Just the plan itself. Make no code changes.`
}

// Name the change for the committed plan's filename. A dedicated step (not folded
// into select) so the model summarizes the WORK rather than copying a URL, path,
// or identifier that happens to appear in the task text.
export function namePrompt(intent: string, plan: string): string {
  return `Name the change described below as a filename: 2–5 words describing what the change DOES, in lowercase kebab-case (e.g. \`add-retry-to-upload-client\`, \`fix-timezone-in-billing-export\`).

Rules:
- Name the action and its subject, not where it lives. NEVER copy a URL, domain, file path, or identifier from the task verbatim into the name.
- Output ONLY the name on a single line — no quotes, punctuation, explanation, or markdown.

## Task
${intent}

## Plan
${plan}`
}

// A user-facing build checklist, appended to the implement/fix prompts so the
// design system + UX decisions are honored at write time, not only caught in review.
function uxBuildNote(userFacing: boolean): string {
  return userFacing
    ? `\n\n## User-facing checklist
This change is user-facing. Reuse existing components and design tokens — do not hand-roll or hardcode styles (colors, spacing, typography). Match the patterns of the closest existing feature, honor the plan's information-architecture decisions, handle the loading / empty / error / disabled states, and keep labels and copy clear and consistent.`
    : ''
}

export function implementPrompt(
  intent: string,
  finalPlan: string,
  verify: string | null,
  userFacing: boolean,
  riskAssessment: string | null,
  feedbackAnalysis: string | null = null
): string {
  return `Implement the plan below in the repository at your working directory. Make the code changes it calls for and nothing more — do not fix, refactor, or comment on unrelated code.

Follow the codebase's existing conventions. Don't assume a library is available; confirm it's already used (package.json, neighboring files) before using it.

Address root causes, not symptoms. Do not weaken, skip, or delete tests, and do not hard-code values to make a check pass — if the plan or a test is wrong, stop and say so rather than work around it.

Do NOT commit — leave the changes in the working tree.

## Task
${intent}

## Plan
${finalPlan}${feedbackAnalysisBlock(feedbackAnalysis)}${riskBlock(riskAssessment)}${verify ? `\n\n## Verification\nThe change is checked with \`${verify}\`. Make sure it passes.` : ''}${uxBuildNote(userFacing)}`
}

// First pass: decide whether a task is trivial enough to skip the planning
// ensemble, AND whether it is user-facing (gates the UI/UX lenses). Biased toward
// COMPLEX so only clearly-small work takes the fast path.
export function triagePrompt(intent: string, verify: string | null): string {
  return `Classify the task below on two axes. Look at the repo briefly if it helps.

COMPLEXITY:
TRIVIAL — a small, mechanical, low-risk change you could describe in one sentence: a one-to-few-line edit, a rename, deleting files, a config/dependency bump, an obvious localized fix.
COMPLEX — needs design choices, touches multiple components, is ambiguous, security/data-sensitive, or otherwise risky.
When in doubt, choose COMPLEX.

USER-FACING:
YES — the change alters something an end user sees or interacts with: UI, a page/screen/component, styling, layout, copy/labels, or an interaction flow.
NO — purely internal: backend/API with no UI, data, infra, build, tooling, or an internal refactor.

Examples:
- "Bump the eslint version in package.json" → TRIVIAL, NO
- "Fix the typo on the login button" → TRIVIAL, YES
- "Rename \`foo\` to \`userId\` in cache.ts" → TRIVIAL, NO
- "Add a settings page for notification preferences" → COMPLEX, YES
- "Add pagination to the transactions API" → COMPLEX, NO

## Task
${intent}${verifyBlock(verify)}

Output ONLY these two final lines:
COMPLEXITY: TRIVIAL|COMPLEX
USER-FACING: YES|NO`
}

// The onComplete step: a full-permission agent delivers the committed branch,
// either by running a named skill or following a free-text policy. Ends with a
// machine-parseable verdict.
export function shipPrompt(
  intent: string,
  branch: string,
  mode: { skill: string } | { policy: string }
): string {
  const how =
    'skill' in mode
      ? `Deliver it by running the \`${mode.skill}\` skill.`
      : `Deliver it according to this policy:\n\n${mode.policy}`
  return `The task below has been implemented, reviewed, verified, and committed on the current branch. ${how}
Use whatever tools and skills the repo provides — open a merge request / PR, iterate on CI until green, respond to review. The commit is already made; push as needed.

## Branch
${branch}

## Task
${intent}

When done, output on the FINAL line exactly one of:
SHIP: OK
SHIP: FAILED <one-line reason>`
}

export type FeedbackPromptInput = {
  taskId: string
  intent: string
  finalPlan: string | null
  verify: string | null
  diff: string | null
  proof: string | null
  verifyLog: string | null
  ship: string | null
}

function optionalFeedbackBlock(label: string, text: string | null): string {
  return text ? `\n\n## ${label}\n${text}` : ''
}

export function feedbackPrompt(input: FeedbackPromptInput): string {
  const verifyLine = input.verify
    ? `\n\nThe verification command that already passed is: \`${input.verify}\`. Include that exact command in "What to verify next".`
    : '\n\nNo verification command is recorded for this task. Say that plainly if it matters.'

  return `Write a concise human-facing completion handoff for a successfully completed factory task.

Output markdown only. Start with \`## Summary\`.

Use exactly these sections, in this order:
## Summary
## What to verify next
## Useful artifacts

Requirements:
- The Summary section must be 2-3 concise sentences describing what changed and why.
- In What to verify next, include the verification command that already passed when one is provided.
- Include concrete manual/UI/code-review checks only when they are grounded in the task, plan, diff, proof, verify output, or delivery output.
- Do not invent URLs, UI paths, commands, deployment status, or manual checks.
- If no UI or manual check is identifiable from the provided context, say so plainly.
- Do not paste raw diffs, raw logs, secrets, or large blobs.
- In Useful artifacts, refer users to \`factory show ${input.taskId}\` for saved artifacts.
- Do not include marker lines, parser contracts, or a top-level \`# Feedback\` heading.

## Task id
${input.taskId}

## Task intent
${input.intent}${verifyLine}${optionalFeedbackBlock('Final plan', input.finalPlan)}${optionalFeedbackBlock(
  'Committed diff',
  input.diff
)}${optionalFeedbackBlock('Proof artifact', input.proof)}${optionalFeedbackBlock(
  'Verify log',
  input.verifyLog
)}${optionalFeedbackBlock('Delivery output', input.ship)}`
}

// Used on a retry after a gate (review or verify) failed: feed the failure and
// current diff back so the implementer fixes it in place.
export function fixPrompt(
  intent: string,
  finalPlan: string,
  failure: string,
  history: string[],
  diff: string,
  userFacing: boolean,
  riskAssessment: string | null,
  feedbackAnalysis: string | null = null
): string {
  const tried = history.length
    ? `\n\n## Already attempted (these fixes did NOT work — do not repeat them)\n${history.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : ''
  return `A previous attempt at the task below did not pass its gate. Fix the working tree so it satisfies the plan and passes verification. Address the root cause — do not weaken, skip, or delete tests or hard-code values to pass; if the failure means the plan is wrong, say so. Change only what's needed; don't touch unrelated code. Do NOT commit.${tried ? '\n\nThe approaches below were already tried and failed — diagnose why, and take a genuinely different path rather than re-applying a variation of them.' : ''}

## Task
${intent}

## Plan
${finalPlan}

## What failed (most recent)
${failure}${tried}

## Current diff
\`\`\`diff
${diff}
\`\`\`${feedbackAnalysisBlock(feedbackAnalysis)}${riskBlock(riskAssessment)}${uxBuildNote(userFacing)}`
}

// The verify-gate doctor: runs with FULL access when the verify command fails.
// It decides what KIND of failure this is and, for environment/setup problems,
// repairs the environment in place so verify can actually run — it does NOT edit
// the project's code or tests to make verify pass (that's the fixer's job). This is
// what lets the loop self-unblock from "tool not installed / deps not installed /
// build not run" instead of blindly re-implementing code or backing off forever.
export function remediatePrompt(
  intent: string,
  verify: string,
  failure: string,
  priorRemedies: string[]
): string {
  const tried = priorRemedies.length
    ? `\n\n## Environment fixes already applied this gate (verify STILL failed after each — don't just repeat them)\n${priorRemedies.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : ''
  return `You are the verify-gate doctor for an autonomous coding loop. The task below was implemented and the working tree's verify command was run to prove it — but verify FAILED. Diagnose WHY, and when the cause is the ENVIRONMENT rather than the code, fix the environment so the check can run. You have full access: install dependencies and tools, run build/codegen/setup steps, start services, set up local config — whatever a developer would do to make this repo's checks runnable.

Classify the failure as exactly one of:

- ENV-FIXED — an ENVIRONMENT/SETUP problem (missing dependencies, an uninstalled tool/binary — e.g. "command not found" / exit 127, a build or codegen step that hasn't run, a service/fixture that isn't up, missing local config) that you have NOW fixed. Apply the fix, then RE-RUN the verify command yourself to confirm it gets past the environment problem.
- ENV-BLOCKED — an environment/setup problem you could NOT fix autonomously (needs credentials, network you lack, a human decision, or infrastructure you can't provision).
- CODE — a genuine defect in the code or tests under verification (an assertion failure, a type error, a lint violation, a real bug). The environment is fine; the code must change. Do NOT change any code yourself — report CODE and the fixer will handle it.
- FLAKE — a transient or external failure unrelated to this change (a network blip, a race, a timeout, a port already in use). Retrying later will likely pass.

Rules:
- NEVER edit the project's source code or tests, and never weaken, skip, or hard-code around a check to make verify pass. Environment-only changes are in scope; changing what is being tested is not.
- When torn between CODE and ENV, prefer CODE — re-implementing is safer than masking a real defect with environment churn.
- Be economical: if it's plainly a code/test failure, don't touch the environment — just report CODE.

## Task
${intent}

## Verify command
\`${verify}\`

## Verify failure
${failure}${tried}

Output, as the FINAL two lines:
SUMMARY: <one sentence: the root cause and, if you fixed it, what you changed>
VERDICT: ENV-FIXED | ENV-BLOCKED | CODE | FLAKE`
}

// The convergence judge: after each failed fix attempt, decides whether the loop
// is making progress (each failure is genuinely new ground) or going in circles
// (the same root cause recurring / oscillating). Replaces a blind retry count —
// keep iterating while novel, stop when stuck. Also summarizes the latest failure
// for the history log the next judgment reads.
export function convergePrompt(
  intent: string,
  priorSummaries: string[],
  latestFailure: string
): string {
  const history = priorSummaries.length
    ? priorSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '(none — this is the first failure)'
  return `An autonomous fix loop is working a task; after each failed attempt it asks you whether to keep iterating. Decide on PROGRESS, not a count. You see every prior failure (summarized) and the latest failure in full.

- CONTINUE — the loop is converging: this latest failure is genuinely NEW ground (a different root cause) and the earlier problems appear resolved. Fixing one thing surfacing the next real problem is healthy progress.
- STUCK — it is NOT converging: the same root cause keeps recurring, an earlier-"fixed" problem has returned, or it's oscillating among problems already seen. Surface novelty (a new error message for the same underlying cause) is still STUCK.

A wrong CONTINUE wastes a loop; a wrong STUCK abandons a task that was nearly done. Weigh both — but if the same underlying problem has now appeared twice, lean STUCK.

## Task
${intent}

## Prior failures (oldest first)
${history}

## Latest failure (full)
${latestFailure}

Output exactly two lines:
SUMMARY: <one sentence naming the latest failure's root cause, for the history log>
VERDICT: CONTINUE | STUCK`
}

// Postmortem on a task the fix loop gave up on: a fast triage briefing for the
// human + a distilled, generalizable lesson candidate (richer than a raw block
// reason). Runs automatically on block; classifies the root cause so recurring
// failure modes are visible (and, later, so systemic failures are detectable).
export function postmortemPrompt(
  intent: string,
  failures: string[],
  diff: string,
  reason: string
): string {
  const history = failures.length
    ? failures.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '(no recorded attempts)'
  return `A task's autonomous fix loop gave up. Diagnose WHY — concisely, for a human triaging the block and for a lesson that prevents a repeat. Read the repo as needed; be honest (if the spec or the verify command was the real problem, say so).

Classify the root cause into ONE category:
- spec — the task/spec was ambiguous, wrong, or under-specified
- plan — the chosen plan was flawed or infeasible
- implementation — the code was buggy or didn't satisfy the plan
- test — the verify command / tests were wrong, flaky, or too strict
- environment — external or transient (build, deps, network, CI, auth)
- other

## Task
${intent}

## Why it gave up
${reason}

## Attempts (oldest first)
${history}

## Final diff
\`\`\`diff
${diff}
\`\`\`

Output in this exact shape:
CATEGORY: <one of the above>
LESSON: <one or two sentences, generalizable to future tasks in this repo — not specific to this task's incidental details>
## Analysis
<a few sentences: the root cause, and what would have prevented it>`
}

// Distill a lesson from a human takeover: the agent's failed attempt vs. the
// human's correction (the answer key) → what the agent should have done. The
// highest-signal lesson source, since the correct outcome is known.
export function correctionPrompt(
  intent: string,
  agentAttempt: string,
  humanFix: string,
  note: string,
  reason: string
): string {
  return `A human took over a task the autonomous loop got stuck on and fixed it. You have the agent's failed attempt and the human's correction — the answer key. Distill what the agent should have done, as a lesson that prevents the same mistake. Read the repo as needed.

Classify the root cause into ONE category: spec | plan | implementation | test | environment | other.

## Task
${intent}

## Why the agent got stuck
${reason}${note ? `\n\n## The human's note\n${note}` : ''}

## The agent's failed attempt
\`\`\`diff
${agentAttempt}
\`\`\`

## The human's correction (the right answer)
\`\`\`diff
${humanFix}
\`\`\`

Output in this exact shape:
CATEGORY: <one of the above>
LESSON: <one or two sentences the agent should remember, generalizable to future tasks in this repo>
## Analysis
<what the agent missed, and why the human's approach is correct>`
}

export function reviewPrompt(
  intent: string,
  verify: string | null,
  finalPlan: string,
  diff: string,
  baselineDiff: string | null
): string {
  return `You are a senior staff engineer pairing with the person who wrote the diff below. You didn't write it, so you bring fresh eyes — verify against the actual code rather than assuming the implementer got it right. Your job is to help make this change correct and ship-worthy, not to find fault. Read files in the repo as needed.

Your most valuable contribution is catching defects that would actually cause harm: wrong behavior, unmet requirements, or tests that don't really test. Spend your attention there. A change that works and meets its requirements is good even if you'd have written it differently — flagging style, taste, or optional polish just burns time and triggers needless rework.

Look, concretely:
- Correctness: does it actually do what the task and plan require? Trace the changed code.
- Completeness: each stated requirement is satisfied by specific code or a test; note any that genuinely aren't.
- Integrity: it does NOT weaken, skip, or delete tests, hard-code expected values, or patch a symptom instead of the cause. These defeat the purpose of the change and always block.
- Scope: it changes only what the task needs; flag unrelated edits that add risk.

If the change is correct and meets its requirements, say so plainly — that's a common and welcome outcome.

## Task
${intent}${verifyBlock(verify)}

## Agreed plan
${finalPlan}

## Diff
\`\`\`diff
${diff}
\`\`\`${baselineBlock(baselineDiff)}

For each finding, cite the specific code (file:line) and tag it BLOCKING (a correctness, requirements, or test-integrity defect that must be fixed before this ships) or ADVISORY (a real improvement that should not hold up the change). If there are none, say so.`
}

// Pre-implementation risk assessment. This is advisory context, not a gate: it
// helps the implementer and reviewer calibrate complexity, blast radius, and proof
// without mixing a scalar risk score into the binary triage marker.
export function planRiskPrompt(intent: string, finalPlan: string): string {
  return `Assess the implementation risk of the plan below. Read the repo as needed and ground the score in concrete facts: touched boundaries, data durability, external APIs, auth/security, concurrency, migrations, rollout order, and verification difficulty.

This is NOT a plan review and NOT a gate. Do not propose a different design unless the plan's risk comes from a specific, concrete flaw; in that case name the flaw as rationale. The goal is calibrated risk metadata that an implementer can use to choose proportionate tests and rollout care.

Use this 0-10 scale:
- 0-2: small localized change with obvious behavior and easy verification.
- 3-5: moderate uncertainty or blast radius; normal tests should cover it.
- 6-8: multiple boundaries, durable data, compatibility, concurrency, security, or hard-to-observe behavior; verification needs extra care.
- 9-10: high blast radius, irreversible/destructive behavior, complex rollout, or substantial unknowns.

## Task
${intent}

## Plan
${finalPlan}

Output ONLY this markdown structure:

## Scores
RISK: <0-10>
COMPLEXITY: <0-10>
MERGE-RISK: <0-10>
TEST-IMPORTANCE: <0-10>
CONFIDENCE: LOW|MEDIUM|HIGH

## Rationale
<bullets citing the concrete risk drivers>

## Verification focus
<bullets naming the proof that matters most>`
}

// Post-diff risk lens. It is deliberately advisory: concrete defects belong to
// the correctness/security/deploy-safety lenses, while this report preserves the
// scalar "how risky is this?" judgment humans often ask for before merging.
export function riskReviewPrompt(
  intent: string,
  finalPlan: string,
  diff: string,
  baselineDiff: string | null
): string {
  return `Assess the residual merge risk of the implemented diff below. Read the changed code and adjacent files as needed. Your job is to answer "0 to 10, how risky is this to merge?" with concrete rationale, not to re-review correctness.

Score risk from actual evidence:
- Complexity and blast radius of the changed code.
- Data durability, migrations, compatibility, config/env, queues/jobs/events, external APIs, auth/security, concurrency, and rollback difficulty.
- Whether the diff's tests or verification are proportionate to the risk.

This lens is advisory. Do NOT tag anything BLOCKING. If you notice a concrete defect, mention it as a risk driver and tag it ADVISORY so the consolidator can compare it with the domain experts' reports.

## Task
${intent}

## Agreed plan
${finalPlan}

## Diff
\`\`\`diff
${diff}
\`\`\`${baselineBlock(baselineDiff)}

Output ONLY this markdown structure:

## Scores
RISK: <0-10>
COMPLEXITY: <0-10>
MERGE-RISK: <0-10>
TEST-IMPORTANCE: <0-10>
CONFIDENCE: LOW|MEDIUM|HIGH

## Rationale
<bullets citing concrete risk drivers, each tagged ADVISORY>

## Verification gaps
<bullets tagged ADVISORY, or "none">`
}

// The dedicated security expert: a red-team researcher audits the implemented
// diff for vulnerabilities the change introduces or leaves open. Runs as its own
// panel lens (separate from the correctness review) so security gets first-class,
// adversarial attention — pointed at the threat model, not the implementer. Emits
// BLOCKING/ADVISORY findings for the consolidator, which renders the one verdict.
export function securityPrompt(
  intent: string,
  finalPlan: string,
  diff: string,
  baselineDiff: string | null
): string {
  return `You are a red-team security researcher auditing the diff below for the task. Assume an adversary controls every input the changed code can reach. You did not write it — trace the data flow through the repo as needed.

Hunt concretely for vulnerabilities this diff introduces or fails to prevent:
- Injection: SQL/command/template/log injection, unsafe deserialization, path traversal.
- AuthZ/AuthN: missing or wrong access checks, privilege escalation, IDOR, trusting client-supplied identity.
- Secrets & data exposure: leaked credentials/tokens, secrets in logs or error messages, over-broad responses, mishandled PII.
- Input validation: untrusted input used unvalidated at a boundary; SSRF from user-controlled URLs.
- Unsafe defaults & fallbacks: failing open, silent catches that mask security errors, disabled or weakened verification.

Report ONLY real, exploitable issues introduced or left open by THIS diff — name the attack and the specific code (file:line). Do NOT raise theoretical hardening unrelated to these changes; manufacturing findings just blocks good work. If the diff introduces no exploitable issue, say so plainly.

## Task
${intent}

## Agreed plan
${finalPlan}

## Diff
\`\`\`diff
${diff}
\`\`\`${baselineBlock(baselineDiff)}

For each exploitable finding, name the attack and cite the specific code (file:line), then tag it BLOCKING (an exploitable vulnerability that must be fixed before this ships) or ADVISORY (a real but non-exploitable security improvement). If there are none, say so.`
}

// The deploy-safety expert audits rollout mechanics rather than local correctness:
// mixed-version compatibility, migrations/backfills, env/config, queues/events,
// and rollback. Unlike general risk, concrete unsafe rollout paths may block.
export function deploySafetyPrompt(
  intent: string,
  finalPlan: string,
  diff: string,
  baselineDiff: string | null
): string {
  return `You are a release engineer auditing whether the diff below is safe to deploy. Judge mixed-version reality, not just whether the code works locally: old and new app versions may overlap, old queued data may meet new workers, old clients may call new APIs, rollback may happen after writes, and migrations/config may arrive before or after code depending on the deploy system.

Look concretely for:
- Backward and forward compatibility across API/schema/type/config changes.
- Database migrations, backfills, non-null/default constraints, destructive changes, and required rollout ordering.
- Queues, jobs, events, caches, and serialized payloads where old producers/consumers interact with new ones.
- Required env vars/secrets/feature flags and whether missing config fails safely.
- Rollback safety after new code has written data.
- Whether verification proves deploy safety, not just local correctness.

Report ONLY deploy hazards introduced or left open by THIS diff. Do not manufacture release-process advice unrelated to the change. If deploy safety is not applicable, say so plainly.

## Task
${intent}

## Agreed plan
${finalPlan}

## Diff
\`\`\`diff
${diff}
\`\`\`${baselineBlock(baselineDiff)}

Output in this structure:

## Classification
DEPLOY-SAFETY: SAFE|UNSAFE|NOT_APPLICABLE|UNCLEAR
MIGRATIONS: NONE|REQUIRED|UNCLEAR
ROLLBACK: SAFE|UNSAFE|UNCLEAR

## Findings
For each finding, cite the specific code or artifact (file:line when possible) and tag it BLOCKING (a concrete compatibility, migration, rollout-order, config, or rollback hazard that must be fixed before this ships) or ADVISORY (real deploy-safety context that should not hold up the change). If there are none, say so.`
}

// The UI/UX review lens: a design-systems engineer audits a user-facing diff for
// consistency and usability (text-grounded — no rendering). Runs only when the
// change touches the UI; emits BLOCKING/ADVISORY findings for the consolidator,
// which renders the one verdict.
export function uxReviewPrompt(
  intent: string,
  finalPlan: string,
  diff: string,
  baselineDiff: string | null
): string {
  return `You are a senior UI/UX and design-systems engineer pairing on the diff below for a USER-FACING change. Read the repo to compare against how this product's UI is already built. Your job is to help the experience and design consistency land well — NOT code correctness or security (others cover those). Judge the user experience, not taste.

Look concretely:
- Design-system adherence: reuses existing components and design tokens vs. hand-rolling or hardcoding values (colors, spacing, typography). Name the component/token it should have used.
- Idiomatic styling: follows the codebase's styling conventions and common UI patterns (forms, modals, lists) rather than a one-off approach.
- States: handles loading / empty / error / disabled, not just the happy path.
- Labeling & affordances: copy and labels are clear, consistent with the product's voice, and controls are discoverable and usable.
- Accessibility basics: semantic elements, labels for inputs/controls, keyboard reachability.

Apply a HIGH bar: only material design-system violations or clearly broken/inconsistent UX are worth blocking. Do NOT block on subjective polish or taste — manufacturing nits just drives churn.

## Task
${intent}

## Agreed plan
${finalPlan}

## Diff
\`\`\`diff
${diff}
\`\`\`${baselineBlock(baselineDiff)}

For each finding, cite the specific code (file:line) and tag it BLOCKING (a material design-system violation or clearly broken/inconsistent UX that must be fixed before this ships) or ADVISORY (a real improvement that should not hold up the change). If there are none, say so.`
}

// The consolidator (judge) for the review panel: merges the independent experts'
// reports into ONE decision so the fix loop targets a single, deduped, conflict-
// resolved list — and adding experts can't thrash, since none blocks on its own.
export function consolidatePrompt(
  intent: string,
  finalPlan: string,
  diff: string,
  reports: Labeled[],
  baselineDiff: string | null
): string {
  return `You are the lead engineer consolidating several independent expert reviews of the diff below into a single decision. Each report is one expert's findings; they overlap, sometimes conflict, and may include nits. Produce ONE verdict and ONE prioritized fix list — do not re-review from scratch.

Do this:
- Merge duplicates: the same issue raised by multiple experts becomes one item.
- Drop non-issues: style nits, subjective polish, speculative concerns, or anything not grounded in the actual diff. Manufacturing work just drives churn.
- Resolve conflicts by this priority (higher wins): correctness > security > deploy safety > test integrity (tests must have teeth) > the task's stated requirements > consistency with the codebase > simplicity > performance > UX polish > docs.
- Classify each surviving finding as BLOCKING (a correctness, security, deploy-safety, requirements, or test-integrity defect that must be fixed before this ships) or ADVISORY (a real but non-blocking improvement). The experts' own BLOCKING/ADVISORY tags are hints, not votes — you own this call. Block on genuine defects, including concrete unsafe rollout, migration, compatibility, config, or rollback hazards. Treat general risk scores as context, not a veto; when a finding is borderline or a matter of degree, prefer ADVISORY so good work ships.

## Task
${intent}

## Agreed plan
${finalPlan}

## Diff
\`\`\`diff
${diff}
\`\`\`${baselineBlock(baselineDiff)}

${labeledBlocks('Expert report', reports)}

Output in EXACTLY this structure:

## Blocking
<numbered list, each citing file:line and the concrete fix — or "none">

## Advisory
<numbered list of non-blocking improvements — or "none">

Then, on the FINAL line, output exactly one of (FAIL if and only if the Blocking list is non-empty):
VERDICT: PASS
VERDICT: FAIL`
}

// The sharpen step turns a rough human intent into a self-contained,
// high-confidence spec the autonomous pipeline can implement with no further
// access to the human. The spec is the durable handoff: it preserves problem
// framing, current-state evidence, priorities, constraints, decisions, rejected
// alternatives, and verification. When unresolved questions remain, the prompt
// batches them with recommended answers so the human makes product/scope calls
// instead of answering questions the repo could answer.
// `transcript` is the running human/agent
// conversation; when `finalize`, emit the spec immediately.
export function sharpenPrompt(transcript: string, finalize: boolean): string {
  // The spec is goal-shaped: what/why/success/constraints, not an implementation
  // plan. The downstream planner chooses the approach. Shown in both modes so
  // finalize has the format too.
  const specFormat = `SPEC READY
VERIFY: <the shell command that proves the outcome, or "none">

## Problem
<what is broken, missing, confusing, or worth improving>

## Goal
<the observable end state: what is true when this is done>

## Context
<why this matters, including the user's motivation or "not specified">

## Verified Current State
<repo facts you verified before asking, with file:line when useful; or "Not verified / greenfield: <why>">

## Priorities
<what to optimize for when tradeoffs arise>

## Scope
In: <what this changes>
Out: <what it explicitly does not touch or must not touch>

## Constraints
<invariants that must not regress or break>

## Decisions and Tradeoffs
<settled choices, rejected tradeoffs, and why>

## Rejected Alternatives
<options considered and why they are not the requested path, or "none">

## Non-Binding Ideas
<implementation ideas worth preserving as ideas, not requirements, or "none">

## Acceptance Criteria
<behavior-level checks that define done>

## Assumptions
<recommended answers chosen for unresolved questions, or "none">

State what, why, success, constraints, and settled decisions. Do not write an implementation plan.`

  const ending = finalize
    ? `The human has ended the interview. Output the spec NOW, in exactly this format:

${specFormat}

For anything still unresolved, choose your recommended answer and record it under an "## Assumptions" heading.`
    : `When (and only when) you have enough for a self-contained, high-confidence goal spec, respond with EXACTLY this format and nothing else:

${specFormat}

Otherwise, ask the unresolved questions that must be settled now as ONE batch,
in EXACTLY this format:

QUESTIONS
- <question> ||| <your recommended answer>
- <question> ||| <your recommended answer>

One question per line; \`|||\` separates the question from your recommended answer.
Put the tradeoff and any brief grounding context BEFORE the QUESTIONS line. (If
instead you are answering a question the human asked you, just reply in prose —
no QUESTIONS block.) Never write "SPEC READY" until the spec is genuinely ready.`

  return `You are sharpening a rough task intent into a precise spec for an autonomous
coding agent that will implement it with NO further access to the human. Your job
is to surface and resolve now every decision that would otherwise be guessed or
discovered mid-build.

Rules:
- You have READ access to the repo. Explore it to answer questions yourself
  instead of asking the human.
- Research before asking: read the files this task would touch, any allowed recent
  history of those areas, and how the codebase already solves similar problems.
  Ground every question and recommendation in what the code actually does — a
  question you could have answered by reading is a wasted turn.
- Classify the task internally before asking (bug, feature, refactor,
  investigation, docs/tooling, product idea, or mixed). Use that to decide which
  ambiguities matter most; do not force irrelevant sections to be long.
- Batch your questions. Each turn is a slow research pass, so ask the unresolved
  questions that must be settled now in ONE batch, highest-impact first, each item
  with your recommended answer. Do NOT drip questions one at a time — that drags
  the interview out. Do NOT ask low-value questions, cosmetic preferences, or
  questions the repo can answer. Only hold a question for a later turn if it
  genuinely depends on the human's answer to one in this batch.
- Challenge the premise: is this the right problem? what happens if nothing
  changes? Say so if the intent targets the wrong thing.
- Temporal lens: focus on decisions that must be settled NOW (interfaces, data
  shape, scope boundaries, the verify command) — not cosmetic detail discoverable
  later.
- Scope lens: if the intent hints at a general capability, or the obvious
  implementation would be a one-off hack, raise the narrow-vs-invest decision —
  build the shared capability now ("make the change easy, then make the easy
  change"), or just this case? It's a priority/investment call the human should
  make; recommend the smallest option that isn't a hack.
- Security sniff: if this touches a sensitive surface (auth, secrets, untrusted
  input, data deletion, external calls, permissions), surface the security
  decision that must be settled now; otherwise don't manufacture one.
- Preserve judgment: capture priorities, constraints, decisions, rejected
  alternatives, and non-binding implementation ideas. Do not flatten the human's
  intent into generic task language.
- The human may ask YOU questions — answer them concretely from the code, then
  continue toward the spec.
- Everything deferred or out of scope must be written down explicitly; vague
  intentions are lies.

${ending}

## Conversation so far
${transcript}`
}

export function sharpenReviewPrompt(
  transcript: string,
  spec: string,
  verify: string | null
): string {
  return `Review this proposed sharpen spec before it is shown to the human or queued
for the autonomous task loop.

This is a gate for task quality, not a code review. The goal is to prevent a
vague, generic, ungrounded, or over-prescriptive spec from entering the loop.

Use the conversation and repo as needed. Output exactly ONE of these formats:

SHARPEN: PASS

SHARPEN: REVISE
<revision instructions that do not require asking the human>

QUESTIONS
- <human decision that must be settled now> ||| <your recommended answer>
- <human decision that must be settled now> ||| <your recommended answer>

Choose PASS only when the spec is a strong autonomous handoff: it preserves the
user's problem framing and priorities, cites or honestly states the verified
current state, has clear scope and non-scope, records important decisions,
rejected alternatives, and non-binding ideas, has behavior-level acceptance
criteria, and does not smuggle in an implementation plan.

Choose REVISE when the problem is answerable by reading, clearer writing, or
better synthesis: generic sections, missing but repo-answerable current state,
missing acceptance criteria, missing rejected alternatives, over-specific
implementation steps, or unclear separation between requirements and ideas.

Choose QUESTIONS only for decisions the human actually must make now. Do not ask
questions the repo can answer, questions with a safe obvious default, or cosmetic
preferences.

## Conversation
${transcript}

## Proposed spec
${spec}

## Proposed verify command
${verify ?? 'none'}`
}

export const grillPrompt = sharpenPrompt
