# Claude Simple — multi-machine gateway (Go)
#
# Build a single static-ish binary for your deploy target:
#   make build
#   make linux-amd64
#   make linux-arm64
#   make darwin-arm64

APP     := claude-gateway
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)
OUT     := dist

.PHONY: all build run tidy clean linux-amd64 linux-arm64 darwin-arm64 darwin-amd64 release

all: build

tidy:
	go mod tidy

build: tidy
	mkdir -p $(OUT)
	CGO_ENABLED=0 go build -ldflags '$(LDFLAGS)' -o $(OUT)/$(APP) .

run:
	@test -n "$$MACHINE_TOKEN" || (echo "MACHINE_TOKEN is required" && exit 1)
	go run . 

linux-amd64: tidy
	mkdir -p $(OUT)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags '$(LDFLAGS)' -o $(OUT)/$(APP)-linux-amd64 .

linux-arm64: tidy
	mkdir -p $(OUT)
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags '$(LDFLAGS)' -o $(OUT)/$(APP)-linux-arm64 .

darwin-arm64: tidy
	mkdir -p $(OUT)
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -ldflags '$(LDFLAGS)' -o $(OUT)/$(APP)-darwin-arm64 .

darwin-amd64: tidy
	mkdir -p $(OUT)
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -ldflags '$(LDFLAGS)' -o $(OUT)/$(APP)-darwin-amd64 .

release: linux-amd64 linux-arm64 darwin-arm64 darwin-amd64
	@ls -lh $(OUT)/

clean:
	rm -rf $(OUT)
