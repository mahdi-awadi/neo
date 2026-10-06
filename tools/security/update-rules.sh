#!/usr/bin/env bash
# Cache the Semgrep registry packs locally so per-edit scans are fast and work offline.
# Run by install.ts and by the nightly sweep. A failed download keeps the previous copy.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dir="$here/rules/registry"; mkdir -p "$dir"
packs="owasp-top-ten secrets jwt xss sql-injection command-injection insecure-transport security-audit
dockerfile docker-compose javascript typescript react nodejs nodejsscan golang gosec python bandit flask
django php java csharp terraform kubernetes"
for p in $packs; do
  if curl -fsS -m 30 "https://semgrep.dev/c/p/$p" -o "$dir/$p.yml.tmp"; then mv "$dir/$p.yml.tmp" "$dir/$p.yml"
  else rm -f "$dir/$p.yml.tmp"; echo "[security] warn: could not refresh p/$p (kept old copy)" >&2; fi
done
echo "[security] semgrep packs cached in $dir"
