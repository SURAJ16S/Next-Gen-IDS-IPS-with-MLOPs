# Security Workflow — NGFW IDS/IPS with MLOps

> **Project:** Next-Gen IDS/IPS with MLOps  
> **Language Stack:** Go (Security Agent) · Node.js / React / MongoDB (Dashboard)  
> **License:** GPL-2.0  
> **Last Updated:** 2026-08-12

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Layer 0 — Kernel Space (eBPF)](#3-layer-0--kernel-space-ebpf)
4. [Layer 1 — Reverse Proxy Engine (L7 DPI)](#4-layer-1--reverse-proxy-engine-l7-dpi)
5. [Layer 2 — Protocol Analyzers](#5-layer-2--protocol-analyzers)
6. [Layer 3 — Behavioral Engine](#6-layer-3--behavioral-engine)
7. [Layer 4 — Detection Bus & Logging](#7-layer-4--detection-bus--logging)
8. [Layer 5 — Telemetry Streaming to Dashboard](#8-layer-5--telemetry-streaming-to-dashboard)
9. [Layer 6 — Central Dashboard (MERN Backend)](#9-layer-6--central-dashboard-mern-backend)
10. [Node Enrollment & Authentication](#10-node-enrollment--authentication)
11. [Operating Modes](#11-operating-modes)
12. [Data Flow Diagrams](#12-data-flow-diagrams)
13. [Detection Categories & Severity Levels](#13-detection-categories--severity-levels)
14. [MLOps Telemetry Schema](#14-mlops-telemetry-schema)
15. [Log Files Reference](#15-log-files-reference)
16. [Configuration Reference](#16-configuration-reference)
17. [Security Controls Summary](#17-security-controls-summary)

---

## 1. System Overview

The system is a **two-tier distributed security platform**:

| Tier | Component | Technology |
|------|-----------|------------|
| **Agent (Sensor)** | Go binary running on Linux edge nodes | Go 1.23+, eBPF (cilium/ebpf), TCX hooks |
| **Central Dashboard** | Web application for fleet management | Node.js / Express / MongoDB / React / WebSockets |

The **Agent** sits in-line in front of protected services, inspects all traffic at both kernel (L3/L4) and application (L7) layers, emits structured telemetry, and streams it to the Dashboard in real time.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Linux Kernel Space                              │
│                                                                         │
│  NIC  ──► TC Ingress Hook  ──► [eBPF: monitor.c]  ──► Ring Buffer      │
│       ◄── TC Egress Hook   ◄──                                          │
└──────────────────────────────────────┬──────────────────────────────────┘
                                       │  (kernel → userspace via ring buf)
┌──────────────────────────────────────▼──────────────────────────────────┐
│                     Go Agent — User Space                               │
│                                                                         │
│   main.go                                                               │
│    ├── [Mode 1]  eBPF Monitor only       → Dashboard + output.txt       │
│    ├── [Mode 2]  Reverse Proxy only      → Detection Engine + logs/     │
│    ├── [Mode 3]  Integrated (eBPF+Proxy) → Combined telemetry           │
│    │                                                                    │
│    ├── proxy/                                                           │
│    │    ├── ProxyEngine       — manages TCP/UDP listeners               │
│    │    ├── TCPListener       — accepts connections, runs DPI pipeline  │
│    │    ├── UDPListener       — datagram forwarding + inspection        │
│    │    ├── TLSInterceptor    — on-the-fly MITM cert generation         │
│    │    └── Forwarder         — bidirectional traffic relay + tee       │
│    │                                                                    │
│    ├── detect/                                                          │
│    │    ├── ProtocolDetector  — magic-byte fingerprinting               │
│    │    ├── HTTPAnalyzer      — SQLi, XSS, LFI, SSRF, Log4Shell, etc.  │
│    │    ├── SSHAnalyzer       — KEX/cipher audit, HASSH, tunneling      │
│    │    ├── DNSAnalyzer       — tunneling, DGA, rebinding, flood        │
│    │    ├── TLSInspector      — ClientHello, JA3, weak ciphers          │
│    │    ├── DBAnalyzer        — MySQL/PgSQL/Redis/MongoDB               │
│    │    ├── SMTPAnalyzer      — open relay, spam, phishing              │
│    │    ├── FTPAnalyzer       — anonymous login, bounce, brute-force    │
│    │    ├── TelnetAnalyzer    — IoT default creds, command injection    │
│    │    ├── GenericAnalyzer   — fallback signature scanning             │
│    │    ├── BehavioralEngine  — port scan, brute-force, C2 beaconing    │
│    │    ├── FlowTracker       — CICFlowMeter-style L4 flow stats (ML)  │
│    │    ├── DetectionBus      — fan-out event distribution              │
│    │    └── JSONLLogger       — structured JSONL file output            │
│    │                                                                    │
│    ├── streamer.go   — tail logs/ → POST /api/agent/telemetry/*         │
│    └── commander.go  — WebSocket client ← Dashboard commands           │
└──────────────────────────────────────┬──────────────────────────────────┘
                                       │  HTTP REST + WebSocket
┌──────────────────────────────────────▼──────────────────────────────────┐
│                  Central Dashboard — Node.js Backend                    │
│                                                                         │
│  Express + Helmet + JWT Auth + Mongoose                                 │
│   ├── /api/auth          — login, register, OTP                         │
│   ├── /api/nodes         — node enrollment, listing                     │
│   ├── /api/agent         — telemetry ingestion (agent auth)             │
│   ├── /api/threats       — threat query, acknowledgement                │
│   ├── /api/network       — network event query                          │
│   ├── /api/logs          — system/audit log query                       │
│   ├── /api/analytics     — aggregated stats                             │
│   ├── /api/devops        — deployment management                        │
│   └── /api/dashboard     — dashboard summary                            │
│                                                                         │
│   WebSocket (socket.io) — real-time push to React frontend             │
└──────────────────────────────────────┬──────────────────────────────────┘
                                       │  Browser
┌──────────────────────────────────────▼──────────────────────────────────┐
│                  React Frontend (Vite, port 5173)                       │
│   Pages: Threat Monitor · Network Monitor · Agent Nodes · Analytics     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Layer 0 — Kernel Space (eBPF)

### Source: [`Security/ebpf/monitor.c`](file:///d:/YASH/Final%20Year%20Projett/Security/ebpf/monitor.c)

The eBPF program is the **earliest point of visibility** — it runs inside the Linux kernel's Traffic Control (TC) subsystem and observes every packet on the wire.

### How it works

```
1. eBPF is compiled to BPF bytecode (bpf_bpfeb.o / bpf_bpfel.o)
2. Go agent loads it into kernel with cilium/ebpf library
3. Two TC hooks attached via TCX (Linux 6.6+ required):
     - handle_ingress(skb)  → direction = 0 (INCOMING)
     - handle_egress(skb)   → direction = 1 (OUTGOING)
4. Per packet, process_packet() runs:
     a. Reads target port from BPF_MAP_TYPE_HASH (port_config map)
     b. Parses Ethernet header → validates IPv4
     c. Parses IP header (IHL, TTL, TOS, ID, Fragment fields)
     d. Parses TCP or UDP L4 header
     e. Port match check (src OR dst must equal target port)
     f. Allocates ring buffer slot, fills packet_event struct
     g. Submits to BPF_MAP_TYPE_RINGBUF (16 MB ring buffer)
5. TC_ACT_OK returned — ALL packets pass (monitor only, no blocking)
```

### `packet_event` struct fields emitted per packet

| Field | Type | Description |
|-------|------|-------------|
| `src_ip` / `dest_ip` | u32 | Network-order IPv4 addresses |
| `src_port` / `dest_port` | u16 | L4 ports |
| `pkt_size` | u16 | Total IP packet size (ip.tot_len) |
| `protocol` | u8 | 6=TCP, 17=UDP |
| `ttl` / `tos` | u8 | Time To Live, Type of Service |
| `ip_hdr_len` | u8 | IP header length in bytes |
| `ip_id` | u16 | IP identification (frag/reorder) |
| `ip_frag_offset` | u16 | Fragment offset (13 bits) |
| `ip_mf` | u8 | More Fragments flag |
| `tcp_seq` / `tcp_ack` | u32 | Sequence/acknowledgment numbers |
| `tcp_flags` | u8 | FIN=0x01, SYN=0x02, RST=0x04, PSH=0x08, ACK=0x10, URG=0x20 |
| `tcp_hdr_len` | u8 | TCP header length (data offset × 4) |
| `tcp_window` | u16 | TCP window size |
| `direction` | u8 | 0=ingress, 1=egress |
| `timestamp` | u64 | bpf_ktime_get_ns() (nanoseconds) |

### BPF Maps

| Map Name | Type | Purpose |
|----------|------|---------|
| `port_config` | HASH (1 entry) | Userspace writes the target port here |
| `packet_events` | RINGBUF (16 MB) | Kernel → userspace packet event stream |

### Ring Buffer Processing (Userspace)

Defined in [`Security/main.go:runEBPFMonitor()`](file:///d:/YASH/Final%20Year%20Projett/Security/main.go):

```
ringbuf.NewReader() opens the ring buffer
goroutine reads records → binary.Read() → packetRecord struct
→ eventCh channel (buffered, 256 slots)
→ dashboard.addEvent()
→ flog.logPacket()    (output.txt — raw packet log)
→ flowTracker.TrackPacket()  (L4 flow aggregation for ML)
```

---

## 4. Layer 1 — Reverse Proxy Engine (L7 DPI)

### Sources: [`Security/proxy/`](file:///d:/YASH/Final%20Year%20Projett/Security/proxy/)

The proxy engine is a **transparent man-in-the-middle** that sits between clients and the protected backend service. Unlike the eBPF monitor, it operates on **decrypted application-layer payloads**.

### Traffic Flow Through the Proxy

```
Client Request
    │
    ▼
TCPListener.Accept()          ← net.Listen(":proxyPort")
    │
    ▼
handleConnection(ctx, conn)
    │
    ├─ Create ConnContext (UUID, IP, port, service, start time)
    ├─ Emit "CONN-START-001" INFO event to DetectionBus
    │
    ├─ Read initial 1024 bytes (5-second deadline)
    │
    ├─ ProtocolDetector.Detect(initialData, port, service)
    │     → magic-byte matching + port heuristics
    │     → fp.Protocol, fp.Confidence, fp.Mismatch
    │
    ├─ AnalyzerRouter.AnalyzeStream(ctx, initialData, fromClient=true)
    │     → dispatches to correct protocol analyzer
    │
    ├─ net.DialTimeout("tcp", backendAddr, 5s)
    │
    ├─ backendConn.Write(initialData)   ← forward buffered initial bytes
    │
    ├─ Forwarder.Forward(ctx, clientConn, backendConn)
    │     → goroutine: client → backend  (tee → AnalyzeStream)
    │     → goroutine: backend → client  (tee → AnalyzeStream)
    │
    └─ emitClose() → DetectionBus.EmitConnectionClose(ConnectionRecord)
```

### Connection Context (`ConnContext`)

Every proxied connection carries a `ConnContext` through the entire pipeline:

```go
ConnID          string   // UUID v4 — links all events to one connection
ClientIP        net.IP
ClientPort      uint16
ListenPort      uint16
BackendAddr     string
ExpectedService string   // From proxy_config.yaml
DetectedProtocol string  // Fingerprinted protocol
ProtoConfidence float64
ProtoMismatch   bool     // True if detected ≠ expected
BytesFromClient int64
BytesToClient   int64
CloseReason     string   // "normal" | "reset" | "timeout" | "backend_unreachable"
```

### TLS Interception

Source: [`Security/proxy/tls_intercept.go`](file:///d:/YASH/Final%20Year%20Projett/Security/proxy/tls_intercept.go)

For `tcp+tls` listeners, the engine performs **MITM inspection**:
1. Self-signed CA created on first run (ECDSA key, stored in `certs/`)
2. Per-SNI certificates generated on demand (cached, up to 1000 entries)
3. Client sees a spoofed cert; backend sees a real TLS connection
4. Decrypted plaintext flows through the same analyzer pipeline

---

## 5. Layer 2 — Protocol Analyzers

### Source: [`Security/detect/`](file:///d:/YASH/Final%20Year%20Projett/Security/detect/)

All analyzers share the same interface pattern:
```go
analyzer.Analyze(connID, srcIP, srcPort, dstPort, data []byte, fromClient bool)
```

Each emits `Detection` objects into the `DetectionBus`.

### 5.1 Protocol Detection (`protocol_detect.go`)

First pass on every new connection:
- **Magic-byte matching** on raw bytes (SSH banner, HTTP verb, DNS header, TLS ClientHello, FTP 220, SMTP 220, MySQL greeting, etc.)
- **Port-number heuristics** as fallback
- Returns `FingerPrint{Protocol, Confidence, Mismatch}`

### 5.2 HTTP Analyzer (`http_analyzer.go`)

The most complex analyzer. Checks all of:

| Threat | Detection ID | Severity |
|--------|-------------|----------|
| SQL Injection | HTTP-SQLI-001 | CRITICAL |
| XSS | HTTP-XSS-001 | HIGH |
| Path Traversal / LFI | HTTP-TRAV-001 | HIGH |
| Command Injection | HTTP-CMDI-001 | CRITICAL |
| SSRF | HTTP-SSRF-001 | HIGH |
| XXE | HTTP-XXE-001 | HIGH |
| Log4Shell | HTTP-L4SH-001 | CRITICAL |
| HTTP Request Smuggling | HTTP-SMUG-001 | HIGH |
| CRLF Injection | HTTP-CRLF-001 | MEDIUM |
| Open Redirect | HTTP-REDIR-001 | MEDIUM |
| Malicious File Upload | HTTP-FUPLOAD-001 | HIGH |
| Bot/Scanner UA | HTTP-BOT-001 | LOW |
| Directory Brute Force | HTTP-DBRF-001 | MEDIUM |
| Credential in URL | HTTP-CRED-001 | HIGH |
| Missing Security Headers | HTTP-HDR-001 | LOW |
| Information Leakage | HTTP-LEAK-001 | LOW |
| LDAP Injection | HTTP-LDAP-001 | HIGH |

> **Important:** The HTTP parser handles **unencoded spaces in URIs** (e.g., raw `SELECT * FROM` without URL encoding) to prevent parser evasion bypasses.

### 5.3 SSH Analyzer (`ssh_analyzer.go`)

| Check | Description |
|-------|-------------|
| Version exchange parsing | SSH-2.0 vs SSH-1.x (legacy flag) |
| KEX algorithm audit | Flags weak key exchange algorithms |
| Cipher suite audit | Flags deprecated/weak ciphers |
| MAC algorithm audit | Flags weak MACs (MD5, etc.) |
| HASSH fingerprinting | Client fingerprint for correlation |
| Port forwarding detection | TCP forwarding / X11 forwarding flags |
| Brute-force | Rapid auth failure tracking |
| Banner scanning | Version string probing without auth |

### 5.4 DNS Analyzer (`dns_analyzer.go`)

| Check | Detection Category |
|-------|-------------------|
| DNS tunneling (entropy analysis) | `dns-tunnel` |
| Domain Generation Algorithm (DGA) | `dga` |
| DNS rebinding | `dns-rebinding` |
| Zone transfer (AXFR) attempt | `zone-transfer` |
| NXDOMAIN flood | `nxdomain-flood` |

### 5.5 TLS Inspector (`tls_inspect.go`)

- Parses **ClientHello** raw bytes (no handshake — passive inspection)
- Extracts: SNI, ALPN, Cipher Suites, Extensions, Session ID
- Computes **JA3 fingerprint** (MD5 of TLS parameters)
- Flags: weak cipher suites, TLS 1.0/1.1 (downgrade), SNI mismatch, expired/self-signed certs

### 5.6 Database Analyzer (`db_analyzer.go`)

Protocols: MySQL, PostgreSQL, Redis, MongoDB

| Check | Description |
|-------|-------------|
| Authentication tracking | Login success/failure |
| Dangerous commands | `DROP TABLE`, `SHUTDOWN`, `FLUSHALL`, etc. |
| SQL injection in queries | Pattern matching on query text |
| Unauthenticated access attempts | Auth bypass detection |

### 5.7 SMTP Analyzer (`smtp_analyzer.go`)

- Open relay detection (relaying to external domains)
- Spam/phishing keywords in headers and body
- Large recipient count detection

### 5.8 FTP Analyzer (`ftp_analyzer.go`)

- Anonymous login detection
- FTP bounce attack (PORT command with foreign IP)
- Brute-force tracking
- FTPS (AUTH TLS) detection → hands off to TLS inspector

### 5.9 Telnet Analyzer (`telnet_analyzer.go`)

- IoT default credential detection (extensive dictionary from `telnet_defaults.go`)
- Command injection in Telnet session data
- IoT device fingerprinting
- Scan pattern detection (rapid connect + disconnect)
- Credential stuffing / password spray patterns

### 5.10 Generic Analyzer (`generic_analyzer.go`)

Fallback for unrecognized protocols. Performs:
- Binary pattern scanning for known malware signatures
- Protocol mismatch detection
- Anomalous payload size detection

---

## 6. Layer 3 — Behavioral Engine

### Source: [`Security/detect/behavioral.go`](file:///d:/YASH/Final%20Year%20Projett/Security/detect/behavioral.go)

The behavioral engine operates **cross-connection** — it maintains per-IP state to detect patterns that span multiple individual connections.

### Per-IP State Tracked

```go
connections        []time.Time       // Recent connection timestamps (5-min window)
portsSeen          map[uint16]time.Time  // Unique ports accessed
authFailures       []time.Time       // Auth failure timestamps (5-min window)
totalBytesIn/Out   int64             // Cumulative transfer volume
connectionIntervals []time.Duration  // Intervals between connections (beaconing)
firstSeen/lastSeen  time.Time
```

### Detection Rules

| Rule ID | Category | Trigger | Severity |
|---------|----------|---------|----------|
| `BEH-RATE-001` | `ddos` | >120 connections in 5 minutes from same IP | HIGH |
| `BEH-SCAN-001` | `port-scan` | ≥10 unique ports in 60 seconds | HIGH |
| `BEH-BRUTE-001` | `brute-force` | ≥5 auth failures in 5 minutes | CRITICAL |
| `BEH-EXFIL-001` | `data-exfiltration` | >10 MB outbound, >100:1 out:in ratio | HIGH |
| `BEH-BEACON-001` | `beaconing` | Connection intervals with CV < 0.20 (mean 5s–10min) | HIGH |

> Thresholds are configurable via `proxy_config.yaml` → `detection.rate_limit`.

---

## 7. Layer 4 — Detection Bus & Logging

### Source: [`Security/detect/detection.go`](file:///d:/YASH/Final%20Year%20Projett/Security/detect/detection.go), [`Security/detect/logger.go`](file:///d:/YASH/Final%20Year%20Projett/Security/detect/logger.go)

### Detection Object Schema

```json
{
  "id":           "HTTP-SQLI-001",
  "timestamp":    "2026-08-12T17:00:00.000Z",
  "severity":     3,
  "severity_str": "HIGH",
  "category":     "sqli",
  "protocol":     "HTTP",
  "source_ip":    "192.168.1.100",
  "source_port":  54321,
  "dest_port":    8080,
  "summary":      "SQL injection attempt in URI parameter",
  "details":      { "uri": "/login?id=1' OR 1=1--" },
  "raw_evidence": "1%27+OR+1%3D1--",
  "conn_id":      "550e8400-e29b-41d4-a716-446655440000"
}
```

### DetectionBus Fan-Out

```
Analyzer emits Detection
         │
         ▼
DetectionBus.EmitDetection(d)
    ├── JSONLLogger.OnDetection()    → logs/detections.jsonl
    ├── StatsCollector.OnDetection() → in-memory counters (severity buckets)
    └── ConsoleLogger.OnDetection()  → terminal output (proxy-only mode)
```

### JSONL Log Files

| File | Content |
|------|---------|
| `logs/detections.jsonl` | Every Detection event (append-only) |
| `logs/connections.jsonl` | Connection lifecycle records |
| `logs/protocols/<proto>.jsonl` | Per-protocol feature extraction |
| `logs/flow_stats.jsonl` | CICFlowMeter-format flow records (ML features) |
| `output.txt` | Raw eBPF packet log (overwritten on restart) |
| `proxy-output.json` | Raw traffic dump (overwritten on restart) |

### Log Rotation

- Configurable max file size via `proxy_config.yaml → logging.max_file_size_mb`
- Default: 100 MB per file
- On rotation: file renamed with timestamp suffix, new file created

---

## 8. Layer 5 — Telemetry Streaming to Dashboard

### Sources: [`Security/streamer.go`](file:///d:/YASH/Final%20Year%20Projett/Security/streamer.go), [`Security/commander.go`](file:///d:/YASH/Final%20Year%20Projett/Security/commander.go)

### Streamer (Agent → Dashboard)

```
RunStreamer()
  │
  ├── goroutine: tailAndSend("logs/detections.jsonl",  "/api/agent/telemetry/detections")
  └── goroutine: tailAndSend("logs/connections.jsonl", "/api/agent/telemetry/connections")

tailAndSend():
  1. Open file, seek to end (only new lines are forwarded)
  2. ReadBytes('\n') — blocks until new data
  3. Unmarshal JSON line
  4. POST to dashboard:
       Headers:
         X-Node-Id:     <nodeId>
         X-Node-Secret: <nodeSecretKey>
       Body: { "detections": [ {...} ] }
  5. 401 response → stop streaming (node revoked)
  6. Error → sleep 2s, retry
```

### Commander (Dashboard → Agent)

```
RunCommander()
  │
  └── goroutine: reconnect loop (5s backoff)
        WebSocket dial: ws://<dashboardURL>
        Headers: X-Node-Id, X-Node-Secret
        
        Receive CommandMsg { type, value }
        handleCommand():
          "block_ip"    → [ACTION] block IP (stub, extend here)
          "unblock_ip"  → [ACTION] unblock IP (stub)
          "update_rules"→ [ACTION] rules update (stub)
```

> **Note:** `block_ip` / `unblock_ip` commands are currently logged but not yet implemented as actual firewall rules. This is where iptables/nftables integration would be added.

---

## 9. Layer 6 — Central Dashboard (MERN Backend)

### Source: [`Web/backend/src/`](file:///d:/YASH/Final%20Year%20Projett/Web/backend/src/)

### Security Controls

| Control | Implementation |
|---------|---------------|
| **Helmet** | `helmet()` middleware — sets 14 HTTP security headers |
| **CORS** | Restricted to `localhost:5173` only |
| **Body size limit** | `10kb` max payload (DoS prevention) |
| **JWT Auth** | `auth.middleware.js` — Bearer token, `JWT_SECRET` from `.env` |
| **Agent Auth** | `agent.middleware.js` — `X-Node-Id` + `X-Node-Secret` bcrypt compare |
| **Rate Limiting** | `rateLimiter.js` — per-route Express rate limits |
| **Request Logging** | `requestLogger.js` — all requests logged |

### API Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /api/auth/login` | None | User login → JWT |
| `POST /api/auth/register` | None | New user registration |
| `POST /api/nodes/enroll` | None | Agent enrollment (uses enrollment token) |
| `GET /api/nodes` | JWT | List all enrolled nodes |
| `POST /api/agent/telemetry/detections` | Agent Secret | Ingest detection events from agent |
| `POST /api/agent/telemetry/connections` | Agent Secret | Ingest connection records from agent |
| `GET /api/threats` | JWT | Query threat events |
| `GET /api/network` | JWT | Query network events |
| `GET /api/logs` | JWT | Query system/audit logs |
| `GET /api/analytics` | JWT | Aggregated statistics |
| `GET /api/dashboard` | JWT | Dashboard summary data |
| `GET/POST /api/devops` | JWT | Deployment management |

### MongoDB Models

| Model | Fields (key) |
|-------|-------------|
| `User` | email, password (bcrypt), role |
| `Node` | nodeId, hostname, ipAddress, osVersion, status, nodeSecretKey (bcrypt), lastSeen, owner |
| `EnrollmentToken` | token (one-time use), expiry, createdBy |
| `SecurityEvent` | type, severity, sourceIP, details, nodeId, timestamp |
| `NetworkEvent` | protocol, srcIP, dstIP, ports, bytes, timestamp |
| `Threat` | category, severity, summary, evidence, connId, nodeId |
| `SystemLog` | level, message, source, timestamp |
| `MLResult` | flowId, prediction, confidence, features, timestamp |
| `Deployment` | name, status, version, nodeId |

### WebSocket (Socket.io)

Real-time push to React frontend on:
- New threat detection received from agent
- Node status change (online/offline)
- New connection records

---

## 10. Node Enrollment & Authentication

### Source: [`Security/setup.go`](file:///d:/YASH/Final%20Year%20Projett/Security/setup.go)

This is a **Dashboard-First** enrollment model — the dashboard controls who can register, preventing rogue agents.

### Enrollment Flow

```
Step 1 — Dashboard Admin Action:
  Dashboard UI → "Link New Node" button
  → Backend generates one-time EnrollmentToken
  → Admin copies token

Step 2 — Agent Setup Wizard (Option 5 in CLI):
  sudo ./ngfw-monitor
  → Select [5] Agent Setup Wizard
  → Enter Enrollment Secret (from dashboard)
  
  POST /api/nodes/enroll
    Body: {
      enrollmentToken: "<secret>",
      hostname: "server-01",
      ipAddress: "10.0.0.5",
      osVersion: "linux amd64"
    }
  
  Dashboard validates token (one-time use, time-limited)
  → Creates Node record with status="active"
  → Generates nodeId (UUID) + nodeSecretKey (random 32-byte hex)
  → Returns { nodeId, nodeSecretKey }

Step 3 — Agent saves credentials:
  NodeConfig { nodeId, nodeSecretKey, dashboardURL }
  JSON → AES-256-GCM encrypt (key = SHA-256 of /etc/machine-id)
  → Written to node.key (chmod 0600)

Step 4 — Subsequent runs:
  LoadNodeConfig() → decrypt node.key → credentials available
  RunStreamer() and RunCommander() use X-Node-Id / X-Node-Secret headers
```

### Credential Storage Security

| Aspect | Detail |
|--------|--------|
| Encryption algorithm | AES-256-GCM (authenticated encryption) |
| Key derivation | SHA-256 hash of `/etc/machine-id` — node-locked |
| Nonce | Cryptographically random, prepended to ciphertext |
| File permissions | 0600 (owner read/write only) |
| Server-side secret | bcrypt hashed before storage (cost factor 10) |

---

## 11. Operating Modes

### Mode 1 — eBPF Monitor Only

```
User traffic on port N
    │
    ▼  (kernel TC hook)
eBPF captures L3/L4 metadata
    │
    ▼
Ring buffer → Go userspace
    │
    ├── Live dashboard (terminal TUI, refreshes 500ms)
    ├── output.txt (full packet log)
    └── logs/flow_stats.jsonl (ML features via FlowTracker)
```

Use case: Passive network visibility, no impact on traffic path.

### Mode 2 — Reverse Proxy Only

```
Client → :proxyPort (proxy)
              │
              ▼
    Protocol Detection
              │
              ▼
    Analyzer (HTTP/SSH/DNS/etc.)
              │
              ├── Detection emitted → DetectionBus → JSONL
              └── Forward to :backendPort (real service)
```

Use case: Application-layer DPI with full L7 inspection.

### Mode 3 — Integrated (eBPF + Proxy) ← Recommended

```
Client → :proxyPort ───► eBPF TC hooks (L3/L4 visibility)
              │
              ▼ (same port)
         Reverse Proxy (L7 DPI)
              │
              ├── eBPF metrics + L7 detections merged in TUI dashboard
              └── Combined telemetry streamed to Central Dashboard
```

Traffic path: `browser → :proxyPort (eBPF+Proxy) → :backendPort (your app)`

Use case: Full-spectrum monitoring — kernel-level packet metadata AND decrypted payload inspection simultaneously.

---

## 12. Data Flow Diagrams

### Detection Event Flow

```
Network Packet
      │
      ├─[eBPF]──► packetRecord ──► FlowTracker ──► flow_stats.jsonl
      │                │
      │                └──► output.txt
      │
      └─[Proxy]─► InitialData ──► ProtocolDetect ──► Analyzer
                                                          │
                                                          ▼
                                                    Detection{}
                                                          │
                                                     DetectionBus
                                                       /    \
                                               JSONLLogger  StatsCollector
                                                   │
                                          detections.jsonl
                                                   │
                                             Streamer.go
                                             (tail + POST)
                                                   │
                                     POST /api/agent/telemetry/detections
                                          [X-Node-Id, X-Node-Secret]
                                                   │
                                        agent.middleware.js
                                        (bcrypt.compare secret)
                                                   │
                                          MongoDB → SecurityEvent
                                                   │
                                          socket.io → React Frontend
```

---

## 13. Detection Categories & Severity Levels

### Severity Scale

| Level | Value | Meaning |
|-------|-------|---------|
| INFO | 0 | Normal activity, audit trail |
| LOW | 1 | Slightly unusual, informational |
| MEDIUM | 2 | Suspicious, requires attention |
| HIGH | 3 | Likely attack or policy violation |
| CRITICAL | 4 | Active exploitation attempt |

### Category Reference (all `detect.Cat*` constants)

#### Web / Application Layer
`sqli` · `xss` · `path-traversal` · `command-injection` · `ssrf` · `xxe` · `log4shell` · `http-smuggling` · `crlf-injection` · `open-redirect` · `file-upload` · `bot-scanner` · `dir-bruteforce` · `credential-leak` · `missing-headers` · `info-leakage` · `ldap-injection`

#### Network / Behavioral
`brute-force` · `port-scan` · `ddos` · `slowloris` · `data-exfiltration` · `beaconing` · `tunneling` · `c2` · `lateral-movement` · `protocol-mismatch` · `time-anomaly`

#### TLS / PKI
`tls-weak-cipher` · `tls-downgrade` · `tls-sni-mismatch` · `tls-expired-cert` · `tls-self-signed`

#### DNS
`dns-tunnel` · `dga` · `dns-rebinding` · `zone-transfer` · `nxdomain-flood`

#### SSH
`ssh-weak-algo` · `ssh-tunnel` · `ssh-brute-force` · `ssh-malformed` · `ssh-legacy-protocol` · `ssh-banner-scan`

#### Email
`open-relay` · `spam` · `phishing`

#### FTP / Telnet / DB
`ftp-bounce` · `ftp-data-channel` · `anonymous-login` · `dangerous-command` · `unauthenticated-access` · `malformed-protocol` · `telnet-iot` · `telnet-scan` · `credential-stuffing` · `password-spray`

---

## 14. MLOps Telemetry Schema

### L4 Flow Features (eBPF → `flow_stats.jsonl`)

CICFlowMeter-compatible. Key fields:

| Feature Group | Fields |
|---------------|--------|
| Identity | `flow_id`, `src_ip`, `dst_ip`, `src_port`, `dst_port`, `protocol` |
| Volume | `fwd_pkts`, `bwd_pkts`, `fwd_bytes`, `bwd_bytes` |
| Packet Length | `pkt_len_mean`, `pkt_len_std`, `pkt_len_min`, `pkt_len_max` |
| IAT (Inter-Arrival Time) | `flow_iat_mean`, `fwd_iat_mean`, `bwd_iat_mean`, `flow_iat_std`, `flow_iat_max`, `flow_iat_min` |
| TCP Flags | `syn_count`, `ack_count`, `fin_count`, `rst_count`, `psh_count`, `urg_count` |
| Flow Duration | `duration_us`, `flow_bytes_per_sec`, `flow_pkts_per_sec` |
| Timing | `active_mean`, `idle_mean` |

### L7 Detection Features (Proxy → `logs/protocols/<proto>.jsonl`)

| Protocol | Feature Export ID | Key Fields |
|----------|------------------|-----------|
| HTTP | `HTTP-FEAT-001` | URI length, query params count, header count/size, entropy, SQL/XSS/traversal hit counts |
| TLS | `TLS-HELLO-001` | SNI, ALPN, cipher suites, JA3 hash, extension list |
| SSH | `SSH-KEX-001` | KEX algorithms, ciphers, MACs, HASSH fingerprint |
| DNS | `DNS-QUERY-001` | query type, domain entropy, label count, TLD |

---

## 15. Log Files Reference

| File | Location | Format | Rotation |
|------|----------|--------|----------|
| Detection events | `Security/logs/detections.jsonl` | JSONL (one Detection per line) | By size (configurable) |
| Connection records | `Security/logs/connections.jsonl` | JSONL (one ConnectionRecord per line) | By size |
| Protocol features | `Security/logs/protocols/<proto>.jsonl` | JSONL | By size |
| Flow statistics | `Security/logs/flow_stats.jsonl` | JSONL (CICFlowMeter schema) | Appended |
| eBPF packet log | `Security/output.txt` | Text table | Overwritten on restart |
| Raw proxy dump | `Security/proxy-output.json` | JSONL | Overwritten on restart |
| Node credentials | `Security/node.key` | AES-256-GCM encrypted binary | Never rotated |

---

## 16. Configuration Reference

### `Security/proxy_config.yaml`

```yaml
central_dashboard_url: "http://localhost:5000"

listeners:
  - listen_port: 18080       # Proxy listens here
    backend_addr: "127.0.0.1:8080"  # Your real app
    transport: "tcp"         # tcp | udp | tcp+tls
    service: "http"          # Protocol hint for analyzer dispatch
    enabled: true

tls:
  enabled: false
  ca_cert_file: "certs/ca.crt"
  ca_key_file:  "certs/ca.key"
  cert_cache_size: 1000

logging:
  dir: "logs"
  max_file_size_mb: 100

detection:
  max_payload_inspect_bytes: 65536
  rate_limit:
    connections_per_minute: 120
    port_scan_threshold: 10      # unique ports / 60s
    brute_force_threshold: 5     # auth failures / 5min
```

### `Web/backend/.env`

| Variable | Purpose |
|----------|---------|
| `PORT` | Backend server port (default 5000) |
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | Secret for signing JWT tokens |
| `NODE_ENV` | `development` / `production` |

---

## 17. Security Controls Summary

| Layer | Control | Status |
|-------|---------|--------|
| Kernel | eBPF TC hooks — packet-level visibility | ✅ Implemented |
| Kernel | Packet forwarding (TC_ACT_OK — monitor only) | ✅ Implemented |
| Network | TLS interception / MITM inspection | ✅ Implemented |
| Network | Protocol fingerprinting (magic bytes) | ✅ Implemented |
| Application | HTTP: SQLi, XSS, LFI, SSRF, Log4Shell, Smuggling | ✅ Implemented |
| Application | SSH: weak algos, HASSH, brute-force | ✅ Implemented |
| Application | DNS: tunneling, DGA, rebinding | ✅ Implemented |
| Application | TLS: JA3, weak ciphers, downgrade | ✅ Implemented |
| Application | DB: dangerous commands, injection | ✅ Implemented |
| Application | SMTP/FTP/Telnet analyzers | ✅ Implemented |
| Behavioral | Port scan detection (sliding window) | ✅ Implemented |
| Behavioral | DDoS / high connection rate | ✅ Implemented |
| Behavioral | Brute-force detection (cross-protocol) | ✅ Implemented |
| Behavioral | C2 Beaconing (statistical) | ✅ Implemented |
| Behavioral | Data exfiltration (volume ratio) | ✅ Implemented |
| Dashboard | JWT authentication for UI users | ✅ Implemented |
| Dashboard | bcrypt-hashed node secret keys | ✅ Implemented |
| Dashboard | One-time enrollment tokens | ✅ Implemented |
| Dashboard | Helmet HTTP security headers | ✅ Implemented |
| Dashboard | CORS origin restriction | ✅ Implemented |
| Dashboard | Body size limit (10KB DoS protection) | ✅ Implemented |
| Dashboard | Rate limiting middleware | ✅ Implemented |
| Agent | AES-256-GCM encrypted credential storage | ✅ Implemented |
| Agent | Machine-locked key derivation | ✅ Implemented |
| Response | block_ip / unblock_ip commands (stub) | ⚠️ Stub — iptables not wired |
| MLOps | CICFlowMeter-compatible flow export | ✅ Implemented |
| MLOps | Per-protocol L7 feature extraction | ✅ Implemented |

---

*Generated from source scan of [`d:/YASH/Final Year Projett/`](file:///d:/YASH/Final%20Year%20Projett/) — covers all Go source files in `Security/`, all `Web/backend/src/` files, and the `proxy_config.yaml` schema.*
