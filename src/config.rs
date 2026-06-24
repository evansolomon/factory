use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::git::{main_worktree_root, repo_root, GitError};

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("invalid JSON config\n\n  {path}: {message}")]
    InvalidJson { path: String, message: String },
    #[error("invalid config\n\n  {path}: expected a JSON object")]
    ExpectedObject { path: String },
    #[error("invalid .factory.json config\n\n{where_set}problems:\n{problems}")]
    InvalidShape { where_set: String, problems: String },
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Git(#[from] GitError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentCli {
    Codex,
    Claude,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentSpec {
    Bare(AgentCli),
    Detailed {
        cli: AgentCli,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Agent {
    pub cli: AgentCli,
    pub model: Option<String>,
    pub provider: Option<String>,
}

impl AgentSpec {
    fn validate(&self) -> Result<(), String> {
        let AgentSpec::Detailed {
            cli,
            model,
            provider,
        } = self
        else {
            return Ok(());
        };
        if provider.is_some() && *cli != AgentCli::Codex {
            return Err("provider is only supported for the codex cli".to_string());
        }
        if provider.is_some() && model.as_deref().unwrap_or_default().is_empty() {
            return Err("provider requires an explicit model".to_string());
        }
        Ok(())
    }

    fn normalized(&self) -> Agent {
        match self {
            AgentSpec::Bare(cli) => Agent {
                cli: cli.clone(),
                model: None,
                provider: None,
            },
            AgentSpec::Detailed {
                cli,
                model,
                provider,
            } => Agent {
                cli: cli.clone(),
                model: model.clone(),
                provider: provider.clone(),
            },
        }
    }
}

fn default_planners() -> Vec<AgentSpec> {
    vec![
        AgentSpec::Bare(AgentCli::Codex),
        AgentSpec::Bare(AgentCli::Claude),
    ]
}

fn default_implementer() -> AgentSpec {
    AgentSpec::Bare(AgentCli::Codex)
}

fn default_reviewer() -> AgentSpec {
    AgentSpec::Bare(AgentCli::Claude)
}

fn default_delivery() -> AgentSpec {
    AgentSpec::Bare(AgentCli::Claude)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentsConfig {
    #[serde(default = "default_planners")]
    pub planners: Vec<AgentSpec>,
    #[serde(default = "default_implementer")]
    pub implementer: AgentSpec,
    #[serde(default = "default_reviewer")]
    pub reviewer: AgentSpec,
    #[serde(default = "default_delivery")]
    pub delivery: AgentSpec,
}

impl Default for AgentsConfig {
    fn default() -> Self {
        Self {
            planners: default_planners(),
            implementer: default_implementer(),
            reviewer: default_reviewer(),
            delivery: default_delivery(),
        }
    }
}

fn default_ask_agent() -> AgentSpec {
    AgentSpec::Bare(AgentCli::Claude)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AskConfig {
    #[serde(default = "default_ask_agent")]
    pub agent: AgentSpec,
}

impl Default for AskConfig {
    fn default() -> Self {
        Self {
            agent: default_ask_agent(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OnComplete {
    Skill { skill: String },
    Policy { policy: String },
}

fn default_retries() -> u32 {
    10
}

fn default_true() -> bool {
    true
}

fn default_plans_dir() -> Option<String> {
    Some(".coding-agent-plans".to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub dir: Option<String>,
    #[serde(default = "default_retries")]
    pub retries: u32,
    #[serde(default = "default_true")]
    pub triage: bool,
    #[serde(default = "default_true")]
    pub security: bool,
    #[serde(default = "default_true")]
    pub ux: bool,
    #[serde(default = "default_plans_dir", rename = "plansDir")]
    pub plans_dir: Option<String>,
    #[serde(default = "default_true", rename = "captureEvals")]
    pub capture_evals: bool,
    #[serde(default = "default_true")]
    pub postmortem: bool,
    #[serde(default = "default_true")]
    pub remediate: bool,
    #[serde(default, rename = "onComplete")]
    pub on_complete: Option<OnComplete>,
    #[serde(default)]
    pub hooks: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub agents: AgentsConfig,
    #[serde(default)]
    pub ask: AskConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            dir: None,
            retries: default_retries(),
            triage: true,
            security: true,
            ux: true,
            plans_dir: default_plans_dir(),
            capture_evals: true,
            postmortem: true,
            remediate: true,
            on_complete: None,
            hooks: BTreeMap::new(),
            agents: AgentsConfig::default(),
            ask: AskConfig::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleAgents {
    pub planners: Vec<Agent>,
    pub implementer: Agent,
    pub reviewer: Agent,
    pub delivery: Agent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkContext {
    pub root: String,
    pub config: Config,
    pub state_dir: String,
    pub tasks_dir: String,
    pub plans_dir: Option<String>,
    pub agents: RoleAgents,
    pub ask_agent: Agent,
    pub repo_state_dir: String,
    pub metrics_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoContext {
    pub main_root: String,
    pub config: Config,
    pub backlog_dir: String,
    pub metrics_path: String,
    pub agents: RoleAgents,
}

pub fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix('~') {
        format!("{}{}", env::var("HOME").unwrap_or_default(), rest)
    } else {
        path.to_string()
    }
}

pub fn factory_home() -> String {
    env::var("FACTORY_HOME")
        .map(|value| expand_tilde(&value))
        .unwrap_or_else(|_| expand_tilde("~/.factory"))
}

pub fn global_config_file() -> String {
    format!("{}/config.json", factory_home())
}

pub fn auto_upgrade_state_file() -> String {
    format!("{}/auto-upgrade.json", factory_home())
}

fn ancestor_dirs(root: &str) -> Vec<String> {
    let mut dirs = Vec::new();
    let mut current = PathBuf::from(root);
    loop {
        dirs.push(current.to_string_lossy().to_string());
        if !current.pop() {
            break;
        }
    }
    dirs
}

fn config_candidates(root: &str) -> Vec<String> {
    let mut candidates = vec![global_config_file()];
    let mut ancestors = ancestor_dirs(root);
    ancestors.reverse();
    candidates.extend(
        ancestors
            .into_iter()
            .map(|dir| format!("{dir}/.factory.json")),
    );
    candidates
}

fn merge_hooks(
    base: Option<&Value>,
    incoming: BTreeMap<String, Vec<String>>,
) -> Result<Value, ConfigError> {
    let mut merged: BTreeMap<String, Vec<String>> = match base {
        Some(value) => {
            serde_json::from_value(value.clone()).map_err(|err| ConfigError::InvalidShape {
                where_set: String::new(),
                problems: format!("  hooks: {}", err),
            })?
        }
        None => BTreeMap::new(),
    };
    for (event, commands) in incoming {
        let existing = merged.entry(event).or_default();
        for command in commands {
            if !existing.contains(&command) {
                existing.push(command);
            }
        }
    }
    serde_json::to_value(merged).map_err(|err| ConfigError::InvalidShape {
        where_set: String::new(),
        problems: format!("  hooks: {}", err),
    })
}

pub fn config_sources(root: &str) -> Vec<String> {
    let mut found: Vec<String> = config_candidates(root)
        .into_iter()
        .filter(|path| Path::new(path).exists())
        .collect();
    found.reverse();
    found
}

pub fn load_config(root: &str) -> Result<Config, ConfigError> {
    let mut merged = Map::new();
    let mut sources = Vec::new();
    for path in config_candidates(root) {
        if !Path::new(&path).exists() {
            continue;
        }
        let text = fs::read_to_string(&path)?;
        let raw: Value = serde_json::from_str(&text).map_err(|err| ConfigError::InvalidJson {
            path: path.clone(),
            message: err.to_string(),
        })?;
        let Value::Object(object) = raw else {
            return Err(ConfigError::ExpectedObject { path });
        };

        let hooks = if let Some(value) = object.get("hooks") {
            Some(
                serde_json::from_value::<BTreeMap<String, Vec<String>>>(value.clone()).map_err(
                    |err| ConfigError::InvalidShape {
                        where_set: format!("set in:\n  {path}\n\n"),
                        problems: format!("  hooks: {}", err),
                    },
                )?,
            )
        } else {
            None
        };

        let prior_hooks = merged.get("hooks").cloned();
        merged.extend(object);
        if let Some(hooks) = hooks {
            merged.insert(
                "hooks".to_string(),
                merge_hooks(prior_hooks.as_ref(), hooks)?,
            );
        }
        sources.push(path);
    }

    let value = Value::Object(merged);
    let config: Config =
        serde_json::from_value(value).map_err(|err| ConfigError::InvalidShape {
            where_set: if sources.is_empty() {
                String::new()
            } else {
                format!(
                    "set in:\n{}\n\n",
                    sources
                        .iter()
                        .map(|source| format!("  {source}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                )
            },
            problems: format!("  (root): {err}"),
        })?;
    validate_config(&config, &sources)?;
    Ok(config)
}

fn validate_config(config: &Config, sources: &[String]) -> Result<(), ConfigError> {
    let mut problems = Vec::new();
    for (label, spec) in [
        ("agents.implementer", &config.agents.implementer),
        ("agents.reviewer", &config.agents.reviewer),
        ("agents.delivery", &config.agents.delivery),
        ("ask.agent", &config.ask.agent),
    ] {
        if let Err(message) = spec.validate() {
            problems.push(format!("  {label}: {message}"));
        }
    }
    for (idx, spec) in config.agents.planners.iter().enumerate() {
        if let Err(message) = spec.validate() {
            problems.push(format!("  agents.planners.{idx}: {message}"));
        }
    }
    if problems.is_empty() {
        return Ok(());
    }
    Err(ConfigError::InvalidShape {
        where_set: if sources.is_empty() {
            String::new()
        } else {
            format!(
                "set in:\n{}\n\n",
                sources
                    .iter()
                    .map(|source| format!("  {source}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        },
        problems: problems.join("\n"),
    })
}

fn resolve_agents(config: &Config) -> RoleAgents {
    RoleAgents {
        planners: config
            .agents
            .planners
            .iter()
            .map(AgentSpec::normalized)
            .collect(),
        implementer: config.agents.implementer.normalized(),
        reviewer: config.agents.reviewer.normalized(),
        delivery: config.agents.delivery.normalized(),
    }
}

pub fn worktree_key(root: &str) -> String {
    root.replace('/', "-").trim_start_matches('-').to_string()
}

pub fn resolve_state_dir(root: &str, config: &Config) -> String {
    if let Some(dir) = &config.dir {
        if dir.starts_with('/') || dir.starts_with('~') {
            return format!("{}/{}", expand_tilde(dir), worktree_key(root));
        }
        return format!("{root}/{dir}");
    }
    format!("{}/sessions/{}", factory_home(), worktree_key(root))
}

pub fn resolve_plans_dir(root: &str, config: &Config) -> Option<String> {
    let path = config.plans_dir.as_ref()?;
    if path.starts_with('/') || path.starts_with('~') {
        Some(expand_tilde(path))
    } else {
        Some(format!("{root}/{path}"))
    }
}

pub fn load_context(cwd: impl AsRef<Path>) -> Result<WorkContext, ConfigError> {
    let root = repo_root(cwd.as_ref())?;
    let config = load_config(&root)?;
    let state_dir = resolve_state_dir(&root, &config);
    let main_root = main_worktree_root(cwd)?;
    let main_config = if main_root == root {
        config.clone()
    } else {
        load_config(&main_root)?
    };
    let repo_state_dir = resolve_state_dir(&main_root, &main_config);
    Ok(WorkContext {
        root: root.clone(),
        config: config.clone(),
        state_dir: state_dir.clone(),
        tasks_dir: format!("{state_dir}/tasks"),
        plans_dir: resolve_plans_dir(&root, &config),
        agents: resolve_agents(&config),
        ask_agent: config.ask.agent.normalized(),
        repo_state_dir: repo_state_dir.clone(),
        metrics_path: format!("{repo_state_dir}/metrics.db"),
    })
}

pub fn load_repo_context(cwd: impl AsRef<Path>) -> Result<RepoContext, ConfigError> {
    let main_root = main_worktree_root(cwd)?;
    let config = load_config(&main_root)?;
    let state_dir = resolve_state_dir(&main_root, &config);
    Ok(RepoContext {
        main_root,
        config: config.clone(),
        backlog_dir: format!("{state_dir}/backlog"),
        metrics_path: format!("{state_dir}/metrics.db"),
        agents: resolve_agents(&config),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Mutex;

    use tempfile::TempDir;

    use super::*;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn write_json(path: impl AsRef<Path>, value: Value) {
        fs::write(
            path,
            format!("{}\n", serde_json::to_string_pretty(&value).unwrap()),
        )
        .unwrap();
    }

    fn with_home<T>(work: impl FnOnce(&Path) -> T) -> T {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous = env::var("FACTORY_HOME").ok();
        let home = TempDir::new().unwrap();
        env::set_var("FACTORY_HOME", home.path());
        let result = work(home.path());
        if let Some(previous) = previous {
            env::set_var("FACTORY_HOME", previous);
        } else {
            env::remove_var("FACTORY_HOME");
        }
        result
    }

    #[test]
    fn applies_precedence_with_concatenated_hooks() {
        with_home(|home| {
            let base = TempDir::new().unwrap();
            let root = base.path().join("repo");
            fs::create_dir_all(&root).unwrap();
            write_json(
                home.join("config.json"),
                serde_json::json!({
                    "retries": 1,
                    "hooks": { "stage.change": ["global-stage"], "attention": ["global-attention"] }
                }),
            );
            write_json(
                base.path().join(".factory.json"),
                serde_json::json!({
                    "retries": 2,
                    "security": false,
                    "hooks": { "stage.change": ["ancestor-stage"] }
                }),
            );
            write_json(
                root.join(".factory.json"),
                serde_json::json!({
                    "retries": 3,
                    "hooks": {
                        "stage.change": ["worktree-stage", "ancestor-stage"],
                        "task.done": ["worktree-done"]
                    }
                }),
            );

            let config = load_config(root.to_str().unwrap()).unwrap();
            assert_eq!(config.retries, 3);
            assert!(!config.security);
            assert_eq!(
                config.hooks.get("stage.change").unwrap(),
                &vec![
                    "global-stage".to_string(),
                    "ancestor-stage".to_string(),
                    "worktree-stage".to_string()
                ]
            );
            assert_eq!(
                config.hooks.get("attention").unwrap(),
                &vec!["global-attention".to_string()]
            );
            assert_eq!(
                config.hooks.get("task.done").unwrap(),
                &vec!["worktree-done".to_string()]
            );
        });
    }

    #[test]
    fn configures_ask_agent_separately() {
        with_home(|_| {
            let root = TempDir::new().unwrap();
            assert_eq!(
                load_config(root.path().to_str().unwrap())
                    .unwrap()
                    .ask
                    .agent,
                AgentSpec::Bare(AgentCli::Claude)
            );
            write_json(
                root.path().join(".factory.json"),
                serde_json::json!({
                    "agents": { "reviewer": "codex" },
                    "ask": { "agent": { "cli": "codex", "model": "gpt-5" } }
                }),
            );
            let config = load_config(root.path().to_str().unwrap()).unwrap();
            assert_eq!(config.agents.reviewer, AgentSpec::Bare(AgentCli::Codex));
            assert_eq!(
                config.ask.agent,
                AgentSpec::Detailed {
                    cli: AgentCli::Codex,
                    model: Some("gpt-5".to_string()),
                    provider: None,
                }
            );
        });
    }

    #[test]
    fn resolves_default_state_under_factory_home_sessions() {
        with_home(|home| {
            let root = "/tmp/example/repo";
            let config = Config::default();
            let key = worktree_key(root);
            assert_eq!(
                resolve_state_dir(root, &config),
                format!("{}/sessions/{key}", home.to_string_lossy())
            );
        });
    }
}
