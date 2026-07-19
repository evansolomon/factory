---
name: release
description: Release a new Factory version end-to-end by prompting for a patch, minor, or major bump, validating and updating package.json, running release-specific checks, using the repository ship workflow to merge the release PR, following the exact master CI run, and verifying the GitHub Release and its assets. Use when the user invokes $release in Codex, /release in Claude Code, or asks to publish or release a new version of /Users/evan/code/factory.
---

# Release

## Overview

Treat `$release` in Codex or `/release` in Claude Code as permission to complete
the current Factory change, bump its version, validate it, ship its PR, and wait
until the corresponding GitHub Release is published and verified.

This permission covers the local edits, validation, git operations, GitHub PR and
auto-merge operations, and release monitoring in this workflow. It does not cover
force-pushing, deleting or replacing a tag or release, or including unrelated
worktree changes.

## Workflow

### 1. Establish the release basis

Inspect the worktree, fetch `origin/master` and tags, and read the version from
`package.json`. Compare it with `package.json` on `origin/master` and with the
latest GitHub Release. Use live repository and GitHub state, not remembered
versions.

If the version on `origin/master` has no complete matching GitHub Release,
diagnose that incomplete release before creating another version. Do not skip an
unpublished version silently.

Keep intended in-progress changes, but identify unrelated user edits and leave
them out. Do not release from a stale version baseline: if the branch and
`origin/master` disagree on the starting package version, reconcile the branch
safely before choosing the next version.

### 2. Choose and apply the version

Before editing, ask the user to choose a `patch`, `minor`, or `major` increment
and wait for the answer. Do not infer a default from the diff or release history.
If the user already supplied one of those choices in the release request, treat
it as the answer and do not ask again.

Apply the chosen increment to the version on `origin/master`. Accept only the
resulting stable numeric semantic version of the form `x.y.z`, require it to be
greater than the version on `origin/master`, and confirm that neither its
`v<version>` tag nor GitHub Release already exists.

Update only the `version` field in `package.json`. `src/version.ts` imports that
value, and the current lockfile does not duplicate it. If the intended worktree
diff already contains a version bump, validate and use it instead of incrementing
again.

Review the diff immediately after the edit. A release-only diff should contain
only the package version change.

### 3. Validate the release locally

Run the normal repository gate and the release build:

```bash
bun run fix
bun run test
bun run build:release
```

Derive the expected binaries from `.github/scripts/build-binaries.sh`; do not
duplicate that list in this skill. Confirm every expected file exists under
`dist/`, then execute the binary matching the current host with `--version` and
require the requested version exactly. `dist/` is ignored and must not be
committed.

Fix project-owned failures and rerun the failed check. Do not ship if the tests,
release build, or version smoke test is red.

### 4. Ship the release PR

Use `.skills/ship/SKILL.md` as the source of truth for completing the change,
inspecting and staging the intended diff, committing, pushing, opening or
updating the PR, and enabling auto-merge. Follow that workflow through its
auto-merge confirmation, then continue here instead of stopping.

For a release-only change, use `Release <version>` as the commit and PR title.
When releasing a substantive change, keep the title about that behavior and
mention the version bump in the PR summary. Add `bun run build:release` and the
host binary version smoke test to the PR's verification section.

### 5. Follow the exact merge and CI run

Wait for the PR to reach `MERGED` and record `mergeCommit.oid`. If it closes
without merging, stop. Find the `CI` workflow's `push` run on `master` whose
`headSha` exactly equals that merge commit; never assume the newest run belongs
to this release.

Watch that run through completion:

```bash
gh run watch <run-id> --exit-status
```

The run includes both the `Test` and `Build release binaries` jobs. If it fails,
inspect the failed job logs and the current release state. Retry only a proven
transient failure and never overwrite or delete a published release as a recovery
shortcut. A code failure after the version PR merged needs a deliberate recovery
plan because another unchanged-version push will not trigger publication.

### 6. Verify the published release

Inspect `v<version>` with `gh release view`. Require all of the following:

- the release exists and is neither draft nor prerelease;
- its target commit is the recorded PR merge commit;
- its assets are exactly the binaries currently produced by
  `.github/scripts/build-binaries.sh` plus `checksums.txt`;
- each asset is fully uploaded and has a non-empty digest;
- the host-compatible published binary prints the requested version.

Download the host-compatible asset into a temporary directory, mark it
executable, and run it with `--version`. Do not replace the user's installed
Factory binary as part of verification.

## Final report

Report the released version, PR URL, exact CI run URL, GitHub Release URL, and
the local and published-binary checks that passed. If publication is blocked,
report the failing job, commit SHA, current tag/release state, and the specific
recovery decision required.
