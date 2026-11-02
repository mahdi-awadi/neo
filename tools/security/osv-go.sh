#!/bin/sh
# osv-scanner with Go call analysis, run by scan.sh inside the pinned Go image (ADR-0066).
#
#   osv-go.sh <repo> <modules list> <versions out> <cache dir>
#   env: OSV_BIN_URL, OSV_BIN_SHA256; GOWORK=off and GOFLAGS come from scan.sh, which also runs the whole
#   script under `timeout` (osvTimeoutSec)
#
# The osv-scanner binary is the release file of OSV_IMAGE's version, kept in the cache folder and checked
# against OSV_BIN_SHA256 before every run. Exit 97: no binary that matches (scan.sh then scans without
# the analysis).
set -eu
repo=$1 modules=$2 versions=$3 cache=$4
bin="$cache/bin/osv-scanner-$OSV_BIN_SHA256"
matches() { echo "$OSV_BIN_SHA256  $1" | sha256sum -c >/dev/null 2>&1; }

if ! matches "$bin"; then
  mkdir -p "$cache/bin"
  tmp=$(mktemp "$cache/bin/dl.XXXXXX")
  if ! wget -q -O "$tmp" "$OSV_BIN_URL"; then rm -f "$tmp"; echo "osv-scanner download failed: $OSV_BIN_URL" >&2; exit 97; fi
  if ! matches "$tmp"; then rm -f "$tmp"; echo "osv-scanner download does not match OSV_BIN_SHA256" >&2; exit 97; fi
  chmod 755 "$tmp"
  mv -f "$tmp" "$bin"
fi

# The module versions Go selects for each module on its own: findings.ts uses a verdict only when the
# analysed version is the one osv reports. A module that does not load writes nothing (full severity).
: > "$versions"
while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  (cd "$dir" && go list -m -f '{{.Path}} {{.Version}}{{with .Replace}} {{.Path}} {{.Version}}{{end}}' all 2>/dev/null) |
    while IFS= read -r line; do printf '%s/go.mod %s\n' "$dir" "$line"; done >> "$versions" || true
done < "$modules"

exec "$bin" scan source -r --format json "$repo"
