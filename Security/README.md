# NGFW - Intelligent Multi-Protocol Intrusion Detection and Prevention System using MLOps

A comprehensive Go-based **Intelligent Multi-Protocol Intrusion Detection and Prevention System (NGFW)** that leverages **eBPF TC (Traffic Control) hooks** for high-performance packet monitoring, a **Layer 7 Reverse Proxy Engine** for Deep Packet Inspection (DPI), and a **Centralized MERN Stack Dashboard** for fleet management and MLOps telemetry.

## What's New (Latest Updates)

- **Dashboard-First Node Enrollment:** A highly secure, modern node pairing system. The Central Web Dashboard generates a secure, one-time cryptographic enrollment token. The Go agent CLI instantly consumes this token to register itself securely, preventing rogue agent registrations.
- **Robust HTTP Request Parsing:** The Layer 7 DPI engine features an upgraded HTTP parser resilient to evasion techniques, correctly handling unencoded spaces in URIs (e.g., raw SQL injection payloads) to prevent firewall bypasses.
- **Centralized MERN Dashboard:** A beautiful React/Vite frontend and Express/MongoDB backend providing real-time Threat Monitoring, Network Monitoring, and Agent Node management via WebSockets.
- **Interactive Setup Wizard:** The CLI has been completely revamped. Just answer two simple questions (Interface and App Port), and the system auto-calculates a safe proxy port.
- **Integrated Port Management:** A built-in utility (`Option 4`) allows you to instantly detect and kill rogue processes holding your application ports.
- **Simultaneous eBPF & Proxy Execution:** Bridges kernel-space eBPF and user-space DPI within a single binary, capturing L4 flows and L7 payloads simultaneously.

## Core Architecture

The platform consists of a **Central Web Dashboard** and a **Distributed Agent Engine**:

### 1. Distributed Go Agent (eBPF + Proxy Engine)
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
│                              │  Go Agent     │    │
│                              │  (CLI & DPI)  │    │
│                              └──────┬───────┘    │
└─────────────────────────────────────┼────────────┘
                                      │ WebSockets
                                      ▼
                        ┌──────────────────────────┐
                        │   Central Dashboard      │
                        │   (Node.js + React)      │
                        └──────────────────────────┘
```

1. **eBPF C code** (`ebpf/monitor.c`) runs inside the Linux kernel, capturing packets matching target proxy ports.
2. The **Reverse Proxy** inspects Layer 7 payloads for malicious signatures (SQLi, XSS, Path Traversal, etc.).
3. The **Go Agent** streams telemetry, flows, and detections directly to the Central Dashboard via WebSockets.

---

## Prerequisites

### For the Central Dashboard
- **Node.js** (v18+)
- **MongoDB** (Local or Atlas)

### For the Go Agent Sensor
- **Linux** with kernel 6.6+ (for TCX support)
- **Go** 1.23+
- **Clang/LLVM** (for compiling eBPF C code)
- **libbpf-dev** and **linux-headers**

```bash
# Install agent dependencies (Debian/Ubuntu)
sudo apt update
sudo apt install -y golang clang llvm libbpf-dev linux-headers-$(uname -r)
```

## Setup & Deployment

### 1. Start the Central Dashboard
```bash
# Terminal 1: Backend
cd Web/backend
npm install
npm run dev

# Terminal 2: Frontend
cd Web/frontend
npm install
npm run dev
```

### 2. Build the Go Agent
```bash
cd Security
make all
```

### 3. Enroll the Agent Node
1. Open the Web Dashboard in your browser (`http://localhost:5173`).
2. Navigate to **Agent Nodes** and click **Link New Node** to generate an Enrollment Secret.
3. Start the Go Agent as root:
   ```bash
   sudo ./ngfw-monitor
   ```
4. Select **Option 5 (Agent Setup Wizard)** and paste your Enrollment Secret. The agent will securely pair with your dashboard.

### 4. Start Monitoring (Integrated Mode)
Once enrolled, select **Option 3 (Integrated Mode)** in the Go CLI. Enter your network interface and your application's port. The firewall will automatically deploy a reverse proxy in front of your application and load eBPF hooks into the kernel. 

All malicious traffic detected at the edge will instantly stream to the Central Dashboard!

---

## Detection Features

### Advanced Protocol Analyzers
- **HTTP**: Detects SQLi, XSS, Path Traversal, Command Injection, SSRF, XXE, Log4Shell, HTTP Smuggling, and more. Immune to space-based URI parser bypasses.
- **SSH**: Analyzes version exchanges, detects weak KEX/Ciphers/MACs, computes Hassh fingerprints, and flags tunneling.
- **DNS**: Detects DNS tunneling, Domain Generation Algorithms (DGA), DNS rebinding, zone transfers, and NXDOMAIN floods.
- **Database (MySQL, PostgreSQL, Redis, MongoDB)**: Tracks authentication, detects dangerous commands, and flags SQL injection in queries.
- **SMTP & FTP**: Detects open relays, spam indicators, anonymous logins, FTP bounce attacks, and brute-force attempts.
- **TLS**: Deep parsing of ClientHello, JA3 fingerprinting, and detection of weak cipher suites or expired certificates.

### Cross-Protocol Behavioral Engine
- **Port Scanning & Brute-Force**: Sliding-window rate limiters to detect scanners and auth brute-forcing.
- **C2 & Beaconing**: Analyzes connection intervals to detect Command & Control beaconing.

### Additional Features
- **Smart Port Mapping**: Auto-calculates proxy ports and completely avoids restricted browser ports.
- **Protocol Fingerprinting (Magic Bytes)**: Identifies the true application protocol regardless of the port.
- **TLS Interception (MITM)**: On-the-fly certificate generation to inspect encrypted traffic.
- **Automated Port Management**: The built-in port management utility safely kills rogue background processes blocking critical ports.

---

## MLOps Ready Telemetry

The NGFW monitor collects comprehensive telemetry specifically designed for training and inference with Machine Learning models.

### 1. eBPF Layer (L4 Features)
- **Packet Info**: Packet Size, TCP Flags, TTL, TOS, Window Size, Seq/Ack Num, Fragment Information.
- **Connection Statistics**: Bidirectional aggregated flow output (Duration, Avg/Max/Min Packet Size).
- **Timing**: Forward/Backward IAT (Mean/Std/Max/Min), Packets/sec.

### 2. Reverse Proxy (L7 Features)
- **HTTP Features**: Extracted URI Length, Query Params, Header Count/Size, Entropy, Character ratios (exported in `HTTP-FEAT-001`).
- **TLS**: Extracted SNI, ALPN, Cipher Suites, JA3 hashes (`TLS-HELLO-001`).
- **Pattern Statistics**: SQL/XSS/Path-Traversal counts exported as discrete binary values.
- **Session Tracking**: Request counts, session duration, unique URIs tracked logically.

---

## License

GPL-2.0
