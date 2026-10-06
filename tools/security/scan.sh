#!/usr/bin/env bash
# One entry point for every layer of the security checks.
#
#   scan.sh file   <repo> <file>...   write-time (Claude Code hook): semgrep + gitleaks on the files
#   scan.sh staged <repo>             pre-commit: staged files only, < ~10 s
#   scan.sh push   <repo> [range]     pre-push: changed files, commit range, deps, Dockerfiles, security tests
#   scan.sh full   <repo>             nightly: everything, full git history, images, SBOM, DAST on dev
#   scan.sh baseline <repo>           record today's findings as the baseline (tracked, not blocking)
#
# Exit 1 = new high/critical findings (blocks). Exit 0 = clean or only baselined/low findings.
# Per-project settings live in <repo>/.security/config.json (devUrls, images, testCmd, zapAuth).
set -uo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

mode="${1:-}"; repo="$(cd "${2:-.}" && git rev-parse --show-toplevel 2>/dev/null || pwd)"; shift 2 2>/dev/null || shift $#
cfg="$repo/.security/config.json"; baseline="$repo/.security/baseline.json"
work="$(mktemp -d /tmp/neo-sec.XXXXXX)"; trap 'rm -rf "$work"' EXIT
specs=()

cfg_get() { [[ -f "$cfg" ]] && bun -e "const c=JSON.parse(require('fs').readFileSync('$cfg','utf8'));const v=c[process.argv[1]];if(v!==undefined)console.log(Array.isArray(v)?v.join('\n'):typeof v==='object'?JSON.stringify(v):v)" "$1" 2>/dev/null; }

if ! sec_have_docker; then sec_warn "docker unavailable — security scan skipped"; exit 0; fi

run_semgrep() { # files...
  (($#)) || return 0
  mapfile -t configs < <(sec_semgrep_configs "$@")
  docker run --rm -v "$repo:$repo:ro" -v "$SEC_KIT:$SEC_KIT:ro" -w "$repo" "$SEMGREP_IMAGE" \
    semgrep scan --metrics=off --disable-version-check --quiet --json --timeout 20 "${configs[@]}" "$@" \
    > "$work/semgrep.json" 2>"$work/semgrep.err" || true
  specs+=("semgrep:$work/semgrep.json")
}

run_gitleaks_files() { # files...
  (($#)) || return 0
  local d="$work/gl-src"; mkdir -p "$d"; local f
  for f in "$@"; do mkdir -p "$d/$(dirname "${f#"$repo"/}")"; cp "$f" "$d/${f#"$repo"/}"; done
  docker run --rm -v "$d:/scan:ro" -v "$work:/out" "$GITLEAKS_IMAGE" dir /scan --no-banner --exit-code 0 \
    --report-format json --report-path /out/gitleaks-files.json >/dev/null 2>&1 || true
  specs+=("gitleaks:$work/gitleaks-files.json")
}

run_gitleaks_git() { # log-opts
  docker run --rm -v "$repo:$repo:ro" -v "$work:/out" -w "$repo" "$GITLEAKS_IMAGE" git "$repo" --no-banner \
    --exit-code 0 --log-opts="$1" --report-format json --report-path /out/gitleaks-git.json >/dev/null 2>&1 || true
  specs+=("gitleaks:$work/gitleaks-git.json")
}

run_hadolint() { # dockerfiles...
  local f n=0
  for f in "$@"; do
    n=$((n + 1))
    docker run --rm -i "$HADOLINT_IMAGE" hadolint --no-fail -f json - < "$f" 2>/dev/null \
      | bun -e "const a=JSON.parse(await Bun.stdin.text()||'[]');console.log(JSON.stringify(a.map(x=>({...x,file:process.argv[1]}))))" "$f" \
      > "$work/hadolint-$n.json" || true
    specs+=("hadolint:$work/hadolint-$n.json")
  done
}

run_osv() {
  docker run --rm -v "$repo:$repo:ro" "$OSV_IMAGE" scan source -r --format json "$repo" > "$work/osv.json" 2>/dev/null || true
  specs+=("osv:$work/osv.json")
}

run_trivy_fs() { # scanners
  docker run --rm -v "$repo:$repo:ro" -v neo-sec-trivy-cache:/root/.cache "$TRIVY_IMAGE" fs --quiet --format json \
    --scanners "$1" --severity MEDIUM,HIGH,CRITICAL --skip-dirs node_modules --skip-dirs .git "$repo" > "$work/trivy-fs.json" 2>/dev/null || true
  specs+=("trivy:$work/trivy-fs.json")
}

run_gosec() {
  [[ -f "$repo/go.mod" || -f "$repo/go.work" ]] || return 0
  docker run --rm -v "$repo:$repo:ro" -w "$repo" -e GOFLAGS=-buildvcs=false "$GOSEC_IMAGE" -quiet -fmt json -no-fail ./... > "$work/gosec.json" 2>/dev/null || true
  specs+=("gosec:$work/gosec.json")
}

run_tests() {
  local cmd; cmd="$(cfg_get testCmd)"
  [[ -n "$cmd" ]] || return 0
  echo "[security] security tests: $cmd"
  (cd "$repo" && timeout 600 bash -c "$cmd") || { echo "[security] BLOCK: security tests failed ($cmd)"; return 1; }
}

report() { # label
  mkdir -p "$repo/.security/reports"
  local out="$repo/.security/reports/$1-$(date +%Y%m%d-%H%M%S).json"
  bun "$SEC_KIT/findings.ts" report --baseline "$baseline" --out "$out" --label "$1" "${specs[@]}"
  local rc=$?
  ls -1t "$repo/.security/reports/$1-"*.json 2>/dev/null | tail -n +31 | xargs -r rm -f # keep 30 per layer
  return $rc
}

list_dockerfiles() { git -C "$repo" ls-files | grep -Ei '(^|/)(Dockerfile[^/]*|[^/]*\.dockerfile)$' | sed "s#^#$repo/#"; }

case "$mode" in
  file)
    files=(); for f in "$@"; do sec_scannable "$f" && files+=("$f"); done
    ((${#files[@]})) || exit 0
    run_semgrep "${files[@]}"; run_gitleaks_files "${files[@]}"
    report write ;;
  staged)
    mapfile -t files < <(git -C "$repo" diff --cached --name-only --diff-filter=ACMR | sed "s#^#$repo/#")
    keep=(); dfs=(); for f in "${files[@]}"; do sec_scannable "$f" && keep+=("$f"); [[ "${f##*/}" =~ ^Dockerfile|\.dockerfile$ ]] && dfs+=("$f"); done
    run_semgrep "${keep[@]}"; run_gitleaks_files "${files[@]}"; run_hadolint "${dfs[@]}"
    report commit ;;
  push)
    range="${1:-}"
    if [[ -z "$range" ]]; then
      up="$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" && range="$up..HEAD" || range="HEAD~20..HEAD"
    fi
    mapfile -t files < <(git -C "$repo" diff --name-only --diff-filter=ACMR "${range%%..*}" HEAD 2>/dev/null | sed "s#^#$repo/#")
    keep=(); for f in "${files[@]}"; do sec_scannable "$f" && keep+=("$f"); done
    mapfile -t dfs < <(list_dockerfiles)
    SEC_DEEP=1 run_semgrep "${keep[@]}"; run_gitleaks_git "$range"; run_osv; run_trivy_fs misconfig; run_hadolint "${dfs[@]}"
    printf '%s\n' "${files[@]}" | grep -q '\.go$' && run_gosec
    rc=0; report push || rc=1; run_tests || rc=1; exit $rc ;;
  full|baseline)
    mapfile -t all < <(git -C "$repo" ls-files | sed "s#^#$repo/#")
    keep=(); for f in "${all[@]}"; do sec_scannable "$f" && keep+=("$f"); done
    mapfile -t dfs < <(list_dockerfiles)
    SEC_DEEP=1 run_semgrep "${keep[@]}"; run_gitleaks_git "--all"; run_osv; run_trivy_fs vuln,misconfig,secret
    run_hadolint "${dfs[@]}"; run_gosec
    if [[ "$mode" == full ]]; then
      mkdir -p "$repo/.security/sbom"; n=0
      while read -r img; do
        [[ -n "$img" ]] || continue; n=$((n + 1))
        docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v neo-sec-trivy-cache:/root/.cache "$TRIVY_IMAGE" image --quiet \
          --format json --scanners vuln,secret --severity MEDIUM,HIGH,CRITICAL "$img" > "$work/trivy-img-$n.json" 2>/dev/null || true
        specs+=("trivy:$work/trivy-img-$n.json")
        docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$SYFT_IMAGE" "$img" -o cyclonedx-json -q \
          > "$repo/.security/sbom/$(echo "$img" | tr '/:@' '___').cdx.json" 2>/dev/null || true
      done < <(cfg_get images)
      n=0
      while read -r url; do
        [[ -n "$url" ]] || continue; n=$((n + 1))
        chmod 777 "$work"
        docker run --rm -v "$work:/zap/wrk" "$ZAP_IMAGE" zap-baseline.py -t "$url" -J "zap-$n.json" -I -m 3 >/dev/null 2>&1 || true
        specs+=("zap:$work/zap-$n.json")
        host="${url#*://}"; host="${host%%/*}"
        if [[ "$url" == https://* ]]; then
          docker run --rm "$TESTSSL_IMAGE" --quiet --severity HIGH --color 0 "$host" > "$repo/.security/reports/testssl-$host.txt" 2>&1 || true
          grep -E 'HIGH|CRITICAL' "$repo/.security/reports/testssl-$host.txt" | head -5 | sed 's/^/[security] testssl: /'
        fi
      done < <(cfg_get devUrls)
      report nightly; exit $?
    fi
    mkdir -p "$repo/.security"
    bun "$SEC_KIT/findings.ts" baseline --baseline "$baseline" "${specs[@]}" ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
