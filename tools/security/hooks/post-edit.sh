#!/usr/bin/env bash
# Claude Code PostToolUse hook (Edit|Write|MultiEdit|NotebookEdit): scan the one changed file with
# semgrep + gitleaks. New high/critical findings → exit 2, so the findings go back to the agent to
# fix now. Missing docker/tools only warns. Baselined findings never block.
set -uo pipefail
kit="$(cd "$(dirname "$0")/.." && pwd)"
input="$(cat)"
file="$(printf '%s' "$input" | bun -e 'const j=JSON.parse(await Bun.stdin.text());console.log(j.tool_input?.file_path??j.tool_input?.notebook_path??"")' 2>/dev/null)"
[[ -n "$file" && -f "$file" ]] || exit 0
dir="$(dirname "$file")"
repo="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || echo "$dir")"
out="$(timeout 60 bash "$kit/scan.sh" file "$repo" "$file" 2>&1)"; rc=$?
if [[ $rc -eq 1 ]]; then
  { echo "Security scan found NEW high/critical issues in $file — fix them before continuing:"; echo "$out"; } >&2
  exit 2
fi
[[ $rc -eq 124 ]] && echo "[security] warn: scan of $file timed out" >&2
# Medium findings: surface without blocking.
printf '%s\n' "$out" | grep -q 'MEDIUM' && { echo "$out" | grep -E 'MEDIUM|new ' >&2; }
exit 0
