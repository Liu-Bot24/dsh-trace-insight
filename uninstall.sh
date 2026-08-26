#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-web}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_CORE="$HERE/scripts/managed-package.mjs"
NPX_FINDER="$HERE/scripts/find-npx-dsh.mjs"
DSH_PACKAGE="@deepseek-ai/dsh"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required." >&2
  exit 1
fi
if [[ ! -f "$PACKAGE_CORE" ]]; then
  echo "Missing Trace Insight managed-package component: $PACKAGE_CORE" >&2
  exit 1
fi
if { command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; } \
  || { command -v pgrep >/dev/null 2>&1 && pgrep -f '(^|[[:space:]"])(([^[:space:]"]*[/\\])?dsh(\.cmd)?|[^[:space:]"]*@deepseek-ai[/\\]dsh[/\\][^[:space:]"]*)([[:space:]"]|$).*([[:space:]]web([[:space:]"]|$)|--profile[[:space:]]+web([[:space:]"]|$))' >/dev/null 2>&1; }; then
  echo "DSH is running. Stop it, then run this uninstaller again." >&2
  exit 1
fi
if command -v dsh >/dev/null 2>&1; then
  DSH=("$(command -v dsh)")
else
  if ! command -v npx >/dev/null 2>&1; then
    echo "Neither a global dsh command nor npx is available." >&2
    exit 1
  fi
  NPX_COMMAND="$(command -v npx)"
  DSH=("$NPX_COMMAND" --yes "--package=$DSH_PACKAGE" dsh)
fi
FOUND_DSH_VERSION="$("${DSH[@]}" --version | tr -d '\r\n')"
if [[ ${#DSH[@]} -gt 1 && ! -f "$NPX_FINDER" ]]; then
  echo "Missing npx DSH locator: $NPX_FINDER" >&2
  exit 1
fi
if [[ ${#DSH[@]} -gt 1 && -z "${DSH_PACKAGE_ROOT:-}" ]]; then
  DSH_PACKAGE_ROOT="$("$NPX_COMMAND" --yes "--package=$DSH_PACKAGE" node "$NPX_FINDER" "$FOUND_DSH_VERSION")"
  export DSH_PACKAGE_ROOT
fi
RESTORE_RESULT="$(node "$HERE/patches/shell-patch.mjs" restore-all --json)"
RESTORED_ROOTS=()
while IFS= read -r root; do
  [[ -n "$root" ]] && RESTORED_ROOTS+=("$root")
done < <(node -e 'const r=JSON.parse(process.argv[1]); for (const i of r.installations || []) if (i.state === "restored") console.log(i.dshRoot)' "$RESTORE_RESULT")
if ! "${DSH[@]}" plugin --profile "$PROFILE" remove dsh-plugin-trace-insight; then
  if [[ ${#RESTORED_ROOTS[@]} -gt 0 ]]; then
    REAPPLY_ARGS=(apply-all --json)
    for root in "${RESTORED_ROOTS[@]}"; do REAPPLY_ARGS+=(--dsh-root "$root"); done
    node "$HERE/patches/shell-patch.mjs" "${REAPPLY_ARGS[@]}" >/dev/null
  fi
  exit 1
fi
node "$PACKAGE_CORE" cleanup --profile "$PROFILE" >/dev/null
echo "Trace Insight and the right-side inspector were removed. Restart DSH."
