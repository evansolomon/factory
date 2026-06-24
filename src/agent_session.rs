use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::config::WorkContext;
use crate::task::{find_task, latest_task, write_artifact, Status, Task};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InteractiveAgent {
    Codex,
    Claude,
}

impl InteractiveAgent {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "codex" => Some(Self::Codex),
            "claude" => Some(Self::Claude),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRequest {
    pub agent: InteractiveAgent,
    pub task_query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseAgentSessionResult {
    Ok(SessionRequest),
    Err(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionHandoff {
    pub artifact: String,
    pub summary_path: String,
    pub content: String,
}

const SUMMARY_ARTIFACT: &str = "agent-session.summary.md";
const HANDOFF_ARTIFACT: &str = "agent-session.md";

const ARTIFACT_ORDER: &[&str] = &[
    "task.md",
    "meta.json",
    "feedback.md",
    "human-feedback.md",
    "plan.md",
    "plan.final.md",
    "risk.plan.md",
    "implement.log.md",
    "diff.patch",
    "review.md",
    "security.md",
    "risk.md",
    "deploy.md",
    "ux.md",
    "consolidated.md",
    "failures.jsonl",
    "verify.log",
    "proof.md",
    "postmortem.md",
    "ship.md",
];

pub fn parse_agent_session_args(
    args: &[String],
    default_agent: InteractiveAgent,
) -> ParseAgentSessionResult {
    let mut agent = default_agent;
    let mut positional = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--agent" {
            let Some(next) = args.get(i + 1) else {
                return ParseAgentSessionResult::Err(
                    "usage: factory session [--agent codex|claude] [task-id]".to_string(),
                );
            };
            let Some(parsed) = InteractiveAgent::parse(next) else {
                return ParseAgentSessionResult::Err(format!(
                    "unknown agent \"{next}\" (expected codex or claude)"
                ));
            };
            agent = parsed;
            i += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--agent=") {
            let Some(parsed) = InteractiveAgent::parse(value) else {
                return ParseAgentSessionResult::Err(format!("unknown agent \"{value}\""));
            };
            agent = parsed;
            i += 1;
            continue;
        }
        if arg.starts_with("--") {
            return ParseAgentSessionResult::Err(format!("unknown option {arg}"));
        }
        positional.push(arg.clone());
        i += 1;
    }

    if positional.len() > 1 {
        return ParseAgentSessionResult::Err(
            "usage: factory session [--agent codex|claude] [task-id]".to_string(),
        );
    }

    ParseAgentSessionResult::Ok(SessionRequest {
        agent,
        task_query: positional.into_iter().next(),
    })
}

fn existing_artifact_names(task: &Task) -> io::Result<Vec<String>> {
    let mut existing = Vec::new();
    for entry in fs::read_dir(&task.dir)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            continue;
        };
        if name.starts_with('.')
            || name.ends_with(".tmp")
            || name == HANDOFF_ARTIFACT
            || name == SUMMARY_ARTIFACT
        {
            continue;
        }
        existing.push(name);
    }
    let mut names = Vec::new();
    for ordered in ARTIFACT_ORDER {
        if existing.iter().any(|name| name == ordered) {
            names.push((*ordered).to_string());
        }
    }
    let mut extra: Vec<String> = existing
        .into_iter()
        .filter(|name| {
            !ARTIFACT_ORDER.contains(&name.as_str())
                && (name.ends_with(".md") || name.ends_with(".activity.jsonl"))
        })
        .collect();
    extra.sort();
    names.extend(extra);
    Ok(names)
}

fn artifact_line(task: &Task, name: &str) -> String {
    format!(
        "- {name}: {}",
        absolute_path(Path::new(&task.dir).join(name))
    )
}

fn absolute_path(path: impl AsRef<Path>) -> String {
    path.as_ref()
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path.as_ref()))
        .to_string_lossy()
        .to_string()
}

pub fn build_agent_session_handoff(
    ctx: &WorkContext,
    task: &Task,
    agent: InteractiveAgent,
    now_iso: &str,
) -> io::Result<AgentSessionHandoff> {
    let summary_path = absolute_path(Path::new(&task.dir).join(SUMMARY_ARTIFACT));
    let artifact_path = absolute_path(Path::new(&task.dir).join(HANDOFF_ARTIFACT));
    let artifact_names = existing_artifact_names(task)?;
    let references = if artifact_names.is_empty() {
        "(no task artifacts found)".to_string()
    } else {
        artifact_names
            .iter()
            .map(|name| artifact_line(task, name))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let content = format!(
        r#"# Agent Session Handoff

Generated: {now_iso}

## Task
- id: {id}
- status: {status}
- agent: {agent}
- commit: {commit}
- verify: {verify}
- task dir: {task_dir}
- worktree: {worktree}

## References
{references}

## Factory Commands
- show task: factory show {id}
- ask saved state: factory ask {id}
- record follow-up feedback: factory feedback {id} --edit

## Session Instructions
- Start by reading this handoff and the referenced artifacts that are relevant.
- Work with the human interactively on small follow-up tweaks.
- Do not commit unless the human explicitly asks.
- Before ending, append a concise summary to {summary_path}.

Suggested summary sections:
- What changed
- Files touched
- Checks run and results
- Remaining follow-up
- Anything factory should consume later
"#,
        id = task.id,
        status = task.meta.status.as_str(),
        agent = agent.as_str(),
        commit = task.meta.commit.as_deref().unwrap_or("(none)"),
        verify = task.meta.verify.as_deref().unwrap_or("(none)"),
        task_dir = absolute_path(&task.dir),
        worktree = ctx.root,
    );

    write_artifact(task, HANDOFF_ARTIFACT, &content)?;
    Ok(AgentSessionHandoff {
        artifact: artifact_path,
        summary_path,
        content,
    })
}

pub fn agent_session_prompt(task_id: &str, handoff_path: &str, summary_path: &str) -> String {
    format!(
        r#"You are taking over after factory task {task_id}.

Read this handoff first:
{handoff_path}

Use the referenced factory artifacts as context.
Work interactively with the human on follow-up tweaks.
Keep the scope narrow. Do not commit unless the human explicitly asks.

Before ending the session, append a concise summary to:
{summary_path}
"#
    )
}

pub fn agent_session_command(
    agent: InteractiveAgent,
    root: &str,
    task_id: &str,
    handoff_path: &str,
    summary_path: &str,
) -> Vec<String> {
    let prompt = agent_session_prompt(task_id, handoff_path, summary_path);
    match agent {
        InteractiveAgent::Codex => vec![
            "codex".to_string(),
            "-C".to_string(),
            root.to_string(),
            "-s".to_string(),
            "workspace-write".to_string(),
            "-a".to_string(),
            "on-request".to_string(),
            prompt,
        ],
        InteractiveAgent::Claude => vec![
            "claude".to_string(),
            "--add-dir".to_string(),
            root.to_string(),
            "--permission-mode".to_string(),
            "default".to_string(),
            prompt,
        ],
    }
}

pub fn target_task(ctx: &WorkContext, query: Option<&str>) -> io::Result<Option<Task>> {
    if let Some(query) = query {
        find_task(ctx, query)
    } else {
        latest_task(ctx, Some(&[Status::Done]))
    }
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use crate::config::{Agent, AgentCli, Config, RoleAgents};
    use crate::task::{add_task, AddTaskOptions};

    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_string()).collect()
    }

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
    fn parse_args_defaults_to_supplied_agent_and_optional_task() {
        assert_eq!(
            parse_agent_session_args(&strings(&["fix-button"]), InteractiveAgent::Codex),
            ParseAgentSessionResult::Ok(SessionRequest {
                agent: InteractiveAgent::Codex,
                task_query: Some("fix-button".to_string())
            })
        );
    }

    #[test]
    fn parse_args_supports_selecting_claude() {
        assert_eq!(
            parse_agent_session_args(&strings(&["--agent", "claude"]), InteractiveAgent::Codex),
            ParseAgentSessionResult::Ok(SessionRequest {
                agent: InteractiveAgent::Claude,
                task_query: None
            })
        );
    }

    #[test]
    fn builds_handoff_with_metadata_and_existing_artifacts() {
        let (_root, ctx) = work_context();
        let mut task = add_task(
            &ctx,
            "Tweak the completed UI",
            Some("bun test".to_string()),
            AddTaskOptions::default(),
        )
        .unwrap();
        task.meta.status = Status::Done;
        task.meta.commit = Some("abc1234".to_string());
        crate::task::save_meta(&task).unwrap();
        write_artifact(&task, "plan.md", "Use the existing component.").unwrap();
        write_artifact(&task, "verify.log", "$ bun test\npassed").unwrap();
        write_artifact(
            &task,
            "implement.activity.jsonl",
            r#"{"type":"turn.completed"}"#,
        )
        .unwrap();
        write_artifact(&task, "agent-session.summary.md", "Prior summary").unwrap();

        let handoff = build_agent_session_handoff(
            &ctx,
            &task,
            InteractiveAgent::Claude,
            "2026-06-22T12:00:00.000Z",
        )
        .unwrap();

        assert_eq!(handoff.artifact, format!("{}/agent-session.md", task.dir));
        assert_eq!(
            handoff.summary_path,
            format!("{}/agent-session.summary.md", task.dir)
        );
        assert!(handoff
            .content
            .contains("Generated: 2026-06-22T12:00:00.000Z"));
        assert!(handoff.content.contains(&format!("- id: {}", task.id)));
        assert!(handoff.content.contains("- status: done"));
        assert!(handoff.content.contains("- agent: claude"));
        assert!(handoff.content.contains("- commit: abc1234"));
        assert!(handoff
            .content
            .contains(&format!("- task.md: {}/task.md", task.dir)));
        assert!(handoff
            .content
            .contains(&format!("- plan.md: {}/plan.md", task.dir)));
        assert!(handoff
            .content
            .contains(&format!("- verify.log: {}/verify.log", task.dir)));
        assert!(handoff.content.contains(&format!(
            "- implement.activity.jsonl: {}/implement.activity.jsonl",
            task.dir
        )));
        assert!(!handoff.content.contains("agent-session.summary.md:"));
        assert!(!handoff.content.contains("ship.md:"));
        assert_eq!(
            fs::read_to_string(format!("{}/agent-session.md", task.dir)).unwrap(),
            handoff.content
        );
    }

    #[test]
    fn opens_interactive_codex_with_workspace_write() {
        let cmd = agent_session_command(
            InteractiveAgent::Codex,
            "/repo",
            "fix-button",
            "/state/tasks/fix-button/agent-session.md",
            "/state/tasks/fix-button/agent-session.summary.md",
        );
        assert_eq!(
            &cmd[..7],
            [
                "codex",
                "-C",
                "/repo",
                "-s",
                "workspace-write",
                "-a",
                "on-request"
            ]
        );
        assert_eq!(
            cmd[7],
            agent_session_prompt(
                "fix-button",
                "/state/tasks/fix-button/agent-session.md",
                "/state/tasks/fix-button/agent-session.summary.md"
            )
        );
    }

    #[test]
    fn opens_interactive_claude_in_task_worktree() {
        let cmd = agent_session_command(
            InteractiveAgent::Claude,
            "/repo",
            "fix-button",
            "/state/tasks/fix-button/agent-session.md",
            "/state/tasks/fix-button/agent-session.summary.md",
        );
        assert_eq!(
            &cmd[..5],
            [
                "claude",
                "--add-dir",
                "/repo",
                "--permission-mode",
                "default"
            ]
        );
        assert_eq!(
            cmd[5],
            agent_session_prompt(
                "fix-button",
                "/state/tasks/fix-button/agent-session.md",
                "/state/tasks/fix-button/agent-session.summary.md"
            )
        );
    }
}
