# syntax=docker/dockerfile:1.7
#
# Build context: this Dockerfile expects the REPO ROOT as the build context,
# not `apps/mail-bridge/`. The bridge's go.mod has a `replace` directive
# pointing at ../../packages/sdk-go, so the sibling package has to be visible
# in the context. Build commands:
#   docker build -f apps/mail-bridge/Dockerfile .
#   make docker        (sets context to repo root)
# CI's `mail-bridge-image.yml` mirrors this.

# --platform=$BUILDPLATFORM keeps the builder on the host arch even when
# producing a foreign-arch binary, so we cross-compile via Go's GOOS/GOARCH
# instead of emulating the whole toolchain through QEMU. This trims a
# multi-arch build from ~25 min to ~6 min in CI.
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src

# Copy the bridge module + its sibling SDK package so the `replace` directive
# in apps/mail-bridge/go.mod resolves inside the build context.
COPY apps/mail-bridge/go.mod apps/mail-bridge/go.sum ./apps/mail-bridge/
COPY packages/sdk-go ./packages/sdk-go
WORKDIR /src/apps/mail-bridge
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
RUN go mod download

# Source last so go.mod/go.sum changes don't invalidate the source layer.
COPY apps/mail-bridge/ ./
RUN GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    go build -ldflags="-s -w" -o /out/polaris-bridge ./cmd/polaris-bridge

FROM alpine:3.21
# procps brings `pgrep`, which the HEALTHCHECK below relies on.
RUN apk add --no-cache ca-certificates tzdata procps && \
    addgroup -S polaris && adduser -S -G polaris polaris && \
    mkdir -p /var/lib/polaris-bridge /var/log/polaris-bridge /etc/polaris-bridge && \
    chown -R polaris:polaris /var/lib/polaris-bridge /var/log/polaris-bridge /etc/polaris-bridge
COPY --from=build /out/polaris-bridge /usr/local/bin/polaris-bridge
USER polaris
# SMTPS (465), IMAPS (993), JMAP/HTTPS (443). The container exposes all three;
# which actually listen is controlled by bridge.toml ([smtps].enabled etc.).
EXPOSE 465 993 443

# Process-liveness only — accurate enough for `docker compose ps` and
# orchestrator restarts. Per-port reachability checks would require a TLS
# client and certs in the container; the bridge logs port-bind failures
# loudly enough that liveness is the right signal here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD pgrep -f polaris-bridge || exit 1

# OCI annotations — GHCR renders these on the package page.
LABEL org.opencontainers.image.source="https://github.com/vladzaharia/polaris-email" \
      org.opencontainers.image.description="polaris-email mail-bridge — SMTPS + IMAP4rev2 in one Go binary" \
      org.opencontainers.image.title="polaris-mail-bridge" \
      org.opencontainers.image.vendor="polaris-email"

ENTRYPOINT ["/usr/local/bin/polaris-bridge"]
