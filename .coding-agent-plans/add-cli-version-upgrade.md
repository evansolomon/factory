# ## Outcome

# Plan: Version and Upgrade Commands

## Design

Add `factory version`, `factory --version`, and `factory upgrade` as early top-level CLI branches in `src/cli.ts`, before any repo/config/task-state loading. These commands must work from a non-git directory and must not touch factory queue, config, session, or task state.

Use `package.json` as the local version source of truth via a tiny `src/version.ts` module validated with zod.

Add `src/upgrade.ts` for upgrade behavior:

- Fetch GitHub Releases `latest` from `https://api.github.com/repos/evansolomon/factory/releases/latest`.
- Validate the response body with zod at the network boundary.
- Normalize versions by stripping one leading lowercase `v`.
- Skip installation only when normalized local and remote versions are equal.
- Install on every mismatch, including local-newer-than-remote.
- Resolve the current install directory from `process.execPath` only when its basename is exactly `factory`.
- If resolved, pass that directory as `FACTORY_INSTALL_DIR`.
- If unresolved, remove inherited `FACTORY_INSTALL_DIR`, use the installer default, and warn the user clearly.

Run the existing installer by fetching `install.sh` and feeding it to `bash -s` over stdin. This avoids shell-pipeline failure masking while still using the installer’s existing release/install logic.

## Files

### `src/version.ts`

Create a small module:

- Import `../package.json` with JSON import attributes.
- Validate it with zod:

```ts
const PackageJsonSchema = z.object({
  version: z.string().min(1),
})
```

- Export `FACTORY_VERSION`.

If TypeScript needs an explicit JSON module declaration, add the smallest declaration needed under `src/`.

### `src/upgrade.ts`

Create focused helpers and one CLI-facing orchestration function:

- `UpgradeError extends Error`
- `normalizeGitHubReleaseVersion(tagName: string): string`
- `shouldInstallLatest(localVersion: string, latestVersion: string): boolean`
- `fetchLatestRelease(fetchImpl = fetch): Promise<{ tagName: string; version: string }>`
- `resolveCurrentFactoryInstallDir(execPath = process.execPath): string | null`
- `buildInstallerEnv(parentEnv: NodeJS.ProcessEnv, installDir: string | null): Record<string, string>`
- `runLatestInstaller(opts): Promise<string>`
- `upgradeFactory(): Promise<number>`

Important behavior:

- `fetchLatestRelease` sends `Accept: application/vnd.github+json` and `User-Agent: factory`.
- Non-2xx GitHub responses throw `UpgradeError`.
- Invalid JSON throws `UpgradeError('malformed GitHub release response: invalid JSON')`.
- Missing or invalid `tag_name` throws a malformed-response `UpgradeError`.
- `buildInstallerEnv` preserves parent env values like `PATH` and `HOME`.
- When `installDir` is `null`, delete `FACTORY_INSTALL_DIR` from the child env so the fallback message is truthful.
- Installer fetch failures and installer nonzero exits throw `UpgradeError` with useful output.

CLI output shape:

- Up to date: `already on the latest version (0.1.0)`
- Mismatch: `updating 0.1.0 -> 0.2.0`
- Resolved install dir: `installing to /path/to/bin`
- Unresolved install dir: warn that factory could not detect an existing install and will use the installer default; tell custom-install users to set `FACTORY_INSTALL_DIR`.
- Success: `factory upgraded to 0.2.0`

Use the existing `log` helper for all output.

### `src/cli.ts`

Add imports for `FACTORY_VERSION` and `upgradeFactory`.

Place these branches immediately after help handling and before repo/config context loading:

```ts
if (cmd === 'version' || cmd === '--version') {
  log.log(FACTORY_VERSION)
  return 0
}

if (cmd === 'upgrade') {
  return await upgradeFactory()
}
```

Update help text at the end of the command list, after `config`:

```text
factory version | --version    Print the current CLI version.
factory upgrade                Update factory to the latest GitHub release.
```

Keep the help copy accurate: install-directory preservation only happens when run from an installed `factory` binary.

### `README.md`

Update install/usage docs:

- Mention `factory --version` for checking the installed CLI version.
- Add `factory upgrade` as the supported way to install the latest GitHub Release.
- Document that upgrade preserves the installed binary directory when run from an installed `factory`.
- Document that unresolved/source runs use the installer default and custom installs can set `FACTORY_INSTALL_DIR`.

## Tests

Add focused tests only.

### Version CLI tests

Run from a temporary non-git directory:

- `factory --version` exits `0` and prints exactly `${FACTORY_VERSION}\n`.
- `factory version` exits `0` and prints exactly `${FACTORY_VERSION}\n`.
- With `FACTORY_HOME` pointed at an empty temp dir, version commands leave it empty.

### Upgrade helper tests

Cover:

- `v0.1.0` normalizes to `0.1.0`.
- `0.1.0` remains `0.1.0`.
- Equal normalized versions do not install.
- Mixed local/remote `v` prefixes compare equal.
- Local newer than latest still installs.
- GitHub response `{ tag_name: 'v0.1.0' }` parses to `0.1.0`.
- Missing/non-string `tag_name` throws `UpgradeError`.
- Invalid JSON throws malformed-response `UpgradeError`.
- Non-2xx response throws `UpgradeError`.
- `resolveCurrentFactoryInstallDir('/Users/evan/.local/bin/factory')` returns `/Users/evan/.local/bin`.
- `resolveCurrentFactoryInstallDir('/opt/homebrew/bin/bun')` returns `null`.
- Installer env preserves inherited `PATH`.
- Installer env sets `FACTORY_INSTALL_DIR` when an install dir is resolved.
- Installer env removes inherited `FACTORY_INSTALL_DIR` when unresolved.
- Installer failure throws `UpgradeError` with installer output.

No live network or real installer execution in tests.

## Verification

After implementation, run the repo gate with permission:

```bash
bun run test
```

This should cover formatting, linting, typechecking, unit tests, and the non-git CLI version contract.
