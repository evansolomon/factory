use std::process::Command;

use tempfile::TempDir;

fn git(root: &std::path::Path, args: &[&str]) {
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

#[test]
fn run_once_idle_queue_emits_attention_and_clears_stage() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().join("repo");
    std::fs::create_dir(&root).unwrap();
    git(&root, &["init"]);
    git(&root, &["config", "user.email", "factory@example.test"]);
    git(&root, &["config", "user.name", "Factory Test"]);
    std::fs::write(root.join("README.md"), "initial\n").unwrap();
    git(&root, &["add", "README.md"]);
    git(&root, &["commit", "-m", "initial"]);

    let hook_log = root.join("hook.log");
    std::fs::write(
        root.join(".factory.json"),
        format!(
            r#"{{
  "dir": ".factory-state",
  "hooks": {{
    "attention": ["printf 'attention:%s\n' \"$FACTORY_STATE\" >> '{hook_log}'"],
    "stage.change": ["printf 'stage:%s:%s\n' \"$FACTORY_STAGE\" \"$FACTORY_ACTIVE\" >> '{hook_log}'"]
  }}
}}
"#,
            hook_log = hook_log.display()
        ),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_factory"))
        .arg("run")
        .arg("--once")
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "factory failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let log = std::fs::read_to_string(hook_log).unwrap();
    assert!(log.contains("attention:none"));
    assert!(log.contains("stage::false"));
}
