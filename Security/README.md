# Next-Gen-IDS-IPS-with-MLOPs

A comprehensive Go-based **Next-Generation Intrusion Detection and Prevention System (IDS/IPS)** that leverages **eBPF TC (Traffic Control) hooks** for high-performance packet monitoring and a **Layer 7 Reverse Proxy Engine** for Deep Packet Inspection (DPI) and behavioral analysis. Together, these form the data-collection foundation for a **Next-Generation Firewall (NGFW)** powered by MLOps.

## Core Architecture

The application features a dual-engine architecture:

### 1. eBPF Packet Monitor Engine
```text
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

1. **eBPF C code** (`ebpf/monitor.c`) runs inside the Linux kernel, attached to TC ingress and egress hooks.
2. Packets matching the user's target port are captured and pushed to a **ring buffer**.
3. **Go application** (`main.go`) reads events from the ring buffer, groups them into bidirectional flows, and displays them in a rich terminal dashboard.

### 2. Layer 7 Proxy & DPI Engine
When run with `--proxy`, the engine intercepts incoming connections using standard Go network listeners (as configured in `proxy_config.yaml`). It proxies traffic to the real backend while passively copying the byte stream. The `detect/` package continuously analyzes the payloads (HTTP, TLS, etc.), extracts machine-learning features (like entropy and character ratios), and streams detections to `logs/detections.jsonl`.

---

## Features

### Advanced Protocol Analyzers
- **HTTP**: Detects SQLi, XSS, Path Traversal, Command Injection, SSRF, XXE, Log4Shell, HTTP Smuggling, and more.
- **SSH**: Analyzes version exchanges, detects weak KEX/Ciphers/MACs, computes Hassh fingerprints, and flags tunneling.
- **DNS**: Detects DNS tunneling, Domain Generation Algorithms (DGA), DNS rebinding, zone transfers, and NXDOMAIN floods.
- **Database (MySQL, PostgreSQL, Redis, MongoDB)**: Tracks authentication, detects dangerous commands, and flags SQL injection in queries.
- **SMTP & FTP**: Detects open relays, spam indicators, anonymous logins, FTP bounce attacks, and brute-force attempts.
- **TLS**: Deep parsing of ClientHello, JA3 fingerprinting, and detection of weak cipher suites or expired/self-signed certificates.

### Cross-Protocol Behavioral Engine
- **Port Scanning & Brute-Force**: Sliding-window rate limiters to detect scanners and auth brute-forcing.
- **C2 & Beaconing**: Analyzes connection intervals to detect Command & Control beaconing.
- **Data Exfiltration**: Tracks outbound data volumes per IP.

### Additional Features
- **Protocol Fingerprinting (Magic Bytes)**: Identifies the true application protocol regardless of the port (e.g., catching SSH running on port 80).
- **TLS Interception (MITM)**: On-the-fly certificate generation to inspect encrypted traffic.
- **JSONL Structured Logging**: Automated rotation and structured logging for connections (`connections.jsonl`) and detections (`detections.jsonl`).
- **Raw Traffic Dumping**: Captures raw request bytes to `proxy-output.json` for forensic analysis.

---

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

---

## Execution Steps

### 1. Reverse Proxy Mode (IDS/IPS Engine)
Run the application in Layer 7 proxy mode to inspect traffic content, detect attacks (SQLi, brute-force, etc.), and generate JSONL logs based on the provided configuration (`proxy_config.yaml`).

```bash
sudo ./ngfw-monitor --proxy --config proxy_config.yaml
```

**Testing the Proxy with OWASP Juice Shop:**
You can test the reverse proxy by running a vulnerable application like OWASP Juice Shop on a backend port (e.g., 13000) while the proxy listens on port 3000.

1. Start Juice Shop on the backend port:
   ```bash
   PORT=13000 npm start
   ```
2. Run the proxy with `proxy_config.yaml` (configured to map port 3000 -> 127.0.0.1:13000).
   ```bash
   sudo ./ngfw-monitor --proxy --config proxy_config.yaml
   ```
3. Test the connection through the proxy:
   ```bash
   curl -I http://127.0.0.1:3000
   ```
   *Any attacks (like SQL injection or XSS) sent to port 3000 will be detected by the HTTP Analyzer and logged.*

### 2. Interactive Packet Monitor Mode (eBPF)
Monitor traffic on a specific port in real-time via the kernel-level eBPF dashboard.

```bash
# Interactive mode (prompts for port)
sudo ./ngfw-monitor

# Or specify a port and interface directly
sudo ./ngfw-monitor --port 8080 --iface eth0
```

---

## Project Structure

```text
Security/
├── ebpf/
│   └── monitor.c           # eBPF kernel program (TC hooks)
├── detect/                 # Deep Packet Inspection & ML feature extraction
│   ├── behavioral.go       # Cross-connection pattern tracking (Port Scans, C2, Brute-force)
│   ├── detection.go        # Detection framework, severity levels, event bus
│   ├── flow_logger.go      # eBPF flow aggregation logic
│   ├── flow_tracker.go     # TCP state and flow timing
│   ├── http_analyzer.go    # HTTP structural extraction & signatures
│   ├── payload_stats.go    # Entropy and character ratio math
│   ├── protocol_detect.go  # Magic-byte protocol identification
│   ├── session_tracker.go  # IP/User-Agent session tracking
│   ├── stats.go            # General statistical helpers
│   ├── tls_inspect.go      # TLS ClientHello/Certificate inspection
│   └── logger.go           # JSONL structured logging helpers
├── proxy/                  # Reverse proxy engine
│   ├── proxy.go            # Listener and connection handling
│   ├── listener.go         # TCP & UDP listeners
│   ├── tls_intercept.go    # TLS MITM & certificate caching
│   ├── config.go           # YAML configuration parsing
│   └── forwarder.go        # Bidirectional data forwarders
├── logs/                   # Output directory for JSONL logs
│   ├── detections.jsonl    # L7 alerts and proxy features
│   ├── connections.jsonl   # Full lifecycle records of proxied connections
│   └── flow_stats.jsonl    # eBPF aggregated flow statistics
├── gen.go                  # go:generate directive for bpf2go
├── bpf_bpfel.go            # Auto-generated Go bindings (little-endian)
├── bpf_bpfel.o             # Compiled eBPF bytecode
├── bpf_bpfeb.go            # Auto-generated Go bindings (big-endian)
├── bpf_bpfeb.o             # Compiled eBPF bytecode
├── main.go                 # Go application with terminal dashboard
├── service_detector.go     # Protocol and Service Detection
├── proxy_config.yaml       # Configuration for reverse proxy listeners
├── go.mod                  # Go module definition
├── go.sum                  # Go dependency checksums
├── Makefile                # Build automation
├── output.txt              # Packet log output (Monitor Mode)
├── proxy-output.json       # Raw traffic data streams
└── README.md               # This file
```

---

## Data Collection & Telemetry Features (MLOps Ready)

The NGFW monitor has been significantly upgraded to collect comprehensive telemetry suitable for training and inference with Machine Learning models. Below is the feature matrix.

### 1. eBPF Layer (Kernel Space)

| Group | Feature | Status | Evidence in your log |
|---|---|---|---|
| **Connection Info** | Source/Dest IP, Source/Dest Port, Protocol, Direction | ✅ Captured | `SOURCE`, `DESTINATION`, `PROTO`, `DIRECTION` columns |
| **Packet Info** | Packet Size, TCP Flags, TTL, TOS, Window Size, Seq/Ack Num | ✅ Captured | `SIZE`, `FLAGS`, `TTL`, `TOS`, `WINDOW`, `SEQ`, `ACK` |
| | Header Size, Payload Size | ✅ Captured | `TCP-HdrLen`, `IP-HdrLen`, `Payload: ~N B` |
| | Fragment Information | ✅ Captured (Full) | `FragOffset: X`, `MF: true/false` now tracked properly |
| | IP-ID (bonus) | ✅ Captured | `IP-ID` column |
| **Connection Statistics**| Start/End/Duration, Packet Count, In/Out Packets, In/Out Bytes, Avg/Max/Min Packet Size | ✅ Captured | Bidirectional aggregated flow output in `logs/flow_stats.jsonl` |
| **TCP Statistics** | SYN/ACK/FIN/RST/PSH/URG counts | ✅ Captured | Aggregated into `flow_stats.jsonl` |
| **Timing** | Packets/sec, Inter-arrival Time, Burst Size, Idle Time | ✅ Captured | Forward/Backward IAT (Mean/Std/Max/Min) in `flow_stats.jsonl` |
| **Socket** | PID, Process Name, UID, Interface, Socket State | ❌ Not captured | No socket-layer instrumentation currently — only TC-layer packet capture |

### 2. Reverse Proxy (JSON Logs)

| Group | Feature | Status | Evidence |
|---|---|---|---|
| **Request** | Method, URI, Host, HTTP Version, Content-Type, Referer | ✅ Captured | `HTTP-REQ-001` details |
| | URI Length, Query Params, Query Count, Content-Length | ✅ Captured | Exported in `HTTP-FEAT-001` JSON |
| **Headers** | Cookie Count | ✅ Captured | `"cookie_count"` |
| | Header Count/Size, JWT Present, Authorization Present, Duplicate Headers, Accept, Origin, Missing-User-Agent | ✅ Captured | Computed and exported in `HTTP-FEAT-001` |
| **Payload** | Entropy, digit/upper/lower/special/whitespace ratios, token stats | ✅ Captured | Exported in `HTTP-FEAT-001` (Crucial for GBT zero-day detection) |
| **Pattern Statistics** | SQL/XSS/Path-Traversal/Cmd-Injection counts | ✅ Captured | Exported as discrete binary counts in `HTTP-FEAT-001` |
| **Response** | Status Code | ✅ Captured | `HTTP-RESP-001` |
| | Response Size, Response Time, Header Count, Compression, Cache-Control | ✅ Captured | Mapped to `HTTP-FEAT-002`, including stateful `response_time_ms` |
| **Session** | Session ID, Request Count, Session Duration, Req/min, Unique URIs | ✅ Captured | Logical tracking emitted via `HTTP-SESSION-001` |
| **TLS** | Version, Cipher Suite, SNI, ALPN, Cert metadata, Session Resumption | ✅ Captured | Extracted securely via `TLS-HELLO-001` and `TLS-CERT-001` |

---

## Extending to a Full NGFW

This monitor and proxy engine provide the detection foundation. To build a complete inline firewall:

1. **Kernel-level L7 parsing**: Move deep packet inspection from the Go proxy layer down into the kernel using `bpf_skb_load_bytes` for better performance.
2. **IP blocking (IPS Mode)**: Add a `blocked_ips` BPF map and return `TC_ACT_SHOT` to actively drop malicious packets.
3. **ML Inference Engine**: Connect the `logs/detections.jsonl` stream into a live Isolation Forest / GBT inference server to dynamically detect zero-day attacks.
4. **Central management**: Export events and ML verdicts as JSON via WebSocket to a central UI dashboard.

---

## License

GPL-2.0
