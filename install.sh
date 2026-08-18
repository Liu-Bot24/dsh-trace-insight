#!/usr/bin/env bash
set -euo pipefail
PROFILE="${1:-web}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGE="$HERE/dsh-plugin-trace-insight-1.1.0.tgz"
PATCH_CORE="$HERE/patches/shell-patch.mjs"
NPX_FINDER="$HERE/scripts/find-npx-dsh.mjs"

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
if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required." >&2
  exit 1
fi
DSH=(npx --yes @deepseek-ai/dsh@0.1.0-rc.7)
DSH_VERSION="$("${DSH[@]}" --version)"
if [[ "$DSH_VERSION" != *"0.1.0-rc.7"* ]]; then
  echo "DeepSeek Harness 0.1.0-rc.7 is required; found $DSH_VERSION." >&2
  exit 1
fi
if [[ -z "${DSH_PACKAGE_ROOT:-}" ]]; then
  DSH_PACKAGE_ROOT="$(node "$NPX_FINDER" 0.1.0-rc.7)"
fi

PATCH_ROOT_ARGS=(--dsh-root "$DSH_PACKAGE_ROOT")
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
  if [[ "$PATCH_WAS_ORIGINAL" -eq 1 ]]; then node "$PATCH_CORE" restore-active --json >/dev/null; fi
  exit 1
fi
if ! "${DSH[@]}" --profile "$PROFILE" --dump-config | grep -q 'dsh-plugin-trace-insight'; then
  "${DSH[@]}" plugin --profile "$PROFILE" remove dsh-plugin-trace-insight || true
  if [[ "$PATCH_WAS_ORIGINAL" -eq 1 ]]; then node "$PATCH_CORE" restore-active --json >/dev/null; fi
  echo "Trace Insight was not added to the DSH web profile." >&2
  exit 1
fi
echo "Installed. Restart DSH with: ${DSH[*]} web"
