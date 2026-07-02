import { $ } from 'bun'

// Thrown when a factory command runs outside a git repo. The CLI prints it
// cleanly instead of dumping a git shell-error stack trace.
export class NotARepoError extends Error {
  override readonly name = 'NotARepoError'
  constructor() {
    super('not in a git repository — run factory from inside a repo')
  }
}

// Worktree root for the directory we're invoked from. Each factory instance runs
// inside its own worktree, so this is the boundary for the queue and all git
// operations.
export async function repoRoot(cwd: string): Promise<string> {
  const res = await $`git -C ${cwd} rev-parse --show-toplevel`.nothrow().quiet()
  if (res.exitCode !== 0) {
    throw new NotARepoError()
  }
  return res.text().trim()
}

// Full working-tree diff (staged + unstaged + UNTRACKED) plus a porcelain status
// header. Untracked files are rendered as add-diffs via `git diff --no-index`:
// `git diff HEAD` alone omitted brand-new modules — usually the core of the
// change — so reviewers judged diffs whose main file was invisible.
export async function worktreeDiff(root: string): Promise<string> {
  const status = await $`git -C ${root} status --porcelain`.text()
  const diff = await $`git -C ${root} diff HEAD`.text()
  const untrackedOut = await $`git -C ${root} ls-files --others --exclude-standard`.text()
  const parts = [`# git status\n${status}\n# git diff HEAD\n${diff}`]
  for (const file of untrackedOut.split('\n').filter((f) => f.trim().length > 0)) {
    // --no-index exits 1 when files differ; nothrow treats that as data, not error.
    const fileDiff = await $`git -C ${root} diff --no-index -- /dev/null ${file}`.nothrow().text()
    parts.push(fileDiff)
  }
  return parts.join('\n')
}

export async function hasChanges(root: string): Promise<boolean> {
  const status = await $`git -C ${root} status --porcelain`.text()
  return status.trim().length > 0
}

export async function commitAll(root: string, message: string): Promise<void> {
  await $`git -C ${root} add -A`
  await $`git -C ${root} commit -m ${message}`.quiet()
}

export async function recentCommitSubjects(root: string, count: number = 30): Promise<string[]> {
  const out = await $`git -C ${root} log --no-merges -n ${count} --format=%s`.text()
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export type AuthorCommitSubjects = {
  identity: string
  subjects: string[]
}

function escapeGitAuthorPattern(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function authorIdentity(ident: string): string | null {
  const email = ident.match(/<([^>]+)>/)
  if (email?.[1]) {
    return email[1].trim()
  }
  const name = ident.replace(/\s+\d+\s+[+-]\d{4}\s*$/, '').trim()
  return name.length > 0 ? name : null
}

export async function recentAuthorCommitSubjects(
  root: string,
  count: number = 20
): Promise<AuthorCommitSubjects | null> {
  const ident = await $`git -C ${root} var GIT_AUTHOR_IDENT`.text()
  const identity = authorIdentity(ident)
  if (!identity) {
    return null
  }
  const pattern = escapeGitAuthorPattern(identity)
  const out =
    await $`git -C ${root} log --all --no-merges -n ${count} --format=%s --author=${pattern}`.text()
  const subjects = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return { identity, subjects }
}

// The origin remote's URL, or null when the repo has no origin (local-only
// repos). Used to derive a host-independent repo identity for repo-level state;
// callers fall back to a path-derived key when this is null.
export async function originUrl(cwd: string): Promise<string | null> {
  const res = await $`git -C ${cwd} remote get-url origin`.nothrow().quiet()
  if (res.exitCode !== 0) {
    return null
  }
  const url = res.text().trim()
  return url.length > 0 ? url : null
}

// The main worktree of the repo (the first entry of `git worktree list`) — the
// stable per-repo anchor for repo-level state like the backlog, shared across
// all of the repo's linked worktrees.
export async function mainWorktreeRoot(cwd: string): Promise<string> {
  const res = await $`git -C ${cwd} worktree list --porcelain`.nothrow().quiet()
  if (res.exitCode !== 0) {
    throw new NotARepoError()
  }
  const line = res
    .text()
    .split('\n')
    .find((l) => l.startsWith('worktree '))
  return line ? line.slice('worktree '.length).trim() : repoRoot(cwd)
}

export async function currentBranch(root: string): Promise<string> {
  // `branch --show-current` survives an unborn HEAD (a repo with no commits yet),
  // unlike `rev-parse --abbrev-ref HEAD` which errors there.
  const out = await $`git -C ${root} branch --show-current`.text()
  return out.trim()
}

export async function headSha(root: string): Promise<string> {
  const out = await $`git -C ${root} rev-parse --short HEAD`.text()
  return out.trim()
}

// The patch a single commit introduced (no message/metadata), for capturing the
// reference diff of a completed task into an eval candidate.
export async function commitDiff(root: string, sha: string): Promise<string> {
  const out = await $`git -C ${root} show ${sha} --format= --no-color`.nothrow().quiet().text()
  return out.trim()
}
