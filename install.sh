#!/usr/bin/env bash
set -euo pipefail
PROFILE="${1:-web}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_VERSION="1.3.2"
DSH_PACKAGE="@deepseek-ai/dsh"
PACKAGE=""
PATCH_CORE="$HERE/patches/shell-patch.mjs"
PACKAGE_CORE="$HERE/scripts/managed-package.mjs"
NPX_FINDER="$HERE/scripts/find-npx-dsh.mjs"
PACKAGE_BUILD_ROOT=""

cleanup_package_build() {
  if [[ -n "$PACKAGE_BUILD_ROOT" && -d "$PACKAGE_BUILD_ROOT" ]]; then
    rm -rf "$PACKAGE_BUILD_ROOT"
  fi
}
trap cleanup_package_build EXIT

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.19.0 or newer is required." >&2
  exit 1
fi
if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
  echo "Node.js 22.19.0 or newer is required; found $(node --version)." >&2
  exit 1
fi
if { command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; } \
  || { command -v pgrep >/dev/null 2>&1 && pgrep -f '(^|[[:space:]"])(([^[:space:]"]*[/\\])?dsh(\.cmd)?|[^[:space:]"]*@deepseek-ai[/\\]dsh[/\\][^[:space:]"]*)([[:space:]"]|$).*([[:space:]]web([[:space:]"]|$)|--profile[[:space:]]+web([[:space:]"]|$))' >/dev/null 2>&1; }; then
  echo "DSH is running. Stop it, then run this installer again." >&2
  exit 1
fi
if ! command -v dsh >/dev/null 2>&1 && ! command -v npx >/dev/null 2>&1; then
  echo "Neither a global dsh command nor npx is available. Install Node.js 22.19.0 or newer." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required." >&2
  exit 1
fi
PACKAGE_BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/trace-insight-pack.XXXXXX")"
(cd "$HERE" && npm pack --ignore-scripts --silent --pack-destination "$PACKAGE_BUILD_ROOT" >/dev/null)
PACKAGE="$PACKAGE_BUILD_ROOT/dsh-plugin-trace-insight-$PLUGIN_VERSION.tgz"
if [[ ! -f "$PACKAGE" ]]; then
  echo "Could not create the Trace Insight package: $PACKAGE" >&2
  exit 1
fi
if [[ ! -f "$PACKAGE_CORE" ]]; then
  echo "Missing Trace Insight managed-package component: $PACKAGE_CORE" >&2
  exit 1
fi
if command -v dsh >/dev/null 2>&1; then
  DSH=("$(command -v dsh)")
  DSH_DISPLAY="${DSH[0]}"
else
  NPX_COMMAND="$(command -v npx)"
  DSH=("$NPX_COMMAND" --yes "--package=$DSH_PACKAGE" dsh)
  DSH_DISPLAY="npx --yes --package=$DSH_PACKAGE dsh"
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
node "$PATCH_CORE" status-all --json >/dev/null
MANAGED_PACKAGE="$(node "$PACKAGE_CORE" stage --source "$PACKAGE" --version "$PLUGIN_VERSION")"
APPLY_RESULT="$(node "$PATCH_CORE" apply-all --json)"
NEWLY_PATCHED_ROOTS=()
while IFS= read -r root; do
  [[ -n "$root" ]] && NEWLY_PATCHED_ROOTS+=("$root")
done < <(node -e 'const r=JSON.parse(process.argv[1]); for (const i of r.installations || []) if (i.previousState === "original") console.log(i.dshRoot)' "$APPLY_RESULT")

restore_new_shell_patches() {
  if [[ ${#NEWLY_PATCHED_ROOTS[@]} -eq 0 ]]; then return 0; fi
  local restore_args=(restore-all --json)
  local root
  for root in "${NEWLY_PATCHED_ROOTS[@]}"; do restore_args+=(--dsh-root "$root"); done
  node "$PATCH_CORE" "${restore_args[@]}" >/dev/null
}
MIGRATION_RESULT="$(node "$PACKAGE_CORE" migrate --profile "$PROFILE" --package "$MANAGED_PACKAGE" --json)"
PLUGIN_WAS_INSTALLED=1
if [[ "$MIGRATION_RESULT" == *'"state":"profile-not-created"'* || "$MIGRATION_RESULT" == *'"state":"not-installed"'* ]]; then
  PLUGIN_WAS_INSTALLED=0
fi
if ! "${DSH[@]}" plugin --profile "$PROFILE" add "$MANAGED_PACKAGE"; then
  if [[ "$PLUGIN_WAS_INSTALLED" -eq 0 ]] && "${DSH[@]}" plugin --profile "$PROFILE" remove dsh-plugin-trace-insight; then
    node "$PACKAGE_CORE" cleanup --profile "$PROFILE" >/dev/null
  fi
  if [[ "$PLUGIN_WAS_INSTALLED" -eq 0 ]]; then restore_new_shell_patches; fi
  exit 1
fi
if ! "${DSH[@]}" --profile "$PROFILE" --dump-config | grep -q 'dsh-plugin-trace-insight'; then
  if [[ "$PLUGIN_WAS_INSTALLED" -eq 0 ]] && "${DSH[@]}" plugin --profile "$PROFILE" remove dsh-plugin-trace-insight; then
    node "$PACKAGE_CORE" cleanup --profile "$PROFILE" >/dev/null
  fi
  if [[ "$PLUGIN_WAS_INSTALLED" -eq 0 ]]; then restore_new_shell_patches; fi
  echo "Trace Insight was not added to the DSH web profile." >&2
  exit 1
fi
node "$PACKAGE_CORE" finalize --profile "$PROFILE" --package "$MANAGED_PACKAGE" >/dev/null
echo "Installed for every supported DSH installation found. Restart with: $DSH_DISPLAY web"
