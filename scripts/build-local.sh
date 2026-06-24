#!/usr/bin/env bash
set -euo pipefail

outfile="${1:-dist/factory}"
base_version="$(bun -e 'console.log((await Bun.file("package.json").json()).version)')"
stamp="$(date -u +%Y%m%d%H%M%S)"
build_version="${FACTORY_BUILD_VERSION:-${base_version}-dev.${stamp}}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

mkdir -p "$(dirname "${outfile}")"
outdir="$(cd "$(dirname "${outfile}")" && pwd -P)"
outfile="${outdir}/$(basename "${outfile}")"

cd "${repo_root}"
go build -ldflags "-X main.version=${build_version}" -o "${outfile}" ./cmd/factory
chmod +x "${outfile}"

echo "built factory ${build_version} to ${outfile}"
