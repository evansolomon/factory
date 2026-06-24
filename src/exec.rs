use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunOptions {
    pub cwd: String,
    pub stdin: Option<String>,
    pub stream_to: Option<String>,
    pub env: Option<BTreeMap<String, String>>,
    pub timeout: Option<Duration>,
}

pub fn run(cmd: &[String], opts: &RunOptions) -> io::Result<RunResult> {
    if cmd.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "command cannot be empty",
        ));
    }
    let mut command = Command::new(&cmd[0]);
    command
        .args(&cmd[1..])
        .current_dir(&opts.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(env) = &opts.env {
        command.env_clear().envs(env);
    }

    let mut child = command.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        let input = opts.stdin.clone().unwrap_or_default();
        thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        });
    }

    let stdout = child.stdout.take().expect("stdout configured as piped");
    let stderr = child.stderr.take().expect("stderr configured as piped");
    let stream_to = opts.stream_to.clone();
    let stdout_thread = thread::spawn(move || read_stdout(stdout, stream_to));
    let stderr_thread = thread::spawn(move || read_stream(stderr));

    let status = if let Some(timeout) = opts.timeout {
        let start = Instant::now();
        loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if start.elapsed() >= timeout {
                child.kill().ok();
                break child.wait()?;
            }
            thread::sleep(Duration::from_millis(20));
        }
    } else {
        child.wait()?
    };

    let stdout = stdout_thread
        .join()
        .map_err(|_| io::Error::other("stdout reader thread panicked"))??;
    let stderr = stderr_thread
        .join()
        .map_err(|_| io::Error::other("stderr reader thread panicked"))??;
    Ok(RunResult {
        stdout,
        stderr,
        code: status.code().unwrap_or(1),
    })
}

fn read_stdout(mut reader: impl Read, stream_to: Option<String>) -> io::Result<String> {
    let mut out = Vec::new();
    let mut file = match stream_to {
        Some(path) => Some(File::create(Path::new(&path))?),
        None => None,
    };
    let mut buf = [0_u8; 8192];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        if let Some(file) = file.as_mut() {
            file.write_all(&buf[..n])?;
            file.flush()?;
        }
        out.extend_from_slice(&buf[..n]);
    }
    Ok(String::from_utf8_lossy(&out).to_string())
}

fn read_stream(mut reader: impl Read) -> io::Result<String> {
    let mut out = Vec::new();
    reader.read_to_end(&mut out)?;
    Ok(String::from_utf8_lossy(&out).to_string())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn runs_command_with_stdin_and_captures_output() {
        let dir = TempDir::new().unwrap();
        let result = run(
            &[
                "bash".to_string(),
                "-lc".to_string(),
                "cat; echo err >&2".to_string(),
            ],
            &RunOptions {
                cwd: dir.path().to_string_lossy().to_string(),
                stdin: Some("hello".to_string()),
                ..RunOptions::default()
            },
        )
        .unwrap();
        assert_eq!(result.code, 0);
        assert_eq!(result.stdout, "hello");
        assert_eq!(result.stderr, "err\n");
    }

    #[test]
    fn tees_stdout_to_file() {
        let dir = TempDir::new().unwrap();
        let stream = dir.path().join("activity.jsonl");
        let result = run(
            &[
                "bash".to_string(),
                "-lc".to_string(),
                "printf 'one\\ntwo\\n'".to_string(),
            ],
            &RunOptions {
                cwd: dir.path().to_string_lossy().to_string(),
                stream_to: Some(stream.to_string_lossy().to_string()),
                ..RunOptions::default()
            },
        )
        .unwrap();
        assert_eq!(result.stdout, "one\ntwo\n");
        assert_eq!(fs::read_to_string(stream).unwrap(), result.stdout);
    }
}
