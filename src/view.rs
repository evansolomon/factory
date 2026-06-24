use std::fs;
use std::io;
use std::path::Path;

use serde_json::Value;

use crate::agents::agent_label;
use crate::config::{config_sources, global_config_file, OnComplete, RepoContext, WorkContext};
use crate::metrics::{read_report, Report};
use crate::task::{find_task, latest_task, pending_feedback_count, read_artifact, Task};

pub const SHOW_ARTIFACTS: &[(&str, &str)] = &[
    ("feedback.md", "## Completion feedback"),
    ("agent-session.summary.md", "## Agent session summary"),
    ("human-feedback.md", "## Feedback"),
    (
        "human-feedback.analysis.md",
        "## Feedback analysis (last pass)",
    ),
    ("questions.md", "## Open questions"),
    ("answers.md", "## Answers"),
    ("plan.final.md", "## Final plan"),
    ("risk.plan.md", "## Plan risk"),
    ("review.md", "## Review (last attempt)"),
    ("risk.md", "## Merge risk (last attempt)"),
    ("deploy.md", "## Deploy safety (last attempt)"),
    ("verify.log", "## Verify output (last attempt)"),
];

fn age(iso: Option<&str>) -> String {
    let Some(iso) = iso else {
        return "?".to_string();
    };
    let Ok(then) =
        ::time::OffsetDateTime::parse(iso, &::time::format_description::well_known::Rfc3339)
    else {
        return "?".to_string();
    };
    let seconds = (::time::OffsetDateTime::now_utc() - then).whole_seconds();
    if seconds < 60 {
        format!("{}s", seconds.max(0))
    } else {
        let minutes = seconds / 60;
        if minutes < 60 {
            format!("{minutes}m")
        } else {
            let hours = minutes / 60;
            if hours < 24 {
                format!("{hours}h")
            } else {
                format!("{}d", hours / 24)
            }
        }
    }
}

fn file_text(task: &Task, name: &str) -> io::Result<Option<String>> {
    read_artifact(task, name)
}

fn activity_steps(task: &Task) -> Vec<String> {
    let Ok(entries) = fs::read_dir(&task.dir) else {
        return Vec::new();
    };
    let mut steps: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|name| name.strip_suffix(".activity.jsonl").map(ToOwned::to_owned))
        .collect();
    steps.sort();
    steps
}

fn value_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

pub fn show_activity(task: &Task, step: &str) -> io::Result<Result<Vec<String>, String>> {
    let steps = activity_steps(task);
    let matched = steps
        .iter()
        .find(|candidate| candidate.as_str() == step)
        .or_else(|| steps.iter().find(|candidate| candidate.starts_with(step)));
    let Some(matched) = matched else {
        let suffix = if steps.is_empty() {
            String::new()
        } else {
            format!("\navailable: {}", steps.join(", "))
        };
        return Ok(Err(format!("no activity for step \"{step}\"{suffix}")));
    };
    let Some(jsonl) = file_text(task, &format!("{matched}.activity.jsonl"))? else {
        return Ok(Err(format!("activity for \"{matched}\" is empty")));
    };
    let mut lines = vec![
        format!("{} · {matched} — agent activity", task.meta.id),
        String::new(),
    ];
    for line in jsonl.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(text) = value_at(&value, &["item", "text"]).and_then(Value::as_str) {
            lines.push(text.to_string());
        } else if let Some(command) = value_at(&value, &["item", "command"]).and_then(Value::as_str)
        {
            lines.push(format!("→ {command}"));
        } else if let Some(kind) = value_at(&value, &["item", "type"]).and_then(Value::as_str) {
            lines.push(format!("· {kind}"));
        } else if value.get("type").and_then(Value::as_str) == Some("assistant") {
            if let Some(content) =
                value_at(&value, &["message", "content"]).and_then(Value::as_array)
            {
                for item in content {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        lines.push(text.to_string());
                    } else if let Some(name) = item.get("name").and_then(Value::as_str) {
                        lines.push(format!("→ {name}"));
                    }
                }
            }
        }
    }
    Ok(Ok(lines))
}

pub fn show_lines(
    ctx: &WorkContext,
    query: Option<&str>,
    step: Option<&str>,
) -> io::Result<Result<Vec<String>, String>> {
    let mut task = if let Some(query) = query {
        find_task(ctx, query)?
    } else {
        latest_task(ctx, None)?
    };
    let mut step_arg = step;
    if query.is_some() && task.is_none() && step.is_none() {
        task = latest_task(ctx, None)?;
        step_arg = query;
    }
    let Some(task) = task else {
        return Ok(Err(query
            .map(|query| format!("no task or step matching \"{query}\""))
            .unwrap_or_else(|| "no tasks in this worktree".to_string())));
    };
    if let Some(step) = step_arg {
        return show_activity(&task, step);
    }

    let meta = &task.meta;
    let mut lines = Vec::new();
    let note = meta
        .note
        .as_ref()
        .map(|note| format!(" — {note}"))
        .unwrap_or_default();
    lines.push(format!("{}  [{}]{}", meta.id, meta.status.as_str(), note));
    let complexity = meta
        .complexity
        .map(|complexity| format!("  ·  complexity: {} (declared)", complexity.as_str()))
        .unwrap_or_default();
    let feedback_count = pending_feedback_count(&task);
    let feedback_summary = if feedback_count > 0 {
        format!("  ·  feedback pending: {feedback_count}")
    } else {
        String::new()
    };
    let feedback_source = meta
        .feedback_source_task_id
        .as_ref()
        .map(|id| format!("  ·  ↩ feedback on {id}"))
        .unwrap_or_default();
    lines.push(format!(
        "verify: {}{}{}{}  ·  sharpen: {}  ·  created {} ago  ·  updated {} ago",
        meta.verify.as_deref().unwrap_or("(none)"),
        complexity,
        feedback_summary,
        feedback_source,
        meta.sharpen.as_str(),
        age(Some(&meta.created_at)),
        age(meta.updated_at.as_deref())
    ));

    if let Some(intent) = file_text(&task, "task.md")? {
        lines.extend([String::new(), "## Intent".to_string(), intent]);
    }
    for (name, heading) in SHOW_ARTIFACTS {
        if let Some(text) = file_text(&task, name)? {
            lines.extend([String::new(), (*heading).to_string(), text]);
        }
    }
    if meta.status.as_str() == "done" {
        if let Some(commit) = &meta.commit {
            lines.extend([String::new(), format!("## Committed as {commit}")]);
        }
    }
    let steps = activity_steps(&task);
    if !steps.is_empty() {
        lines.extend([
            String::new(),
            format!("## Step activity  (factory show {} <step>)", meta.id),
            format!("  {}", steps.join("  ")),
        ]);
    }
    Ok(Ok(lines))
}

pub fn print_show(ctx: &WorkContext, query: Option<&str>, step: Option<&str>) -> io::Result<i32> {
    match show_lines(ctx, query, step)? {
        Ok(lines) => {
            for line in lines {
                println!("{line}");
            }
            Ok(0)
        }
        Err(message) => {
            eprintln!("{message}");
            Ok(1)
        }
    }
}

pub fn config_lines(ctx: &WorkContext) -> Vec<String> {
    let config = &ctx.config;
    let on_complete = match &config.on_complete {
        None => "(not set — committed, not shipped)".to_string(),
        Some(OnComplete::Skill { skill }) => format!("skill: {skill}"),
        Some(OnComplete::Policy { policy }) => format!("policy: {policy}"),
    };
    let mut lines = Vec::new();

    lines.push(format!("factory config — effective for {}", ctx.root));
    lines.push(String::new());
    config_field(
        &mut lines,
        "dir",
        config.dir.clone().unwrap_or_else(|| {
            "(unset → ~/.factory/sessions or $FACTORY_HOME/sessions)".to_string()
        }),
    );
    config_field(&mut lines, "stateDir", ctx.state_dir.clone());
    config_field(&mut lines, "retries", config.retries.to_string());
    config_field(&mut lines, "triage", config.triage.to_string());
    config_field(&mut lines, "security", config.security.to_string());
    config_field(&mut lines, "ux", config.ux.to_string());
    config_field(
        &mut lines,
        "plansDir",
        config
            .plans_dir
            .clone()
            .unwrap_or_else(|| "(disabled)".to_string()),
    );
    config_field(&mut lines, "captureEvals", config.capture_evals.to_string());
    config_field(&mut lines, "postmortem", config.postmortem.to_string());
    config_field(&mut lines, "onComplete", on_complete);
    config_field(&mut lines, "ask", agent_label(&ctx.ask_agent));
    lines.push(String::new());
    config_field(
        &mut lines,
        "planners",
        ctx.agents
            .planners
            .iter()
            .map(agent_label)
            .collect::<Vec<_>>()
            .join(", "),
    );
    config_field(
        &mut lines,
        "implementer",
        agent_label(&ctx.agents.implementer),
    );
    config_field(&mut lines, "reviewer", agent_label(&ctx.agents.reviewer));
    config_field(&mut lines, "delivery", agent_label(&ctx.agents.delivery));
    if !config.hooks.is_empty() {
        lines.push(String::new());
        lines.push("  hooks:".to_string());
        for (event, commands) in &config.hooks {
            for command in commands {
                lines.push(format!("    {:<16} {}", event, command));
            }
        }
    }
    lines.push(String::new());
    config_field(&mut lines, "state →", ctx.state_dir.clone());
    if let Some(plans_dir) = &ctx.plans_dir {
        config_field(&mut lines, "plans →", plans_dir.clone());
    }
    lines.push(String::new());
    let sources = config_sources(&ctx.root);
    if !sources.is_empty() {
        lines.push("  set by (closest wins):".to_string());
        lines.extend(sources.into_iter().map(|source| format!("    {source}")));
        lines.push(String::new());
    }
    let parent = std::path::Path::new(&ctx.root)
        .parent()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| ctx.root.clone());
    lines.push("  to edit (.factory.json cascades up; closest wins):".to_string());
    lines.push(format!(
        "    global defaults:            {}   ← factory config edit",
        global_config_file()
    ));
    lines.push(format!(
        "    just this worktree:          {}/.factory.json   (factory config edit --worktree)",
        ctx.root
    ));
    lines.push(format!(
        "    all worktrees of this repo:  {parent}/.factory.json   (factory config edit --repo-parent)"
    ));
    lines.push("    custom layer:                factory config edit --dir <dir>".to_string());
    lines
}

fn config_field(lines: &mut Vec<String>, name: &str, value: String) {
    lines.push(format!("  {:<11} {}", name, value));
}

pub fn print_config(ctx: &WorkContext) {
    for line in config_lines(ctx) {
        println!("{line}");
    }
}

fn pct_of(value: Option<f64>) -> String {
    value
        .map(|value| format!("{}%", (value * 100.0).round() as i64))
        .unwrap_or_else(|| "—".to_string())
}

fn tokens(value: Option<f64>) -> String {
    let Some(value) = value else {
        return "—".to_string();
    };
    if value >= 1_000_000.0 {
        format!("{:.1}M", value / 1_000_000.0)
    } else if value >= 1_000.0 {
        format!("{:.1}k", value / 1_000.0)
    } else {
        format!("{}", value.round() as i64)
    }
}

fn dur_ms(value: Option<f64>) -> String {
    let Some(value) = value else {
        return "—".to_string();
    };
    let seconds = (value / 1000.0).round() as i64;
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        let minutes = seconds / 60;
        if minutes < 60 {
            format!("{minutes}m")
        } else {
            let hours = minutes / 60;
            if hours < 24 {
                format!("{}h{}m", hours, minutes % 60)
            } else {
                format!("{}d", hours / 24)
            }
        }
    }
}

pub fn format_report(report: &Report) -> Vec<String> {
    let mut lines = Vec::new();
    let plural = |n: i64, word: &str| format!("{n} {word}{}", if n == 1 { "" } else { "s" });
    let total_tokens = report.input_tokens_total + report.output_tokens_total;

    lines.push(format!(
        "factory report — {} · {}",
        plural(report.tasks, "task"),
        plural(report.runs, "run")
    ));
    lines.push(String::new());
    report_field(
        &mut lines,
        "first-pass yield",
        pct_of(report.first_pass_yield),
        "done w/ no retries, of implement attempts",
    );
    report_field(
        &mut lines,
        "escalation rate",
        pct_of(report.escalation_rate),
        &plural(report.escalations, "pause"),
    );
    report_field(&mut lines, "blocked rate", pct_of(report.blocked_rate), "");
    report_field(
        &mut lines,
        "retry success",
        pct_of(report.retry_success),
        &format!("of {}", plural(report.retry_runs, "retried run")),
    );
    lines.push(String::new());
    report_field(
        &mut lines,
        "cost",
        format!(
            "input {} tok · output {} tok · total {} tok · median {} tok/task",
            tokens(Some(report.input_tokens_total as f64)),
            tokens(Some(report.output_tokens_total as f64)),
            tokens(Some(total_tokens as f64)),
            tokens(report.tokens_median_per_task)
        ),
        "",
    );
    report_field(
        &mut lines,
        "cycle time",
        format!("median {}", dur_ms(report.cycle_median_ms)),
        "",
    );
    lines.push(String::new());
    lines.push(format!(
        "  outcomes:  {}",
        report
            .outcomes
            .iter()
            .map(|outcome| format!("{} {}", outcome.outcome, outcome.count))
            .collect::<Vec<_>>()
            .join(" · ")
    ));

    if !report.stages.is_empty() {
        let stage_tokens: i64 = report.stages.iter().map(|stage| stage.total_tokens).sum();
        let stage_ms: i64 = report.stages.iter().map(|stage| stage.ms).sum();
        let stage_width = 14;
        let token_width = 7;
        let share_width = 7;

        lines.push(String::new());
        lines.push("  stage cost and time:".to_string());
        lines.push(format!(
            "    {:<stage_width$} {:>token_width$} {:>token_width$} {:>token_width$} {:>share_width$} {:>token_width$} {:>share_width$}",
            "stage",
            "input",
            "output",
            "total",
            "token %",
            "time",
            "time %",
        ));
        for stage in &report.stages {
            lines.push(format!(
                "    {:<stage_width$} {:>token_width$} {:>token_width$} {:>token_width$} {:>share_width$} {:>token_width$} {:>share_width$}",
                stage.stage,
                tokens(Some(stage.input_tokens as f64)),
                tokens(Some(stage.output_tokens as f64)),
                tokens(Some(stage.total_tokens as f64)),
                pct_of(ratio_f64(stage.total_tokens, stage_tokens)),
                dur_ms(Some(stage.ms as f64)),
                pct_of(ratio_f64(stage.ms, stage_ms)),
            ));
        }
    }
    lines
}

fn report_field(lines: &mut Vec<String>, name: &str, value: String, note: &str) {
    lines.push(format!(
        "  {:<16} {}{}",
        name,
        value,
        if note.is_empty() {
            String::new()
        } else {
            format!("   {note}")
        }
    ));
}

fn ratio_f64(num: i64, denom: i64) -> Option<f64> {
    (denom > 0).then_some(num as f64 / denom as f64)
}

pub fn print_report(ctx: &RepoContext) -> i32 {
    if !Path::new(&ctx.metrics_path).exists() {
        eprintln!("no telemetry yet — run some tasks first");
        return 0;
    }
    let report = match read_report(&ctx.metrics_path) {
        Ok(Some(report)) => report,
        Ok(None) => {
            eprintln!("no telemetry yet — run some tasks first");
            return 0;
        }
        Err(err) => {
            eprintln!("warning: telemetry: could not read metrics — {err}");
            eprintln!("the db rebuilds itself on the next task run");
            return 0;
        }
    };
    for line in format_report(&report) {
        println!("{line}");
    }
    0
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use tempfile::TempDir;

    use crate::config::{Agent, AgentCli, Config, RoleAgents, WorkContext};
    use crate::task::{add_task, save_meta, write_artifact, AddTaskOptions, Status};

    use super::*;

    fn work_context() -> (TempDir, WorkContext) {
        let root = TempDir::new().unwrap();
        let state_dir = root.path().join("state").to_string_lossy().to_string();
        let ctx = WorkContext {
            root: root.path().to_string_lossy().to_string(),
            config: Config::default(),
            state_dir: state_dir.clone(),
            tasks_dir: format!("{state_dir}/tasks"),
            plans_dir: None,
            agents: RoleAgents {
                planners: vec![
                    Agent {
                        cli: AgentCli::Codex,
                        model: None,
                        provider: None,
                    },
                    Agent {
                        cli: AgentCli::Claude,
                        model: None,
                        provider: None,
                    },
                ],
                implementer: Agent {
                    cli: AgentCli::Codex,
                    model: None,
                    provider: None,
                },
                reviewer: Agent {
                    cli: AgentCli::Claude,
                    model: None,
                    provider: None,
                },
                delivery: Agent {
                    cli: AgentCli::Claude,
                    model: None,
                    provider: None,
                },
            },
            ask_agent: Agent {
                cli: AgentCli::Claude,
                model: None,
                provider: None,
            },
            repo_state_dir: state_dir.clone(),
            metrics_path: format!("{state_dir}/metrics.db"),
        };
        (root, ctx)
    }

    #[test]
    fn show_artifacts_puts_completion_feedback_before_plan() {
        assert_eq!(SHOW_ARTIFACTS[0], ("feedback.md", "## Completion feedback"));
        let names: Vec<&str> = SHOW_ARTIFACTS.iter().map(|(name, _)| *name).collect();
        assert!(
            names.iter().position(|name| *name == "feedback.md")
                < names.iter().position(|name| *name == "plan.final.md")
        );
    }

    #[test]
    fn show_lines_includes_intent_artifacts_and_commit() {
        let (_root, ctx) = work_context();
        let mut task = add_task(
            &ctx,
            "Build the thing",
            Some("cargo test".to_string()),
            AddTaskOptions::default(),
        )
        .unwrap();
        task.meta.status = Status::Done;
        task.meta.commit = Some("abc1234".to_string());
        save_meta(&task).unwrap();
        write_artifact(&task, "feedback.md", "Done.").unwrap();
        write_artifact(&task, "plan.final.md", "Plan.").unwrap();

        let lines = show_lines(&ctx, Some(&task.id), None).unwrap().unwrap();
        let text = lines.join("\n");
        assert!(text.contains("## Intent\nBuild the thing"));
        assert!(text.contains("## Completion feedback\nDone."));
        assert!(text.contains("## Final plan\nPlan."));
        assert!(text.contains("## Committed as abc1234"));
    }

    #[test]
    fn show_activity_renders_jsonl_events() {
        let (_root, ctx) = work_context();
        let task = add_task(&ctx, "Inspect activity", None, AddTaskOptions::default()).unwrap();
        fs::write(
            Path::new(&task.dir).join("implement.activity.jsonl"),
            r#"{"item":{"text":"thinking"}}
{"item":{"command":"rg foo"}}
{"type":"assistant","message":{"content":[{"text":"final"},{"name":"tool"}]}}"#,
        )
        .unwrap();
        let lines = show_activity(&task, "impl").unwrap().unwrap();
        let text = lines.join("\n");
        assert!(text.contains("thinking"));
        assert!(text.contains("→ rg foo"));
        assert!(text.contains("final"));
        assert!(text.contains("→ tool"));
    }

    #[test]
    fn config_lines_show_core_fields_and_edit_targets() {
        let (_root, ctx) = work_context();
        let lines = config_lines(&ctx);
        let text = lines.join("\n");
        assert!(text.contains("factory config — effective for"));
        assert!(text.contains("stateDir"));
        assert!(text.contains("planners"));
        assert!(text.contains("factory config edit --worktree"));
        assert!(text.contains("factory config edit --repo-parent"));
    }

    #[test]
    fn report_format_renders_cost_totals_and_combined_stage_table() {
        let report = Report {
            tasks: 2,
            runs: 3,
            outcomes: vec![
                crate::metrics::OutcomeCount {
                    outcome: "done".to_string(),
                    count: 2,
                },
                crate::metrics::OutcomeCount {
                    outcome: "blocked".to_string(),
                    count: 1,
                },
            ],
            implement_runs: 3,
            first_pass_yield: Some(2.0 / 3.0),
            escalations: 1,
            escalation_rate: Some(1.0 / 2.0),
            blocked_rate: Some(1.0 / 3.0),
            retry_runs: 1,
            retry_success: Some(1.0),
            input_tokens_total: 12_300,
            output_tokens_total: 4_500,
            tokens_median_per_task: Some(8_400.0),
            stages: vec![
                crate::metrics::ReportStage {
                    stage: "implement".to_string(),
                    input_tokens: 8_000,
                    output_tokens: 2_000,
                    total_tokens: 10_000,
                    ms: 40_000,
                },
                crate::metrics::ReportStage {
                    stage: "review".to_string(),
                    input_tokens: 4_000,
                    output_tokens: 2_000,
                    total_tokens: 6_000,
                    ms: 35_000,
                },
                crate::metrics::ReportStage {
                    stage: "verify".to_string(),
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0,
                    ms: 5_000,
                },
            ],
            cycle_median_ms: Some(120_000.0),
        };
        let lines = format_report(&report);
        let text = lines.join("\n");
        assert!(text.contains(
            "input 12.3k tok · output 4.5k tok · total 16.8k tok · median 8.4k tok/task"
        ));
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.as_str() == "  stage cost and time:")
                .count(),
            1
        );
        assert!(text.contains("stage"));
        assert!(text.contains("token %"));
        assert!(lines.contains(
            &"    implement         8.0k    2.0k   10.0k     63%     40s     50%".to_string()
        ));
        let verify = lines
            .iter()
            .find(|line| line.contains("verify"))
            .expect("verify row");
        assert!(verify.contains("0       0       0"));
        assert!(verify.contains("0%"));
        assert!(verify.contains("5s"));
    }
}
