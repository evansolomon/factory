#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Labeled {
    pub label: String,
    pub text: String,
}

fn answers_block(answers: Option<&str>) -> String {
    answers
        .filter(|text| !text.trim().is_empty())
        .map(|text| {
            format!(
                "\n\n## Answers already provided by the human\n{}",
                text.trim()
            )
        })
        .unwrap_or_default()
}

fn lessons_block(lessons: Option<&str>) -> String {
    lessons
        .filter(|text| !text.trim().is_empty())
        .map(|text| format!("\n\n## Lessons from past runs\n{}", text.trim()))
        .unwrap_or_default()
}

fn verify_block(verify: Option<&str>) -> String {
    verify
        .filter(|text| !text.trim().is_empty())
        .map(|text| format!("\n\n## Verification command\n`{}`", text.trim()))
        .unwrap_or_default()
}

fn research_block(research: Option<&str>, framing: &str) -> String {
    research
        .filter(|text| !text.trim().is_empty())
        .map(|text| format!("\n\n## Repository research ({framing})\n{}", text.trim()))
        .unwrap_or_default()
}

fn feedback_analysis_block(feedback_analysis: Option<&str>) -> String {
    feedback_analysis
        .filter(|text| !text.trim().is_empty())
        .map(|text| {
            format!(
                "\n\n## Human feedback analysis\n{}\n\nApply this as post-progress feedback: change only the concrete cases justified by the inferred abstract problem or root cause.",
                text.trim()
            )
        })
        .unwrap_or_default()
}

fn risk_block(risk_assessment: Option<&str>) -> String {
    risk_assessment
        .filter(|text| !text.trim().is_empty())
        .map(|text| {
            format!(
                "\n\n## Risk assessment (advisory)\nUse this to calibrate implementation and verification effort. Do not expand scope beyond the plan just because a score is high; use the rationale to make the planned change safer and better proven.\n{}",
                text.trim()
            )
        })
        .unwrap_or_default()
}

fn ux_build_note(user_facing: bool) -> &'static str {
    if user_facing {
        "\n\n## User-facing checklist\nThis change is user-facing. Reuse existing components and design tokens; do not hand-roll or hardcode styles. Match the patterns of the closest existing feature, handle loading/empty/error/disabled states, and keep labels and copy clear and consistent."
    } else {
        ""
    }
}

fn baseline_block(baseline_diff: Option<&str>) -> String {
    let Some(diff) = baseline_diff.filter(|text| !text.trim().is_empty()) else {
        return String::new();
    };
    format!(
        r#"

## Worktree diff before this factory run
The worktree already had changes before this run began. Treat factory as operating on the whole current worktree, but use this baseline to distinguish preexisting context from new changes when reviewing scope.

```diff
{diff}
```"#
    )
}

fn labeled_blocks(heading: &str, items: &[Labeled]) -> String {
    items
        .iter()
        .map(|item| format!("## {heading} ({})\n{}", item.label, item.text))
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn feedback_analysis_prompt(
    intent: &str,
    feedback: &str,
    current_diff: &str,
    final_plan: &str,
) -> String {
    format!(
        r#"Interpret the human feedback below as post-progress critique on an existing task. Do not make code changes. Generalize from the concrete comment before deciding what should change.

Report:
- Concrete observation: what the human specifically pointed at.
- Inferred abstract problem or root cause: the broader issue that explains the comment.
- Repo and diff surfaces inspected: files, artifacts, and current diff areas you checked.
- Other applicable concrete instances: sibling cases where the same abstraction applies.
- Non-applicable look-alikes: similar-looking cases inspected and intentionally excluded.
- Specific required changes: the exact cases that should change.

Rules:
- First infer the abstraction/root cause, then search downward for affected cases.
- Change only cases justified by that abstraction.
- If the feedback is too narrow to generalize, say that explicitly and still list what you inspected.

## Task
{intent}

## Final plan
{final_plan}

## Human feedback
{feedback}

## Current diff
```diff
{current_diff}
```

Output ONLY markdown under the report headings above. Make no code changes.
"#
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FeedbackPromptInput<'a> {
    pub task_id: &'a str,
    pub intent: &'a str,
    pub final_plan: Option<&'a str>,
    pub verify: Option<&'a str>,
    pub diff: Option<&'a str>,
    pub proof: Option<&'a str>,
    pub verify_log: Option<&'a str>,
    pub ship: Option<&'a str>,
}

fn optional_feedback_block(label: &str, text: Option<&str>) -> String {
    text.filter(|text| !text.trim().is_empty())
        .map(|text| format!("\n\n## {label}\n{}", text.trim()))
        .unwrap_or_default()
}

pub fn feedback_prompt(input: FeedbackPromptInput<'_>) -> String {
    let verify_line = input
        .verify
        .filter(|text| !text.trim().is_empty())
        .map(|verify| {
            format!(
                "\n\nThe verification command that already passed is: `{verify}`. Include that exact command in What to verify next."
            )
        })
        .unwrap_or_else(|| {
            "\n\nNo verification command is recorded for this task. Say that plainly if it matters."
                .to_string()
        });
    format!(
        r#"Write a concise human-facing completion handoff for a successfully completed factory task.

Output markdown only. Start with `## Summary`.

Use exactly these sections, in this order:
## Summary
## What to verify next
## Useful artifacts

Requirements:
- Summary must be 2-3 concise sentences describing what changed and why.
- In What to verify next, include the verification command that already passed when provided.
- Include concrete manual/UI/code-review checks only when grounded in the task, plan, diff, proof, verify output, or delivery output.
- Do not invent URLs, UI paths, commands, deployment status, or manual checks.
- Do not paste raw diffs, raw logs, secrets, or large blobs.
- In Useful artifacts, refer users to `factory show {task_id}` for saved artifacts.
- Do not include marker lines.

## Task id
{task_id}

## Task intent
{intent}{verify_line}{final_plan}{diff}{proof}{verify_log}{ship}
"#,
        task_id = input.task_id,
        intent = input.intent,
        final_plan = optional_feedback_block("Final plan", input.final_plan),
        diff = optional_feedback_block("Committed diff", input.diff),
        proof = optional_feedback_block("Proof artifact", input.proof),
        verify_log = optional_feedback_block("Verify log", input.verify_log),
        ship = optional_feedback_block("Delivery output", input.ship),
    )
}

pub fn research_prompt(
    intent: &str,
    verify: Option<&str>,
    plans_dir: Option<&str>,
    user_facing: bool,
) -> String {
    let plans_line = plans_dir
        .filter(|text| !text.trim().is_empty())
        .map(|dir| {
            format!(
                "\n- Prior plans: read recent files under `{dir}` for conventions and pitfalls."
            )
        })
        .unwrap_or_default();
    let ui_line = if user_facing {
        "\n- UI vocabulary: identify the component library, styling conventions, closest existing user-facing feature, and how users reach similar features today."
    } else {
        ""
    };
    let verify = verify_block(verify);

    format!(
        r#"Research the repository at your working directory to build the factual groundwork for planning the task below. Do NOT propose a solution and do NOT make code changes.

Investigate and report:
- Relevant code: files, modules, functions, and types the task will touch. Cite paths and key signatures.
- Existing patterns: how this codebase already solves similar problems. Cite concrete examples.
- Recent history: git history for the likely target areas, especially reverts or follow-up fixes.{plans_line}
- Conventions and constraints: error handling, testing, naming, and library choices in the neighborhood.
- Gotchas: hidden coupling, invariants, non-obvious state, or risks a naive plan would miss.{ui_line}

## Task
{intent}{verify}

Output ONLY a markdown research dossier grounded in actual repo facts. Make no code changes.
"#
    )
}

pub fn plan_prompt(
    intent: &str,
    verify: Option<&str>,
    answers: Option<&str>,
    lessons: Option<&str>,
    research: Option<&str>,
    user_facing: bool,
) -> String {
    let ux = if user_facing {
        "\n\nThis task is USER-FACING. The plan must address exposure, flow and states, consistency with existing components/design tokens, and labels/copy."
    } else {
        ""
    };
    format!(
        r#"Plan how to implement the task below in the repository at your working directory. Explore the codebase first and base the plan on what exists.

Produce a concrete, interface-level plan another engineer could execute without re-deciding the design. Cover:
- Files: each file to change and the specific change.
- Interfaces: key functions/types/signatures added or changed.
- Verification: how the change is proven, including the verify command and tests to add.
- Order: implementation steps in sequence.

Follow existing patterns from the research. Scope deliberately: choose the simplest design that meets the requirements, while allowing a focused preparatory refactor when it makes this change simpler overall.{ux}

## Task
{intent}{verify}{answers}{lessons}{research}

Output ONLY the plan as markdown. Make no code changes.
"#,
        verify = verify_block(verify),
        answers = answers_block(answers),
        lessons = lessons_block(lessons),
        research = research_block(research, "ground the plan in these facts"),
    )
}

pub fn critique_prompt(
    intent: &str,
    other_plan: &str,
    answers: Option<&str>,
    lessons: Option<&str>,
    research: Option<&str>,
) -> String {
    format!(
        r#"You are a skeptical staff engineer reviewing another engineer's implementation plan for the task below. You did not write it. Read the codebase to check the plan against reality.

List the plan's problems as a ranked list, most to least serious: correctness errors, wrong assumptions, missed requirements, or a materially simpler/more-correct approach. Cite specific files and functions. If the plan is sound, say so plainly.

Also surface anything only the human can resolve under a section named Open questions for the human, each with a recommended default. Apply a high bar: only ask when a wrong guess would build the wrong thing and no reasonable default exists.

## Task
{intent}{answers}{lessons}{research}

## Plan under review
{other_plan}

Output ONLY your critique as markdown. Make no code changes.
"#,
        answers = answers_block(answers),
        lessons = lessons_block(lessons),
        research = research_block(research, "check the plan against these facts"),
    )
}

pub fn reconcile_prompt(
    intent: &str,
    plans: &[Labeled],
    critiques: &[Labeled],
    answers: Option<&str>,
) -> String {
    let critique_section = if critiques.is_empty() {
        String::new()
    } else {
        format!("\n\n{}", labeled_blocks("Critique", critiques))
    };
    format!(
        r#"Decide whether this task is clear enough to implement autonomously, or must pause for the human. Default to PROCEED. Pause only for a genuine blocker: ambiguity changes what gets built, the work is destructive/irreversible, or no reasonable default exists.

## Task
{intent}{answers}

{plans}{critique_section}

On the FIRST line output exactly one of:
DECISION: PROCEED
DECISION: ASK
If ASK, follow it with a concise markdown list of only the blocking questions, each with your recommended default. Make no code changes.
"#,
        answers = answers_block(answers),
        plans = labeled_blocks("Plan", plans),
    )
}

pub fn revise_prompt(intent: &str, own_plan: &str, critique: &str) -> String {
    format!(
        r#"Below is your implementation plan and a critique of it. Revise the plan: fix the valid problems, and explicitly ignore critique points that are style-only, speculative, or out of scope.

## Task
{intent}

## Your plan
{own_plan}

## Critique
{critique}

Output ONLY the revised plan as markdown. Make no code changes.
"#
    )
}

pub fn select_prompt(intent: &str, plans: &[Labeled]) -> String {
    let intro = if plans.len() > 1 {
        "Several independent plans for the task below are given. Internally choose the strongest, or merge the best of them into one coherent plan."
    } else {
        "A plan for the task below is given. Refine it into the final plan to implement."
    };
    format!(
        r#"{intro} Favor correctness first, then the simplest plan that meets the requirements.

## Task
{intent}

{plans}

Output ONLY the final plan, as a single self-contained markdown document written as if authored from scratch. Do not mention candidate plans, labels, or the selection process. Make no code changes.
"#,
        plans = labeled_blocks("Plan", plans),
    )
}

pub fn name_prompt(intent: &str, plan: &str) -> String {
    format!(
        r#"Name the change described below as a filename: 2-5 words describing what the change DOES, in lowercase kebab-case, such as `add-retry-to-upload-client`.

Rules:
- Name the action and its subject, not where it lives.
- Never copy a URL, domain, file path, or identifier from the task verbatim.
- Output ONLY the name on a single line.

## Task
{intent}

## Plan
{plan}
"#
    )
}

pub fn plan_risk_prompt(intent: &str, final_plan: &str) -> String {
    format!(
        r#"Assess the implementation risk of the plan below. This is advisory: do not expand scope, just identify the riskiest assumptions and verification needs.

Report:
- Overall risk: low, medium, or high.
- Risk drivers: the specific parts of the plan most likely to break behavior.
- Verification emphasis: what tests or manual checks matter most.
- Rollback concerns: anything that would be hard to revert.

## Task
{intent}

## Final plan
{final_plan}

Output ONLY markdown. Make no code changes.
"#
    )
}

pub fn implement_prompt(
    intent: &str,
    final_plan: &str,
    verify: Option<&str>,
    user_facing: bool,
    risk_assessment: Option<&str>,
    feedback_analysis: Option<&str>,
) -> String {
    let verify = verify
        .filter(|text| !text.trim().is_empty())
        .map(|text| {
            format!(
                "\n\n## Verification\nThe change is checked with `{text}`. Make sure it passes."
            )
        })
        .unwrap_or_default();

    format!(
        r#"Implement the task below in the repository at your working directory. Make the code changes it calls for and nothing more.

Follow the codebase's existing conventions. Do not assume a library is available; confirm it is already used before relying on it.

Address root causes, not symptoms. Do not weaken, skip, or delete tests, and do not hard-code values to make a check pass.

Do NOT commit. Leave the changes in the working tree.

## Task
{intent}

## Plan
{final_plan}{feedback_analysis}{risk_assessment}{verify}{ux_note}
"#,
        feedback_analysis = feedback_analysis_block(feedback_analysis),
        risk_assessment = risk_block(risk_assessment),
        ux_note = ux_build_note(user_facing),
    )
}

pub fn review_prompt(
    intent: &str,
    verify: Option<&str>,
    final_plan: &str,
    diff: &str,
    baseline_diff: Option<&str>,
) -> String {
    let verify = verify
        .filter(|text| !text.trim().is_empty())
        .map(|text| format!("\n\n## Verification\nExpected command: `{text}`"))
        .unwrap_or_default();

    format!(
        r#"You are reviewing the implemented diff below. Read files in the repo as needed.

Focus on defects that would make the change wrong or unsafe: unmet requirements, incorrect behavior, weakened tests, hard-coded pass conditions, or unrelated risky edits. Do not block on style preferences.

## Task
{intent}{verify}

## Plan
{final_plan}

## Diff
```diff
{diff}
```{baseline}

If the change is correct and meets the task, say so. If it must be fixed before shipping, list the blocking findings with concrete file references.

On the FINAL line, output exactly one of:
VERDICT: PASS
VERDICT: FAIL
"#,
        baseline = baseline_block(baseline_diff),
    )
}

pub fn risk_review_prompt(
    intent: &str,
    final_plan: &str,
    diff: &str,
    baseline_diff: Option<&str>,
) -> String {
    format!(
        r#"Assess the residual merge risk of the implemented diff below. This lens is advisory: do not tag anything BLOCKING.

Consider complexity, blast radius, data durability, migrations, compatibility, config/env, queues/events, external APIs, auth/security, concurrency, rollback difficulty, and whether verification is proportionate.

## Task
{intent}

## Agreed plan
{final_plan}

## Diff
```diff
{diff}
```{baseline}

Output markdown with:
## Scores
RISK: <0-10>
COMPLEXITY: <0-10>
MERGE-RISK: <0-10>
TEST-IMPORTANCE: <0-10>
CONFIDENCE: LOW|MEDIUM|HIGH

## Rationale
<bullets tagged ADVISORY>
"#,
        baseline = baseline_block(baseline_diff),
    )
}

pub fn security_prompt(
    intent: &str,
    final_plan: &str,
    diff: &str,
    baseline_diff: Option<&str>,
) -> String {
    format!(
        r#"You are a red-team security researcher auditing the diff below. Assume an adversary controls every input the changed code can reach. Read files as needed.

Hunt for exploitable issues introduced or left open by this diff: injection, auth/authz flaws, data exposure, secret leakage, SSRF/path traversal, unsafe defaults, and failing open.

Report only real issues grounded in this diff. Tag each finding BLOCKING or ADVISORY and cite specific code. If there are none, say so plainly.

## Task
{intent}

## Agreed plan
{final_plan}

## Diff
```diff
{diff}
```{baseline}
"#,
        baseline = baseline_block(baseline_diff),
    )
}

pub fn deploy_safety_prompt(
    intent: &str,
    final_plan: &str,
    diff: &str,
    baseline_diff: Option<&str>,
) -> String {
    format!(
        r#"You are a release engineer auditing whether the diff below is safe to deploy. Judge mixed-version reality: old and new app versions may overlap, queued data may cross versions, clients may lag, and rollback may happen after writes.

Look for concrete hazards around API/schema/config compatibility, migrations, queues/jobs/events/caches, required env vars/secrets, feature flags, and rollback safety.

Report only deploy hazards introduced or left open by this diff. Tag findings BLOCKING or ADVISORY and cite specific code/artifacts. If not applicable, say so.

## Task
{intent}

## Agreed plan
{final_plan}

## Diff
```diff
{diff}
```{baseline}
"#,
        baseline = baseline_block(baseline_diff),
    )
}

pub fn ux_review_prompt(
    intent: &str,
    final_plan: &str,
    diff: &str,
    baseline_diff: Option<&str>,
) -> String {
    format!(
        r#"You are a senior UI/UX and design-systems engineer reviewing this USER-FACING diff. Judge design-system consistency and usability, not code correctness or security.

Look for material issues in component/token reuse, styling conventions, loading/empty/error/disabled states, labels and affordances, accessibility basics, and consistency with similar features. Tag findings BLOCKING or ADVISORY and cite specific code. Do not block on taste.

## Task
{intent}

## Agreed plan
{final_plan}

## Diff
```diff
{diff}
```{baseline}
"#,
        baseline = baseline_block(baseline_diff),
    )
}

pub fn consolidate_prompt(
    intent: &str,
    final_plan: &str,
    diff: &str,
    reports: &[Labeled],
    baseline_diff: Option<&str>,
) -> String {
    format!(
        r#"You are the lead engineer consolidating several independent expert reviews into one decision. Merge duplicates, drop nits and speculative issues, and produce one prioritized fix list.

Classify each surviving finding as BLOCKING (correctness, security, deploy-safety, requirements, or test-integrity defect that must be fixed before shipping) or ADVISORY (real but non-blocking improvement). Expert tags are hints, not votes. Risk scores are context, not a veto.

## Task
{intent}

## Agreed plan
{final_plan}

## Diff
```diff
{diff}
```{baseline}

{reports}

Output exactly this structure:

## Blocking
<numbered list, each citing file:line and the concrete fix, or "none">

## Advisory
<numbered list of non-blocking improvements, or "none">

Then, on the FINAL line, output exactly one of:
VERDICT: PASS
VERDICT: FAIL
"#,
        reports = labeled_blocks("Expert report", reports),
        baseline = baseline_block(baseline_diff),
    )
}

pub fn triage_prompt(intent: &str, verify: Option<&str>) -> String {
    let verify = verify
        .filter(|text| !text.trim().is_empty())
        .map(|text| format!("\n\n## Verification\n{text}"))
        .unwrap_or_default();
    format!(
        r#"Classify the task below on two axes. Look at the repo briefly if it helps.

COMPLEXITY:
TRIVIAL - a small, mechanical, low-risk change.
COMPLEX - needs design choices, touches multiple components, is ambiguous, security/data-sensitive, or otherwise risky.
When in doubt, choose COMPLEX.

USER-FACING:
YES - changes something an end user sees or interacts with.
NO - purely internal.

## Task
{intent}{verify}

Output ONLY these two final lines:
COMPLEXITY: TRIVIAL|COMPLEX
USER-FACING: YES|NO
"#
    )
}

pub fn fix_prompt(
    intent: &str,
    final_plan: &str,
    failure: &str,
    prior_summaries: &[String],
    diff: &str,
    verify: Option<&str>,
    user_facing: bool,
    risk_assessment: Option<&str>,
    feedback_analysis: Option<&str>,
) -> String {
    let verify = verify
        .filter(|text| !text.trim().is_empty())
        .map(|text| format!("\n\n## Verification\nExpected command: `{text}`"))
        .unwrap_or_default();
    let tried = if prior_summaries.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n## Already attempted (these fixes did NOT work - do not repeat them)\n{}",
            prior_summaries
                .iter()
                .enumerate()
                .map(|(idx, summary)| format!("{}. {summary}", idx + 1))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    let repeat_warning = if prior_summaries.is_empty() {
        ""
    } else {
        "\n\nThe approaches below were already tried and failed. Diagnose why, and take a genuinely different path rather than re-applying a variation of them."
    };

    format!(
        r#"A previous attempt at the task below did not pass its gate. Fix the working tree so it satisfies the plan and verification.{repeat_warning}

Address the root cause. Do not weaken, skip, or delete tests or hard-code values to pass. Change only what is needed. Do NOT commit.

## Task
{intent}{verify}

## Plan
{final_plan}

## What failed
{failure}

{tried}

## Current diff
```diff
{diff}
```{feedback_analysis}{risk_assessment}{verify}{ux_note}
"#,
        feedback_analysis = feedback_analysis_block(feedback_analysis),
        risk_assessment = risk_block(risk_assessment),
        ux_note = ux_build_note(user_facing),
    )
}

pub fn converge_prompt(intent: &str, prior_summaries: &[String], latest_failure: &str) -> String {
    let history = if prior_summaries.is_empty() {
        "(none - this is the first failure)".to_string()
    } else {
        prior_summaries
            .iter()
            .enumerate()
            .map(|(idx, summary)| format!("{}. {summary}", idx + 1))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        r#"An autonomous fix loop is working a task. Decide whether to keep iterating based on progress, not a blind count.

- CONTINUE: the latest failure is genuinely new ground and earlier problems appear resolved.
- STUCK: the same root cause is recurring, an earlier problem returned, or the loop is oscillating.

## Task
{intent}

## Prior failures
{history}

## Latest failure
{latest_failure}

Output exactly two final lines:
SUMMARY: <one sentence naming the latest failure's root cause>
VERDICT: CONTINUE | STUCK
"#
    )
}

pub fn remediate_prompt(
    intent: &str,
    verify: &str,
    failure: &str,
    prior_remedies: &[String],
) -> String {
    let tried = if prior_remedies.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n## Environment fixes already tried\n{}",
            prior_remedies
                .iter()
                .enumerate()
                .map(|(idx, remedy)| format!("{}. {remedy}", idx + 1))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    format!(
        r#"You are the verify-gate doctor for an autonomous coding loop. The task was implemented and the verify command failed. Diagnose why, and when the cause is ENVIRONMENT/SETUP rather than code, fix the environment so the check can run.

Classify the failure as exactly one of:
- ENV-FIXED: an environment/setup problem that you have now fixed. Re-run verify yourself to confirm it gets past the environment problem.
- ENV-BLOCKED: an environment/setup problem you could not fix autonomously.
- CODE: a genuine code or test defect. Do not change code; report CODE so the fixer handles it.
- FLAKE: a transient/external failure where retrying later is likely to pass.

Rules:
- Never edit project source code or tests to make verify pass. Environment-only changes are in scope.
- When torn between CODE and ENV, prefer CODE.
- If it is plainly a code/test failure, do not touch the environment.

## Task
{intent}

## Verify command
`{verify}`

## Verify failure
{failure}{tried}

Output, as the FINAL two lines:
SUMMARY: <one sentence: the root cause and, if fixed, what changed>
VERDICT: ENV-FIXED | ENV-BLOCKED | CODE | FLAKE
"#
    )
}

pub fn postmortem_prompt(intent: &str, failures: &[String], diff: &str, reason: &str) -> String {
    let history = if failures.is_empty() {
        "(no recorded attempts)".to_string()
    } else {
        failures
            .iter()
            .enumerate()
            .map(|(idx, failure)| format!("{}. {failure}", idx + 1))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        r#"A task's autonomous fix loop gave up. Diagnose why, concisely, for a human triaging the block and for a lesson that prevents a repeat. Read the repo as needed; be honest if the spec or verify command was the real problem.

Classify the root cause into one category:
- spec: task/spec ambiguous, wrong, or under-specified
- plan: chosen plan flawed or infeasible
- implementation: code was buggy or did not satisfy the plan
- test: verify command/tests wrong, flaky, or too strict
- environment: external/transient build, deps, network, CI, auth
- other

## Task
{intent}

## Why it gave up
{reason}

## Attempts
{history}

## Final diff
```diff
{diff}
```

Output in this exact shape:
CATEGORY: <one of the above>
LESSON: <one or two sentences, generalizable to future tasks in this repo>
## Analysis
<a few sentences: the root cause and what would have prevented it>
"#
    )
}

pub fn ship_prompt(intent: &str, branch: &str, mode: ShipMode<'_>) -> String {
    let how = match mode {
        ShipMode::Skill(skill) => format!("Deliver it by running the `{skill}` skill."),
        ShipMode::Policy(policy) => format!("Deliver it according to this policy:\n\n{policy}"),
    };
    format!(
        r#"The task below has been implemented, reviewed, verified, and committed on the current branch. {how}

Use whatever tools and skills the repo provides. Open a merge request or PR, iterate on CI until green, respond to review, and push as needed.

## Branch
{branch}

## Task
{intent}

On the FINAL line, output exactly one of:
SHIP: OK
SHIP: FAILED <reason>
"#
    )
}

pub fn sharpen_prompt(transcript: &str, finalize: bool) -> String {
    let ending = if finalize {
        "The human has ended the interview. Output the spec now. For anything still unresolved, choose your recommended answer and record it under Assumptions."
    } else {
        "When you have enough for a self-contained high-confidence goal spec, output SPEC READY. Otherwise ask the unresolved questions as one QUESTIONS block."
    };
    format!(
        r#"You are sharpening a rough task intent into a precise spec for an autonomous coding agent that will implement it with no further access to the human.

Rules:
- You have read access to the repo. Explore it to answer questions yourself instead of asking the human.
- Batch unresolved human decisions in one QUESTIONS block, each with a recommended answer.
- Do not ask questions the repo can answer.
- Preserve the user's problem framing, priorities, constraints, decisions, rejected alternatives, and acceptance criteria.
- Do not write an implementation plan; write a goal/spec.

If ready, output exactly:
SPEC READY
VERIFY: <the shell command that proves the outcome, or "none">

## Problem
<what is broken, missing, confusing, or worth improving>

## Goal
<observable end state>

## Context
<why this matters>

## Verified Current State
<repo facts verified, or "Not verified: <why>">

## Scope
In: <what changes>
Out: <what does not change>

## Constraints
<invariants>

## Decisions and Tradeoffs
<settled choices>

## Rejected Alternatives
<rejected options, or "none">

## Acceptance Criteria
<behavior-level checks>

## Assumptions
<recommended answers chosen for unresolved questions, or "none">

If not ready, output:
QUESTIONS
- <question> ||| <your recommended answer>

{ending}

## Conversation so far
{transcript}
"#
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShipMode<'a> {
    Skill(&'a str),
    Policy(&'a str),
}

pub fn direct_plan(intent: &str) -> String {
    format!(
        r#"Fast-path plan:
1. Inspect the relevant code for the task.
2. Make the minimal correct change that satisfies the task.
3. Preserve existing behavior outside the requested scope.
4. Run the configured verification, if any.

Task:
{intent}
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_prompt_preserves_verdict_contract() {
        let prompt = review_prompt("Do it", Some("cargo test"), "Plan", "diff", None);

        assert!(prompt.contains("VERDICT: PASS"));
        assert!(prompt.contains("VERDICT: FAIL"));
        assert!(prompt.contains("Expected command: `cargo test`"));
    }

    #[test]
    fn review_prompt_includes_baseline_diff_when_present() {
        let prompt = review_prompt("Do it", None, "Plan", "new diff", Some("old diff"));

        assert!(prompt.contains("## Worktree diff before this factory run"));
        assert!(prompt.contains("old diff"));
    }

    #[test]
    fn implement_prompt_includes_feedback_and_verify() {
        let prompt = implement_prompt(
            "Task",
            "Plan",
            Some("bun test"),
            true,
            Some("Risk"),
            Some("Feedback"),
        );

        assert!(prompt.contains("## Human feedback analysis\nFeedback"));
        assert!(prompt.contains("## Risk assessment (advisory)"));
        assert!(prompt.contains("## User-facing checklist"));
        assert!(prompt.contains("The change is checked with `bun test`"));
    }

    #[test]
    fn fix_prompt_includes_prior_failures_risk_and_ux_context() {
        let prompt = fix_prompt(
            "Task",
            "Plan",
            "latest failure",
            &["review: missed edge case".to_string()],
            "diff",
            Some("cargo test"),
            true,
            Some("High migration risk"),
            Some("Feedback"),
        );

        assert!(prompt.contains("Already attempted"));
        assert!(prompt.contains("review: missed edge case"));
        assert!(prompt.contains("High migration risk"));
        assert!(prompt.contains("User-facing checklist"));
        assert!(prompt.contains("Expected command: `cargo test`"));
    }

    #[test]
    fn triage_prompt_preserves_marker_contract() {
        let prompt = triage_prompt("Task", None);

        assert!(prompt.contains("COMPLEXITY: TRIVIAL|COMPLEX"));
        assert!(prompt.contains("USER-FACING: YES|NO"));
    }

    #[test]
    fn ship_prompt_preserves_marker_contract() {
        let prompt = ship_prompt("Task", "main", ShipMode::Skill("ship"));

        assert!(prompt.contains("SHIP: OK"));
        assert!(prompt.contains("SHIP: FAILED <reason>"));
        assert!(prompt.contains("running the `ship` skill"));
    }

    #[test]
    fn sharpen_prompt_preserves_marker_contract() {
        let prompt = sharpen_prompt("human: task", false);

        assert!(prompt.contains("SPEC READY"));
        assert!(prompt.contains("VERIFY:"));
        assert!(prompt.contains("QUESTIONS"));
    }

    #[test]
    fn reconcile_prompt_preserves_decision_contract() {
        let prompt = reconcile_prompt(
            "Task",
            &[Labeled {
                label: "codex".to_string(),
                text: "Plan".to_string(),
            }],
            &[],
            Some("Already answered"),
        );

        assert!(prompt.contains("DECISION: PROCEED"));
        assert!(prompt.contains("DECISION: ASK"));
        assert!(prompt.contains("Already answered"));
    }

    #[test]
    fn planning_prompts_thread_research_and_lessons() {
        let prompt = plan_prompt(
            "Task",
            Some("cargo test"),
            Some("Use sqlite"),
            Some("Prefer explicit errors"),
            Some("src/main.rs owns dispatch"),
            true,
        );

        assert!(prompt.contains("`cargo test`"));
        assert!(prompt.contains("Use sqlite"));
        assert!(prompt.contains("Prefer explicit errors"));
        assert!(prompt.contains("src/main.rs owns dispatch"));
        assert!(prompt.contains("USER-FACING"));
    }

    #[test]
    fn consolidate_prompt_preserves_verdict_contract() {
        let prompt = consolidate_prompt(
            "Task",
            "Plan",
            "diff",
            &[Labeled {
                label: "security".to_string(),
                text: "No findings.".to_string(),
            }],
            None,
        );

        assert!(prompt.contains("VERDICT: PASS"));
        assert!(prompt.contains("VERDICT: FAIL"));
        assert!(prompt.contains("## Blocking"));
        assert!(prompt.contains("## Advisory"));
    }

    #[test]
    fn converge_prompt_preserves_verdict_contract() {
        let prompt = converge_prompt(
            "Task",
            &["review: missing edge case".to_string()],
            "verify still fails",
        );

        assert!(prompt.contains("SUMMARY:"));
        assert!(prompt.contains("VERDICT: CONTINUE | STUCK"));
        assert!(prompt.contains("review: missing edge case"));
        assert!(prompt.contains("verify still fails"));
    }

    #[test]
    fn remediate_prompt_preserves_verdict_contract() {
        let prompt = remediate_prompt(
            "Task",
            "cargo test",
            "command not found: cargo",
            &["installed rustup".to_string()],
        );

        assert!(prompt.contains("SUMMARY:"));
        assert!(prompt.contains("VERDICT: ENV-FIXED | ENV-BLOCKED | CODE | FLAKE"));
        assert!(prompt.contains("installed rustup"));
        assert!(prompt.contains("`cargo test`"));
    }

    #[test]
    fn postmortem_prompt_preserves_lesson_contract() {
        let prompt = postmortem_prompt(
            "Task",
            &["verify: command failed".to_string()],
            "diff",
            "retry budget exhausted",
        );

        assert!(prompt.contains("CATEGORY:"));
        assert!(prompt.contains("LESSON:"));
        assert!(prompt.contains("verify: command failed"));
        assert!(prompt.contains("retry budget exhausted"));
    }

    #[test]
    fn feedback_prompt_preserves_completion_sections() {
        let prompt = feedback_prompt(FeedbackPromptInput {
            task_id: "task-1",
            intent: "Do the work",
            final_plan: Some("Plan"),
            verify: Some("cargo test"),
            diff: Some("diff"),
            proof: Some("proof"),
            verify_log: Some("passed"),
            ship: Some("SHIP: OK"),
        });

        assert!(prompt.contains("## Summary"));
        assert!(prompt.contains("## What to verify next"));
        assert!(prompt.contains("## Useful artifacts"));
        assert!(prompt.contains("`cargo test`"));
        assert!(prompt.contains("factory show task-1"));
    }
}
