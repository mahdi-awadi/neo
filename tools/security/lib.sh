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

# Warm scanner containers (ADR-0024): started once and reused, so a scan pays no container start.
# No network, a read-only root, and no host mount but the kit's rules: the files to scan are streamed
# in (sec_stage) and removed after. One pair per kit copy (the name carries a hash of its path), so two
# copies never recreate each other's container mid-scan; recreated when the image digest changes.
SEC_KIT_ID="$(printf '%s' "$SEC_KIT" | sha1sum | cut -c1-8)"
SEC_SEMGREP_CTR="neo-sec-semgrep-$SEC_KIT_ID"
SEC_GITLEAKS_CTR="neo-sec-gitleaks-$SEC_KIT_ID"

sec_warm() { # name image → 0 when the container is up
  local name="$1" image="$2" want="$2|$SEC_KIT" fd rc=1
  exec {fd}>"/tmp/$name.lock"
  flock -w 60 "$fd" || { exec {fd}>&-; return 1; } # two hooks at once: one starts it, the other waits
  if [[ "$(docker inspect -f '{{index .Config.Labels "neo.sec"}}|{{.State.Running}}' "$name" 2>/dev/null)" == "$want|true" ]]; then rc=0
  else
    docker rm -f "$name" >/dev/null 2>&1
    docker run -d --name "$name" --label "neo.sec=$want" --network none --read-only \
      --tmpfs /scan:size=1g --tmpfs /tmp:size=256m -e HOME=/tmp \
      -v "$SEC_KIT/rules:/kit/rules:ro" --entrypoint sleep "$image" infinity >/dev/null 2>&1 && rc=0
  fi
  exec {fd}>&-
  return $rc
}

sec_stage() { # name repo relfile... → prints the scan id (files under /scan/<id>)
  local name="$1" repo="$2" id="s$$-$RANDOM"; shift 2
  tar -C "$repo" -cf - -- "$@" 2>/dev/null | docker exec -i "$name" sh -c "mkdir -p /scan/$id && tar -xf - -C /scan/$id" || return 1
  echo "$id"
}

sec_unstage() { docker exec "$1" rm -rf "/scan/$2" >/dev/null 2>&1 || true; }

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
