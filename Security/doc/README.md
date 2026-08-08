# Next-Gen IDS/IPS Detection Engine — Documentation

> Technical documentation for the Security component of the Next-Gen IDS/IPS with MLOps project.

## Structure

```
doc/
└── protocol/                   ← Per-protocol detection documentation
    ├── README.md               ← Protocol index
    └── ssh/
        └── README.md           ← SSH detection engine doc
```

## Quick Links

| Section | Description |
|:--------|:------------|
| [Protocol Documentation](protocol/README.md) | Per-protocol analyzer documentation |
| [SSH Detection Engine](protocol/ssh/README.md) | State machine, rules, configuration, known issues |

## Component Overview

The `Security/` directory contains a Go-based network security monitor with two operating modes:

| Mode | Description |
|:-----|:------------|
| **eBPF Monitor** | Kernel-level TC hook packet inspection via `bpf2go` |
| **Reverse Proxy** | Application-layer DPI — sits in front of services and inspects L7 traffic |
| **Integrated** | Both modes simultaneously |

### Key Source Files

| File | Role |
|:-----|:-----|
| `main.go` | CLI, mode selection, UI |
| `proxy/proxy.go` | Proxy engine, listener management, analyzer routing |
| `proxy/forwarder.go` | Bidirectional TCP relay, analyzer call hooks |
| `proxy/config.go` | YAML configuration types |
| `proxy_config.yaml` | Listener and detection configuration |
| `detect/detection.go` | Core types: Detection, Severity, DetectionBus |
| `detect/ssh_analyzer.go` | SSH stateful analyzer |
| `detect/http_analyzer.go` | HTTP DPI analyzer |
| `detect/behavioral.go` | Cross-protocol behavioral engine |
