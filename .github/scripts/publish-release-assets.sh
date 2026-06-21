#!/usr/bin/env bash
set -euo pipefail

if gh release view "${TAG_NAME}" >/dev/null 2>&1; then
  gh release upload "${TAG_NAME}" dist/* --clobber
else
  gh release create "${TAG_NAME}" dist/* --target "${TARGET_SHA}" --title "${TAG_NAME}" --generate-notes
fi
