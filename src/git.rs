use std::path::Path;
use std::process::Command;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitError {
    #[error("not in a git repository - run factory from inside a repo")]
    NotARepo,
    #[error("git command failed: {0}")]
    CommandFailed(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

fn git_output(cwd: &Path, args: &[&str]) -> Result<String, GitError> {
    let output = Command::new("git").arg("-C").arg(cwd).args(args).output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return if args.first() == Some(&"rev-parse") || args.first() == Some(&"worktree") {
            Err(GitError::NotARepo)
        } else {
            Err(GitError::CommandFailed(stderr))
        };
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn repo_root(cwd: impl AsRef<Path>) -> Result<String, GitError> {
    git_output(cwd.as_ref(), &["rev-parse", "--show-toplevel"])
}

pub fn main_worktree_root(cwd: impl AsRef<Path>) -> Result<String, GitError> {
    let out = git_output(cwd.as_ref(), &["worktree", "list", "--porcelain"])?;
    if let Some(root) = out
        .lines()
        .find_map(|line| line.strip_prefix("worktree ").map(str::trim))
    {
        Ok(root.to_string())
    } else {
        repo_root(cwd)
    }
}

pub fn has_changes(root: impl AsRef<Path>) -> Result<bool, GitError> {
    Ok(!git_output(root.as_ref(), &["status", "--porcelain"])?.is_empty())
}

pub fn worktree_diff(root: impl AsRef<Path>) -> Result<String, GitError> {
    let status = git_output(root.as_ref(), &["status", "--porcelain"])?;
    let diff = git_output(root.as_ref(), &["diff", "HEAD"])?;
    Ok(format!("# git status\n{status}\n# git diff HEAD\n{diff}"))
}

pub fn commit_diff(root: impl AsRef<Path>, sha: &str) -> Result<String, GitError> {
    git_output(root.as_ref(), &["show", sha, "--format=", "--no-color"])
        .map(|out| out.trim().to_string())
}

pub fn commit_all(root: impl AsRef<Path>, message: &str) -> Result<(), GitError> {
    git_output(root.as_ref(), &["add", "-A"])?;
    git_output(root.as_ref(), &["commit", "-m", message])?;
    Ok(())
}

pub fn current_branch(root: impl AsRef<Path>) -> Result<String, GitError> {
    git_output(root.as_ref(), &["branch", "--show-current"])
}

pub fn head_sha(root: impl AsRef<Path>) -> Result<String, GitError> {
    git_output(root.as_ref(), &["rev-parse", "--short", "HEAD"])
}
