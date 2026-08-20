#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-web}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required." >&2
  exit 1
fi
if { command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; } \
  || { command -v pgrep >/dev/null 2>&1 && pgrep -f '(@deepseek-ai/dsh|(^|[/\\])dsh)([^[:alnum:]]|$).*[^[:alnum:]]web([^[:alnum:]]|$)' >/dev/null 2>&1; }; then
  echo "DSH is running. Stop it, then run this uninstaller again." >&2
  exit 1
fi
if ! command -v dsh >/dev/null 2>&1; then
  echo "A global DeepSeek Harness installation is required." >&2
  exit 1
fi
DSH_COMMAND="$(command -v dsh)"
DSH_VERSION="$("$DSH_COMMAND" --version | tr -d '\r\n')"
case "$DSH_VERSION" in
  0.1.0-rc.7|0.1.0-rc.8) ;;
  *)
    echo "DeepSeek Harness 0.1.0-rc.7 or 0.1.0-rc.8 is required; found $DSH_VERSION." >&2
    exit 1
    ;;
esac
node "$HERE/patches/shell-patch.mjs" restore-active --dsh-root "$DSH_COMMAND" --json >/dev/null
"$DSH_COMMAND" plugin --profile "$PROFILE" remove dsh-plugin-trace-insight
echo "Trace Insight and the right-side inspector were removed. Restart DSH."
