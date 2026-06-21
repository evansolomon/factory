---
name: ship
description: Ship the current factory repo change by using the local PR workflow, waiting for CI, then merging the GitHub PR. Use when the user invokes $ship in Codex, /ship in Claude Code, or asks to ship/merge work in /Users/evan/code/factory; unlike $pr or /pr, this includes merging after CI passes.
---

# Ship

## Overview

Treat `$ship` in Codex or `/ship` in Claude Code as a deferred ship directive:
finish the current work, get a PR open with passing CI, then merge it. `$ship` or
`/ship` is the higher-permission version of `$pr` or `/pr`.

Invocation is explicit permission for the local validation, git, GitHub CLI, and
merge side effects in this workflow. Do not merge partial work or a red PR.

## Workflow

### 1. Complete the PR workflow

Use `.skills/pr/SKILL.md` as the source of truth for finishing the change,
validating locally, committing, pushing, opening or updating the PR, and waiting
for CI.

Do not duplicate or reinterpret the PR workflow. If the PR workflow stops because
validation fails, CI fails, or the branch state is unsafe, stop there and report
the blocker.

### 2. Merge after CI passes

After the PR workflow has produced an open PR with passing CI, merge using the
repo's observed convention. Prefer squash merge unless recent merged PRs show a
different convention:

```bash
gh pr merge --squash
```

Do not pass `--delete-branch` unless the user asks for it.

The separate `Release` workflow runs after successful CI on `master`. Watch or
report it only when the user asked for release confirmation or the change directly
affects release behavior.

## Final report

End with the PR URL and a short status line, for example:

`https://github.com/evansolomon/factory/pull/123 merged after CI passed.`
