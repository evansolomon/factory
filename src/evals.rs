use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::clock::now_iso;
use crate::config::WorkContext;
use crate::git::{commit_diff, head_sha, worktree_diff, GitError};
use crate::lessons::append_candidate;
use crate::task::{read_artifact, read_intent, Task};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EvalOutcome {
    Done,
    Blocked,
}

impl EvalOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Blocked => "blocked",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalCase {
    pub id: String,
    pub ts: String,
    pub outcome: String,
    pub reason: Option<String>,
    pub worktree: String,
    pub base_commit: String,
    pub verify: Option<String>,
    pub spec: String,
    pub diff: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionEvalCase {
    pub id: String,
    pub ts: String,
    pub outcome: String,
    pub reason: String,
    pub note: Option<String>,
    pub worktree: String,
    pub base_commit: String,
    pub verify: Option<String>,
    pub spec: String,
    pub agent_attempt: String,
    pub human_fix: String,
}

pub fn capture_eval_case(
    ctx: &WorkContext,
    task: &Task,
    outcome: EvalOutcome,
    reason: Option<&str>,
) {
    if let Err(err) = capture_eval_case_at(ctx, task, outcome, reason, &now_iso(), None) {
        eprintln!("eval capture failed for {}: {err}", task.id);
    }
}

pub fn capture_correction(ctx: &WorkContext, task: &Task, note: &str) {
    let suffix = {
        let now = time::OffsetDateTime::now_utc();
        ((now.unix_timestamp() as i128 * 1000) + (now.nanosecond() as i128 / 1_000_000)).to_string()
    };
    let lesson = if note.trim().is_empty() {
        "see eval candidate"
    } else {
        note.trim()
    };
    if let Err(err) =
        capture_correction_eval_at(ctx, task, note, "manual", lesson, &now_iso(), &suffix)
    {
        eprintln!("correction capture failed for {}: {err}", task.id);
    }
}

pub fn capture_eval_case_at(
    ctx: &WorkContext,
    task: &Task,
    outcome: EvalOutcome,
    reason: Option<&str>,
    timestamp: &str,
    filename_suffix: Option<&str>,
) -> Result<Option<String>, CaptureEvalError> {
    if !ctx.config.capture_evals {
        return Ok(None);
    }
    let spec = read_intent(task)?;
    let committed = outcome == EvalOutcome::Done && task.meta.commit.is_some();
    let base_commit = if committed {
        format!("{}^", task.meta.commit.as_deref().unwrap_or_default())
    } else {
        head_sha(&ctx.root)?
    };
    let diff = if committed {
        commit_diff(&ctx.root, task.meta.commit.as_deref().unwrap_or_default())?
    } else {
        worktree_diff(&ctx.root)?
    };
    let record = EvalCase {
        id: task.id.clone(),
        ts: timestamp.to_string(),
        outcome: outcome.as_str().to_string(),
        reason: reason.map(ToOwned::to_owned),
        worktree: ctx.root.clone(),
        base_commit,
        verify: task.meta.verify.clone(),
        spec,
        diff,
    };
    let dir = format!("{}/eval-candidates", ctx.repo_state_dir);
    fs::create_dir_all(&dir)?;
    let suffix = filename_suffix.map(ToOwned::to_owned).unwrap_or_else(|| {
        let now = time::OffsetDateTime::now_utc();
        ((now.unix_timestamp() as i128 * 1000) + (now.nanosecond() as i128 / 1_000_000)).to_string()
    });
    let path = format!("{dir}/{}.{}.{}.json", task.id, outcome.as_str(), suffix);
    write_json(&path, &record)?;
    Ok(Some(path))
}

pub fn capture_correction_eval_at(
    ctx: &WorkContext,
    task: &Task,
    note: &str,
    category: &str,
    lesson: &str,
    timestamp: &str,
    filename_suffix: &str,
) -> Result<Option<String>, CaptureEvalError> {
    let intent = read_intent(task)?;
    let agent_attempt = read_artifact(task, "diff.patch")?.unwrap_or_default();
    let human_fix = worktree_diff(&ctx.root)?;
    let reason = task
        .meta
        .note
        .clone()
        .unwrap_or_else(|| "blocked".to_string());

    let path = if ctx.config.capture_evals {
        let record = CorrectionEvalCase {
            id: task.id.clone(),
            ts: timestamp.to_string(),
            outcome: "corrected".to_string(),
            reason,
            note: (!note.is_empty()).then(|| note.to_string()),
            worktree: ctx.root.clone(),
            base_commit: head_sha(&ctx.root)?,
            verify: task.meta.verify.clone(),
            spec: intent,
            agent_attempt,
            human_fix,
        };
        let dir = format!("{}/eval-candidates", ctx.repo_state_dir);
        fs::create_dir_all(&dir)?;
        let path = format!("{dir}/{}.corrected.{filename_suffix}.json", task.id);
        write_json(&path, &record)?;
        Some(path)
    } else {
        None
    };

    append_candidate(
        ctx,
        &format!(
            "correction - {} - [{}] {}",
            task.id,
            category,
            if lesson.is_empty() {
                "see eval candidate"
            } else {
                lesson
            }
        ),
    );
    Ok(path)
}

fn write_json(path: impl AsRef<Path>, value: &impl Serialize) -> io::Result<()> {
    fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(value).map_err(io::Error::other)?
        ),
    )
}

#[derive(Debug, thiserror::Error)]
pub enum CaptureEvalError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Git(#[from] GitError),
}

#[cfg(test)]
mod tests {
    use std::process::{Command, Stdio};

    use tempfile::TempDir;

    use crate::config::{Agent, AgentCli, AgentsConfig, AskConfig, Config, RoleAgents};
    use crate::task::{add_task, write_artifact, AddTaskOptions};

    use super::*;

    fn ctx(dir: &TempDir, capture_evals: bool) -> WorkContext {
        let root = dir.path().to_string_lossy().to_string();
        WorkContext {
            root: root.clone(),
            config: Config {
                capture_evals,
                agents: AgentsConfig::default(),
                ask: AskConfig::default(),
                ..Config::default()
            },
            state_dir: format!("{root}/state"),
            tasks_dir: format!("{root}/state/tasks"),
            plans_dir: None,
            agents: RoleAgents {
                planners: Vec::new(),
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
            repo_state_dir: format!("{root}/repo-state"),
            metrics_path: format!("{root}/repo-state/metrics.db"),
        }
    }

    fn git(dir: &TempDir, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn init_repo(dir: &TempDir) {
        git(dir, &["init"]);
        git(dir, &["config", "user.email", "factory@example.com"]);
        git(dir, &["config", "user.name", "Factory"]);
        fs::write(dir.path().join("README.md"), "base\n").unwrap();
        git(dir, &["add", "README.md"]);
        git(dir, &["commit", "-m", "base"]);
    }

    #[test]
    fn capture_eval_writes_blocked_worktree_candidate() {
        let dir = TempDir::new().unwrap();
        init_repo(&dir);
        let ctx = ctx(&dir, true);
        let task = add_task(
            &ctx,
            "Fix the thing",
            Some("cargo test".to_string()),
            AddTaskOptions::default(),
        )
        .unwrap();
        fs::write(dir.path().join("README.md"), "changed\n").unwrap();

        let path = capture_eval_case_at(
            &ctx,
            &task,
            EvalOutcome::Blocked,
            Some("review failed"),
            "2026-06-22T12:00:00.000Z",
            Some("123"),
        )
        .unwrap()
        .unwrap();

        let text = fs::read_to_string(path).unwrap();
        assert!(text.contains(r#""outcome": "blocked""#));
        assert!(text.contains(r#""reason": "review failed""#));
        assert!(text.contains(r#""verify": "cargo test""#));
        assert!(text.contains("# git status"));
        assert!(text.contains("README.md"));
    }

    #[test]
    fn capture_eval_returns_none_when_disabled() {
        let dir = TempDir::new().unwrap();
        init_repo(&dir);
        let ctx = ctx(&dir, false);
        let task = add_task(&ctx, "No capture", None, AddTaskOptions::default()).unwrap();

        assert_eq!(
            capture_eval_case_at(
                &ctx,
                &task,
                EvalOutcome::Blocked,
                None,
                "2026-06-22T12:00:00.000Z",
                Some("123"),
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn capture_correction_writes_eval_and_lesson_candidate() {
        let dir = TempDir::new().unwrap();
        init_repo(&dir);
        let ctx = ctx(&dir, true);
        let task = add_task(&ctx, "Correct this", None, AddTaskOptions::default()).unwrap();
        write_artifact(&task, "diff.patch", "agent diff").unwrap();
        fs::write(dir.path().join("README.md"), "human fix\n").unwrap();

        let path = capture_correction_eval_at(
            &ctx,
            &task,
            "human note",
            "testing",
            "assert the right thing",
            "2026-06-22T12:00:00.000Z",
            "456",
        )
        .unwrap()
        .unwrap();

        let text = fs::read_to_string(path).unwrap();
        assert!(text.contains(r#""outcome": "corrected""#));
        assert!(text.contains(r#""agentAttempt": "agent diff""#));
        assert!(text.contains("human fix"));
        let candidates =
            fs::read_to_string(format!("{}/LESSONS.candidates.md", ctx.repo_state_dir)).unwrap();
        assert!(candidates.contains("[testing] assert the right thing"));
    }
}
