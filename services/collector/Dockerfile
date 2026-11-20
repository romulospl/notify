# syntax=docker/dockerfile:1
# Image of the API metrics collector (#30). The build context is the repository
# root:
#   docker build -f services/collector/Dockerfile .

FROM golang:1.26.11-alpine@sha256:ecb67f987aa1a57794c91d19ade7ae0209f2f0f5496aaef9e6ae85ddf92d02ab AS build
WORKDIR /src/services
COPY services/go.mod services/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY services/collector collector
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/stellytics-collector ./collector/cmd/stellytics-collector && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/healthcheck ./collector/cmd/healthcheck

# No shell and no package manager: the two binaries and the configuration.
FROM scratch
COPY --from=build /out/stellytics-collector /stellytics-collector
COPY --from=build /out/healthcheck /healthcheck
COPY services/collector/config.yaml /etc/stellytics-collector/config.yaml
USER 65532:65532
EXPOSE 4317 4318
ENTRYPOINT ["/stellytics-collector"]
CMD ["--config", "/etc/stellytics-collector/config.yaml"]
