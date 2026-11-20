# syntax=docker/dockerfile:1
# Web ingestion gateway image. The build context is the repository root:
#   docker build -f services/ingest-web/Dockerfile .

FROM golang:1.26.11-alpine@sha256:ecb67f987aa1a57794c91d19ade7ae0209f2f0f5496aaef9e6ae85ddf92d02ab AS build
WORKDIR /src/services
COPY services/go.mod services/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY services/ingest-web ingest-web
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ingest-web ./ingest-web

# No shell or package manager: only the binary and the scripts.
# The healthcheck uses the binary itself (ingest-web -healthcheck).
FROM scratch
COPY --from=build /out/ingest-web /ingest-web
# Published script versions (/s/vX.Y.Z/n.js); the build fails without them.
COPY packages/tracker/published /scripts
ENV LISTEN_ADDR=:8080 \
    SCRIPT_DIR=/scripts
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/ingest-web"]
