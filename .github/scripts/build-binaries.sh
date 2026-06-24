#!/usr/bin/env bash
set -euo pipefail

mkdir -p dist

base_version="$(bun -e 'console.log((await Bun.file("package.json").json()).version)')"
build_version="${FACTORY_BUILD_VERSION:-${base_version}}"

CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -ldflags "-X main.version=${build_version}" -o dist/factory-darwin-arm64 ./cmd/factory
CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -ldflags "-X main.version=${build_version}" -o dist/factory-darwin-x64 ./cmd/factory
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "-X main.version=${build_version}" -o dist/factory-linux-x64-baseline ./cmd/factory
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags "-X main.version=${build_version}" -o dist/factory-linux-arm64 ./cmd/factory
