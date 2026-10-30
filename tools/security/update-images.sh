#!/usr/bin/env bash
# Pull the latest scanner images and rewrite images.env with their digests.
# The osv-scanner binary for Go call analysis (ADR-0066) is pinned from the new OSV_IMAGE: its version and
# the SHA-256 of the binary in it. The release download must be that same file, or nothing is written.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
declare -A tags=(
  [SEMGREP_IMAGE]=semgrep/semgrep:latest [GITLEAKS_IMAGE]=zricethezav/gitleaks:latest
  [TRIVY_IMAGE]=aquasec/trivy:latest [OSV_IMAGE]=ghcr.io/google/osv-scanner:latest
  [HADOLINT_IMAGE]=hadolint/hadolint:latest-debian [GOSEC_IMAGE]=securego/gosec:latest
  [ZAP_IMAGE]=ghcr.io/zaproxy/zaproxy:stable [SYFT_IMAGE]=anchore/syft:latest
  [TESTSSL_IMAGE]=drwetter/testssl.sh:latest [GO_IMAGE]=golang:alpine
)
declare -A pin=()
for k in SEMGREP_IMAGE GITLEAKS_IMAGE TRIVY_IMAGE OSV_IMAGE HADOLINT_IMAGE GOSEC_IMAGE ZAP_IMAGE SYFT_IMAGE TESTSSL_IMAGE GO_IMAGE; do
  docker pull -q "${tags[$k]}" >/dev/null
  pin[$k]="$(docker image inspect --format '{{index .RepoDigests 0}}' "${tags[$k]}")"
done
version="$(docker run --rm "${pin[OSV_IMAGE]}" --version | sed -n 's/^osv-scanner version: //p')"
sha="$(docker run --rm --entrypoint sha256sum "${pin[OSV_IMAGE]}" /osv-scanner | cut -d' ' -f1)"
arch="$(docker version --format '{{.Server.Arch}}')"
url="https://github.com/google/osv-scanner/releases/download/v$version/osv-scanner_linux_$arch"
got="$(curl -fsSL "$url" | sha256sum | cut -d' ' -f1)"
[[ -n "$version" && "$got" == "$sha" ]] || { echo "osv-scanner $version release ($url) is not the binary in OSV_IMAGE — images.env unchanged" >&2; exit 1; }
{
  echo "# Scanner images, pinned by digest. Bump with: bash tools/security/update-images.sh"
  for k in SEMGREP_IMAGE GITLEAKS_IMAGE TRIVY_IMAGE OSV_IMAGE HADOLINT_IMAGE GOSEC_IMAGE ZAP_IMAGE SYFT_IMAGE TESTSSL_IMAGE; do
    echo "$k=${pin[$k]}"
  done
  echo "# Go call analysis for osv-scanner (ADR-0066): the Go image, and the osv-scanner binary of OSV_IMAGE"
  echo "GO_IMAGE=${pin[GO_IMAGE]}"
  echo "OSV_BIN_URL=$url"
  echo "OSV_BIN_SHA256=$sha"
} > "$here/images.env.new"
mv "$here/images.env.new" "$here/images.env"
echo "images.env updated"
