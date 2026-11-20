# syntax=docker/dockerfile:1
# Image of the API metrics rollup and retention job (#34). The build context
# is the repository root:
#   docker build -f services/rollup/Dockerfile .

FROM golang:1.26.11-alpine@sha256:ecb67f987aa1a57794c91d19ade7ae0209f2f0f5496aaef9e6ae85ddf92d02ab AS build
WORKDIR /src/services
COPY services/go.mod services/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY services/rollup rollup
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/rollup ./rollup

# No shell: the healthcheck uses the binary itself (rollup -healthcheck).
FROM scratch
COPY --from=build /out/rollup /rollup
ENV LISTEN_ADDR=:8080
USER 65532:65532
ENTRYPOINT ["/rollup"]
