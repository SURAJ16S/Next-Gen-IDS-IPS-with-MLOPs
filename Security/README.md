# NGFW - Intelligent multi protocol intrusion detection and prevention system using the ML Ops

A comprehensive Go-based **Intelligent multi protocol intrusion detection and prevention system using the ML Ops (NGFW)** that leverages **eBPF TC (Traffic Control) hooks** for high-performance packet monitoring and a **Layer 7 Reverse Proxy Engine** for Deep Packet Inspection (DPI) and behavioral analysis.

## What's New (Latest Updates)

- **Interactive 2-Question Wizard:** The CLI has been completely revamped. You no longer need to pass complex flags or map proxy ports manually. Just answer two simple questions (Interface and App Port), and the system auto-calculates a safe, non-conflicting proxy port that avoids browser restrictions.
- **Integrated Port Management:** A built-in utility (`Option 4`) allows you to instantly detect and kill rogue processes holding your application ports (resolving `Address already in use` errors).
- **Simultaneous eBPF & Proxy Execution:** The system bridges kernel-space eBPF and user-space Reverse Proxy engines within a single binary, capturing L4 flows and L7 payloads simultaneously.
- **Flicker-Free Unified Dashboard:** Combines raw eBPF metrics and Proxy security detections into a beautiful, static dashboard that updates seamlessly in place without scrolling.

## Core Architecture

The application features a dual-engine architecture running **simultaneously** within a single binary:

### 1. eBPF Packet Monitor Engine
```text
┌──────────────────────────────────────────────────┐
│                  Linux Kernel                    │
│                                                  │
│  ┌─────────┐    TC Ingress    ┌──────────────┐   │
│  │ Network  │───────────────▶│  eBPF Program │   │
│  │Interface │    TC Egress    │  (monitor.c) │   │
│  │ (eth0/lo)│◀───────────────│                │   │
│  └─────────┘                 └──────┬───────┘     │
│                                      │            │
│                              Ring Buffer          │
│                                      │            │
├──────────────────────────────────────┼────────────┤
│              User Space              │            │
│                                      ▼            │
│                              ┌──────────────┐    │
│                              │  Go App       │    │
│                              │  Dashboard    │    │
│                              └──────────────┘    │
└──────────────────────────────────────────────────┘
```

1. **eBPF C code** (`ebpf/monitor.c`) runs inside the Linux kernel, attached to TC ingress and egress hooks.
2. Packets matching the target proxy port are captured and pushed to a **ring buffer**.
3. The **Go application** (`main.go`) reads events, groups them into bidirectional flows, and seamlessly renders them alongside proxy Layer 7 metrics.

### 2. Layer 7 Proxy & DPI Engine
The proxy engine intercepts incoming connections using standard Go network listeners. It acts as an invisible middleman, analyzing payloads (HTTP, TLS, etc.) for malicious signatures before seamlessly forwarding traffic to your actual backend application. It features **robust connection state tracking** to prevent memory leaks during attacks and extracts machine-learning features to `logs/detections.jsonl`.

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

## Build Instructions

```bash
# Compile eBPF + build Go binary
make all
```

---

## Execution & Usage

The application features an incredibly simple interactive CLI.

```bash
sudo ./ngfw-monitor
```

### Main Menu

```text
  [1]  eBPF Traffic Monitor — kernel-level packet inspection via TC hooks
  [2]  Reverse Proxy          — application-layer DPI detection engine
  [3]  Integrated Mode        — eBPF monitor + proxy detection combined
  [4]  Port Management        — check if a port is in use and free it
  [5]  Exit
```

### Option 3: Integrated Mode (Recommended)
This runs both the Layer 4 eBPF packet monitor and the Layer 7 reverse proxy simultaneously to get full stack visibility.

**How to test locally (using a Python server):**
1. **Terminal 1:** Start your backend app on port 80.
   ```bash
   python3 -m http.server 80
   ```
2. **Terminal 2:** Start the firewall (`sudo ./ngfw-monitor`).
   - Select Option `3` (Integrated Mode).
   - **CRITICAL:** When asked for the interface, select `lo` (loopback) if you plan to test using `localhost`.
   - Enter your app's port (`80`).
   - *The firewall will automatically create a safe proxy port (e.g., 10081) and begin monitoring.*
3. **Terminal 3 / Browser:** Send traffic to the **Proxy Port**.
   ```bash
   curl http://localhost:10081
   ```
   *The dashboard will instantly light up with packet captures and HTTP detection telemetry.*

### Option 4: Port Management
If you ever encounter an `OSError: [Errno 98] Address already in use` error when starting your backend application, use this tool.
Simply enter the port number (e.g., `80`), and the tool will show you exactly what process is blocking it and give you a 1-click option to force-kill it safely.

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
- **Smart Port Mapping**: Auto-calculates proxy ports and automatically avoids restricted browser ports (e.g., avoiding 10080 to prevent NAT slipstreaming blocks in Firefox/Chrome).
- **Protocol Fingerprinting (Magic Bytes)**: Identifies the true application protocol regardless of the port.
- **TLS Interception (MITM)**: On-the-fly certificate generation to inspect encrypted traffic.
- **JSONL Structured Logging**: Automated rotation and structured logging for connections (`connections.jsonl`) and detections (`detections.jsonl`).
- **Raw Traffic Dumping**: Captures raw request bytes to `proxy-output.json` for forensic analysis.

---

## Data Collection & Telemetry Features (MLOps Ready)

The NGFW monitor has been significantly upgraded to collect comprehensive telemetry suitable for training and inference with Machine Learning models.

### 1. eBPF Layer (Kernel Space)
- **Connection Info**: Source/Dest IP, Port, Protocol, Direction.
- **Packet Info**: Packet Size, TCP Flags, TTL, TOS, Window Size, Seq/Ack Num, Fragment Information.
- **Connection Statistics**: Bidirectional aggregated flow output in `logs/flow_stats.jsonl` (Duration, Avg/Max/Min Packet Size).
- **Timing**: Forward/Backward IAT (Mean/Std/Max/Min), Packets/sec.

### 2. Reverse Proxy (JSON Logs)
- **HTTP Features**: Extracted URI Length, Query Params, Header Count/Size, Entropy, Character ratios (exported in `HTTP-FEAT-001`).
- **TLS**: Extracted SNI, ALPN, Cipher Suites, JA3 hashes (`TLS-HELLO-001`).
- **Pattern Statistics**: SQL/XSS/Path-Traversal counts exported as discrete binary values.
- **Session Tracking**: Request counts, session duration, unique URIs tracked logically (`HTTP-SESSION-001`).

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
