use std::fs;
use std::io;
use std::path::Path;

use crate::clock::now_iso;
use crate::config::WorkContext;

const CANDIDATES_HEADER: &str = "# Lesson candidates\n\nRaw signals from blocks and questions. Curate the recurring ones into\nLESSONS.md (which the planner reads every run); delete the noise.\n\n";

pub fn lessons_path(ctx: &WorkContext) -> String {
    format!("{}/LESSONS.md", ctx.repo_state_dir)
}

pub fn candidates_path(ctx: &WorkContext) -> String {
    format!("{}/LESSONS.candidates.md", ctx.repo_state_dir)
}

pub fn read_lessons(ctx: &WorkContext) -> io::Result<Option<String>> {
    read_optional_trimmed(lessons_path(ctx))
}

pub fn read_candidates(ctx: &WorkContext) -> io::Result<Option<String>> {
    read_optional_trimmed(candidates_path(ctx))
}

pub fn append_candidate(ctx: &WorkContext, signal: &str) {
    if let Err(err) = append_candidate_at(ctx, signal, &now_iso()) {
        eprintln!("lesson candidate capture failed: {err}");
    }
}

pub fn append_candidate_at(ctx: &WorkContext, signal: &str, timestamp: &str) -> io::Result<()> {
    let path = candidates_path(ctx);
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent)?;
    }
    let existing = fs::read_to_string(&path).unwrap_or_else(|_| CANDIDATES_HEADER.to_string());
    fs::write(path, format!("{existing}- {timestamp} - {signal}\n"))
}

fn read_optional_trimmed(path: impl AsRef<Path>) -> io::Result<Option<String>> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)?.trim().to_string();
    Ok((!text.is_empty()).then_some(text))
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use crate::config::{Agent, AgentCli, AgentsConfig, AskConfig, Config, RoleAgents};

    use super::*;

    fn ctx(dir: &TempDir) -> WorkContext {
        let root = dir.path().to_string_lossy().to_string();
        WorkContext {
            root: root.clone(),
            config: Config {
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

    #[test]
    fn reads_missing_and_empty_lessons_as_none() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);
        assert_eq!(read_lessons(&ctx).unwrap(), None);

        fs::create_dir_all(&ctx.repo_state_dir).unwrap();
        fs::write(lessons_path(&ctx), " \n").unwrap();
        assert_eq!(read_lessons(&ctx).unwrap(), None);
    }

    #[test]
    fn appends_candidates_with_header_and_timestamp() {
        let dir = TempDir::new().unwrap();
        let ctx = ctx(&dir);

        append_candidate_at(&ctx, "blocked on unclear scope", "2026-06-22T12:00:00.000Z").unwrap();
        append_candidate_at(
            &ctx,
            "asked for deployment target",
            "2026-06-22T12:01:00.000Z",
        )
        .unwrap();

        let text = read_candidates(&ctx).unwrap().unwrap();
        assert!(text.starts_with("# Lesson candidates"));
        assert!(text.contains("- 2026-06-22T12:00:00.000Z - blocked on unclear scope"));
        assert!(text.contains("- 2026-06-22T12:01:00.000Z - asked for deployment target"));
    }
}
