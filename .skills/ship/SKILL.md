---
name: ship
description: Ship the current factory repo change by using the local PR workflow and enabling GitHub auto-merge. Use when the user invokes $ship in Codex, /ship in Claude Code, or asks to ship/merge work in /Users/evan/code/factory; unlike $pr or /pr, this delegates merging to GitHub after checks pass.
---

# Ship

## Overview

Treat `$ship` in Codex or `/ship` in Claude Code as a deferred ship directive:
finish the current work, get a PR open, and enable GitHub auto-merge. `$ship` or
`/ship` is the higher-permission version of `$pr` or `/pr`.

Invocation is explicit permission for the local validation, git, GitHub CLI, and
auto-merge side effects in this workflow. Do not ship partial work or a red PR.

## Workflow

### 1. Complete the PR workflow through PR creation

Use `.skills/pr/SKILL.md` as the source of truth for finishing the change,
validating locally, committing, pushing, and opening or updating the PR.

Do not duplicate or reinterpret the PR workflow. Follow it through step 5
(`Push and open the PR`), then switch to the ship-specific auto-merge flow below.
If the PR workflow stops because validation fails or the branch state is unsafe,
stop there and report the blocker.

### 2. Enable auto-merge

After the PR workflow has produced an open PR, enable GitHub auto-merge using the
repo's observed convention. Prefer squash merge unless recent merged PRs show a
different convention:

```bash
gh pr merge --squash --auto
```

Do not pass `--delete-branch` unless the user asks for it.

If `gh pr merge --squash --auto` fails because auto-merge is unavailable for the
PR, stop and report the exact GitHub error. Do not fall back to a manual merge
unless the user explicitly asks for it.

### 3. Confirm auto-merge is enabled

After enabling auto-merge, confirm the PR state:

```bash
gh pr view --json autoMergeRequest,mergeStateStatus,state,url
```

If `autoMergeRequest` is present, stop. Do not poll checks; GitHub is now the
source of truth for merging after required checks pass. If the PR merged
immediately because all requirements were already satisfied, report that state.
If auto-merge is not present and the PR is still open, report the unexpected PR
state and do not manually merge.

The separate `Release` workflow runs after successful CI on `master`. Watch or
report it only when the user asked for release confirmation or the change directly
affects release behavior.

## Final report

End with the PR URL and a short status line, for example:

`https://github.com/evansolomon/factory/pull/123 has auto-merge enabled.`
