# The gateway binary is built on the host by ./build.sh (it depends on the local /home/gopkg
# workspace via go.work, so a self-contained Docker build would have to ship all of gopkg).
# This image just packages the static, CGO-free binary into distroless.
#   ./build.sh && docker compose up -d --build
# The :nonroot variant ships the unprivileged `nonroot` user (uid/gid 65532). The gateway only
# listens on an unprivileged port (LISTEN_ADDR, default :8080) and writes no files, so it needs no root.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --chmod=0555 bin/neo-gateway /neo-gateway
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/neo-gateway"]
