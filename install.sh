#!/usr/bin/env bash
set -euo pipefail
PROFILE="${1:-web}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGE="$HERE/dsh-plugin-trace-insight-1.2.2.tgz"
PATCH_CORE="$HERE/patches/shell-patch.mjs"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.19.0 or newer is required." >&2
  exit 1
fi
if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
  echo "Node.js 22.19.0 or newer is required; found $(node --version)." >&2
  exit 1
fi
if { command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; } \
  || { command -v pgrep >/dev/null 2>&1 && pgrep -f '(@deepseek-ai/dsh|(^|[/\\])dsh)([^[:alnum:]]|$).*[^[:alnum:]]web([^[:alnum:]]|$)' >/dev/null 2>&1; }; then
  echo "DSH is running. Stop it, then run this installer again." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required." >&2
  exit 1
fi
if [[ ! -f "$PACKAGE" ]]; then
  (cd "$HERE" && npm pack --ignore-scripts --silent >/dev/null)
fi
if [[ ! -f "$PACKAGE" ]]; then
  echo "Could not create the Trace Insight package: $PACKAGE" >&2
  exit 1
fi
if ! command -v dsh >/dev/null 2>&1; then
  echo "A global DeepSeek Harness installation is required. Install DSH, then run this installer again." >&2
  exit 1
fi
DSH_COMMAND="$(command -v dsh)"
DSH=("$DSH_COMMAND")
DSH_VERSION="$("${DSH[@]}" --version | tr -d '\r\n')"
case "$DSH_VERSION" in
  0.1.0-rc.7|0.1.0-rc.8) ;;
  *)
    echo "DeepSeek Harness 0.1.0-rc.7 or 0.1.0-rc.8 is required; found $DSH_VERSION." >&2
    exit 1
    ;;
esac

PATCH_ROOT_ARGS=(--dsh-root "${DSH_PACKAGE_ROOT:-$DSH_COMMAND}")
PATCH_STATUS="$(node "$PATCH_CORE" status "${PATCH_ROOT_ARGS[@]}" --json)"
PATCH_WAS_ORIGINAL=0
if [[ "$PATCH_STATUS" == *'"state":"original"'* ]]; then
  PATCH_WAS_ORIGINAL=1
elif [[ "$PATCH_STATUS" != *'"state":"patched"'* ]]; then
  echo "The current DSH shell cannot be installed safely." >&2
  exit 1
fi

node "$PATCH_CORE" apply "${PATCH_ROOT_ARGS[@]}" --json >/dev/null
if ! "${DSH[@]}" plugin --profile "$PROFILE" add "$PACKAGE"; then
  if [[ "$PATCH_WAS_ORIGINAL" -eq 1 ]]; then node "$PATCH_CORE" restore-active "${PATCH_ROOT_ARGS[@]}" --json >/dev/null; fi
  exit 1
fi
if ! "${DSH[@]}" --profile "$PROFILE" --dump-config | grep -q 'dsh-plugin-trace-insight'; then
  "${DSH[@]}" plugin --profile "$PROFILE" remove dsh-plugin-trace-insight || true
  if [[ "$PATCH_WAS_ORIGINAL" -eq 1 ]]; then node "$PATCH_CORE" restore-active "${PATCH_ROOT_ARGS[@]}" --json >/dev/null; fi
  echo "Trace Insight was not added to the DSH web profile." >&2
  exit 1
fi
echo "Installed. Restart DSH with: dsh web"
