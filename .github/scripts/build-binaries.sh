#!/usr/bin/env bash
set -euo pipefail

target="${FACTORY_RELEASE_TARGET:-}"
asset="${FACTORY_RELEASE_ASSET:-}"

if [ -z "${target}" ] || [ -z "${asset}" ]; then
  cat >&2 <<'EOF'
FACTORY_RELEASE_TARGET and FACTORY_RELEASE_ASSET are required.

Example:
  FACTORY_RELEASE_TARGET=x86_64-unknown-linux-gnu \
  FACTORY_RELEASE_ASSET=factory-linux-x64-baseline \
  bash .github/scripts/build-binaries.sh
EOF
  exit 2
fi

mkdir -p dist

rustup target add "${target}"
cargo build --release --locked --target "${target}"
cp "target/${target}/release/factory" "dist/${asset}"
chmod +x "dist/${asset}"

if command -v strip >/dev/null 2>&1; then
  strip "dist/${asset}" || true
fi

"dist/${asset}" --version
