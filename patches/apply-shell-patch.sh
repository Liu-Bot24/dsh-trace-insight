#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.19.0 or newer is required." >&2
  exit 1
fi

exec node "$HERE/shell-patch.mjs" "$@"
