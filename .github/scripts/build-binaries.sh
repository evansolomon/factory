#!/usr/bin/env bash
set -euo pipefail

mkdir -p dist

bun build src/cli.ts --compile --target=bun-darwin-arm64 --outfile dist/factory-darwin-arm64
bun build src/cli.ts --compile --target=bun-darwin-x64 --outfile dist/factory-darwin-x64
bun build src/cli.ts --compile --target=bun-linux-x64-baseline --outfile dist/factory-linux-x64-baseline
bun build src/cli.ts --compile --target=bun-linux-arm64 --outfile dist/factory-linux-arm64
