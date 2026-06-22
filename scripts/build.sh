#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
No default build target.

Use one of:
  bun run build:local [-- /path/to/factory]
  bun run build:release

build:local creates one dev-stamped executable for this machine.
build:release creates all release binaries for GitHub Releases.
EOF

exit 1
