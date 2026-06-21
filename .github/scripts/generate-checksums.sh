#!/usr/bin/env bash
set -euo pipefail

cd dist
sha256sum factory-* > checksums.txt
