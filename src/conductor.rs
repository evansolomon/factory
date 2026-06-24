use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::time::Instant;

use serde_json::{json, Map};
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};

use crate::add_options::TaskComplexity;
use crate::agents::{agent_label, run_agent, Access, AgentResult, AgentRun};
use crate::clock::now_iso;
use crate::config::{Agent, AgentCli, OnComplete, WorkContext};
use crate::evals::{capture_eval_case, EvalOutcome};
use crate::exec::{run, RunOptions};
use crate::git::{commit_all, commit_diff, current_branch, has_changes, head_sha, worktree_diff};
use crate::hooks::{emit, HookEvent};
use crate::lessons::{append_candidate, read_lessons};
use crate::markers::{
    parse_convergence_verdict, parse_reconcile_decision, parse_remedy, parse_review_verdict,
    parse_ship, parse_triage, ReconcileDecision, RemedyVerdict, ShipResult,
};
use crate::metrics::{record_run, RunRecord, StageStat};
use crate::prompts::{
    consolidate_prompt, converge_prompt, critique_prompt, deploy_safety_prompt, direct_plan,
    feedback_analysis_prompt, feedback_prompt, fix_prompt, implement_prompt, name_prompt,
    plan_prompt, plan_risk_prompt, postmortem_prompt, reconcile_prompt, remediate_prompt,
    research_prompt, review_prompt, revise_prompt, risk_review_prompt, security_prompt,
    select_prompt, sharpen_prompt, ship_prompt, triage_prompt, ux_review_prompt,
    FeedbackPromptInput, Labeled, ShipMode,
};
use crate::sharpen::{format_questions, parse_questions, parse_sharpen};
use crate::task::{
    append_failure, mark_feedback_consumed, pending_feedback_count, read_answers, read_artifact,
    read_failures, read_intent, read_pending_feedback, ready_sharpened_task,
    refresh_feedback_state, save_meta, set_status, write_artifact, Failure, ResumeKind,
    SharpenState, Status, Task,
};
use crate::task::{write_live_meter, LiveMeter, LiveMeterStage};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComplexityDecision {
    Declared {
        trivial: bool,
        complexity: TaskComplexity,
    },
    Triage,
    None,
}

pub fn decide_complexity(
    declared: Option<TaskComplexity>,
    triage_enabled: bool,
) -> ComplexityDecision {
    match declared {
        Some(TaskComplexity::Trivial) => ComplexityDecision::Declared {
            trivial: true,
            complexity: TaskComplexity::Trivial,
        },
        Some(TaskComplexity::Complex) => ComplexityDecision::Declared {
            trivial: false,
            complexity: TaskComplexity::Complex,
        },
        None if triage_enabled => ComplexityDecision::Triage,
        None => ComplexityDecision::None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskOutcome {
    Done,
    NeedsInput {
        questions: String,
    },
    Retrying {
        reason: String,
        retry_at: String,
        auto_retries: u32,
    },
    Blocked {
        reason: String,
        detail: Option<String>,
    },
}

trait AgentRunner {
    fn run(&mut self, agent: &Agent, opts: &AgentRun) -> std::io::Result<AgentResult>;
}

struct RealAgentRunner;

impl AgentRunner for RealAgentRunner {
    fn run(&mut self, agent: &Agent, opts: &AgentRun) -> std::io::Result<AgentResult> {
        run_agent(agent, opts)
    }
}

#[derive(Debug)]
struct Meter {
    in_tokens: i64,
    out_tokens: i64,
    stages: Vec<StageStat>,
    started_at: String,
    started: Instant,
}

#[derive(Debug, Clone, Default)]
struct RunStats {
    triage: Option<String>,
    retries: i64,
    verify_first_try: Option<bool>,
}

impl Meter {
    fn new() -> Self {
        Self {
            in_tokens: 0,
            out_tokens: 0,
            stages: Vec::new(),
            started_at: now_iso(),
            started: Instant::now(),
        }
    }

    fn elapsed_ms(&self) -> i64 {
        self.started.elapsed().as_millis() as i64
    }
}

pub fn run_task(ctx: &WorkContext, mut task: Task) -> Result<TaskOutcome, Box<dyn Error>> {
    let mut meter = Meter::new();
    let mut stats = RunStats::default();
    let mut runner = RealAgentRunner;
    persist_live_meter(&task, &meter);
    emit_task(ctx, HookEvent::TaskStart, &task, None);

    let result = run_task_inner(ctx, &mut task, &mut meter, &mut runner, &mut stats);
    match result {
        Ok(TaskOutcome::Done) => {
            record_task_run(ctx, &task, &meter, "done", &stats);
            capture_eval_case(ctx, &task, EvalOutcome::Done, None);
            emit_task(ctx, HookEvent::TaskDone, &task, None);
            Ok(TaskOutcome::Done)
        }
        Ok(TaskOutcome::NeedsInput { questions }) => {
            record_task_run(ctx, &task, &meter, "needs-input", &stats);
            emit_task(ctx, HookEvent::TaskNeedsInput, &task, None);
            Ok(TaskOutcome::NeedsInput { questions })
        }
        Ok(TaskOutcome::Retrying {
            reason,
            retry_at,
            auto_retries,
        }) => {
            let mut payload = Map::new();
            payload.insert("reason".to_string(), json!(reason));
            payload.insert("retryAt".to_string(), json!(retry_at));
            payload.insert("autoRetries".to_string(), json!(auto_retries));
            emit_task(ctx, HookEvent::TaskRetrying, &task, Some(payload));
            Ok(TaskOutcome::Retrying {
                reason,
                retry_at,
                auto_retries,
            })
        }
        Ok(TaskOutcome::Blocked { reason, detail }) => {
            postmortem(ctx, &task, &mut meter, &reason, &mut runner);
            record_task_run(ctx, &task, &meter, "blocked", &stats);
            capture_eval_case(ctx, &task, EvalOutcome::Blocked, Some(&reason));
            let mut payload = Map::new();
            payload.insert("reason".to_string(), json!(reason));
            emit_task(ctx, HookEvent::TaskBlocked, &task, Some(payload));
            Ok(TaskOutcome::Blocked { reason, detail })
        }
        Err(err) => {
            let reason = err.to_string();
            let _ = block_task(&mut task, &reason, None);
            postmortem(ctx, &task, &mut meter, &reason, &mut runner);
            record_task_run(ctx, &task, &meter, "blocked", &stats);
            capture_eval_case(ctx, &task, EvalOutcome::Blocked, Some(&reason));
            Ok(TaskOutcome::Blocked {
                reason,
                detail: None,
            })
        }
    }
}

fn run_task_inner(
    ctx: &WorkContext,
    task: &mut Task,
    meter: &mut Meter,
    runner: &mut dyn AgentRunner,
    stats: &mut RunStats,
) -> Result<TaskOutcome, Box<dyn Error>> {
    let mut intent = read_intent(task)?;
    let baseline_diff = worktree_diff(&ctx.root)?;
    let baseline_has_changes = has_changes(&ctx.root)?;
    write_artifact(task, "baseline.patch", &baseline_diff)?;
    let baseline_for_review = baseline_has_changes.then_some(baseline_diff.as_str());
    let resuming = task.meta.resume;
    let resume_kind = task.meta.resume_kind;
    let resume_note = task.meta.resume_note.clone();
    let mut user_facing = false;
    let mut risk_assessment = if resuming {
        read_artifact(task, "risk.plan.md")?
    } else {
        None
    };

    let final_plan = if resuming {
        let plan = read_artifact(task, "plan.final.md")?
            .or(read_artifact(task, "plan.md")?)
            .unwrap_or_else(|| intent.clone());
        task.meta.resume = false;
        task.meta.resume_kind = None;
        task.meta.resume_note = None;
        task.meta.retry_at = None;
        save_meta(task)?;
        plan
    } else {
        let complexity = decide_task_complexity(ctx, task, meter, runner, &intent)?;
        let trivial = complexity.trivial;
        stats.triage = complexity.triage.clone();
        user_facing = ctx.config.ux && complexity.user_facing;
        if trivial && task.meta.sharpen == SharpenState::Pending {
            task.meta.sharpen = SharpenState::Skipped;
            save_meta(task)?;
        }
        if !trivial && task.meta.sharpen == SharpenState::Pending {
            if let Some(outcome) = run_sharpen_stage(ctx, task, meter, runner, &mut intent)? {
                return Ok(outcome);
            }
        }

        let existing_plan =
            read_artifact(task, "plan.final.md")?.or(read_artifact(task, "plan.md")?);
        if let Some(plan) = existing_plan {
            plan
        } else if trivial {
            direct_plan(&intent)
        } else {
            let answers = read_answers(task)?;
            let lessons = read_lessons(ctx)?;
            let verify = task.meta.verify.clone();
            match plan_ensemble(
                ctx,
                task,
                meter,
                runner,
                &intent,
                verify.as_deref(),
                answers.as_deref(),
                lessons.as_deref(),
                ctx.config.ux && complexity.user_facing,
            )? {
                PlanOutcome::Plan(plan) => {
                    risk_assessment =
                        Some(run_plan_risk(ctx, task, meter, runner, &intent, &plan)?);
                    persist_named_plan(ctx, task, meter, runner, &intent, &plan)?;
                    plan
                }
                PlanOutcome::NeedsInput { questions } => {
                    return Ok(TaskOutcome::NeedsInput { questions });
                }
            }
        }
    };
    write_artifact(task, "plan.final.md", &final_plan)?;
    write_artifact(task, "plan.md", &final_plan)?;
    let mut failure: Option<(String, String)> = None;
    let mut failures = read_failures(task)?;
    if resuming && task.meta.commit.is_some() {
        return deliver_and_finish(ctx, task, meter, runner, &intent);
    }
    if resuming && ctx.config.ux {
        user_facing = ui_in_diff(&worktree_diff(&ctx.root).unwrap_or_default());
    }
    let feedback_context =
        analyze_feedback_if_pending(ctx, task, meter, runner, &intent, &final_plan)?;

    let mut attempt = 0;
    let mut skip_implement = resuming && has_changes(&ctx.root)?;
    if skip_implement
        && resume_kind == Some(ResumeKind::AutoRetry)
        && resume_note.as_deref().unwrap_or_default().trim().is_empty()
        && feedback_context.is_none()
    {
        attempt = ctx.config.retries;
    }
    if skip_implement
        && (resume_note
            .as_deref()
            .is_some_and(|note| !note.trim().is_empty())
            || feedback_context.is_some())
    {
        skip_implement = false;
        attempt = failures.len().max(1) as u32;
        let mut detail = Vec::new();
        if let Some(note) = resume_note
            .as_deref()
            .filter(|note| !note.trim().is_empty())
        {
            detail.push(format!("Human guidance on retry: {note}"));
        }
        if feedback_context.is_some() {
            detail.push("Human feedback requires a follow-up fix pass.".to_string());
        }
        failure = Some((
            "resume requested a fix pass".to_string(),
            detail.join("\n\n"),
        ));
    }

    loop {
        stats.retries = attempt as i64;
        if attempt > ctx.config.retries {
            break;
        }
        let is_fix = attempt > 0;
        if skip_implement {
            skip_implement = false;
        } else {
            set_stage(
                ctx,
                task,
                Status::Implementing,
                if is_fix { "fix" } else { "implement" },
            )?;
            let stage = if is_fix { "fix" } else { "implement" };
            let artifact = if is_fix {
                format!("fix.{attempt}.md")
            } else {
                "implement.md".to_string()
            };
            let prompt = if let Some((reason, detail)) = &failure {
                let current_diff = worktree_diff(&ctx.root).unwrap_or_default();
                fix_prompt(
                    &intent,
                    &final_plan,
                    &format!("{reason}\n\n{detail}"),
                    &prior_failure_summaries(&failures, reason),
                    &current_diff,
                    task.meta.verify.as_deref(),
                    user_facing,
                    risk_assessment.as_deref(),
                    feedback_context
                        .as_ref()
                        .map(|context| context.analysis.as_str()),
                )
            } else {
                implement_prompt(
                    &intent,
                    &final_plan,
                    task.meta.verify.as_deref(),
                    user_facing,
                    risk_assessment.as_deref(),
                    feedback_context
                        .as_ref()
                        .map(|context| context.analysis.as_str()),
                )
            };
            if let Err(err) = agent_step(
                ctx,
                task,
                meter,
                runner,
                stage,
                &ctx.agents.implementer,
                Access::Write,
                prompt,
                &artifact,
            ) {
                return block_task(task, stage_failure(stage), Some(err.to_string()));
            }
        }
        let diff = worktree_diff(&ctx.root)?;
        write_artifact(task, "diff.patch", &diff)?;
        if !has_changes(&ctx.root)? {
            let detail = "the implementer completed without leaving a worktree diff".to_string();
            if assess_failure(
                ctx,
                task,
                meter,
                runner,
                &intent,
                &mut failures,
                attempt,
                "implement",
                &detail,
            )? == FailureAction::Stop
            {
                return block_task(task, "implementation produced no changes", Some(detail));
            }
            failure = Some(("implementation produced no changes".to_string(), detail));
        } else {
            if let Some(detail) = run_review_panel(
                ctx,
                task,
                meter,
                runner,
                &intent,
                &final_plan,
                &diff,
                user_facing,
                baseline_for_review,
            )? {
                if assess_failure(
                    ctx,
                    task,
                    meter,
                    runner,
                    &intent,
                    &mut failures,
                    attempt,
                    "review",
                    &detail,
                )? == FailureAction::Stop
                {
                    return block_task(task, "review panel did not pass", Some(detail));
                }
                failure = Some(("review panel did not pass".to_string(), detail));
            } else {
                match run_verify_gate(ctx, task, meter, runner, &intent, &diff)? {
                    VerifyGate::Code { detail } => {
                        if assess_failure(
                            ctx,
                            task,
                            meter,
                            runner,
                            &intent,
                            &mut failures,
                            attempt,
                            "verify",
                            &detail,
                        )? == FailureAction::Stop
                        {
                            return set_aside(task, "verify failed", Some(detail));
                        }
                        failure = Some(("verify failed".to_string(), detail));
                    }
                    VerifyGate::Aside { reason, detail } => {
                        let entry = Failure {
                            attempt,
                            gate: "verify".to_string(),
                            summary: first_line(&detail).chars().take(200).collect(),
                            detail: detail.clone(),
                        };
                        failures.push(entry.clone());
                        append_failure(task, &entry)?;
                        return set_aside(task, &reason, Some(detail));
                    }
                    VerifyGate::Pass => {
                        if task.meta.verify.is_some() {
                            stats.verify_first_try = Some(attempt == 0);
                        }
                        if !has_changes(&ctx.root)? {
                            return block_task(
                                task,
                                "verified but no changes remained",
                                Some("there is no diff to commit".to_string()),
                            );
                        }
                        write_proof(task, &final_plan)?;
                        let message = commit_message(&intent);
                        commit_all(&ctx.root, &message)?;
                        task.meta.commit = Some(head_sha(&ctx.root)?);
                        if let Some(feedback_context) = &feedback_context {
                            refresh_feedback_state(task)?;
                            mark_feedback_consumed(task, feedback_context.count);
                            save_meta(task)?;
                        }
                        return deliver_and_finish(ctx, task, meter, runner, &intent);
                    }
                }
            }
        }

        let (reason, detail) = failure.clone().unwrap_or_else(|| {
            (
                "task did not pass".to_string(),
                "the task failed without a specific gate detail".to_string(),
            )
        });
        write_artifact(
            task,
            "fix.md",
            &fix_prompt(
                &intent,
                &final_plan,
                &format!("{reason}\n\n{detail}"),
                &prior_failure_summaries(&failures, &reason),
                &worktree_diff(&ctx.root).unwrap_or_default(),
                task.meta.verify.as_deref(),
                user_facing,
                risk_assessment.as_deref(),
                feedback_context
                    .as_ref()
                    .map(|context| context.analysis.as_str()),
            ),
        )?;
        if attempt >= ctx.config.retries {
            return block_task(task, &reason, Some(detail));
        }
        attempt += 1;
    }

    block_task(
        task,
        "task did not pass",
        Some("retry loop exited without a terminal result".to_string()),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ComplexityOutcome {
    trivial: bool,
    user_facing: bool,
    triage: Option<String>,
}

enum PlanOutcome {
    Plan(String),
    NeedsInput { questions: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FeedbackContext {
    count: u32,
    analysis: String,
}

fn first_line(text: &str) -> &str {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
}

fn prior_failure_summaries(failures: &[Failure], current_reason: &str) -> Vec<String> {
    let count = if current_reason == "resume requested a fix pass" {
        failures.len()
    } else {
        failures.len().saturating_sub(1)
    };
    failures
        .iter()
        .take(count)
        .map(|failure| format!("{}: {}", failure.gate, failure.summary))
        .collect()
}

fn label_safe(text: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-') {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "agent".to_string()
    } else {
        trimmed
    }
}

fn cli_name(cli: &AgentCli) -> &'static str {
    match cli {
        AgentCli::Codex => "codex",
        AgentCli::Claude => "claude",
    }
}

fn planner_labels(planners: &[Agent]) -> Vec<String> {
    let mut cli_counts: BTreeMap<String, usize> = BTreeMap::new();
    for planner in planners {
        let key = cli_name(&planner.cli).to_string();
        *cli_counts.entry(key).or_default() += 1;
    }
    let bases = planners
        .iter()
        .map(|planner| {
            let cli = cli_name(&planner.cli);
            if cli_counts.get(cli).copied().unwrap_or(0) > 1 {
                planner
                    .model
                    .as_deref()
                    .map(label_safe)
                    .unwrap_or_else(|| cli.to_string())
            } else {
                cli.to_string()
            }
        })
        .collect::<Vec<_>>();

    let mut labels = Vec::new();
    for (idx, base) in bases.iter().enumerate() {
        if bases.iter().filter(|candidate| *candidate == base).count() == 1 {
            labels.push(base.clone());
            continue;
        }
        let seen = bases[..=idx]
            .iter()
            .filter(|candidate| *candidate == base)
            .count();
        labels.push(format!("{base}-{seen}"));
    }
    labels
}

fn labeled(labels: &[String], texts: &[String]) -> Vec<Labeled> {
    texts
        .iter()
        .enumerate()
        .map(|(idx, text)| Labeled {
            label: labels
                .get(idx)
                .cloned()
                .unwrap_or_else(|| format!("plan-{}", idx + 1)),
            text: text.clone(),
        })
        .collect()
}

fn slugify_plan_name(text: &str) -> Option<String> {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in text.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let slug = out.trim_matches('-').to_string();
    (!slug.is_empty()).then_some(slug)
}

fn analyze_feedback_if_pending(
    ctx: &WorkContext,
    task: &mut Task,
    meter: &mut Meter,
    runner: &mut dyn AgentRunner,
    intent: &str,
    final_plan: &str,
) -> Result<Option<FeedbackContext>, Box<dyn Error>> {
    let count = pending_feedback_count(task);
    if count == 0 {
        return Ok(None);
    }
    let Some(raw) = read_pending_feedback(task)? else {
        return Ok(None);
    };
    set_stage(ctx, task, Status::Planning, "feedback")?;
    let current_diff = worktree_diff(&ctx.root).unwrap_or_default();
    let analysis = agent_step(
        ctx,
        task,
        meter,
        runner,
        "feedback",
        &ctx.agents.implementer,
        Access::Read,
        feedback_analysis_prompt(intent, &raw, &current_diff, final_plan),
        "human-feedback.analysis.md",
    )?;
    Ok(Some(FeedbackContext { count, analysis }))
}

fn decide_task_complexity(
    ctx: &WorkContext,
    task: &mut Task,
    meter: &mut Meter,
    runner: &mut dyn AgentRunner,
    intent: &str,
) -> Result<ComplexityOutcome, Box<dyn Error>> {
    match decide_complexity(task.meta.complexity, ctx.config.triage) {
        ComplexityDecision::Declared { trivial, .. } => Ok(ComplexityOutcome {
            trivial,
            user_facing: false,
            triage: None,
        }),
        ComplexityDecision::None => Ok(ComplexityOutcome {
            trivial: false,
            user_facing: false,
            triage: None,
        }),
        ComplexityDecision::Triage => {
            set_stage(ctx, task, Status::Planning, "triage")?;
            let text = agent_step(
                ctx,
                task,
                meter,
                runner,
                "triage",
                &ctx.agents.implementer,
                Access::Read,
                triage_prompt(intent, task.meta.verify.as_deref()),
                "triage.md",
            )?;
            let triage = parse_triage(&text);
            Ok(ComplexityOutcome {
                trivial: triage.trivial,
                user_facing: triage.user_facing,
                triage: Some(if triage.trivial { "trivial" } else { "complex" }.to_string()),
            })
        }
    }
}

fn plan_ensemble(
    ctx: &WorkContext,
    task: &mut Task,
    meter: &mut Meter,
    runner: &mut dyn AgentRunner,
    intent: &str,
    verify: Option<&str>,
    answers: Option<&str>,
    lessons: Option<&str>,
    user_facing: bool,
) -> Result<PlanOutcome, Box<dyn Error>> {
    let planners = if ctx.agents.planners.is_empty() {
        vec![ctx.agents.implementer.clone()]
    } else {
        ctx.agents.planners.clone()
    };
    let labels = planner_labels(&planners);

    set_stage(ctx, task, Status::Planning, "research")?;
    let research = agent_step(
        ctx,
        task,
        meter,
        runner,
        "research",
        &ctx.agents.implementer,
        Access::Research,
        research_prompt(intent, verify, ctx.plans_dir.as_deref(), user_facing),
        "research.md",
    )?;

    set_stage(ctx, task, Status::Planning, "plan")?;
    let mut plans = Vec::new();
    for (idx, planner) in planners.iter().enumerate() {
        let label = labels
            .get(idx)
            .cloned()
            .unwrap_or_else(|| format!("plan-{}", idx + 1));
        let text = agent_step(
            ctx,
            task,
            meter,
            runner,
            "plan",
            planner,
            Access::Read,
            plan_prompt(
                intent,
                verify,
                answers,
                lessons,
                Some(&research),
                user_facing,
            ),
            &format!("plan.{label}.md"),
        )?;
        plans.push(text);
    }

    let labeled_plans = labeled(&labels, &plans);
    let mut critiques = Vec::new();
    if planners.len() >= 2 {
        set_stage(ctx, task, Status::Planning, "critique")?;
        for (idx, planner) in planners.iter().enumerate() {
            let label = labels
                .get(idx)
                .cloned()
                .unwrap_or_else(|| format!("plan-{}", idx + 1));
            let others = plans
                .iter()
                .enumerate()
                .filter(|(other_idx, _)| *other_idx != idx)
                .map(|(_, plan)| plan.as_str())
                .collect::<Vec<_>>()
                .join("\n\n---\n\n");
            let text = agent_step(
                ctx,
                task,
                meter,
                runner,
                "critique",
                planner,
                Access::Read,
                critique_prompt(intent, &others, answers, lessons, Some(&research)),
                &format!("critique.{label}.md"),
            )?;
            critiques.push(text);
        }
    }
    let labeled_critiques = labeled(&labels, &critiques);

    set_stage(ctx, task, Status::Planning, "reconcile")?;
    let reconcile = agent_step(
        ctx,
        task,
        meter,
        runner,
        "reconcile",
        &ctx.agents.implementer,
        Access::Read,
        reconcile_prompt(intent, &labeled_plans, &labeled_critiques, answers),
        "reconcile.md",
    )?;
    if parse_reconcile_decision(&reconcile) == Some(ReconcileDecision::Ask) {
        let questions = reconcile
            .lines()
            .skip_while(|line| {
                !line
                    .trim_start()
                    .to_ascii_uppercase()
                    .starts_with("DECISION: ASK")
            })
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
        let questions = if questions.is_empty() {
            reconcile.trim().to_string()
        } else {
            questions
        };
        write_artifact(task, "questions.md", &questions)?;
        append_candidate(
            ctx,
            &format!("needs-input - {} - {}", task.id, first_line(&questions)),
        );
        set_status(
            task,
            Status::NeedsInput,
            Some("planning needs input".to_string()),
        )?;
        return Ok(PlanOutcome::NeedsInput { questions });
    }

    let revised = if planners.len() >= 2 {
        set_stage(ctx, task, Status::Planning, "revise")?;
        let all_critiques = labeled_critiques
            .iter()
            .map(|critique| format!("## Critique ({})\n{}", critique.label, critique.text))
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut revised = Vec::new();
        for (idx, planner) in planners.iter().enumerate() {
            let label = labels
                .get(idx)
                .cloned()
                .unwrap_or_else(|| format!("plan-{}", idx + 1));
            let own_plan = plans.get(idx).map(String::as_str).unwrap_or_default();
            let text = agent_step(
                ctx,
                task,
                meter,
                runner,
                "revise",
                planner,
                Access::Read,
                revise_prompt(intent, own_plan, &all_critiques),
                &format!("plan.{label}.v2.md"),
            )?;
            revised.push(text);
        }
        revised
    } else {
        plans
    };

    set_stage(ctx, task, Status::Planning, "select")?;
    let final_plan = agent_step(
        ctx,
        task,
        meter,
        runner,
        "select",
        &ctx.agents.implementer,
        Access::Read,
        select_prompt(intent, &labeled(&labels, &revised)),
        "plan.final.md",
    )?;
    Ok(PlanOutcome::Plan(final_plan))
}

fn run_plan_risk(
    ctx: &WorkContext,
    task: &mut Task,
    meter: &mut Meter,
    runner: &mut dyn AgentRunner,
    intent: &str,
    final_plan: &str,
) -> Result<String, Box<dyn Error>> {
    set_stage(ctx, task, Status::Planning, "risk")?;
    let text = agent_step(
        ctx,
        task,
        meter,
        runner,
        "risk",
        &ctx.agents.reviewer,
        Access::Read,
        plan_risk_prompt(intent, final_plan),
        "risk.plan.md",
    )?;
    Ok(text)
}

fn persist_named_plan(
    ctx: &WorkContext,
    task: &mut Task,
    meter: &mut Meter,
    runner: &mut dyn AgentRunner,
    intent: &str,
    final_plan: &str,
) -> Result<(), Box<dyn Error>> {
    let Some(plans_dir) = &ctx.plans_dir else {
        return Ok(());
    };
    set_stage(ctx, task, Status::Planning, "name")?;
    let suggested = agent_step(
        ctx,
        task,
        meter,
        runner,
        "name",
        &ctx.agents.implementer,
        Access::Read,
        name_prompt(intent, final_plan),
        "plan.name.md",
    )?;
    fs::create_dir_all(plans_dir)?;
    let base = slugify_plan_name(first_line(&suggested))
        .or_else(|| slugify_plan_name(first_line(intent)))
        .unwrap_or_else(|| task.id.clone());
    let mut name = base.clone();
    for n in 2.. {
        let path = format!("{plans_dir}/{name}.md");
        if fs::metadata(&path).is_err() {
            fs::write(
                path,
                format!("# {}\n\n{}\n", first_line(intent), final_plan),
            )?;
            return Ok(());
        }
        name = format!("{base}-{n}");
    }
    unreachable!("unbounded collision loop must return")
}

fn run_review_panel(
    ctx: &WorkContext,
    task: &mut Task,
    meter: &mut Meter,
    runner: &mut dyn AgentRunner,
    intent: &str,
    final_plan: &str,
    diff: &str,
    user_facing: bool,
    baseline_diff: Option<&str>,
) -> Result<Option<String>, Box<dyn Error>> {
    set_stage(ctx, task, Status::Reviewing, "review")?;
    let mut reports = Vec::new();

    let correctness = agent_step(
        ctx,
        task,
        meter,
        runner,
        "review",
        &ctx.agents.reviewer,
        Access::Read,
        review_prompt(
            intent,
            task.meta.verify.as_deref(),
            final_plan,
            diff,
            baseline_diff,
        ),
        "review.md",
    )?;
    reports.push(Labeled {
        label: "correctness".to_string(),
        text: correctness,
    });

    if ctx.config.security {
        let security = agent_step(
            ctx,
            task,
            meter,
            runner,
            "security",
            &ctx.agents.reviewer,
            Access::Read,
            security_prompt(intent, final_plan, diff, baseline_diff),
            "security.md",
        )?;
        reports.push(Labeled {
            label: "security".to_string(),
            text: security,
        });
    }

    let risk = agent_step(
        ctx,
        task,
        meter,
        runner,
        "risk-review",
        &ctx.agents.reviewer,
        Access::Read,
        risk_review_prompt(intent, final_plan, diff, baseline_diff),
        "risk.md",
    )?;
    reports.push(Labeled {
        label: "risk".to_string(),
        text: risk,
    });

    let deploy = agent_step(
        ctx,
        task,
        meter,
        runner,
        "deploy",
        &ctx.agents.reviewer,
        Access::Read,
        deploy_safety_prompt(intent, final_plan, diff, baseline_diff),
        "deploy.md",
    )?;
    reports.push(Labeled {
        label: "deploy safety".to_string(),
        text: deploy,
    });

    if ctx.config.ux && (user_facing || ui_in_diff(diff)) {
        let ux = agent_step(
            ctx,
            task,
            meter,
            runner,
            "ux",
            &ctx.agents.reviewer,
            Access::Read,
            ux_review_prompt(intent, final_plan, diff, baseline_diff),
            "ux.md",
        )?;
        reports.push(Labeled {
            label: "ux/design".to_string(),
            text: ux,
        });
    }

    set_stage(ctx, task, Status::Reviewing, "consolidate")?;
    let consolidated = agent_step(
        ctx,
        task,
        meter,
        runner,
        "consolidate",
        &ctx.agents.reviewer,
        Access::Read,
        consolidate_prompt(intent, final_plan, diff, &reports, baseline_diff),
        "consolidated.md",
    )?;
    if parse_review_verdict(&consolidated) == Some("PASS") {
        Ok(None)
    } else if parse_review_verdict(&consolidated).is_none() {
        Ok(Some(
            "review panel did not end with VERDICT: PASS".to_string(),
        ))
    } else {
        Ok(Some(consolidated))
    }
}

fn ui_in_diff(diff: &str) -> bool {
    diff.lines().any(|line| {
        let Some(path) = line.strip_prefix("+++ ") else {
            return false;
        };
        let normalized = path.trim().strip_prefix("b/").unwrap_or(path.trim());
        let lower = normalized.to_ascii_lowercase();
        [
            ".tsx", ".jsx", ".vue", ".svelte", ".css", ".scss", ".sass", ".less", ".styl", ".html",
            ".astro", ".mdx", ".erb", ".haml", ".slim",
        ]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureAction {
    Continue,
    Stop,
}

fn assess_failure(
    ctx: &WorkContext,
    task: &mut Task,
    meter: &mut Meter,
    runner: &mut dyn AgentRunner,
    intent: &str,
    failures: &mut Vec<Failure>,
    attempt: u32,
    gate: &str,
    detail: &str,
) -> Result<FailureAction, Box<dyn Error>> {
    if attempt >= ctx.config.retries {
        let entry = Failure {
            attempt,
            gate: gate.to_string(),
            summary: first_line(detail).chars().take(200).collect(),
            detail: detail.to_string(),
        };
        failures.push(entry.clone());
        append_failure(task, &entry)?;
        return Ok(FailureAction::Stop);
    }

    let prior_summaries = failures
        .iter()
        .map(|failure| format!("{}: {}", failure.gate, failure.summary))
        .collect::<Vec<_>>();
    set_stage(ctx, task, Status::Reviewing, "converge")?;
    let judgment = agent_step(
        ctx,
        task,
        meter,
        runner,
        "converge",
        &ctx.agents.reviewer,
        Access::Read,
        converge_prompt(intent, &prior_summaries, detail),
        "converge.md",
    )?;
    let summary = marker_payload(&judgment, "SUMMARY")
        .unwrap_or_else(|| first_line(detail).chars().take(200).collect());
    let action = if parse_convergence_verdict(&judgment) == Some("CONTINUE") {
        FailureAction::Continue
    } else {
        FailureAction::Stop
    };
    let entry = Failure {
        attempt,
        gate: gate.to_string(),
        summary,
        detail: detail.to_string(),
    };
    failures.push(entry.clone());
    append_failure(task, &entry)?;
    Ok(action)
}

const AUTO_RETRY_CAP: u32 = 5;
const BACKOFF_SECS: [i64; 5] = [120, 300, 900, 1800, 3600];

fn set_aside(
    task: &mut Task,
    reason: &str,
    detail: Option<String>,
) -> Result<TaskOutcome, Box<dyn Error>> {
    if task.meta.auto_retries >= AUTO_RETRY_CAP {
        return block_task(
            task,
            &format!("{reason} (gave up after {AUTO_RETRY_CAP} auto-retries)"),
            detail,
        );
    }
    if let Some(detail) = &detail {
        write_artifact(task, "retrying.md", &format!("{reason}\n\n{detail}\n"))?;
    } else {
        write_artifact(task, "retrying.md", &format!("{reason}\n"))?;
    }

    let retry_number = task.meta.auto_retries + 1;
    let delay = BACKOFF_SECS
        .get(task.meta.auto_retries as usize)
        .copied()
        .unwrap_or(*BACKOFF_SECS.last().unwrap_or(&3600));
    let retry_at = retry_at_iso(delay);
    task.meta.auto_retries = retry_number;
    task.meta.retry_at = Some(retry_at.clone());
    task.meta.resume = false;
    task.meta.resume_kind = None;
    task.meta.resume_note = None;
    set_status(task, Status::Retrying, Some(reason.to_string()))?;

    Ok(TaskOutcome::Retrying {
        reason: reason.to_string(),
        retry_at,
        auto_retries: retry_number,
    })
}

fn retry_at_iso(delay_secs: i64) -> String {
    (OffsetDateTime::now_utc() + Duration::seconds(delay_secs))
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn marker_payload(text: &str, marker: &str) -> Option<String> {
    text.lines().rev().find_map(|line| {
        let (head, value) = line.split_once(':')?;
        head.trim()
            .eq_ignore_ascii_case(marker)
            .then(|| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum VerifyGate {
    Pass,
    Code { detail: String },
    Aside { reason: String, detail: String },
}

const REMEDIATE_CAP: usize = 3;

fn run_verify_gate(
    ctx: &WorkContext,
    task: &mut Task,
    meter: &mut Meter,
    runner: &mut dyn AgentRunner,
    intent: &str,
    fallback_diff: &str,
) -> Result<VerifyGate, Box<dyn Error>> {
    let Some(verify) = task.meta.verify.clone() else {
        return Ok(VerifyGate::Pass);
    };
    let mut remedies = Vec::new();
    loop {
        set_stage(ctx, task, Status::Verifying, "verify")?;
        let start = Instant::now();
        let verify_result = run(
            &["bash".to_string(), "-lc".to_string(), verify.clone()],
            &RunOptions {
                cwd: ctx.root.clone(),
                stream_to: Some(format!("{}/verify.log", task.dir)),
                ..RunOptions::default()
            },
        )?;
        meter.stages.push(StageStat {
            stage: "verify".to_string(),
            agent: "shell".to_string(),
            in_tok: 0,
            out_tok: 0,
            ms: start.elapsed().as_millis() as i64,
        });
        persist_live_meter(task, meter);
        if verify_result.code == 0 {
            return Ok(VerifyGate::Pass);
        }
        let detail = format!(
            "Verify `{verify}` failed (exit {}):\n{}",
            verify_result.code,
            combined_output(&verify_result.stdout, &verify_result.stderr)
        );

        if !ctx.config.remediate || remedies.len() >= REMEDIATE_CAP {
            write_verify_fix_prompt(ctx, task, fallback_diff, &detail)?;
            return Ok(VerifyGate::Code { detail });
        }

        let n = remedies.len() + 1;
        set_stage(ctx, task, Status::Verifying, "remediate")?;
        let out = agent_step(
            ctx,
            task,
            meter,
            runner,
            "remediate",
            &ctx.agents.implementer,
            Access::Full,
            remediate_prompt(intent, &verify, &detail, &remedies),
            &format!(
                "remediate{suffix}.md",
                suffix = if n == 1 {
                    String::new()
                } else {
                    format!(".{n}")
                }
            ),
        )?;
        let summary =
            marker_payload(&out, "SUMMARY").unwrap_or_else(|| first_line(&out).to_string());
        match parse_remedy(&out) {
            Some(RemedyVerdict::EnvFixed) => {
                remedies.push(summary);
                continue;
            }
            Some(RemedyVerdict::Flake) => {
                return Ok(VerifyGate::Aside {
                    reason: "verify hit a transient/external flake".to_string(),
                    detail,
                });
            }
            Some(RemedyVerdict::EnvBlocked) => {
                return Ok(VerifyGate::Aside {
                    reason: format!("verify blocked on an environment problem: {summary}"),
                    detail,
                });
            }
            Some(RemedyVerdict::Code) | None => {
                write_verify_fix_prompt(ctx, task, fallback_diff, &detail)?;
                return Ok(VerifyGate::Code { detail });
            }
        }
    }
}

fn write_verify_fix_prompt(
    ctx: &WorkContext,
    task: &Task,
    fallback_diff: &str,
    detail: &str,
) -> Result<(), Box<dyn Error>> {
    let current_diff = worktree_diff(&ctx.root).unwrap_or_else(|_| fallback_diff.to_string());
    write_artifact(
        task,
        "fix.md",
        &fix_prompt(
            &read_intent(task)?,
            &read_artifact(task, "plan.final.md")?.unwrap_or_default(),
            detail,
            &[],
            &current_diff,
            task.meta.verify.as_deref(),
            false,
            read_artifact(task, "risk.plan.md")?.as_deref(),
            None,
        ),
    )?;
    Ok(())
}

const FEEDBACK_INPUT_LIMIT: usize = 12_000;

fn write_proof(task: &Task, final_plan: &str) -> Result<(), Box<dyn Error>> {
    let verify = task
        .meta
        .verify
        .as_deref()
        .map(|verify| format!("`{verify}` passed"))
        .unwrap_or_else(|| "no verify command".to_string());
    let proof = [
        format!("# Proof - {}", task.id),
        String::new(),
        "## Selected plan (head)".to_string(),
        final_plan.lines().take(3).collect::<Vec<_>>().join("\n"),
        String::new(),
        "## Review".to_string(),
        "VERDICT: PASS".to_string(),
        String::new(),
        "## Verify".to_string(),
        verify,
    ]
    .join("\n");
    write_artifact(task, "proof.md", &proof)?;
    Ok(())
}

fn write_completion_feedback(
    ctx: &WorkContext,
    task: &Task,
    meter: &mut Meter,
    runner: &mut dyn AgentRunner,
    intent: &str,
) {
    if let Err(err) = write_completion_feedback_inner(ctx, task, meter, runner, intent) {
        eprintln!(
            "warning: completion handoff failed for {}: {}",
            task.id, err
        );
    }
}

fn deliver_and_finish(
    ctx: &WorkContext,
    task: &mut Task,
    meter: &mut Meter,
    runner: &mut dyn AgentRunner,
    intent: &str,
) -> Result<TaskOutcome, Box<dyn Error>> {
    if let Some(on_complete) = &ctx.config.on_complete {
        set_stage(ctx, task, Status::Shipping, "ship")?;
        let branch = current_branch(&ctx.root).unwrap_or_default();
        let mode = match on_complete {
            OnComplete::Skill { skill } => ShipMode::Skill(skill),
            OnComplete::Policy { policy } => ShipMode::Policy(policy),
        };
        let ship = match agent_step(
            ctx,
            task,
            meter,
            runner,
            "ship",
            &ctx.agents.delivery,
            Access::Full,
            ship_prompt(intent, &branch, mode),
            "ship.md",
        ) {
            Ok(text) => text,
            Err(err) => return set_aside(task, "ship failed", Some(err.to_string())),
        };
        match parse_ship(&ship) {
            ShipResult::Ok => {}
            ShipResult::Failed { reason } => return set_aside(task, "ship failed", Some(reason)),
        }
    }
    write_completion_feedback(ctx, task, meter, runner, intent);
    set_status(task, Status::Done, None)?;
    Ok(TaskOutcome::Done)
}

fn write_completion_feedback_inner(
    ctx: &WorkContext,
    task: &Task,
    meter: &mut Meter,
    runner: &mut dyn AgentRunner,
    intent: &str,
) -> Result<(), Box<dyn Error>> {
    let diff = task
        .meta
        .commit
        .as_deref()
        .and_then(|sha| commit_diff(&ctx.root, sha).ok());
    let clipped_intent = clip_feedback_input(Some(intent));
    let final_plan = read_artifact(task, "plan.md")?;
    let clipped_plan = clip_feedback_input(final_plan.as_deref());
    let clipped_diff = clip_feedback_input(diff.as_deref());
    let proof = read_artifact(task, "proof.md")?;
    let clipped_proof = clip_feedback_input(proof.as_deref());
    let verify_log = read_artifact(task, "verify.log")?;
    let clipped_verify_log = clip_feedback_input(verify_log.as_deref());
    let ship = read_artifact(task, "ship.md")?;
    let clipped_ship = clip_feedback_input(ship.as_deref());
    agent_step(
        ctx,
        task,
        meter,
        runner,
        "feedback",
        &ctx.agents.delivery,
        Access::Read,
        feedback_prompt(FeedbackPromptInput {
            task_id: &task.id,
            intent: clipped_intent.as_deref().unwrap_or(intent),
            final_plan: clipped_plan.as_deref(),
            verify: task.meta.verify.as_deref(),
            diff: clipped_diff.as_deref(),
            proof: clipped_proof.as_deref(),
            verify_log: clipped_verify_log.as_deref(),
            ship: clipped_ship.as_deref(),
        }),
        "feedback.md",
    )?;
    Ok(())
}

fn clip_feedback_input(text: Option<&str>) -> Option<String> {
    let text = text?;
    if text.len() <= FEEDBACK_INPUT_LIMIT {
        return Some(text.to_string());
    }
    let clipped = text.chars().take(FEEDBACK_INPUT_LIMIT).collect::<String>();
    Some(format!("{clipped}\n\n[clipped for feedback prompt]"))
}

fn run_sharpen_stage(
    ctx: &WorkContext,
    task: &mut Task,
    meter: &mut Meter,
    runner: &mut dyn AgentRunner,
    intent: &mut String,
) -> Result<Option<TaskOutcome>, Box<dyn Error>> {
    set_stage(ctx, task, Status::Sharpening, "sharpen")?;
    let answers = read_answers(task)?.unwrap_or_default();
    let transcript = if answers.trim().is_empty() {
        format!("human: {}", intent.trim())
    } else {
        format!("human: {}\n\nanswers:\n{}", intent.trim(), answers.trim())
    };
    let text = match agent_step(
        ctx,
        task,
        meter,
        runner,
        "sharpen",
        &ctx.agents.implementer,
        Access::Read,
        sharpen_prompt(&transcript, false),
        "sharpen.md",
    ) {
        Ok(text) => text,
        Err(err) => return block_task(task, "sharpen failed", Some(err.to_string())).map(Some),
    };
    let parsed = parse_sharpen(&text);
    if parsed.ready {
        ready_sharpened_task(task, &parsed.spec, parsed.verify)?;
        *intent = parsed.spec;
        return Ok(None);
    }

    let parsed_questions = parse_questions(&text);
    let questions = if parsed_questions.questions.is_empty() {
        let message = parsed.message.trim();
        if message.is_empty() {
            "The sharpener did not produce SPEC READY or a QUESTIONS block.".to_string()
        } else {
            message.to_string()
        }
    } else {
        format_questions(&parsed_questions.preamble, &parsed_questions.questions)
    };
    write_artifact(task, "questions.md", &questions)?;
    set_status(
        task,
        Status::NeedsInput,
        Some("sharpen needs input".to_string()),
    )?;
    Ok(Some(TaskOutcome::NeedsInput { questions }))
}

fn agent_step(
    ctx: &WorkContext,
    task: &Task,
    meter: &mut Meter,
    runner: &mut dyn AgentRunner,
    stage: &str,
    agent: &crate::config::Agent,
    access: Access,
    prompt: String,
    artifact: &str,
) -> Result<String, Box<dyn Error>> {
    let start = Instant::now();
    let out_file = format!("{}/{}", task.dir, artifact);
    let result = runner.run(
        agent,
        &AgentRun {
            root: ctx.root.clone(),
            prompt,
            access,
            out_file: Some(out_file.clone()),
        },
    )?;
    fs::write(out_file, &result.text)?;
    meter.in_tokens += result.usage.input_tokens as i64;
    meter.out_tokens += result.usage.output_tokens as i64;
    meter.stages.push(StageStat {
        stage: stage.to_string(),
        agent: agent_label(agent),
        in_tok: result.usage.input_tokens as i64,
        out_tok: result.usage.output_tokens as i64,
        ms: start.elapsed().as_millis() as i64,
    });
    persist_live_meter(task, meter);
    Ok(result.text)
}

fn persist_live_meter(task: &Task, meter: &Meter) {
    let snapshot = LiveMeter {
        started_at: meter.started_at.clone(),
        input_tokens: meter.in_tokens,
        output_tokens: meter.out_tokens,
        stages: meter
            .stages
            .iter()
            .map(|stage| LiveMeterStage {
                stage: stage.stage.clone(),
                agent: stage.agent.clone(),
                in_tok: stage.in_tok,
                out_tok: stage.out_tok,
                ms: stage.ms,
            })
            .collect(),
    };
    if let Err(err) = write_live_meter(task, &snapshot) {
        eprintln!("warning: live meter failed for {}: {}", task.id, err);
    }
}

fn set_stage(
    ctx: &WorkContext,
    task: &mut Task,
    status: Status,
    stage: &str,
) -> Result<(), Box<dyn Error>> {
    set_status(task, status, None)?;
    let mut payload = Map::new();
    payload.insert("stage".to_string(), json!(stage));
    payload.insert("active".to_string(), json!(true));
    emit_task(ctx, HookEvent::StageChange, task, Some(payload));
    Ok(())
}

fn block_task(
    task: &mut Task,
    reason: &str,
    detail: Option<String>,
) -> Result<TaskOutcome, Box<dyn Error>> {
    if let Some(detail) = &detail {
        write_artifact(task, "blocked.md", &format!("{reason}\n\n{detail}\n"))?;
    } else {
        write_artifact(task, "blocked.md", &format!("{reason}\n"))?;
    }
    set_status(task, Status::Blocked, Some(reason.to_string()))?;
    Ok(TaskOutcome::Blocked {
        reason: reason.to_string(),
        detail,
    })
}

fn postmortem(
    ctx: &WorkContext,
    task: &Task,
    meter: &mut Meter,
    reason: &str,
    runner: &mut dyn AgentRunner,
) {
    if !ctx.config.postmortem {
        append_candidate(ctx, &format!("blocked - {} - {}", task.id, reason));
        return;
    }
    if let Err(err) = write_postmortem(ctx, task, meter, reason, runner) {
        eprintln!("warning: postmortem failed for {}: {err}", task.id);
        append_candidate(ctx, &format!("blocked - {} - {}", task.id, reason));
    }
}

fn write_postmortem(
    ctx: &WorkContext,
    task: &Task,
    meter: &mut Meter,
    reason: &str,
    runner: &mut dyn AgentRunner,
) -> Result<(), Box<dyn Error>> {
    let intent = read_intent(task)?;
    let history = read_failures(task)?
        .into_iter()
        .map(|failure| format!("{}: {}", failure.gate, failure.summary))
        .collect::<Vec<_>>();
    let diff = worktree_diff(&ctx.root).unwrap_or_default();
    let out = agent_step(
        ctx,
        task,
        meter,
        runner,
        "postmortem",
        &ctx.agents.reviewer,
        Access::Read,
        postmortem_prompt(&intent, &history, &diff, reason),
        "postmortem.md",
    )?;
    let category = marker_payload(&out, "CATEGORY").unwrap_or_else(|| "other".to_string());
    let lesson = marker_payload(&out, "LESSON");
    append_candidate(
        ctx,
        &lesson.map_or_else(
            || format!("blocked - {} - {}", task.id, reason),
            |lesson| format!("blocked - {} - [{}] {}", task.id, category, lesson),
        ),
    );
    Ok(())
}

fn record_task_run(ctx: &WorkContext, task: &Task, meter: &Meter, outcome: &str, stats: &RunStats) {
    record_run(
        &ctx.metrics_path,
        &RunRecord {
            task: task.id.clone(),
            ts: now_iso(),
            created_at: Some(task.meta.created_at.clone()),
            outcome: outcome.to_string(),
            triage: stats.triage.clone(),
            retries: stats.retries,
            verify_first_try: stats.verify_first_try,
            ms: meter.elapsed_ms(),
            in_tokens: meter.in_tokens,
            out_tokens: meter.out_tokens,
            stages: meter.stages.clone(),
        },
    );
}

fn emit_task(
    ctx: &WorkContext,
    event: HookEvent,
    task: &Task,
    extra: Option<Map<String, serde_json::Value>>,
) {
    let mut payload = extra.unwrap_or_default();
    payload.insert("task".to_string(), json!(task.id));
    payload.insert("status".to_string(), json!(task.meta.status.as_str()));
    emit(&ctx.root, &ctx.config.hooks, event, payload);
}

fn combined_output(stdout: &str, stderr: &str) -> String {
    [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|piece| !piece.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn stage_failure(stage: &str) -> &'static str {
    match stage {
        "fix" => "fix failed",
        "implement" => "implement failed",
        _ => "agent stage failed",
    }
}

fn commit_message(intent: &str) -> String {
    let summary = intent
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("factory task")
        .chars()
        .take(72)
        .collect::<String>();
    format!("factory: {summary}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    use crate::config::{Agent, AgentCli};
    use crate::config::{Config, RoleAgents, WorkContext};
    use crate::task::{add_task, append_feedback, AddTaskOptions, Meta, ResumeKind};
    use tempfile::TempDir;

    #[test]
    fn declared_trivial_wins_regardless_of_triage_config() {
        assert_eq!(
            decide_complexity(Some(TaskComplexity::Trivial), true),
            ComplexityDecision::Declared {
                trivial: true,
                complexity: TaskComplexity::Trivial,
            }
        );
        assert_eq!(
            decide_complexity(Some(TaskComplexity::Trivial), false),
            ComplexityDecision::Declared {
                trivial: true,
                complexity: TaskComplexity::Trivial,
            }
        );
    }

    #[test]
    fn declared_complex_wins_regardless_of_triage_config() {
        assert_eq!(
            decide_complexity(Some(TaskComplexity::Complex), true),
            ComplexityDecision::Declared {
                trivial: false,
                complexity: TaskComplexity::Complex,
            }
        );
        assert_eq!(
            decide_complexity(Some(TaskComplexity::Complex), false),
            ComplexityDecision::Declared {
                trivial: false,
                complexity: TaskComplexity::Complex,
            }
        );
    }

    #[test]
    fn no_declaration_uses_triage_when_enabled() {
        assert_eq!(decide_complexity(None, true), ComplexityDecision::Triage);
    }

    #[test]
    fn no_declaration_uses_no_shortcut_when_triage_disabled() {
        assert_eq!(decide_complexity(None, false), ComplexityDecision::None);
    }

    #[test]
    fn planner_labels_use_models_to_disambiguate_same_cli() {
        let labels = planner_labels(&[
            Agent {
                cli: AgentCli::Codex,
                model: Some("gpt-5".to_string()),
                provider: None,
            },
            Agent {
                cli: AgentCli::Codex,
                model: Some("anthropic/claude".to_string()),
                provider: None,
            },
            Agent {
                cli: AgentCli::Claude,
                model: None,
                provider: None,
            },
        ]);

        assert_eq!(labels, vec!["gpt-5", "anthropic-claude", "claude"]);
    }

    #[test]
    fn planner_labels_suffix_colliding_bases() {
        let labels = planner_labels(&[
            Agent {
                cli: AgentCli::Codex,
                model: None,
                provider: None,
            },
            Agent {
                cli: AgentCli::Codex,
                model: None,
                provider: None,
            },
        ]);

        assert_eq!(labels, vec!["codex-1", "codex-2"]);
    }

    #[test]
    fn slugify_plan_name_sanitizes_model_output() {
        assert_eq!(
            slugify_plan_name("  Add Retry to /api/upload.ts!!  "),
            Some("add-retry-to-api-upload-ts".to_string())
        );
        assert_eq!(slugify_plan_name("   "), None);
    }

    #[test]
    fn ui_in_diff_detects_user_interface_changes() {
        assert!(ui_in_diff(
            "diff --git a/src/Button.tsx b/src/Button.tsx\n+++ b/src/Button.tsx\n+<button aria-label=\"Save\" />"
        ));
        assert!(ui_in_diff(
            "diff --git a/templates/index.html b/templates/index.html\n+++ b/templates/index.html"
        ));
        assert!(!ui_in_diff("+const className = 'primary'"));
        assert!(!ui_in_diff(
            "diff --git a/src/config.rs b/src/config.rs\n+++ b/src/config.rs\n+retries: 3"
        ));
    }

    #[test]
    fn marker_payload_reads_latest_marker_value() {
        assert_eq!(
            marker_payload("SUMMARY: first\nnotes\nSUMMARY: second", "SUMMARY"),
            Some("second".to_string())
        );
        assert_eq!(marker_payload("no marker", "SUMMARY"), None);
    }

    #[test]
    fn set_aside_marks_task_retrying_with_backoff() {
        let dir = TempDir::new().unwrap();
        let mut task = test_task(dir.path().to_string_lossy().as_ref());

        let outcome = set_aside(&mut task, "verify failed", Some("details".to_string())).unwrap();

        assert_eq!(task.meta.status, Status::Retrying);
        assert_eq!(task.meta.auto_retries, 1);
        assert!(task.meta.retry_at.is_some());
        assert_eq!(task.meta.resume_kind, None);
        assert!(std::fs::read_to_string(dir.path().join("retrying.md"))
            .unwrap()
            .contains("details"));
        assert!(matches!(
            outcome,
            TaskOutcome::Retrying {
                reason,
                auto_retries: 1,
                ..
            } if reason == "verify failed"
        ));
    }

    #[test]
    fn set_aside_blocks_after_retry_cap() {
        let dir = TempDir::new().unwrap();
        let mut task = test_task(dir.path().to_string_lossy().as_ref());
        task.meta.auto_retries = AUTO_RETRY_CAP;

        let outcome = set_aside(&mut task, "ship failed", None).unwrap();

        assert_eq!(task.meta.status, Status::Blocked);
        assert!(
            matches!(outcome, TaskOutcome::Blocked { reason, .. } if reason.contains("gave up"))
        );
    }

    #[test]
    fn write_proof_persists_review_and_verify_summary() {
        let dir = TempDir::new().unwrap();
        let mut task = test_task(dir.path().to_string_lossy().as_ref());
        task.meta.verify = Some("cargo test".to_string());

        write_proof(&task, "Step one\nStep two\nStep three\nStep four").unwrap();

        let proof = std::fs::read_to_string(dir.path().join("proof.md")).unwrap();
        assert!(proof.contains("# Proof - task"));
        assert!(proof.contains("VERDICT: PASS"));
        assert!(proof.contains("`cargo test` passed"));
        assert!(proof.contains("Step three"));
        assert!(!proof.contains("Step four"));
    }

    #[test]
    fn clip_feedback_input_bounds_large_text() {
        let text = "x".repeat(FEEDBACK_INPUT_LIMIT + 10);
        let clipped = clip_feedback_input(Some(&text)).unwrap();

        assert!(clipped.contains("[clipped for feedback prompt]"));
        assert!(clipped.len() < text.len() + 40);
        assert_eq!(clip_feedback_input(None), None);
    }

    #[test]
    fn conductor_commits_verified_trivial_task_with_scripted_agents() {
        let base = TempDir::new().unwrap();
        let repo = base.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        run_git(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "factory@example.test"]);
        run_git(&repo, &["config", "user.name", "Factory Test"]);
        std::fs::write(repo.join("README.md"), "initial\n").unwrap();
        run_git(&repo, &["add", "README.md"]);
        run_git(&repo, &["commit", "-m", "initial"]);

        let state_dir = base.path().join("state");
        let mut ctx = test_context(&repo, &state_dir);
        ctx.config.triage = true;
        let mut task = add_task(
            &ctx,
            "Create done.txt",
            Some("test -f done.txt".to_string()),
            AddTaskOptions::default(),
        )
        .unwrap();
        let mut meter = Meter::new();
        let mut stats = RunStats::default();
        let mut runner = ScriptedRunner::default();

        let outcome = run_task_inner(&ctx, &mut task, &mut meter, &mut runner, &mut stats).unwrap();

        assert_eq!(outcome, TaskOutcome::Done);
        assert_eq!(stats.retries, 0);
        assert_eq!(stats.verify_first_try, Some(true));
        assert_eq!(stats.triage, Some("trivial".to_string()));
        assert_eq!(task.meta.status, Status::Done);
        assert!(task.meta.commit.is_some());
        assert_eq!(
            std::fs::read_to_string(repo.join("done.txt")).unwrap(),
            "done\n"
        );
        assert_eq!(git_output_for_test(&repo, &["status", "--porcelain"]), "");
        assert_eq!(
            git_output_for_test(&repo, &["log", "-1", "--format=%s"]),
            "factory: Create done.txt"
        );
        assert!(
            std::fs::read_to_string(Path::new(&task.dir).join("verify.log"))
                .unwrap()
                .is_empty()
        );
        assert!(
            std::fs::read_to_string(Path::new(&task.dir).join("proof.md"))
                .unwrap()
                .contains("`test -f done.txt` passed")
        );
        assert!(
            std::fs::read_to_string(Path::new(&task.dir).join("baseline.patch"))
                .unwrap()
                .contains("# git status")
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&task.dir).join("consolidated.md")).unwrap(),
            "No findings\nVERDICT: PASS"
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&task.dir).join("feedback.md")).unwrap(),
            "Completion handoff"
        );
        assert_eq!(
            runner.calls,
            vec![
                "triage.md".to_string(),
                "implement.md".to_string(),
                "review.md".to_string(),
                "risk.md".to_string(),
                "deploy.md".to_string(),
                "consolidated.md".to_string(),
                "feedback.md".to_string(),
            ]
        );
    }

    #[test]
    fn conductor_preserves_feedback_appended_while_task_runs() {
        let base = TempDir::new().unwrap();
        let repo = base.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        run_git(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "factory@example.test"]);
        run_git(&repo, &["config", "user.name", "Factory Test"]);
        std::fs::write(repo.join("README.md"), "initial\n").unwrap();
        run_git(&repo, &["add", "README.md"]);
        run_git(&repo, &["commit", "-m", "initial"]);

        let state_dir = base.path().join("state");
        let ctx = test_context(&repo, &state_dir);
        let mut task = add_task(
            &ctx,
            "Create done.txt with feedback",
            None,
            AddTaskOptions {
                complexity: Some(TaskComplexity::Trivial),
                ..AddTaskOptions::default()
            },
        )
        .unwrap();
        append_feedback(&mut task, "Analyzed note.").unwrap();
        let verify_script = base.path().join("late-feedback-verify.sh");
        std::fs::write(
            &verify_script,
            format!(
                r#"#!/bin/sh
set -eu
test -f done.txt
cat >> '{task_dir}/human-feedback.md' <<'EOF'

## Feedback (late)

Later note.
EOF
sed -i 's/"feedbackCount": 1/"feedbackCount": 2/' '{task_dir}/meta.json'
"#,
                task_dir = task.dir
            ),
        )
        .unwrap();
        task.meta.verify = Some(format!("bash {}", verify_script.to_string_lossy()));
        save_meta(&task).unwrap();
        let mut meter = Meter::new();
        let mut stats = RunStats::default();
        let mut runner = ConcurrentFeedbackRunner::default();

        let outcome = run_task_inner(&ctx, &mut task, &mut meter, &mut runner, &mut stats).unwrap();

        assert_eq!(outcome, TaskOutcome::Done);
        let persisted_meta: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(Path::new(&task.dir).join("meta.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            persisted_meta
                .get("feedbackCount")
                .and_then(serde_json::Value::as_u64),
            Some(2)
        );
        assert_eq!(task.meta.feedback_count, 2);
        assert_eq!(task.meta.feedback_consumed, 1);
        assert_eq!(pending_feedback_count(&task), 1);
        let pending = read_pending_feedback(&task).unwrap().unwrap();
        assert!(pending.contains("Later note."));
        assert!(!pending.contains("Analyzed note."));
        assert_eq!(
            runner.calls,
            vec![
                "human-feedback.analysis.md".to_string(),
                "implement.md".to_string(),
                "review.md".to_string(),
                "risk.md".to_string(),
                "deploy.md".to_string(),
                "consolidated.md".to_string(),
                "feedback.md".to_string(),
            ]
        );
    }

    #[test]
    fn conductor_resume_with_existing_diff_reenters_gates_without_implementing() {
        let base = TempDir::new().unwrap();
        let repo = base.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        run_git(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "factory@example.test"]);
        run_git(&repo, &["config", "user.name", "Factory Test"]);
        std::fs::write(repo.join("README.md"), "initial\n").unwrap();
        run_git(&repo, &["add", "README.md"]);
        run_git(&repo, &["commit", "-m", "initial"]);
        std::fs::write(repo.join("done.txt"), "done\n").unwrap();

        let state_dir = base.path().join("state");
        let ctx = test_context(&repo, &state_dir);
        let mut task = add_task(
            &ctx,
            "Resume done.txt",
            Some("test -f done.txt".to_string()),
            AddTaskOptions {
                complexity: Some(TaskComplexity::Trivial),
                ..AddTaskOptions::default()
            },
        )
        .unwrap();
        task.meta.resume = true;
        task.meta.resume_kind = Some(ResumeKind::AutoRetry);
        save_meta(&task).unwrap();
        write_artifact(&task, "plan.md", "Saved resume plan").unwrap();
        let mut meter = Meter::new();
        let mut stats = RunStats::default();
        let mut runner = ScriptedRunner::default();

        let outcome = run_task_inner(&ctx, &mut task, &mut meter, &mut runner, &mut stats).unwrap();

        assert_eq!(outcome, TaskOutcome::Done);
        assert_eq!(stats.verify_first_try, Some(true));
        assert_eq!(task.meta.status, Status::Done);
        assert!(!task.meta.resume);
        assert_eq!(task.meta.resume_kind, None);
        assert_eq!(task.meta.resume_note, None);
        assert_eq!(git_output_for_test(&repo, &["status", "--porcelain"]), "");
        assert_eq!(
            git_output_for_test(&repo, &["show", "--name-only", "--format="]),
            "done.txt"
        );
        assert!(
            std::fs::read_to_string(Path::new(&task.dir).join("baseline.patch"))
                .unwrap()
                .contains("?? done.txt")
        );
        assert_eq!(
            runner.calls,
            vec![
                "review.md".to_string(),
                "risk.md".to_string(),
                "deploy.md".to_string(),
                "consolidated.md".to_string(),
                "feedback.md".to_string(),
            ]
        );
    }

    #[test]
    fn conductor_fix_loop_repairs_verify_failure_before_commit() {
        let base = TempDir::new().unwrap();
        let repo = base.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        run_git(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "factory@example.test"]);
        run_git(&repo, &["config", "user.name", "Factory Test"]);
        std::fs::write(repo.join("README.md"), "initial\n").unwrap();
        run_git(&repo, &["add", "README.md"]);
        run_git(&repo, &["commit", "-m", "initial"]);

        let state_dir = base.path().join("state");
        let mut ctx = test_context(&repo, &state_dir);
        ctx.config.retries = 1;
        let mut task = add_task(
            &ctx,
            "Create done.txt after a failed first attempt",
            Some("test -f done.txt".to_string()),
            AddTaskOptions {
                complexity: Some(TaskComplexity::Trivial),
                ..AddTaskOptions::default()
            },
        )
        .unwrap();
        let mut meter = Meter::new();
        let mut stats = RunStats::default();
        let mut runner = VerifyFixRunner::default();

        let outcome = run_task_inner(&ctx, &mut task, &mut meter, &mut runner, &mut stats).unwrap();

        assert_eq!(outcome, TaskOutcome::Done);
        assert_eq!(stats.retries, 1);
        assert_eq!(stats.verify_first_try, Some(false));
        assert_eq!(task.meta.status, Status::Done);
        assert_eq!(
            std::fs::read_to_string(repo.join("done.txt")).unwrap(),
            "done\n"
        );
        assert!(!repo.join("wrong.txt").exists());
        assert_eq!(git_output_for_test(&repo, &["status", "--porcelain"]), "");
        let committed_files = git_output_for_test(&repo, &["show", "--name-only", "--format="]);
        assert_eq!(committed_files, "done.txt");
        assert!(
            std::fs::read_to_string(Path::new(&task.dir).join("failures.jsonl"))
                .unwrap()
                .contains("\"gate\":\"verify\"")
        );
        assert!(std::fs::read_to_string(Path::new(&task.dir).join("fix.md"))
            .unwrap()
            .contains("Verify `test -f done.txt` failed"));
        assert_eq!(
            runner.calls,
            vec![
                "implement.md".to_string(),
                "review.md".to_string(),
                "risk.md".to_string(),
                "deploy.md".to_string(),
                "consolidated.md".to_string(),
                "converge.md".to_string(),
                "fix.1.md".to_string(),
                "review.md".to_string(),
                "risk.md".to_string(),
                "deploy.md".to_string(),
                "consolidated.md".to_string(),
                "feedback.md".to_string(),
            ]
        );
    }

    #[test]
    fn conductor_runs_complex_planning_ensemble_before_commit() {
        let base = TempDir::new().unwrap();
        let repo = base.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        run_git(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "factory@example.test"]);
        run_git(&repo, &["config", "user.name", "Factory Test"]);
        std::fs::write(repo.join("README.md"), "initial\n").unwrap();
        run_git(&repo, &["add", "README.md"]);
        run_git(&repo, &["commit", "-m", "initial"]);

        let state_dir = base.path().join("state");
        let mut ctx = test_context(&repo, &state_dir);
        ctx.agents.planners = vec![test_agent(AgentCli::Codex), test_agent(AgentCli::Claude)];
        ctx.plans_dir = Some(
            repo.join(".coding-agent-plans")
                .to_string_lossy()
                .to_string(),
        );
        let mut task = add_task(
            &ctx,
            "Plan and create done.txt",
            Some("test -f done.txt".to_string()),
            AddTaskOptions {
                complexity: Some(TaskComplexity::Complex),
                ..AddTaskOptions::default()
            },
        )
        .unwrap();
        let mut meter = Meter::new();
        let mut stats = RunStats::default();
        let mut runner = ComplexPlanningRunner::default();

        let outcome = run_task_inner(&ctx, &mut task, &mut meter, &mut runner, &mut stats).unwrap();

        assert_eq!(outcome, TaskOutcome::Done);
        assert_eq!(stats.triage, None);
        assert_eq!(task.meta.status, Status::Done);
        assert_eq!(
            std::fs::read_to_string(repo.join(".coding-agent-plans/durable-plan.md")).unwrap(),
            "# Plan and create done.txt\n\nSelected final plan\n"
        );
        assert!(runner
            .implement_prompt
            .as_deref()
            .unwrap()
            .contains("No plan risks"));
        assert_eq!(
            std::fs::read_to_string(Path::new(&task.dir).join("plan.final.md")).unwrap(),
            "Selected final plan"
        );
        assert_eq!(git_output_for_test(&repo, &["status", "--porcelain"]), "");
        let committed_files = git_output_for_test(&repo, &["show", "--name-only", "--format="]);
        assert_eq!(
            committed_files,
            ".coding-agent-plans/durable-plan.md\ndone.txt"
        );
        assert_eq!(
            runner.calls,
            vec![
                "research.md".to_string(),
                "plan.codex.md".to_string(),
                "plan.claude.md".to_string(),
                "critique.codex.md".to_string(),
                "critique.claude.md".to_string(),
                "reconcile.md".to_string(),
                "plan.codex.v2.md".to_string(),
                "plan.claude.v2.md".to_string(),
                "plan.final.md".to_string(),
                "risk.plan.md".to_string(),
                "plan.name.md".to_string(),
                "implement.md".to_string(),
                "review.md".to_string(),
                "risk.md".to_string(),
                "deploy.md".to_string(),
                "consolidated.md".to_string(),
                "feedback.md".to_string(),
            ]
        );
    }

    #[test]
    fn review_panel_runs_ux_review_for_user_facing_task_even_without_ui_file_diff() {
        let base = TempDir::new().unwrap();
        let repo = base.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let state_dir = base.path().join("state");
        let mut ctx = test_context(&repo, &state_dir);
        ctx.config.ux = true;
        let mut task = add_task(
            &ctx,
            "Tune user-facing behavior",
            None,
            AddTaskOptions::default(),
        )
        .unwrap();
        let mut meter = Meter::new();
        let mut runner = ScriptedRunner::default();

        let outcome = run_review_panel(
            &ctx,
            &mut task,
            &mut meter,
            &mut runner,
            "Tune user-facing behavior",
            "Plan",
            "diff --git a/src/server.rs b/src/server.rs\n+++ b/src/server.rs\n+let label = \"Save\";",
            true,
            None,
        )
        .unwrap();

        assert_eq!(outcome, None);
        assert_eq!(
            runner.calls,
            vec![
                "review.md".to_string(),
                "risk.md".to_string(),
                "deploy.md".to_string(),
                "ux.md".to_string(),
                "consolidated.md".to_string(),
            ]
        );
    }

    #[derive(Default)]
    struct ScriptedRunner {
        calls: Vec<String>,
    }

    impl AgentRunner for ScriptedRunner {
        fn run(&mut self, _agent: &Agent, opts: &AgentRun) -> std::io::Result<AgentResult> {
            let artifact = opts
                .out_file
                .as_deref()
                .and_then(|path| Path::new(path).file_name())
                .and_then(|name| name.to_str())
                .unwrap_or("unknown")
                .to_string();
            self.calls.push(artifact.clone());
            let text = match artifact.as_str() {
                "triage.md" => "COMPLEXITY: TRIVIAL\nUSER-FACING: NO".to_string(),
                "implement.md" => {
                    std::fs::write(Path::new(&opts.root).join("done.txt"), "done\n")?;
                    "Created done.txt".to_string()
                }
                "review.md" => "No correctness findings".to_string(),
                "risk.md" => "No material risks".to_string(),
                "deploy.md" => "Safe to deploy".to_string(),
                "ux.md" => "No UX findings".to_string(),
                "consolidated.md" => "No findings\nVERDICT: PASS".to_string(),
                "feedback.md" => "Completion handoff".to_string(),
                other => format!("Unexpected scripted artifact: {other}"),
            };
            Ok(AgentResult {
                text,
                usage: Default::default(),
            })
        }
    }

    #[derive(Default)]
    struct ConcurrentFeedbackRunner {
        calls: Vec<String>,
    }

    impl AgentRunner for ConcurrentFeedbackRunner {
        fn run(&mut self, _agent: &Agent, opts: &AgentRun) -> std::io::Result<AgentResult> {
            let artifact = opts
                .out_file
                .as_deref()
                .and_then(|path| Path::new(path).file_name())
                .and_then(|name| name.to_str())
                .unwrap_or("unknown")
                .to_string();
            self.calls.push(artifact.clone());
            let text = match artifact.as_str() {
                "human-feedback.analysis.md" => "Feedback analysis".to_string(),
                "implement.md" => {
                    std::fs::write(Path::new(&opts.root).join("done.txt"), "done\n")?;
                    "Created done.txt".to_string()
                }
                "review.md" => "No correctness findings".to_string(),
                "risk.md" => "No material risks".to_string(),
                "deploy.md" => "Safe to deploy".to_string(),
                "consolidated.md" => "No findings\nVERDICT: PASS".to_string(),
                "feedback.md" => "Completion handoff".to_string(),
                other => format!("Unexpected scripted artifact: {other}"),
            };
            Ok(AgentResult {
                text,
                usage: Default::default(),
            })
        }
    }

    #[derive(Default)]
    struct VerifyFixRunner {
        calls: Vec<String>,
    }

    impl AgentRunner for VerifyFixRunner {
        fn run(&mut self, _agent: &Agent, opts: &AgentRun) -> std::io::Result<AgentResult> {
            let artifact = opts
                .out_file
                .as_deref()
                .and_then(|path| Path::new(path).file_name())
                .and_then(|name| name.to_str())
                .unwrap_or("unknown")
                .to_string();
            self.calls.push(artifact.clone());
            let text = match artifact.as_str() {
                "implement.md" => {
                    std::fs::write(Path::new(&opts.root).join("wrong.txt"), "wrong\n")?;
                    "Created the wrong file".to_string()
                }
                "fix.1.md" => {
                    let root = Path::new(&opts.root);
                    std::fs::remove_file(root.join("wrong.txt")).ok();
                    std::fs::write(root.join("done.txt"), "done\n")?;
                    "Created done.txt".to_string()
                }
                "review.md" => "No correctness findings".to_string(),
                "risk.md" => "No material risks".to_string(),
                "deploy.md" => "Safe to deploy".to_string(),
                "consolidated.md" => "No findings\nVERDICT: PASS".to_string(),
                "converge.md" => "SUMMARY: done.txt was missing\nVERDICT: CONTINUE".to_string(),
                "feedback.md" => "Completion handoff".to_string(),
                other => format!("Unexpected scripted artifact: {other}"),
            };
            Ok(AgentResult {
                text,
                usage: Default::default(),
            })
        }
    }

    #[derive(Default)]
    struct ComplexPlanningRunner {
        calls: Vec<String>,
        implement_prompt: Option<String>,
    }

    impl AgentRunner for ComplexPlanningRunner {
        fn run(&mut self, _agent: &Agent, opts: &AgentRun) -> std::io::Result<AgentResult> {
            let artifact = opts
                .out_file
                .as_deref()
                .and_then(|path| Path::new(path).file_name())
                .and_then(|name| name.to_str())
                .unwrap_or("unknown")
                .to_string();
            self.calls.push(artifact.clone());
            let text = match artifact.as_str() {
                "research.md" => "Research notes".to_string(),
                "plan.codex.md" => "Codex plan".to_string(),
                "plan.claude.md" => "Claude plan".to_string(),
                "critique.codex.md" => "Codex critique".to_string(),
                "critique.claude.md" => "Claude critique".to_string(),
                "reconcile.md" => "DECISION: PROCEED\nPlans are compatible".to_string(),
                "plan.codex.v2.md" => "Codex revised plan".to_string(),
                "plan.claude.v2.md" => "Claude revised plan".to_string(),
                "plan.final.md" => "Selected final plan".to_string(),
                "risk.plan.md" => "No plan risks".to_string(),
                "plan.name.md" => "durable-plan".to_string(),
                "implement.md" => {
                    self.implement_prompt = Some(opts.prompt.clone());
                    std::fs::write(Path::new(&opts.root).join("done.txt"), "done\n")?;
                    "Created done.txt".to_string()
                }
                "review.md" => "No correctness findings".to_string(),
                "risk.md" => "No material risks".to_string(),
                "deploy.md" => "Safe to deploy".to_string(),
                "consolidated.md" => "No findings\nVERDICT: PASS".to_string(),
                "feedback.md" => "Completion handoff".to_string(),
                other => format!("Unexpected scripted artifact: {other}"),
            };
            Ok(AgentResult {
                text,
                usage: Default::default(),
            })
        }
    }

    fn test_context(repo: &Path, state_dir: &Path) -> WorkContext {
        let config = Config {
            retries: 0,
            triage: false,
            security: false,
            ux: false,
            plans_dir: None,
            capture_evals: false,
            postmortem: false,
            remediate: false,
            ..Config::default()
        };
        let agents = RoleAgents {
            planners: Vec::new(),
            implementer: test_agent(AgentCli::Codex),
            reviewer: test_agent(AgentCli::Claude),
            delivery: test_agent(AgentCli::Claude),
        };
        let state = state_dir.to_string_lossy().to_string();
        WorkContext {
            root: repo.to_string_lossy().to_string(),
            config,
            state_dir: state.clone(),
            tasks_dir: format!("{state}/tasks"),
            plans_dir: None,
            agents,
            ask_agent: test_agent(AgentCli::Claude),
            repo_state_dir: state.clone(),
            metrics_path: format!("{state}/metrics.db"),
        }
    }

    fn test_agent(cli: AgentCli) -> Agent {
        Agent {
            cli,
            model: None,
            provider: None,
        }
    }

    fn run_git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output_for_test(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn test_task(dir: &str) -> Task {
        Task {
            id: "task".to_string(),
            dir: dir.to_string(),
            meta: Meta {
                id: "task".to_string(),
                slug: "task".to_string(),
                status: Status::Ready,
                verify: None,
                created_at: "2026-01-01T00:00:00Z".to_string(),
                updated_at: None,
                commit: None,
                note: None,
                sharpen: SharpenState::Done,
                resume: false,
                resume_note: None,
                resume_kind: Some(ResumeKind::AutoRetry),
                retry_at: None,
                auto_retries: 0,
                complexity: None,
                feedback_count: 0,
                feedback_consumed: 0,
                feedback_source_task_id: None,
            },
        }
    }
}
