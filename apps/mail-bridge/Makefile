.PHONY: build test vet lint docker docker-multiarch tidy compose-examples

PKG := ./...
IMAGE ?= polaris-bridge:dev
MULTIARCH_IMAGE ?= ghcr.io/vladzaharia/polaris-mail-bridge:dev

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

# Build context is the repo root because the bridge's go.mod has a `replace`
# directive that points at ../../packages/sdk-go. Both targets below pass
# `..\/..` as the context and `-f Dockerfile` so they Just Work whether you
# run them from apps/mail-bridge or from the repo root via the root Makefile.
REPO_ROOT := ../..

docker:
	docker build -f Dockerfile -t $(IMAGE) $(REPO_ROOT)

# Multi-arch convenience target. Note: `--load` only works for single-platform
# builds, so this target produces an image that lives only in the buildx
# cache. To actually consume a multi-arch image locally, either:
#   - push to a registry: `make docker-multiarch BUILDX_OUTPUT="--push"`
#   - export an OCI tarball: `BUILDX_OUTPUT="--output type=oci,dest=out.tar"`
# Real publishing happens via the mail-bridge-image GitHub Actions workflow.
BUILDX_OUTPUT ?=
docker-multiarch:
	docker buildx build \
	  --platform linux/amd64,linux/arm64 \
	  -f Dockerfile \
	  -t $(MULTIARCH_IMAGE) \
	  $(BUILDX_OUTPUT) \
	  $(REPO_ROOT)

# Regenerate the in-repo example compose files from the bridge daemon's
# Go templates. CI has a drift gate that runs this target and fails on
# a non-empty `git diff --exit-code apps/mail-bridge/docker-compose.*.yml`.
#
# The image tag baked into the examples is taken from `cmds.Version`
# (the CLI's compiled-in version). On `main` that is the literal
# "dev"; goreleaser stamps a real version at release time.
COMPOSE_IMAGE_TAG ?=
compose-examples:
	cd $(REPO_ROOT)/apps/polaris-cli && go run ./cmd/render-compose-examples \
	  -out $(REPO_ROOT)/apps/mail-bridge \
	  $(if $(COMPOSE_IMAGE_TAG),-image-tag $(COMPOSE_IMAGE_TAG))
