use std::fs;
use std::io;
use std::path::Path;
use std::thread;
use std::time::Duration;

use serde::Deserialize;

use crate::config::{Agent, AgentCli};
use crate::exec::{run, RunOptions, RunResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AgentResult {
    pub text: String,
    pub usage: Usage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Research,
    Write,
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRun {
    pub root: String,
    pub prompt: String,
    pub access: Access,
    pub out_file: Option<String>,
}

const ZERO_USAGE: Usage = Usage {
    input_tokens: 0,
    output_tokens: 0,
};

pub fn agent_label(agent: &Agent) -> String {
    agent
        .model
        .as_ref()
        .map(|model| format!("{}:{model}", agent_cli_name(&agent.cli)))
        .unwrap_or_else(|| agent_cli_name(&agent.cli).to_string())
}

fn agent_cli_name(cli: &AgentCli) -> &'static str {
    match cli {
        AgentCli::Codex => "codex",
        AgentCli::Claude => "claude",
    }
}

pub fn activity_path(out_file: &str) -> String {
    out_file
        .strip_suffix(".md")
        .map(|base| format!("{base}.activity.jsonl"))
        .unwrap_or_else(|| format!("{out_file}.activity.jsonl"))
}

fn run_with_retry(label: &str, cmd: &[String], opts: &RunOptions) -> io::Result<RunResult> {
    let retry_delays = [Duration::from_millis(3000), Duration::from_millis(8000)];
    let mut result = run(cmd, opts)?;
    for (attempt, delay) in retry_delays.iter().enumerate() {
        if result.code == 0 {
            return Ok(result);
        }
        eprintln!(
            "{label}: exited {}; retrying in {}s ({}/{})",
            result.code,
            delay.as_secs(),
            attempt + 1,
            retry_delays.len()
        );
        thread::sleep(*delay);
        result = run(cmd, opts)?;
    }
    Ok(result)
}

#[derive(Debug, Deserialize)]
struct CodexTurn {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    usage: CodexUsage,
}

#[derive(Debug, Default, Deserialize)]
struct CodexUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
}

pub fn parse_codex_usage(stdout: &str) -> Usage {
    let mut usage = ZERO_USAGE;
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(turn) = serde_json::from_str::<CodexTurn>(line) else {
            continue;
        };
        if turn.kind == "turn.completed" {
            usage = Usage {
                input_tokens: turn.usage.input_tokens,
                output_tokens: turn.usage.output_tokens,
            };
        }
    }
    usage
}

#[derive(Debug, Deserialize)]
struct ClaudeResultEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    result: String,
    #[serde(default)]
    usage: ClaudeUsage,
}

#[derive(Debug, Default, Deserialize)]
struct ClaudeUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

pub fn parse_claude_stream(stdout: &str) -> AgentResult {
    let mut out = None;
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(event) = serde_json::from_str::<ClaudeResultEvent>(line) else {
            continue;
        };
        if event.kind == "result" {
            out = Some(AgentResult {
                text: event.result.trim().to_string(),
                usage: Usage {
                    input_tokens: event.usage.input_tokens
                        + event.usage.cache_read_input_tokens
                        + event.usage.cache_creation_input_tokens,
                    output_tokens: event.usage.output_tokens,
                },
            });
        }
    }
    out.unwrap_or_else(|| AgentResult {
        text: stdout.trim().to_string(),
        usage: ZERO_USAGE,
    })
}

fn codex_sandbox(access: Access) -> &'static str {
    match access {
        Access::Read => "read-only",
        Access::Research | Access::Write => "workspace-write",
        Access::Full => "danger-full-access",
    }
}

pub fn codex_command(agent: &Agent, opts: &AgentRun, out_file: &str) -> Vec<String> {
    let mut cmd = vec![
        "codex".to_string(),
        "exec".to_string(),
        "-C".to_string(),
        opts.root.clone(),
        "-s".to_string(),
        codex_sandbox(opts.access).to_string(),
        "-c".to_string(),
        "approval_policy=\"never\"".to_string(),
    ];
    if opts.access == Access::Research {
        cmd.extend([
            "-c".to_string(),
            "sandbox_workspace_write.network_access=true".to_string(),
        ]);
    }
    if let Some(provider) = &agent.provider {
        cmd.extend(["-c".to_string(), format!("model_provider=\"{provider}\"")]);
    }
    cmd.push("--json".to_string());
    if let Some(model) = &agent.model {
        cmd.extend(["-m".to_string(), model.clone()]);
    }
    cmd.extend(["-o".to_string(), out_file.to_string(), "-".to_string()]);
    cmd
}

pub fn claude_command(agent: &Agent, opts: &AgentRun) -> Vec<String> {
    let mut cmd = vec![
        "claude".to_string(),
        "-p".to_string(),
        "--add-dir".to_string(),
        opts.root.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
    ];
    if let Some(model) = &agent.model {
        cmd.extend(["--model".to_string(), model.clone()]);
    }
    if matches!(opts.access, Access::Read | Access::Research) {
        cmd.extend([
            "--disallowedTools".to_string(),
            "Edit".to_string(),
            "Write".to_string(),
            "NotebookEdit".to_string(),
        ]);
    }
    cmd
}

pub fn run_agent(agent: &Agent, opts: &AgentRun) -> io::Result<AgentResult> {
    match agent.cli {
        AgentCli::Codex => run_codex(agent, opts),
        AgentCli::Claude => run_claude(agent, opts),
    }
}

fn run_codex(agent: &Agent, opts: &AgentRun) -> io::Result<AgentResult> {
    let temp_out;
    let out = if let Some(out_file) = &opts.out_file {
        out_file.as_str()
    } else {
        temp_out = format!(
            "{}/factory-codex-{}.md",
            std::env::temp_dir().to_string_lossy(),
            ::time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        );
        temp_out.as_str()
    };
    let cmd = codex_command(agent, opts, out);
    let result = run_with_retry(
        &agent_label(agent),
        &cmd,
        &RunOptions {
            cwd: opts.root.clone(),
            stdin: Some(opts.prompt.clone()),
            stream_to: opts.out_file.as_ref().map(|path| activity_path(path)),
            ..RunOptions::default()
        },
    )?;
    if result.code != 0 {
        return Err(io::Error::other(
            format!(
                "codex exec failed (exit {}): {}",
                result.code,
                if result.stderr.is_empty() {
                    result.stdout
                } else {
                    result.stderr
                }
            )
            .trim()
            .to_string(),
        ));
    }
    let text = fs::read_to_string(out)
        .unwrap_or_default()
        .trim()
        .to_string();
    if opts.out_file.is_none() {
        fs::remove_file(out).ok();
    }
    Ok(AgentResult {
        text,
        usage: parse_codex_usage(&result.stdout),
    })
}

fn run_claude(agent: &Agent, opts: &AgentRun) -> io::Result<AgentResult> {
    let cmd = claude_command(agent, opts);
    let result = run_with_retry(
        &agent_label(agent),
        &cmd,
        &RunOptions {
            cwd: opts.root.clone(),
            stdin: Some(opts.prompt.clone()),
            stream_to: opts.out_file.as_ref().map(|path| activity_path(path)),
            ..RunOptions::default()
        },
    )?;
    if result.code != 0 {
        return Err(io::Error::other(
            format!(
                "claude failed (exit {}): {}",
                result.code,
                if result.stderr.is_empty() {
                    result.stdout
                } else {
                    result.stderr
                }
            )
            .trim()
            .to_string(),
        ));
    }
    let parsed = parse_claude_stream(&result.stdout);
    if let Some(out_file) = &opts.out_file {
        fs::write(Path::new(out_file), &parsed.text)?;
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use crate::config::{Agent, AgentCli};

    use super::*;

    #[test]
    fn parses_codex_usage_from_last_turn_completed_event() {
        let stdout = r#"{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}
{"type":"other"}
{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}"#;
        assert_eq!(
            parse_codex_usage(stdout),
            Usage {
                input_tokens: 3,
                output_tokens: 4
            }
        );
    }

    #[test]
    fn parses_claude_result_usage_including_cache_tokens() {
        let stdout = r#"{"type":"system"}
{"type":"result","result":" done\n","usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}}"#;
        assert_eq!(
            parse_claude_stream(stdout),
            AgentResult {
                text: "done".to_string(),
                usage: Usage {
                    input_tokens: 8,
                    output_tokens: 2
                }
            }
        );
    }

    #[test]
    fn claude_stream_falls_back_to_raw_text_without_result() {
        assert_eq!(
            parse_claude_stream("plain text"),
            AgentResult {
                text: "plain text".to_string(),
                usage: ZERO_USAGE
            }
        );
    }

    #[test]
    fn builds_codex_command_for_research_access() {
        let agent = Agent {
            cli: AgentCli::Codex,
            model: Some("gpt-5".to_string()),
            provider: Some("xai".to_string()),
        };
        let opts = AgentRun {
            root: "/repo".to_string(),
            prompt: "prompt".to_string(),
            access: Access::Research,
            out_file: None,
        };
        let cmd = codex_command(&agent, &opts, "/tmp/out.md");
        assert!(cmd.contains(&"workspace-write".to_string()));
        assert!(cmd.contains(&"sandbox_workspace_write.network_access=true".to_string()));
        assert!(cmd.contains(&"model_provider=\"xai\"".to_string()));
        assert!(cmd.contains(&"gpt-5".to_string()));
    }

    #[test]
    fn builds_claude_read_command_with_edit_tools_disallowed() {
        let agent = Agent {
            cli: AgentCli::Claude,
            model: None,
            provider: None,
        };
        let opts = AgentRun {
            root: "/repo".to_string(),
            prompt: "prompt".to_string(),
            access: Access::Read,
            out_file: None,
        };
        let cmd = claude_command(&agent, &opts);
        assert_eq!(
            &cmd[..5],
            ["claude", "-p", "--add-dir", "/repo", "--output-format"]
        );
        assert!(cmd.contains(&"--disallowedTools".to_string()));
        assert!(cmd.contains(&"Edit".to_string()));
        assert!(cmd.contains(&"Write".to_string()));
        assert!(cmd.contains(&"NotebookEdit".to_string()));
    }
}
