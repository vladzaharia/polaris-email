.PHONY: build test vet lint release-dryrun clean

BIN := bin/polaris-email
PKG := ./...

build:
	mkdir -p bin
	go build -o $(BIN) ./cmd/polaris-email
	ln -sf polaris-email bin/pml

test:
	go test -count=1 $(PKG)

vet:
	go vet $(PKG)

lint: vet
	@echo "use 'golangci-lint run' for richer linting"

release-dryrun:
	goreleaser release --snapshot --clean --skip=publish

clean:
	rm -rf bin dist
