use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{Map, Value};

use crate::exec::{run, RunOptions};

pub type Hooks = BTreeMap<String, Vec<String>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    TaskStart,
    StageChange,
    Attention,
    TaskNeedsInput,
    TaskBlocked,
    TaskRetrying,
    TaskDone,
    LoopIdle,
}

impl HookEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TaskStart => "task.start",
            Self::StageChange => "stage.change",
            Self::Attention => "attention",
            Self::TaskNeedsInput => "task.needs_input",
            Self::TaskBlocked => "task.blocked",
            Self::TaskRetrying => "task.retrying",
            Self::TaskDone => "task.done",
            Self::LoopIdle => "loop.idle",
        }
    }
}

const HOOK_TIMEOUT: Duration = Duration::from_secs(10);

pub fn flat_env(payload: &Map<String, Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (key, value) in payload {
        if value.is_null() {
            continue;
        }
        let value = value
            .as_str()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| value.to_string());
        out.insert(format!("FACTORY_{}", key.to_uppercase()), value);
    }
    out
}

pub fn emit(root: &str, hooks: &Hooks, event: HookEvent, payload: Map<String, Value>) {
    let Some(commands) = hooks.get(event.as_str()) else {
        return;
    };
    if commands.is_empty() {
        return;
    }

    let mut stdin = Map::new();
    stdin.insert(
        "event".to_string(),
        Value::String(event.as_str().to_string()),
    );
    stdin.extend(payload.clone());
    let stdin = Value::Object(stdin).to_string();

    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    env.insert("FACTORY_EVENT".to_string(), event.as_str().to_string());
    env.insert("FACTORY_ROOT".to_string(), root.to_string());
    env.extend(flat_env(&payload));

    for command in commands {
        match run(
            &["bash".to_string(), "-lc".to_string(), command.clone()],
            &RunOptions {
                cwd: root.to_string(),
                stdin: Some(stdin.clone()),
                env: Some(env.clone()),
                timeout: Some(HOOK_TIMEOUT),
                ..RunOptions::default()
            },
        ) {
            Ok(result) if result.code == 0 => {}
            Ok(result) => eprintln!(
                "warning: hook {} ({}) exited {}",
                event.as_str(),
                command,
                result.code
            ),
            Err(err) => eprintln!(
                "warning: hook {} ({}) failed: {}",
                event.as_str(),
                command,
                err
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn flat_env_skips_null_and_json_encodes_non_strings() {
        let mut payload = Map::new();
        payload.insert("stage".to_string(), Value::String("plan".to_string()));
        payload.insert("active".to_string(), Value::Bool(true));
        payload.insert("skip".to_string(), Value::Null);

        let env = flat_env(&payload);
        assert_eq!(env.get("FACTORY_STAGE"), Some(&"plan".to_string()));
        assert_eq!(env.get("FACTORY_ACTIVE"), Some(&"true".to_string()));
        assert!(!env.contains_key("FACTORY_SKIP"));
    }

    #[test]
    fn emit_delivers_stdin_and_env() {
        let dir = TempDir::new().unwrap();
        let out = dir.path().join("hook.out");
        let command = format!(
            "printf '%s\\n' \"$FACTORY_EVENT:$FACTORY_STAGE:$FACTORY_ACTIVE\" > {}; cat >> {}",
            out.display(),
            out.display()
        );
        let mut hooks = Hooks::new();
        hooks.insert("stage.change".to_string(), vec![command]);

        let mut payload = Map::new();
        payload.insert("stage".to_string(), json!("plan"));
        payload.insert("active".to_string(), json!(true));
        emit(
            dir.path().to_str().unwrap(),
            &hooks,
            HookEvent::StageChange,
            payload,
        );

        let text = fs::read_to_string(out).unwrap();
        assert!(text.contains("stage.change:plan:true"));
        assert!(text.contains(r#""event":"stage.change""#));
        assert!(text.contains(r#""stage":"plan""#));
        assert!(text.contains(r#""active":true"#));
    }
}
