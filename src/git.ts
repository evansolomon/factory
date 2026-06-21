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

// Full working-tree diff (staged + unstaged) plus a porcelain status header so
// the adversarial reviewer sees new/deleted files, not just hunks.
export async function worktreeDiff(root: string): Promise<string> {
  const status = await $`git -C ${root} status --porcelain`.text()
  const diff = await $`git -C ${root} diff HEAD`.text()
  return `# git status\n${status}\n# git diff HEAD\n${diff}`
}

export async function hasChanges(root: string): Promise<boolean> {
  const status = await $`git -C ${root} status --porcelain`.text()
  return status.trim().length > 0
}

export async function commitAll(root: string, message: string): Promise<void> {
  await $`git -C ${root} add -A`
  await $`git -C ${root} commit -m ${message}`.quiet()
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
