use std::fs;
use std::io;
use std::path::Path;
use std::process::{Command, Stdio};

pub fn open_editor(path: impl AsRef<Path>) -> io::Result<()> {
    let editor = std::env::var("AGENT_WORK_EDITOR")
        .or_else(|_| std::env::var("EDITOR"))
        .or_else(|_| std::env::var("VISUAL"))
        .unwrap_or_else(|_| "vi".to_string());
    let status = Command::new("sh")
        .arg("-c")
        .arg(format!("{editor} \"$1\""))
        .arg("sh")
        .arg(path.as_ref())
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "editor exited {}: {editor}",
            status.code().unwrap_or(1)
        )))
    }
}

pub fn compose_in_editor(seed: &str) -> io::Result<String> {
    let tmp = std::env::temp_dir().join(format!(
        "factory-edit-{}.md",
        ::time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    fs::write(
        &tmp,
        if seed.is_empty() {
            String::new()
        } else {
            format!("{seed}\n")
        },
    )?;
    let result = open_editor(&tmp).and_then(|()| fs::read_to_string(&tmp));
    fs::remove_file(&tmp).ok();
    result.map(|text| text.trim().to_string())
}
