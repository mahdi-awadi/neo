#!/usr/bin/env bash
# Cache the Semgrep registry packs locally, then build the merged per-language rule files the scans
# load (rules.ts, ADR-0024). Run by install.ts and by the nightly sweep. A failed download keeps the
# previous copy.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dir="$here/rules/registry"; mkdir -p "$dir"
for p in $(bun "$here/rules.ts" packs); do
  if curl -fsS -m 30 "https://semgrep.dev/c/p/$p" -o "$dir/$p.yml.tmp"; then mv "$dir/$p.yml.tmp" "$dir/$p.yml"
  else rm -f "$dir/$p.yml.tmp"; echo "[security] warn: could not refresh p/$p (kept old copy)" >&2; fi
done
echo "[security] semgrep packs cached in $dir"
bun "$here/rules.ts" build "$here"
