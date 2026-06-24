use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use time::{OffsetDateTime, UtcOffset};

use crate::config::auto_upgrade_state_file;
use crate::upgrade::{resolve_current_factory_install_dir, should_install_latest};
use crate::version::resolve_factory_version;

pub const AUTO_UPGRADE_CHECK_INTERVAL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub const AUTO_UPGRADE_CHECK_TIMEOUT: Duration = Duration::from_millis(2000);

const AUTO_UPGRADE_COMMANDS: &[&str] = &[
    "add", "backlog", "run", "answer", "feedback", "resume", "correct", "status", "ask", "session",
    "codex", "claude", "config", "show", "lessons", "report",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpgradeState {
    pub last_checked_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoUpgradeResult {
    Continue,
    Exit { code: i32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoUpgradeDecisionInput {
    pub command: String,
    pub env: BTreeMap<String, String>,
    pub exec_path: String,
    pub current_version: String,
    pub stdin_is_tty: bool,
    pub stdout_is_tty: bool,
    pub state: Option<AutoUpgradeState>,
    pub now: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoUpgradeCheckDecision {
    Skip,
    Check,
}

impl AutoUpgradeDecisionInput {
    pub fn from_runtime(
        command: impl Into<String>,
        env: BTreeMap<String, String>,
        exec_path: impl Into<String>,
        stdin_is_tty: bool,
        stdout_is_tty: bool,
        state: Option<AutoUpgradeState>,
        now: OffsetDateTime,
    ) -> Self {
        Self {
            command: command.into(),
            env,
            exec_path: exec_path.into(),
            current_version: resolve_factory_version(),
            stdin_is_tty,
            stdout_is_tty,
            state,
            now,
        }
    }
}

pub fn is_auto_upgrade_command(command: &str) -> bool {
    AUTO_UPGRADE_COMMANDS.contains(&command)
}

pub fn is_dev_factory_version(version: &str) -> bool {
    version.contains("-dev.")
}

pub fn is_affirmative_auto_upgrade_answer(answer: &str) -> bool {
    matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

pub fn should_run_auto_upgrade_check(
    state: Option<&AutoUpgradeState>,
    now: OffsetDateTime,
) -> bool {
    let Some(state) = state else {
        return true;
    };
    let Ok(last_checked_at) = OffsetDateTime::parse(&state.last_checked_at, &Rfc3339) else {
        return true;
    };
    let Ok(elapsed): Result<Duration, _> = (now - last_checked_at).try_into() else {
        return false;
    };
    elapsed >= AUTO_UPGRADE_CHECK_INTERVAL
}

pub fn decide_auto_upgrade_check(input: &AutoUpgradeDecisionInput) -> AutoUpgradeCheckDecision {
    if input.env.contains_key("FACTORY_DISABLE_AUTO_UPGRADE")
        || !is_auto_upgrade_command(&input.command)
        || !input.stdin_is_tty
        || !input.stdout_is_tty
        || resolve_current_factory_install_dir(&input.exec_path).is_none()
        || is_dev_factory_version(&input.current_version)
        || !should_run_auto_upgrade_check(input.state.as_ref(), input.now)
    {
        AutoUpgradeCheckDecision::Skip
    } else {
        AutoUpgradeCheckDecision::Check
    }
}

pub fn should_prompt_for_auto_upgrade(current_version: &str, latest_version: &str) -> bool {
    should_install_latest(current_version, latest_version)
}

pub fn read_auto_upgrade_state(file: impl AsRef<Path>) -> Option<AutoUpgradeState> {
    let text = fs::read_to_string(file).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn write_auto_upgrade_state(
    file: impl AsRef<Path>,
    now: OffsetDateTime,
) -> std::io::Result<()> {
    let file = file.as_ref();
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let state = AutoUpgradeState {
        last_checked_at: format_js_iso(now),
    };
    fs::write(
        file,
        format!("{}\n", serde_json::to_string_pretty(&state).unwrap()),
    )
}

pub fn default_auto_upgrade_state_file() -> String {
    auto_upgrade_state_file()
}

pub fn strip_control_chars(value: &str) -> String {
    value
        .chars()
        .filter(|ch| {
            let code = *ch as u32;
            !((code <= 31) || (127..=159).contains(&code))
        })
        .collect()
}

pub fn auto_upgrade_prompt(current_version: &str, latest_version: &str) -> String {
    format!(
        "a newer factory is available: {} -> {}\nupgrade now? [y/N] ",
        strip_control_chars(current_version),
        strip_control_chars(latest_version)
    )
}

fn format_js_iso(now: OffsetDateTime) -> String {
    now.to_offset(UtcOffset::UTC)
        .format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;
    use time::macros::datetime;

    use super::*;

    fn base_input(state: Option<AutoUpgradeState>) -> AutoUpgradeDecisionInput {
        AutoUpgradeDecisionInput {
            command: "status".to_string(),
            env: BTreeMap::new(),
            exec_path: "/usr/local/bin/factory".to_string(),
            current_version: "0.1.0".to_string(),
            stdin_is_tty: true,
            stdout_is_tty: true,
            state,
            now: datetime!(2026-06-22 12:00 UTC),
        }
    }

    #[test]
    fn uses_explicit_normal_command_allow_list() {
        for command in AUTO_UPGRADE_COMMANDS {
            assert!(is_auto_upgrade_command(command));
        }

        for command in [
            "",
            "help",
            "-h",
            "--help",
            "version",
            "--version",
            "upgrade",
            "wat",
        ] {
            assert!(!is_auto_upgrade_command(command));
        }
    }

    #[test]
    fn missing_recent_old_and_malformed_state_decisions() {
        let now = datetime!(2026-06-22 12:00 UTC);
        let recent = AutoUpgradeState {
            last_checked_at: "2026-06-22T11:59:59.000Z".to_string(),
        };
        let old = AutoUpgradeState {
            last_checked_at: "2026-06-15T11:59:59.999Z".to_string(),
        };
        let malformed = AutoUpgradeState {
            last_checked_at: "not-a-date".to_string(),
        };

        assert!(should_run_auto_upgrade_check(None, now));
        assert!(!should_run_auto_upgrade_check(Some(&recent), now));
        assert!(should_run_auto_upgrade_check(Some(&old), now));
        assert!(should_run_auto_upgrade_check(Some(&malformed), now));
    }

    #[test]
    fn eligibility_skips_without_side_effect_prerequisites() {
        let mut disabled = base_input(None);
        disabled
            .env
            .insert("FACTORY_DISABLE_AUTO_UPGRADE".to_string(), "1".to_string());
        assert_eq!(
            decide_auto_upgrade_check(&disabled),
            AutoUpgradeCheckDecision::Skip
        );

        let mut source = base_input(None);
        source.exec_path = "/opt/homebrew/bin/bun".to_string();
        assert_eq!(
            decide_auto_upgrade_check(&source),
            AutoUpgradeCheckDecision::Skip
        );

        let mut dev = base_input(None);
        dev.current_version = "0.1.0-dev.20260622010101".to_string();
        assert!(is_dev_factory_version(&dev.current_version));
        assert_eq!(
            decide_auto_upgrade_check(&dev),
            AutoUpgradeCheckDecision::Skip
        );

        let mut no_tty = base_input(None);
        no_tty.stdin_is_tty = false;
        assert_eq!(
            decide_auto_upgrade_check(&no_tty),
            AutoUpgradeCheckDecision::Skip
        );
    }

    #[test]
    fn eligibility_checks_for_installed_current_normal_command() {
        assert_eq!(
            decide_auto_upgrade_check(&base_input(None)),
            AutoUpgradeCheckDecision::Check
        );

        let mut recent = base_input(Some(AutoUpgradeState {
            last_checked_at: "2026-06-22T11:59:59.000Z".to_string(),
        }));
        assert_eq!(
            decide_auto_upgrade_check(&recent),
            AutoUpgradeCheckDecision::Skip
        );
        recent.command = "version".to_string();
        assert_eq!(
            decide_auto_upgrade_check(&recent),
            AutoUpgradeCheckDecision::Skip
        );
    }

    #[test]
    fn state_reader_treats_malformed_as_missing_and_writer_creates_parent() {
        let dir = TempDir::new().unwrap();
        let malformed = dir.path().join("malformed.json");
        fs::write(&malformed, "{").unwrap();
        assert_eq!(read_auto_upgrade_state(&malformed), None);

        let file = dir.path().join("nested/auto-upgrade.json");
        let now = datetime!(2026-06-22 12:00 UTC);
        write_auto_upgrade_state(&file, now).unwrap();
        assert_eq!(
            read_auto_upgrade_state(&file),
            Some(AutoUpgradeState {
                last_checked_at: "2026-06-22T12:00:00.000Z".to_string(),
            })
        );
    }

    #[test]
    fn prompt_strips_control_characters_and_accepts_only_yes() {
        let prompt = auto_upgrade_prompt("0.1.0\rbad", "0.1.1\u{1b}[2K");

        assert!(!prompt.contains('\r'));
        assert!(!prompt.contains('\u{1b}'));
        assert!(prompt.contains("0.1.0bad -> 0.1.1[2K"));

        for answer in ["y", "Y", " yes ", "YES"] {
            assert!(is_affirmative_auto_upgrade_answer(answer));
        }
        for answer in ["", "n", "no", "yeah", "sure"] {
            assert!(!is_affirmative_auto_upgrade_answer(answer));
        }
    }
}
