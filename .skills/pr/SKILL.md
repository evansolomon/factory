---
name: pr
description: Finish the current factory repo change, run the repo validation gate, commit intentionally, push, open or update a GitHub PR with a concise diff-derived description, and wait for PR CI without merging. Use when the user invokes $pr in Codex, /pr in Claude Code, or asks to create a PR for work in /Users/evan/code/factory.
---

# PR

## Overview

Treat `$pr` in Codex or `/pr` in Claude Code as a deferred PR directive: finish
the current work first, then validate, commit, push, open or update a GitHub PR,
and wait for CI. Stop after CI passes. Do not merge.

Invocation is explicit permission for the local validation, git, and GitHub CLI
side effects in this workflow. It is not permission to ship to the default branch.

Do not commit partial work. If the requested behavior is not implemented, or if
the spec is still materially ambiguous, keep working or ask the one question needed
to avoid opening the wrong PR.

## Workflow

### 1. Finish the change

Complete the in-progress task before starting PR mechanics. Read the relevant
source and docs if needed; do not infer from memory alone.

If the user adds instructions after invoking `$pr` or `/pr`, include them in the
current change before moving on.

### 2. Validate locally

Run the factory repo's validation path:

```bash
bun run fix
bun run test
```

`bun run fix` handles Biome formatting and safe lint fixes. `bun run test` is the
gate and runs `biome check .`, `tsc --noEmit`, and `bun test`.

If dependencies changed or `node_modules` is missing, run:

```bash
bun install --frozen-lockfile
```

If validation fails, fix the failure and rerun the relevant command. If the failure
is clearly environmental or pre-existing, stop and explain the evidence rather than
pushing a known-red change.

### 3. Inspect the diff

Use git inspection commands to understand exactly what will go into the PR:

```bash
git status --short
git diff
git diff --cached
git branch --show-current
gh repo view --json defaultBranchRef
```

Stage files explicitly by path. Do not use `git add .` or `git add -A`.

If there are unrelated user edits, leave them unstaged. If your intended change
depends on those edits, explain the dependency before committing.

If currently on the default branch, create a short branch name derived from the
change before committing. Use the repo's existing branch style if visible.

### 4. Commit

Write one commit for one logical change. Split only when the diff contains separate
concerns that should be reviewed independently.

Commit message rules:

- Use imperative mood, verb first.
- Keep the subject short, ideally under 10 words.
- Do not use conventional-commit prefixes.
- Do not add a trailing period.
- Use a subsystem prefix only when it clarifies the change, such as
  `skills: split PR and ship workflows`.
- Do not add co-author trailers.

Pass the message without opening an editor:

```bash
git commit -m "$(cat <<'EOF'
skills: split PR and ship workflows
EOF
)"
```

### 5. Push and open the PR

Push the current branch:

```bash
git push -u origin HEAD
```

If the push is rejected because the remote has commits you do not have, stop and
ask before rebasing, merging, or force-pushing.

Check for an existing PR:

```bash
gh pr view --json number,url,state 2>/dev/null
```

If an open PR already exists, update it only if the existing title/body are stale
or misleading. If the existing PR is closed or merged, stop and ask.

If no open PR exists, create one. Base the title and body on the full diff against
the default branch, not just the last command output.

Use this PR body shape unless recent merged PRs in the repo clearly use another
style:

```markdown
## Summary
- Describe the behavior change, not the files mechanically touched.
- Mention the important design choice if review depends on it.

## Verification
- `bun run fix`
- `bun run test`
```

Keep the body concise but useful. A good PR description answers: what changed, why
this is the right shape, and how it was verified. Do not add generated-by trailers.

### 6. Wait for CI

The factory repo's PR CI is `.github/workflows/ci.yml`, job `Test`, running
`bun run test` on pull requests to `master`.

Watch checks:

```bash
gh pr checks --watch --fail-fast
```

If checks have not attached yet, wait briefly and retry. If a check fails, inspect
the failed run logs, fix the root cause, rerun local validation, commit the fix,
push, and watch CI again. Do not rerun CI blindly.

Stop after CI passes. Do not merge unless the user invoked `$ship` or separately
asked to merge.

## Final report

End with the PR URL and a short status line, for example:

`https://github.com/evansolomon/factory/pull/123 is open with CI passing.`
