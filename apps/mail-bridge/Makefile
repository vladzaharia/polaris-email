.PHONY: build test vet lint docker tidy

PKG := ./...
IMAGE ?= polaris-bridge:dev

build:
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/polaris-bridge ./cmd/polaris-bridge

test:
	go test $(PKG)

vet:
	go vet $(PKG)

lint:
	@which golangci-lint >/dev/null 2>&1 || { echo "install golangci-lint first"; exit 1; }
	golangci-lint run

tidy:
	go mod tidy

docker:
	docker build -t $(IMAGE) .
