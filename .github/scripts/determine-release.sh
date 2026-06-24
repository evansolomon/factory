#!/usr/bin/env bash
set -euo pipefail

version="$(awk -F\" '/^version = / { print $2; exit }' Cargo.toml)"
tag="v${version}"
should_publish=true

if [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
  tag="${GITHUB_REF_NAME}"
fi

if gh release view "${tag}" >/dev/null 2>&1; then
  echo "Release ${tag} already exists; skipping release."
  should_publish=false
elif [ "${GITHUB_EVENT_NAME:-}" = "push" ]; then
  previous_version=""

  if [ -n "${PREVIOUS_SHA:-}" ] &&
    ! printf '%s' "${PREVIOUS_SHA}" | grep -Eq '^0+$' &&
    git cat-file -e "${PREVIOUS_SHA}:Cargo.toml" 2>/dev/null; then
    previous_version="$(
      git show "${PREVIOUS_SHA}:Cargo.toml" |
        awk -F\" '/^version = / { print $2; exit }'
    )"
  fi

  if [ "${previous_version}" = "${version}" ]; then
    echo "Cargo.toml version is still ${version}; skipping release."
    should_publish=false
  fi
fi

{
  echo "tag=${tag}"
  echo "should_publish=${should_publish}"
} >> "${GITHUB_OUTPUT}"
