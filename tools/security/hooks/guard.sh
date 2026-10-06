#!/usr/bin/env bash
# Claude Code PreToolUse hook: keep agents away from secret files (.env*, private keys, credential
# stores). Neo workers (headless) are BLOCKED; the operator's own interactive sessions are WARNED.
# Templates (.env.example/.sample/.template/.dist) are always allowed.
set -uo pipefail
input="$(cat)"
IFS= read -r line < <(printf '%s' "$input" | bun -e '
const j=JSON.parse(await Bun.stdin.text()); const t=j.tool_input??{};
const v=t.file_path??t.notebook_path??t.path??t.pattern??t.command??"";
// a secret file passed to docker/compose as --env-file is used, not read into context
const s=String(v).replace(/\s+/g," "); console.log(j.tool_name+" "+(j.tool_name==="Bash"?s.replace(/--env-file[ =]\S+/g,""):s))' 2>/dev/null)
tool="${line%% *}"; target="${line#* }"
[[ -n "${target:-}" && "$target" != "$tool" ]] || exit 0

secret_re='(^|[/ "'"'"'=<>|;&])(\.env(\.[A-Za-z0-9_-]+)?|[^ /]*\.(pem|key|p12|pfx|jks|keystore|ppk)|id_(rsa|ed25519|ecdsa|dsa)|\.netrc|\.pgpass|\.npmrc|\.pypirc|credentials(\.json)?|service-account[^ /]*\.json|\.git-credentials|\.docker/config\.json)($|[ "'"'"'<>|;&)])'
allow_re='\.env\.(example|sample|template|dist|defaults)($|[^A-Za-z])|\.key\.example'

if [[ "$target" =~ $secret_re ]]; then
  hit="${BASH_REMATCH[2]}"
  [[ "$target" =~ $allow_re ]] && exit 0
  if [[ -n "${NEO_WORKER:-}${CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS:-}" ]]; then
    echo "Blocked by security guard: $tool on a secret file ($hit). Secrets stay out of agent context. Read config via the app's env loader, or ask the operator (ask_operator) to set/check the value." >&2
    exit 2
  fi
  echo "[security] warning: $tool touches a secret file ($hit) — never paste its values into code, logs or replies." >&2
fi
exit 0
