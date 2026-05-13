# syntax=docker/dockerfile:1.7
FROM golang:1.22-alpine AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -ldflags="-s -w" -o /out/polaris-daemon ./cmd/polaris-daemon

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S polaris && adduser -S -G polaris polaris && \
    mkdir -p /var/lib/polaris-daemon /var/log/polaris-daemon && \
    chown -R polaris:polaris /var/lib/polaris-daemon /var/log/polaris-daemon
COPY --from=build /out/polaris-daemon /usr/local/bin/polaris-daemon
USER polaris
EXPOSE 465
ENTRYPOINT ["/usr/local/bin/polaris-daemon"]
