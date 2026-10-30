#!/usr/bin/env bash
# One entry point for every layer of the security checks.
#
#   scan.sh file   <repo> <file>...   write-time (Claude Code hook): semgrep + gitleaks on the files
#   scan.sh staged <repo>             pre-commit: staged files only, < ~10 s
#   scan.sh push   <repo> [log-opts]  pre-push: the commits not yet pushed (default "HEAD --not --remotes"),
#                                     their files, deps, Dockerfiles, security tests
#   scan.sh full   <repo>             nightly: everything, full git history, images, SBOM, DAST on dev
#   scan.sh baseline <repo>           record today's findings as the baseline (tracked, not blocking)
#
# Exit 1 = new high/critical findings (blocks). Exit 0 = clean, only baselined/low findings, or a scan
# that could not run (it warns). Reports are written only for repos with .security/config.json.
# Per-project settings live in <repo>/.security/config.json (devUrls, images, testCmd, zapAuth,
# semgrepChunkFiles, semgrepTimeoutSec, osvMemoryMb, osvTimeoutSec, osvGoTags). A scan part with no result is recorded as missing
# (ADR-0051).
set -uo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

mode="${1:-}"; repo="$(cd "${2:-.}" && git rev-parse --show-toplevel 2>/dev/null || pwd)"; shift 2 2>/dev/null || shift $#
cfg="$repo/.security/config.json"; baseline="$repo/.security/baseline.json"
work="$(mktemp -d /tmp/neo-sec.XXXXXX)"; trap 'rm -rf "$work"' EXIT
specs=()

src="$repo" # where the scanned files are read from (staged: a copy of the index)
# Inner limit for one gitleaks run in its warm container, so a hook killed by its own timeout
# never leaves a scan running there. The write-time hook allows 60 s.
inner_timeout=$([[ "$mode" == file ]] && echo 50 || echo 1800)

cfg_get() { # key → the value (arrays one per line)
  [[ -f "$cfg" ]] && bun -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=c[process.argv[2]];if(v!==undefined)console.log(Array.isArray(v)?v.join("\n"):typeof v==="object"?JSON.stringify(v):v)' "$cfg" "$1" 2>/dev/null
}
cfg_int() { # key default → a positive integer from config.json, else the default
  local v; v="$(cfg_get "$1")"
  if [[ "$v" =~ ^[1-9][0-9]{0,6}$ ]]; then echo "$v"; else echo "$2"; fi
}

# Semgrep runs in parts (ADR-0051): each part is staged, scanned and removed on its own, under its own
# time limit, so a slow part loses only its own files. Per repo in .security/config.json.
semgrep_part="$(cfg_int semgrepChunkFiles 200)"
semgrep_timeout=$([[ "$mode" == file ]] && echo 50 || cfg_int semgrepTimeoutSec 1800)
# A scan that produced no result is a missing part, recorded in the baseline/report (ADR-0051).
missing_part() { printf '%s\t%s\n' "$1" "$2" >> "$work/missing"; } # tool detail

if ! sec_have_docker; then sec_warn "docker unavailable — security scan skipped"; exit 0; fi

# Semgrep and file-gitleaks run in the background (both in warm containers); report() waits for them.
run_semgrep() { # repo-relative files...
  (($#)) || return 0
  local rel=("$@") n=$((($# + semgrep_part - 1) / semgrep_part)) k
  local deep=(); [[ "${SEC_DEEP:-0}" == 1 ]] && deep=(--deep)
  for ((k = 1; k <= n; k++)); do specs+=("semgrep:$work/semgrep-$k.json"); done
  (
    sec_warm "$SEC_SEMGREP_CTR" "$SEMGREP_IMAGE" || {
      sec_warn "semgrep container did not start — skipped"; missing_part semgrep "all $n parts: the container did not start"; exit 0
    }
    for ((k = 1; k <= n; k++)); do
      part=("${rel[@]:$(((k - 1) * semgrep_part)):$semgrep_part}")
      mapfile -t configs < <(bun "$SEC_KIT/rules.ts" configs "${deep[@]}" --base /kit/rules "${part[@]}")
      id="$(sec_stage "$SEC_SEMGREP_CTR" "$src" "${part[@]}")" || {
        sec_warn "could not stage semgrep part $k/$n — skipped"; missing_part semgrep "part $k/$n (${#part[@]} files): could not stage its files"; continue
      }
      docker exec -w "/scan/$id" "$SEC_SEMGREP_CTR" timeout "$semgrep_timeout" semgrep scan --experimental --metrics=off \
        --disable-version-check --quiet --json --timeout 20 "${configs[@]}" "${part[@]}" > "$work/semgrep-$k.json" 2>"$work/semgrep-$k.err"
      if [[ ! -s "$work/semgrep-$k.json" ]]; then # semgrep exits non-zero with findings too: only no output is a miss
        sec_warn "semgrep part $k/$n did not finish (timeout ${semgrep_timeout}s or error) — its findings are missing"
        missing_part semgrep "part $k/$n (${#part[@]} files, from ${part[0]}): no output — timeout ${semgrep_timeout}s or error"
      fi
      sec_unstage "$SEC_SEMGREP_CTR" "$id"
    done
  ) &
}

run_gitleaks_files() { # repo-relative files...
  (($#)) || return 0
  local rel=() f; for f in "$@"; do [[ -f "$src/$f" ]] && rel+=("$f"); done
  ((${#rel[@]})) || return 0
  specs+=("gitleaks:$work/gitleaks-files.json")
  (
    sec_warm "$SEC_GITLEAKS_CTR" "$GITLEAKS_IMAGE" || {
      sec_warn "gitleaks container did not start — skipped"; missing_part gitleaks "file scan: the container did not start"; exit 0
    }
    id="$(sec_stage "$SEC_GITLEAKS_CTR" "$src" "${rel[@]}")" || {
      sec_warn "could not stage files for gitleaks — skipped"; missing_part gitleaks "file scan: could not stage its files"; exit 0
    }
    docker exec -w "/scan/$id" "$SEC_GITLEAKS_CTR" timeout "$inner_timeout" gitleaks dir . --no-banner --exit-code 0 --report-format json \
      --report-path "/tmp/$id.json" >/dev/null 2>&1
    docker exec "$SEC_GITLEAKS_CTR" cat "/tmp/$id.json" > "$work/gitleaks-files.json" 2>/dev/null
    [[ -s "$work/gitleaks-files.json" ]] || missing_part gitleaks "file scan (${#rel[@]} files): no output — timeout ${inner_timeout}s or error"
    docker exec "$SEC_GITLEAKS_CTR" rm -f "/tmp/$id.json" >/dev/null 2>&1
    sec_unstage "$SEC_GITLEAKS_CTR" "$id"
  ) &
}

run_gitleaks_git() { # log-opts
  # A worktree's .git is a file pointing at the main repo's git dir: mount that too, or gitleaks sees
  # no repository and reports "no leaks" for history it never read.
  local common mounts=(-v "$repo:$repo:ro")
  common="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  [[ -n "$common" && "$common" != "$repo/.git" ]] && mounts+=(-v "$common:$common:ro")
  mkdir -p "$work/gl"
  docker run --rm "${mounts[@]}" -v "$work/gl:/out" -w "$repo" "$GITLEAKS_IMAGE" git "$repo" --no-banner \
    --exit-code 0 --log-opts="$1" --report-format json --report-path /out/gitleaks-git.json >"$work/gl/err" 2>&1
  [[ -f "$work/gl/gitleaks-git.json" ]] || {
    sec_warn "gitleaks history scan failed: $(tail -1 "$work/gl/err")"; missing_part gitleaks "history scan ($1): no report"
  }
  specs+=("gitleaks:$work/gl/gitleaks-git.json")
}

run_hadolint() { # repo-relative dockerfiles...
  local f n=0
  for f in "$@"; do
    n=$((n + 1))
    docker run --rm -i "$HADOLINT_IMAGE" hadolint --no-fail -f json - < "$src/$f" 2>/dev/null \
      | bun -e "const a=JSON.parse(await Bun.stdin.text()||'[]');console.log(JSON.stringify(a.map(x=>({...x,file:process.argv[1]}))))" "$f" \
      > "$work/hadolint-$n.json" || true
    specs+=("hadolint:$work/hadolint-$n.json")
  done
}

# osv-scanner runs Go call analysis (govulncheck) only with a Go toolchain on PATH (ADR-0066), so it runs
# in the pinned Go image through osv-go.sh. The repo is mounted as a copy-on-write overlay (Docker's
# local volume driver mounts it; the container gets no extra rights): Go may write go.sum files, the
# writes land in $work, and paths, so fingerprints, are unchanged. Each module is analysed on its own
# (GOWORK=off), the way its own build sees it; gomods.ts links a local replace target that is only a
# mount placeholder to the repo's module of that path, inside the overlay. One Go analysis at a time on
# the host (memory). No usable result (no binary, out of memory or time, no overlay, invalid output):
# the plain osv image scans read-only, and every Go finding keeps its full severity (findings.ts).
osv_go_lock="${NEO_SEC_OSV_LOCK:-/tmp/neo-sec-osv-go.lock}" # one Go analysis at a time on this host

run_osv() {
  local mem limit tags fd line failed=()
  mem="$(cfg_int osvMemoryMb 8192)"; limit="$(cfg_int osvTimeoutSec 2400)"; tags="$(cfg_get osvGoTags)"
  [[ "$tags" =~ ^[A-Za-z0-9_.,]*$ ]] || { sec_warn "osvGoTags ignored: only letters, digits, _ . and , are allowed"; tags=""; }
  mkdir -p "$work/osv-up" "$work/osv-wk" "$work/osv-meta"
  : > "$work/osv-go.err"
  if [[ "$repo$work" =~ [,\"=:\\] ]]; then # these would break the overlay's mount options
    echo "the repo path holds a character the overlay mount cannot take" >> "$work/osv-go.err"
  elif ! bun "$SEC_KIT/gomods.ts" prepare --repo "$repo" --upper "$work/osv-up" --list "$work/osv-meta/modules.txt" 2>>"$work/osv-go.err"; then
    echo "could not list the Go modules" >> "$work/osv-go.err"
  else
    exec {fd}>"$osv_go_lock"
    if flock -w "$limit" "$fd"; then
      # No swap: an analysis too big for the limit fails fast (full severity) instead of thrashing the host.
      # GOMEMLIMIT makes osv's in-process govulncheck collect harder before it reaches the limit.
      docker run --rm --memory "${mem}m" --memory-swap "${mem}m" -e GOMEMLIMIT="$((mem * 85 / 100))MiB" \
        --mount "type=volume,dst=$repo,volume-driver=local,volume-opt=type=overlay,volume-opt=device=overlay,\"volume-opt=o=lowerdir=$repo,upperdir=$work/osv-up,workdir=$work/osv-wk\"" \
        -v neo-sec-gocache:/neo -v "$work/osv-meta:/meta" -v "$SEC_KIT/osv-go.sh:/kit/osv-go.sh:ro" \
        -e GOMODCACHE=/neo/mod -e GOCACHE=/neo/build -e CGO_ENABLED=0 -e GOWORK=off \
        -e GOFLAGS="-buildvcs=false -mod=readonly${tags:+ -tags=$tags}" -e OSV_TIMEOUT="$limit" \
        -e OSV_BIN_URL="$OSV_BIN_URL" -e OSV_BIN_SHA256="$OSV_BIN_SHA256" \
        --entrypoint sh "$GO_IMAGE" /kit/osv-go.sh "$repo" /meta/modules.txt /meta/go-versions.txt /neo \
        > "$work/osv.json" 2>>"$work/osv-go.err" || true
    else
      echo "another Go analysis held the host lock for ${limit}s" >> "$work/osv-go.err"
    fi
    exec {fd}>&-
  fi
  if ! bun "$SEC_KIT/findings.ts" json-ok "$work/osv.json"; then
    rm -f "$work/osv-meta/go-versions.txt"
    sec_warn "osv-scanner with Go call analysis gave no result ($(grep -v '^Scanned' "$work/osv-go.err" | tail -1)) — scanned without it; Go findings keep full severity"
    docker run --rm -v "$repo:$repo:ro" "$OSV_IMAGE" scan source -r --format json "$repo" > "$work/osv.json" 2>/dev/null || true
  else
    while IFS= read -r line; do
      [[ "$line" =~ ^Failed\ to\ run\ code\ analysis\ \(govulncheck\)\ on\ \'(.*)\'\ because ]] && failed+=("${BASH_REMATCH[1]#"$repo"/}")
    done < "$work/osv-go.err"
    ((${#failed[@]})) && sec_warn "Go call analysis failed for ${failed[*]} — their Go findings keep full severity"
  fi
  specs+=("osv:$work/osv.json")
}

run_trivy_fs() { # scanners (the kit's rule packs quote example secrets: never scanned as project code)
  docker run --rm -v "$repo:$repo:ro" -v neo-sec-trivy-cache:/root/.cache "$TRIVY_IMAGE" fs --quiet --format json \
    --scanners "$1" --severity MEDIUM,HIGH,CRITICAL --skip-dirs node_modules --skip-dirs .git \
    --skip-dirs "**/tools/security/rules" "$repo" > "$work/trivy-fs.json" 2>/dev/null || true
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
  wait # the background scanners
  local out=() rc
  if [[ -f "$cfg" ]]; then # only a repo that turned the checks on (init.ts) gets report files
    mkdir -p "$repo/.security/reports"
    out=(--out "$repo/.security/reports/$1-$(date +%Y%m%d-%H%M%S).json")
  fi
  bun "$SEC_KIT/findings.ts" report --root "$repo" --src "$src" --baseline "$baseline" "${out[@]}" --label "$1" \
    --missing "$work/missing" --osv-go-versions "$work/osv-meta/go-versions.txt" "${specs[@]}"
  rc=$?
  ls -1t "$repo/.security/reports/$1-"*.json 2>/dev/null | tail -n +31 | xargs -r rm -f # keep 30 per layer
  [[ $rc -eq 3 ]] && return 0 # the baseline is unreadable: findings.ts warned; never block on that
  return $rc
}

is_dockerfile() { [[ "${1##*/}" =~ ^Dockerfile|\.dockerfile$ ]]; }
list_dockerfiles() { git -C "$repo" ls-files | while read -r f; do is_dockerfile "$f" && echo "$f"; done; }
scannable() { local f; for f in "$@"; do sec_scannable "$src/$f" && echo "$f"; done; }

case "$mode" in
  file)
    rel=(); for f in "$@"; do f="$(realpath -m "$f")"; [[ "$f" == "$repo/"* ]] && rel+=("${f#"$repo"/}"); done
    mapfile -t files < <(scannable "${rel[@]}")
    ((${#files[@]})) || exit 0
    run_semgrep "${files[@]}"; run_gitleaks_files "${files[@]}"
    report write ;;
  staged)
    # Scan what will be committed: the index, not the working tree (a staged secret removed from the
    # working copy afterwards is still committed).
    mapfile -t staged < <(git -C "$repo" diff --cached --name-only --diff-filter=ACMR)
    ((${#staged[@]})) || exit 0
    src="$work/idx"; mkdir -p "$src"
    git -C "$repo" checkout-index --prefix="$src/" -- "${staged[@]}" 2>/dev/null
    mapfile -t files < <(scannable "${staged[@]}")
    dfs=(); for f in "${staged[@]}"; do is_dockerfile "$f" && dfs+=("$f"); done
    run_semgrep "${files[@]}"; run_gitleaks_files "${staged[@]}"; run_hadolint "${dfs[@]}"
    report commit ;;
  push)
    # The commits not yet on any remote. The pre-push hook passes "<local sha>... --not --remotes".
    range="${1:-HEAD --not --remotes}"; read -ra logargs <<<"$range"
    mapfile -t changed < <(git -C "$repo" log --name-only --format= --diff-filter=ACMR "${logargs[@]}" 2>/dev/null | sort -u)
    mapfile -t files < <(scannable "${changed[@]}")
    mapfile -t dfs < <(list_dockerfiles)
    SEC_DEEP=1 run_semgrep "${files[@]}"; run_gitleaks_git "$range"; run_osv; run_trivy_fs misconfig; run_hadolint "${dfs[@]}"
    printf '%s\n' "${changed[@]}" | grep -q '\.go$' && run_gosec
    rc=0; report push || rc=1; run_tests || rc=1; exit $rc ;;
  full|baseline)
    mapfile -t all < <(git -C "$repo" ls-files)
    mapfile -t keep < <(scannable "${all[@]}")
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
        # ZAP runs as its own user: open only its folder, never $work (raw scanner output lives there).
        mkdir -p "$work/zap"; chmod 777 "$work/zap"
        docker run --rm -v "$work/zap:/zap/wrk" "$ZAP_IMAGE" zap-baseline.py -t "$url" -J "zap-$n.json" -I -m 3 >/dev/null 2>&1 || true
        specs+=("zap:$work/zap/zap-$n.json")
        host="${url#*://}"; host="${host%%/*}"
        if [[ "$url" == https://* ]]; then
          mkdir -p "$repo/.security/reports"
          docker run --rm "$TESTSSL_IMAGE" --quiet --severity HIGH --color 0 "$host" > "$repo/.security/reports/testssl-$host.txt" 2>&1 || true
          grep -E 'HIGH|CRITICAL' "$repo/.security/reports/testssl-$host.txt" | head -5 | sed 's/^/[security] testssl: /'
        fi
      done < <(cfg_get devUrls)
      report nightly; exit $?
    fi
    wait; mkdir -p "$repo/.security"
    bun "$SEC_KIT/findings.ts" baseline --root "$repo" --baseline "$baseline" --missing "$work/missing" \
      --osv-go-versions "$work/osv-meta/go-versions.txt" "${specs[@]}" ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
