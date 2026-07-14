#!/usr/bin/env bash
# Guard against the f668b13 outage class: an extensionless relative import in
# serverless code crashes every route at module load on Vercel (ERR_MODULE_NOT_FOUND).
# tsconfig uses moduleResolution:"bundler", so tsc alone never catches this.
set -euo pipefail
cd "$(dirname "$0")/.."

# NOTE: no bash globstar on macOS bash 3.2 — api/**/*.ts silently expands to
# nothing there, which would skip api/[...path].ts entirely. Use find instead.
files=(server.ts sanitizeSessionEnd.ts src/viewer/jargon.ts src/viewer/jargonGlossary.ts)
while IFS= read -r f; do files+=("$f"); done < <(find api -name '*.ts')

pattern="^[[:space:]]*(import|export)([[:space:]][^;]*[[:space:]]from[[:space:]]*|[[:space:]]*)['\"](\\./|\\.\\./)[^'\"]*['\"]"

matches="$(
  grep -nE "$pattern" "${files[@]}" \
    | grep -vE "import[[:space:]]+type[[:space:]]" \
    | grep -vE "\\.(js|json)['\"]" \
    || true
)"

if [[ -n "$matches" ]]; then
  printf '%s\n' "$matches"
  exit 1
fi

echo "serverless import extensions OK (${#files[@]} files scanned)"
