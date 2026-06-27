# Plan: Reduce Raw Standalone Binary Size

## Recommendation

Add Bun’s `--minify` option to the existing standalone compile commands for both local and release builds.

This is the smallest behavior-preserving change that directly reduces the raw installed executable size while keeping:

- Bun as the compiler/runtime.
- `factory` as a standalone executable.
- Existing release asset names.
- `install.sh` unchanged.
- Checksum generation unchanged.
- `factory --version` working from the compiled binary.

Do not use `strip`, UPX, compressed archives, or a JS bundle requiring user-installed Bun.

## Why This Approach

Bun standalone executables are dominated by the embedded Bun runtime, so large reductions are unlikely without changing the distribution model. `--minify` is still a real raw-byte reduction because it shrinks the bundled application JavaScript inside the standalone executable.

Measured evidence from this worktree with Bun `1.3.13`:

| Build path | Plain | `--minify` | Saved |
|---|---:|---:|---:|
| Local wrapper entry | 102,172,992 | 101,910,848 | 262,144 B |
| Release `bun-linux-x64-baseline` | 101,730,624 | 101,427,520 | 303,104 B |
| Release `bun-darwin-arm64` | 63,879,202 | 63,565,474 | 313,728 B |

This satisfies the goal: the raw standalone executable itself becomes smaller.

## Files To Change

### `scripts/build-local.sh`

Keep the existing wrapper entrypoint behavior intact. Change only the Bun compile command:

```bash
bun build "${entrypoint}" --compile --minify --outfile "${outfile}"
```

Preserve the existing `chmod +x "${outfile}"`.

### `.github/scripts/build-binaries.sh`

Keep the four release assets and target names exactly the same. Add `--minify` to each compile command:

```bash
bun build src/cli.ts --compile --minify --target=bun-darwin-arm64 --outfile dist/factory-darwin-arm64
bun build src/cli.ts --compile --minify --target=bun-darwin-x64 --outfile dist/factory-darwin-x64
bun build src/cli.ts --compile --minify --target=bun-linux-x64-baseline --outfile dist/factory-linux-x64-baseline
bun build src/cli.ts --compile --minify --target=bun-linux-arm64 --outfile dist/factory-linux-arm64
```

### No Changes

Do not change:

- `install.sh`
- `.github/scripts/generate-checksums.sh`
- release asset names
- README distribution docs
- CLI/runtime code
- version resolution code

## Measurement Procedure

Before editing, measure the current local executable without mutating git state:

```bash
bun run build:local -- /tmp/factory-size-before
wc -c /tmp/factory-size-before
/tmp/factory-size-before --version
```

After editing:

```bash
bun run build:local -- /tmp/factory-size-check
wc -c /tmp/factory-size-check
/tmp/factory-size-check --version
```

The after binary must be smaller. If it is not smaller, revert the build-script edits and report the measured result instead of landing the change.

## Verification

Run the normal gate:

```bash
bun run test
```

Verify local compiled behavior:

```bash
bun run build:local -- /tmp/factory-size-check
/tmp/factory-size-check --version
```

Verify release artifact shape:

```bash
bun run build:release
ls -l dist/factory-darwin-arm64 dist/factory-darwin-x64 dist/factory-linux-x64-baseline dist/factory-linux-arm64
bash .github/scripts/generate-checksums.sh
```

On Linux x64, smoke-test the host-compatible release binary:

```bash
dist/factory-linux-x64-baseline --version
```

## Implementation Notes To Report

Include the exact before/after byte counts and commands used.

Also note the tradeoff: `--minify` may reduce diagnostic readability in uncaught stack traces, but it does not change the documented CLI/install contract, and no runtime code should depend on function or local variable names.
