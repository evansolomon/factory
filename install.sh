#!/usr/bin/env bash
set -euo pipefail

repo="evansolomon/factory"
install_dir="${FACTORY_INSTALL_DIR:-/usr/local/bin}"

case "$(uname -s)" in
  Darwin)
    os="darwin"
    ;;
  Linux)
    os="linux"
    ;;
  *)
    echo "unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64 | aarch64)
    arch="arm64"
    ;;
  x86_64 | amd64)
    if [ "${os}" = "linux" ]; then
      arch="x64-baseline"
    else
      arch="x64"
    fi
    ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

asset="factory-${os}-${arch}"
url="https://github.com/${repo}/releases/latest/download/${asset}"
tmp="$(mktemp -t factory.XXXXXX)"

cleanup() {
  rm -f "${tmp}"
}
trap cleanup EXIT

curl -fsSL "${url}" -o "${tmp}"
chmod +x "${tmp}"
mkdir -p "${install_dir}"
mv "${tmp}" "${install_dir}/factory"

echo "installed factory to ${install_dir}/factory"
