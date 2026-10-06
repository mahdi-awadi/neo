#!/usr/bin/env bash
# Pull the latest scanner images and rewrite images.env with their digests.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
declare -A tags=(
  [SEMGREP_IMAGE]=semgrep/semgrep:latest [GITLEAKS_IMAGE]=zricethezav/gitleaks:latest
  [TRIVY_IMAGE]=aquasec/trivy:latest [OSV_IMAGE]=ghcr.io/google/osv-scanner:latest
  [HADOLINT_IMAGE]=hadolint/hadolint:latest-debian [GOSEC_IMAGE]=securego/gosec:latest
  [ZAP_IMAGE]=ghcr.io/zaproxy/zaproxy:stable [SYFT_IMAGE]=anchore/syft:latest
  [TESTSSL_IMAGE]=drwetter/testssl.sh:latest
)
{
  echo "# Scanner images, pinned by digest. Bump with: bash tools/security/update-images.sh"
  for k in SEMGREP_IMAGE GITLEAKS_IMAGE TRIVY_IMAGE OSV_IMAGE HADOLINT_IMAGE GOSEC_IMAGE ZAP_IMAGE SYFT_IMAGE TESTSSL_IMAGE; do
    docker pull -q "${tags[$k]}" >/dev/null
    echo "$k=$(docker image inspect --format '{{index .RepoDigests 0}}' "${tags[$k]}")"
  done
} > "$here/images.env.new"
mv "$here/images.env.new" "$here/images.env"
echo "images.env updated"
