use std::collections::BTreeMap;
use std::env;
use std::path::Path;

use serde::Deserialize;
use thiserror::Error;

use crate::exec::{run, RunOptions, RunResult};
use crate::version::resolve_factory_version;

pub const LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/evansolomon/factory/releases/latest";
pub const INSTALLER_URL: &str =
    "https://raw.githubusercontent.com/evansolomon/factory/master/install.sh";

#[derive(Debug, Error)]
pub enum UpgradeError {
    #[error("failed to fetch latest GitHub release: {0}")]
    LatestReleaseFetch(String),
    #[error("failed to fetch installer: {0}")]
    InstallerFetch(String),
    #[error("malformed GitHub release response: invalid JSON")]
    InvalidReleaseJson,
    #[error("malformed GitHub release response: invalid or missing tag_name")]
    InvalidReleaseShape,
    #[error("failed to run installer: {0}")]
    InstallerIo(#[from] std::io::Error),
    #[error("installer failed with exit code {code}: {output}")]
    InstallerFailedWithOutput { code: i32, output: String },
    #[error("installer failed with exit code {0}")]
    InstallerFailed(i32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatestRelease {
    pub tag_name: String,
    pub version: String,
}

#[derive(Debug, Deserialize)]
struct LatestReleaseBody {
    tag_name: String,
}

pub fn normalize_github_release_version(tag_name: &str) -> String {
    tag_name.strip_prefix('v').unwrap_or(tag_name).to_string()
}

pub fn should_install_latest(local_version: &str, latest_version: &str) -> bool {
    normalize_github_release_version(local_version)
        != normalize_github_release_version(latest_version)
}

pub fn parse_latest_release(body: &str) -> Result<LatestRelease, UpgradeError> {
    let parsed: LatestReleaseBody =
        serde_json::from_str(body).map_err(|_| UpgradeError::InvalidReleaseJson)?;
    if parsed.tag_name.is_empty() {
        return Err(UpgradeError::InvalidReleaseShape);
    }
    Ok(LatestRelease {
        version: normalize_github_release_version(&parsed.tag_name),
        tag_name: parsed.tag_name,
    })
}

pub fn fetch_latest_release() -> Result<LatestRelease, UpgradeError> {
    let response = get_text(
        LATEST_RELEASE_URL,
        "application/vnd.github+json",
        "latest GitHub release",
    )
    .map_err(UpgradeError::LatestReleaseFetch)?;
    parse_latest_release(&response)
}

pub fn resolve_current_factory_install_dir(exec_path: impl AsRef<Path>) -> Option<String> {
    let path = exec_path.as_ref();
    if path.file_name().and_then(|name| name.to_str()) != Some("factory") {
        return None;
    }
    path.parent()
        .map(|parent| parent.to_string_lossy().to_string())
}

pub fn build_installer_env(
    parent_env: &BTreeMap<String, String>,
    install_dir: Option<&str>,
) -> BTreeMap<String, String> {
    let mut env = parent_env.clone();
    if let Some(install_dir) = install_dir {
        env.insert("FACTORY_INSTALL_DIR".to_string(), install_dir.to_string());
    } else {
        env.remove("FACTORY_INSTALL_DIR");
    }
    env
}

pub fn run_latest_installer_script(
    installer: &str,
    cwd: &str,
    parent_env: &BTreeMap<String, String>,
    install_dir: Option<&str>,
) -> Result<String, UpgradeError> {
    let result = run(
        &["bash".to_string(), "-s".to_string()],
        &RunOptions {
            cwd: cwd.to_string(),
            stdin: Some(installer.to_string()),
            env: Some(build_installer_env(parent_env, install_dir)),
            ..RunOptions::default()
        },
    )?;
    installer_output(result)
}

pub fn run_latest_installer(install_dir: Option<&str>, cwd: &str) -> Result<String, UpgradeError> {
    let installer =
        get_text(INSTALLER_URL, "text/plain", "installer").map_err(UpgradeError::InstallerFetch)?;
    let parent_env = env::vars().collect::<BTreeMap<_, _>>();
    run_latest_installer_script(&installer, cwd, &parent_env, install_dir)
}

pub fn upgrade_factory(exec_path: &str, cwd: &str) -> Result<String, UpgradeError> {
    let current = resolve_factory_version();
    let latest = fetch_latest_release()?;
    if !should_install_latest(&current, &latest.version) {
        return Ok(format!("already on the latest version ({current})"));
    }
    let install_dir = resolve_current_factory_install_dir(exec_path);
    let mut lines = vec![format!("updating {current} -> {}", latest.version)];
    if let Some(install_dir) = &install_dir {
        lines.push(format!("installing to {install_dir}"));
    } else {
        lines.push(
            "could not detect an existing factory install; using the installer default".to_string(),
        );
    }
    let output = run_latest_installer(install_dir.as_deref(), cwd)?;
    if !output.is_empty() {
        lines.push(output);
    }
    lines.push(format!("factory upgraded to {}", latest.version));
    Ok(lines.join("\n"))
}

pub fn installer_output(result: RunResult) -> Result<String, UpgradeError> {
    let output = combined_output(&result);
    if result.code != 0 {
        return if output.is_empty() {
            Err(UpgradeError::InstallerFailed(result.code))
        } else {
            Err(UpgradeError::InstallerFailedWithOutput {
                code: result.code,
                output,
            })
        };
    }
    Ok(output)
}

pub fn combined_output(result: &RunResult) -> String {
    [result.stdout.trim(), result.stderr.trim()]
        .into_iter()
        .filter(|piece| !piece.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn get_text(url: &str, accept: &str, label: &str) -> Result<String, String> {
    let response = ureq::get(url)
        .set("Accept", accept)
        .set("User-Agent", "factory")
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, response) => {
                format!("HTTP {code} {}", response.status_text())
                    .trim()
                    .to_string()
            }
            ureq::Error::Transport(transport) => transport.to_string(),
        })?;
    response
        .into_string()
        .map_err(|err| format!("failed to read {label}: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_one_leading_lowercase_v() {
        assert_eq!(normalize_github_release_version("v0.1.0"), "0.1.0");
        assert_eq!(normalize_github_release_version("0.1.0"), "0.1.0");
        assert_eq!(normalize_github_release_version("V0.1.0"), "V0.1.0");
    }

    #[test]
    fn installs_only_when_normalized_versions_differ() {
        assert!(!should_install_latest("0.1.0", "v0.1.0"));
        assert!(!should_install_latest("v0.1.0", "0.1.0"));
        assert!(should_install_latest("0.2.0", "0.1.0"));
    }

    #[test]
    fn parses_latest_release_tag() {
        assert_eq!(
            parse_latest_release(r#"{"tag_name":"v0.1.0"}"#).unwrap(),
            LatestRelease {
                tag_name: "v0.1.0".to_string(),
                version: "0.1.0".to_string(),
            }
        );
    }

    #[test]
    fn rejects_malformed_latest_release() {
        assert!(matches!(
            parse_latest_release("{"),
            Err(UpgradeError::InvalidReleaseJson)
        ));
        assert!(matches!(
            parse_latest_release(r#"{"tag_name":123}"#),
            Err(UpgradeError::InvalidReleaseJson)
        ));
        assert!(matches!(
            parse_latest_release(r#"{}"#),
            Err(UpgradeError::InvalidReleaseJson)
        ));
        assert!(matches!(
            parse_latest_release(r#"{"tag_name":""}"#),
            Err(UpgradeError::InvalidReleaseShape)
        ));
    }

    #[test]
    fn resolves_install_dir_only_for_factory_binary() {
        assert_eq!(
            resolve_current_factory_install_dir("/Users/evan/.local/bin/factory"),
            Some("/Users/evan/.local/bin".to_string())
        );
        assert_eq!(
            resolve_current_factory_install_dir("/opt/homebrew/bin/bun"),
            None
        );
    }

    #[test]
    fn builds_installer_env_from_parent_env() {
        let mut parent = BTreeMap::new();
        parent.insert("PATH".to_string(), "/bin".to_string());
        parent.insert("HOME".to_string(), "/home/evan".to_string());

        let resolved = build_installer_env(&parent, Some("/factory/bin"));
        assert_eq!(resolved.get("PATH").map(String::as_str), Some("/bin"));
        assert_eq!(resolved.get("HOME").map(String::as_str), Some("/home/evan"));
        assert_eq!(
            resolved.get("FACTORY_INSTALL_DIR").map(String::as_str),
            Some("/factory/bin")
        );

        parent.insert(
            "FACTORY_INSTALL_DIR".to_string(),
            "/old/factory/bin".to_string(),
        );
        let unresolved = build_installer_env(&parent, None);
        assert_eq!(unresolved.get("PATH").map(String::as_str), Some("/bin"));
        assert!(!unresolved.contains_key("FACTORY_INSTALL_DIR"));
    }

    #[test]
    fn installer_failure_includes_captured_output() {
        let err = installer_output(RunResult {
            stdout: "installer stdout".to_string(),
            stderr: "installer stderr".to_string(),
            code: 12,
        })
        .unwrap_err();

        let message = err.to_string();
        assert!(message.contains("installer stdout"));
        assert!(message.contains("installer stderr"));
    }
}
