#!/usr/bin/env bash
set -euo pipefail
PROFILE="${1:-web}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGE="$HERE/dsh-plugin-trace-insight-1.0.0.tgz"

if [[ ! -f "$PACKAGE" ]]; then
  echo "Package not found: $PACKAGE" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.19.0 or newer is required." >&2
  exit 1
fi
if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
  echo "Node.js 22.19.0 or newer is required; found $(node --version)." >&2
  exit 1
fi
if command -v dsh >/dev/null 2>&1; then
  DSH=(dsh)
else
  if ! command -v npx >/dev/null 2>&1; then
    echo "Neither dsh nor npx is available." >&2
    exit 1
  fi
  DSH=(npx --yes @deepseek-ai/dsh@0.1.0-rc.6)
fi
"${DSH[@]}" plugin --profile "$PROFILE" add "$PACKAGE"
"${DSH[@]}" --profile "$PROFILE" --dump-config | grep -q 'dsh-plugin-trace-insight'
echo "Installed. Restart DSH with: ${DSH[*]} web"
