#!/usr/bin/env bash
set -euo pipefail

outfile="${1:-dist/factory}"
base_version="$(bun -e 'console.log((await Bun.file("package.json").json()).version)')"
stamp="$(date -u +%Y%m%d%H%M%S)"
build_version="${FACTORY_BUILD_VERSION:-${base_version}-dev.${stamp}}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
entrypoint="${repo_root}/src/cli.ts"
build_version_json="$(
  BUILD_VERSION="${build_version}" bun -e 'console.log(JSON.stringify(process.env.BUILD_VERSION))'
)"
entrypoint_json="$(
  ENTRYPOINT="${entrypoint}" bun -e 'console.log(JSON.stringify(process.env.ENTRYPOINT))'
)"

mkdir -p "$(dirname "${outfile}")"
outdir="$(cd "$(dirname "${outfile}")" && pwd -P)"
outfile="${outdir}/$(basename "${outfile}")"
build_dir="$(mktemp -d "${outdir}/.factory-build.XXXXXX")"
cleanup() {
  rm -rf "${build_dir}"
}
trap cleanup EXIT

cd "${build_dir}"
cat > entrypoint.ts <<EOF
process.env['FACTORY_BUILD_VERSION'] = ${build_version_json}
await import(${entrypoint_json})
EOF
bun build entrypoint.ts --compile --outfile "${outfile}"
chmod +x "${outfile}"

echo "built factory ${build_version} to ${outfile}"
