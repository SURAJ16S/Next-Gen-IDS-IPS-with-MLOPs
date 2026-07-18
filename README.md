# NGFW — eBPF Traffic Monitor

A Go-based desktop CLI application that uses **eBPF TC (Traffic Control) hooks** to monitor incoming and outgoing TCP/UDP traffic on a user-specified port in real time. This is the foundation for a **Next-Generation Firewall (NGFW)** application.

## How It Works

```
┌──────────────────────────────────────────────────┐
│                  Linux Kernel                     │
│                                                   │
│  ┌─────────┐    TC Ingress    ┌──────────────┐   │
│  │ Network  │───────────────▶│  eBPF Program  │   │
│  │Interface │    TC Egress    │  (monitor.c)   │   │
│  │ (eth0)  │◀───────────────│               │   │
│  └─────────┘                 └──────┬───────┘   │
│                                      │            │
│                              Ring Buffer          │
│                                      │            │
├──────────────────────────────────────┼────────────┤
│              User Space              │            │
│                                      ▼            │
│                              ┌──────────────┐    │
│                              │  Go App       │    │
│                              │  (main.go)    │    │
│                              │  Dashboard    │    │
│                              └──────────────┘    │
└──────────────────────────────────────────────────┘
```

1. **eBPF C code** (`ebpf/monitor.c`) runs inside the Linux kernel, attached to TC ingress and egress hooks
2. Packets matching the user's target port are captured and pushed to a **ring buffer**
3. **Go application** (`main.go`) reads events from the ring buffer and displays them in a rich terminal dashboard

## Prerequisites

- **Linux** with kernel 6.6+ (for TCX support)
- **Go** 1.23+
- **Clang/LLVM** (for compiling eBPF C code)
- **libbpf-dev** and **linux-headers**

```bash
sudo apt update
sudo apt install -y golang clang llvm libbpf-dev linux-headers-$(uname -r)
```

## Build

```bash
# Install Go dependencies
make deps

# Compile eBPF + build Go binary
make all
```

## Usage

### Interactive mode (prompts for port)
```bash
sudo ./ngfw-monitor
```

### CLI flags
```bash
# Monitor port 8080 on eth0
sudo ./ngfw-monitor -port 8080

# Monitor port 443 on a different interface
sudo ./ngfw-monitor -port 443 -iface wlan0
```

### Using Make
```bash
make run                  # Interactive mode
make run-port PORT=8080   # Specify port
```

## Dashboard

The terminal dashboard shows:
- **Live packet table** — scrolling list of the last 50 captured packets
- **Direction** — ⬇ INCOMING (green) / ⬆ OUTGOING (red)
- **Source & Destination** — IP:Port pairs
- **Protocol** — TCP or UDP
- **Packet size** — in human-readable format
- **Stats panel** — total packets, ingress/egress counts, bytes, packets/sec

Press **Ctrl+C** to gracefully stop monitoring and detach eBPF programs.

## Project Structure

```
NGFW/
├── ebpf/
│   └── monitor.c          # eBPF kernel program (TC hooks)
├── gen.go                  # go:generate directive for bpf2go
├── bpf_bpfel.go            # Auto-generated Go bindings (little-endian)
├── bpf_bpfel.o             # Compiled eBPF bytecode
├── bpf_bpfeb.go            # Auto-generated Go bindings (big-endian)
├── bpf_bpfeb.o             # Compiled eBPF bytecode
├── main.go                 # Go application with terminal dashboard
├── go.mod                  # Go module definition
├── go.sum                  # Go dependency checksums
├── Makefile                # Build automation
├── portMonitor.txt         # Original design document
└── README.md               # This file
```

## Extending to a Full NGFW

This monitor is the foundation. To build a complete firewall:

1. **Payload inspection**: Use `bpf_skb_load_bytes` to grab HTTP/SSH payloads
2. **IP blocking**: Add a `blocked_ips` BPF map; return `TC_ACT_SHOT` to drop packets
3. **Central management**: Export events as JSON via WebSocket to a dashboard
4. **Rule engine**: Define firewall rules in Go that update eBPF maps dynamically

## License

GPL-2.0
