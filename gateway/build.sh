#!/usr/bin/env sh
# Build the static, CGO-free gateway binary on the host (uses the local /home/gopkg workspace
# via go.work). The Dockerfile then packages bin/neo-gateway into a distroless image.
set -e
cd "$(dirname "$0")"
CGO_ENABLED=0 go build -trimpath -o bin/neo-gateway .
echo "built bin/neo-gateway ($(du -h bin/neo-gateway | cut -f1))"
