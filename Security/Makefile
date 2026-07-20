# NGFW eBPF Traffic Monitor — Makefile
# ─────────────────────────────────────────────────────────────────────────────

BINARY   := ngfw-monitor
GOPATH   := $(shell go env GOPATH)
export PATH := $(GOPATH)/bin:$(PATH)

.PHONY: all generate build run clean help

all: generate build ## Full build: compile eBPF + Go binary

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

deps: ## Install Go dependencies
	go get github.com/cilium/ebpf@latest
	go get github.com/charmbracelet/lipgloss@latest
	go install github.com/cilium/ebpf/cmd/bpf2go@latest

generate: ## Compile eBPF C → Go bindings via bpf2go
	go generate

build: ## Build the Go binary
	go build -o $(BINARY)

run: build ## Build + run with sudo
	sudo ./$(BINARY)

run-port: build ## Build + run on a specific port (usage: make run-port PORT=8080)
	sudo ./$(BINARY) -port $(PORT)

run-proxy: build ## Build + run the reverse proxy engine with detection
	sudo ./$(BINARY) --proxy --config proxy_config.yaml

clean: ## Remove generated files and binary
	rm -f $(BINARY)
	rm -f bpf_bpfel.go bpf_bpfeb.go bpf_bpfel.o bpf_bpfeb.o
