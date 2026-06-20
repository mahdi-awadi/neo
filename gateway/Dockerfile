# The gateway binary is built on the host by ./build.sh (it depends on the local /home/gopkg
# workspace via go.work, so a self-contained Docker build would have to ship all of gopkg).
# This image just packages the static, CGO-free binary into distroless.
#   ./build.sh && docker compose up -d --build
FROM gcr.io/distroless/static-debian12
COPY bin/neo-gateway /neo-gateway
EXPOSE 8080
ENTRYPOINT ["/neo-gateway"]
