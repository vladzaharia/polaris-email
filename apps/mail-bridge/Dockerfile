# syntax=docker/dockerfile:1.7
FROM golang:1.25-alpine AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -ldflags="-s -w" -o /out/polaris-bridge ./cmd/polaris-bridge

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S polaris && adduser -S -G polaris polaris && \
    mkdir -p /var/lib/polaris-bridge /var/log/polaris-bridge /etc/polaris-bridge && \
    chown -R polaris:polaris /var/lib/polaris-bridge /var/log/polaris-bridge /etc/polaris-bridge
COPY --from=build /out/polaris-bridge /usr/local/bin/polaris-bridge
USER polaris
# SMTPS (465), IMAPS (993), JMAP/HTTPS (443). The container exposes all three;
# which actually listen is controlled by bridge.toml ([smtps].enabled etc.).
EXPOSE 465 993 443
ENTRYPOINT ["/usr/local/bin/polaris-bridge"]
