#!/usr/bin/env bash
# Shared helpers for the security kit. Sourced, not run.
# Every scanner runs from a digest-pinned Docker image (images.env); nothing is installed on the host.
# A missing tool or Docker only WARNS — a scanner outage must never break editing or committing.

SEC_KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SEC_KIT/images.env"

sec_warn() { echo "[security] warn: $*" >&2; }

sec_have_docker() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

# Semgrep configs for a set of files: the OWASP/secrets core, our custom rules, plus language packs.
sec_semgrep_configs() {
  local reg="$SEC_KIT/rules/registry" exts="" f
  local packs="owasp-top-ten secrets jwt xss sql-injection command-injection insecure-transport"
  for f in "$@"; do exts="$exts ${f##*/}"; done
  [[ "$exts" =~ \.(ts|tsx|js|jsx|mjs|cjs)( |$) ]] && packs="$packs javascript typescript react nodejs nodejsscan"
  [[ "$exts" =~ \.go( |$) ]] && packs="$packs golang gosec"
  [[ "$exts" =~ \.py( |$) ]] && packs="$packs python bandit flask django"
  [[ "$exts" =~ \.php( |$) ]] && packs="$packs php"
  [[ "$exts" =~ \.java( |$) ]] && packs="$packs java"
  [[ "$exts" =~ \.cs( |$) ]] && packs="$packs csharp"
  [[ "$exts" =~ \.tf( |$) ]] && packs="$packs terraform"
  [[ "$exts" =~ (Dockerfile[^ ]*|\.dockerfile)( |$) ]] && packs="$packs dockerfile"
  [[ "$exts" =~ (compose[^ ]*\.ya?ml)( |$) ]] && packs="$packs docker-compose"
  [[ "${SEC_DEEP:-0}" == 1 ]] && packs="$packs security-audit"
  local p
  for p in $packs; do [[ -f "$reg/$p.yml" ]] && printf -- '--config=%s\n' "$reg/$p.yml"; done
  printf -- '--config=%s\n' "$SEC_KIT/rules/custom"
}

# Files worth scanning (skip binaries, vendored, generated, lockfiles and huge files).
sec_scannable() {
  local f="$1"
  [[ -f "$f" ]] || return 1
  case "$f" in
    */tools/security/rules/tests/*) return 1 ;; # intentionally vulnerable rule fixtures
    */node_modules/*|*/vendor/*|*/.git/*|*/dist/*|*/build/*|*.min.js|*.map|*.lock|*-lock.json|*.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.pdf|*.zip|*.woff*|*.ttf) return 1 ;;
  esac
  [[ $(stat -c %s "$f" 2>/dev/null || echo 0) -le 1048576 ]]
}
