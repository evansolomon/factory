# ## Problem

# Plan: Weekly Automatic Upgrade Prompt

## Goal

Add a low-annoyance automatic upgrade check that runs before eligible interactive commands, at most once every 7 days. If a newer GitHub Release exists, prompt the user. Accepting runs the existing in-place upgrade flow and exits with its result; declining continues the original command and suppresses checks for 7 days.

Manual `factory upgrade` remains unchanged and is not affected by `FACTORY_DISABLE_AUTO_UPGRADE`.

## Design

Add a new import-safe module, `src/auto-upgrade.ts`, containing all automatic upgrade policy, state handling, prompt logic, and orchestration. Wire it into `src/cli.ts` after existing early exits for help, version, and explicit `upgrade`, but before normal command behavior.

The automatic path is best-effort and silent unless a prompt is shown. No-update, recent-state, ineligible, network failure, release lookup failure, malformed state, and timeout paths continue the original command without output.

## Core Decisions

- Use one global state file: `$FACTORY_HOME/auto-upgrade.json`, or `~/.factory/auto-upgrade.json`.
- State shape: `{ "lastCheckedAt": "<ISO timestamp>" }`.
- Validate state with zod; malformed or unreadable state is treated as stale.
- Record the weekly suppression state once, immediately after deciding a check is due and before the network call. This makes no-update, failure, prompt-shown, decline, accept, and abandoned prompts all suppress future checks for 7 days.
- Bound the automatic GitHub release check with a short timeout, around 2 seconds.
- Only explicit `y` or `yes`, case-insensitive and trimmed, accepts the upgrade.
- Any other answer declines and continues the original command.
- Accepted upgrades call the existing `upgradeFactory()` and return its exit code. The original command does not continue.
- After a successful accepted auto-upgrade, print a terse hint to rerun the original command.
- Do not add a lock file for exact cross-process suppression. Simultaneous interactive commands may race; that is acceptable best-effort behavior.
- Keep `factory run` eligible. The re-run hint handles the fact that the original command intentionally does not continue.

## Eligibility

Auto-upgrade must be skipped when any of these are true:

- `FACTORY_DISABLE_AUTO_UPGRADE` is present with a non-empty value.
- Command is absent, unknown, help, `-h`, `--help`, version, `--version`, or `upgrade`.
- Either stdin or stdout is not a TTY.
- `process.execPath` does not resolve to an installed `factory` binary.
- Current version contains `-dev.`.
- Last completed auto-check is less than 7 days ago.

Use an explicit recognized-normal-command allow-list in `src/auto-upgrade.ts`, with a comment requiring it to stay in sync with `src/cli.ts` dispatch. Do not refactor CLI dispatch into a command registry for this task.

## File Changes

### `src/upgrade.ts`

Extend `fetchLatestRelease` to accept an optional abort signal:

```ts
export async function fetchLatestRelease(
  fetchImpl: FetchImpl = fetch,
  opts?: { signal?: AbortSignal },
): Promise<GitHubRelease>
```

Thread `opts?.signal` into the existing fetch call. Manual `factory upgrade` should keep existing behavior by calling without a signal.

If the installed-binary detection helper is not exported today, export the narrow helper needed by `auto-upgrade.ts` rather than duplicating the logic.

### `src/config.ts`

Expose the global auto-upgrade state path near existing factory-home/global-config helpers:

```ts
export function autoUpgradeStateFile(): string {
  return `${factoryHome()}/auto-upgrade.json`
}
```

Keep the `$FACTORY_HOME` / `~/.factory` logic single-sourced.

### `src/auto-upgrade.ts`

Add the new module with:

```ts
export const AUTO_UPGRADE_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
export const AUTO_UPGRADE_CHECK_TIMEOUT_MS = 2000

export type AutoUpgradeState = {
  lastCheckedAt: string
}

export type AutoUpgradeResult =
  | { kind: 'continue' }
  | { kind: 'exit'; code: number }
```

Provide pure helpers:

```ts
export function isAutoUpgradeCommand(command: string): boolean
export function isDevFactoryVersion(version: string): boolean
export function isAffirmativeAutoUpgradeAnswer(answer: string): boolean
export function shouldRunAutoUpgradeCheck(input: {
  state: AutoUpgradeState | null
  now: Date
}): boolean
```

Provide state helpers:

```ts
export async function readAutoUpgradeState(file: string): Promise<AutoUpgradeState | null>
export async function writeAutoUpgradeState(file: string, now: Date): Promise<void>
```

State writing should create the parent directory first and write formatted JSON with a trailing newline.

Provide orchestration:

```ts
export async function maybeAutoUpgrade(opts: {
  command: string
  env?: Record<string, string | undefined>
  execPath?: string
  currentVersion?: string
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  now?: Date
  stateFile?: string
  fetchImpl?: FetchImpl
  readAnswer?: (question: string) => Promise<string>
  upgrade?: () => Promise<number>
  checkTimeoutMs?: number
}): Promise<AutoUpgradeResult>
```

Behavior:

1. Check eligibility.
2. Read state.
3. If stale or missing, write `lastCheckedAt` before the release lookup.
4. Fetch latest release with timeout.
5. On lookup failure or timeout, continue silently.
6. If current, continue silently.
7. If newer, prompt:

```text
a newer factory is available: 0.1.5 -> 0.1.6
upgrade now? [y/N]
```

8. Decline continues silently.
9. Accept runs `upgradeFactory()`.
10. If upgrade returns `0`, print:

```text
re-run `factory <command>` to continue on the new version
```

11. Return `{ kind: 'exit', code }`.

Unexpected errors in the check/prompt path should return `{ kind: 'continue' }` silently. The accepted upgrade path should not be swallowed; it should behave like explicit manual upgrade and return its result.

### `src/cli.ts`

Import `maybeAutoUpgrade`.

After the explicit `upgrade` early return and before normal command dispatch:

```ts
const autoUpgrade = await maybeAutoUpgrade({ command: cmd })
if (autoUpgrade.kind === 'exit') {
  return autoUpgrade.code
}
```

Keep help/no-command, version, and explicit upgrade exits before this call.

Update help near `factory upgrade`:

```text
factory upgrade                Update factory to the latest GitHub release.
                               Installed builds also check weekly and prompt
                               before interactive commands; FACTORY_DISABLE_AUTO_UPGRADE=1 opts out.
```

### `README.md`

Update the install/upgrade section to document:

- Installed non-dev binaries check GitHub Releases at most once every 7 days.
- Checks only happen before recognized normal commands in an interactive terminal.
- Help, version, explicit upgrade, source runs, dev builds, and non-TTY runs skip checks.
- `FACTORY_DISABLE_AUTO_UPGRADE=1` disables only automatic checks.
- Declining suppresses checks for 7 days.
- Accepting upgrades and exits; the original command should be rerun.
- Manual `factory upgrade` remains available.

## Tests

Add focused tests in `tests/auto-upgrade.test.ts` using injected fetch, prompt, upgrade, clock, and temp state files. Do not hit the network or run the real installer.

Cover:

- Disable env prevents fetch, prompt, state write.
- Help/version/upgrade/unknown commands are ineligible.
- Known normal commands require both stdin and stdout TTY.
- Source runs skip when exec path is not an installed `factory` binary.
- Versions containing `-dev.` skip.
- Missing state checks now.
- Recent state suppresses.
- Old state checks now.
- Malformed state is treated as stale.
- State writer creates the parent directory.
- No-update writes state and does not prompt.
- Release lookup failure writes state and continues.
- Timeout writes state and continues.
- State is written before prompt is shown.
- Only `y` and `yes` accept, with case and whitespace handling.
- Decline, empty, and arbitrary answers continue without upgrade.
- Accept runs injected upgrade and exits with its code.
- Successful accepted upgrade emits the re-run hint.
- Accepted failed upgrade exits with the upgrade failure code.
- Unexpected check/prompt errors continue silently.

Add a minimal CLI placement test if existing coverage does not already prove help/version/upgrade return before auto-upgrade state is touched.

## Verification

Primary gate, with permission:

```bash
bun run test
```

The implementation should not require live GitHub access, installer execution, builds, migrations, commits, or git operations to validate.
