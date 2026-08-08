# SSH Protocol — Detection Engine Documentation

> **File:** `Security/detect/ssh_analyzer.go`  
> **Component:** Protocol-specific analyzer within the NGFW Reverse Proxy detection pipeline  
> **Author:** Next-Gen IDS/IPS Project  
> **Last Updated:** 2026-08-07  
> **RFC References:** [RFC 4253](https://datatracker.ietf.org/doc/html/rfc4253) · [RFC 4252](https://datatracker.ietf.org/doc/html/rfc4252) · [RFC 4254](https://datatracker.ietf.org/doc/html/rfc4254)

---

## Table of Contents

1. [Type — What This Analyzer Does](#1-type)
2. [Architecture — State Machine](#2-architecture)
3. [Installation and Configuration Steps](#3-installation-and-configuration)
4. [Required Information to Detect](#4-required-information-to-detect)
5. [Detection Rules and Output](#5-detection-rules-and-output)
6. [Known Issues and Limitations](#6-known-issues-and-limitations)
7. [Remarks and Recommendations](#7-remarks-and-recommendations)

---

## 1. Type

**Category:** Application-Layer Protocol Analyzer (L7)  
**Protocol:** SSH (Secure Shell)  
**Port:** 22 (default) — configurable in `proxy_config.yaml`  
**Transport:** TCP  
**Inspection Mode:** Passive — the analyzer reads traffic in transit; it does not initiate connections or modify packets.  
**Encryption Boundary:** SSH traffic is **plaintext only until `SSH_MSG_NEWKEYS`**. After that message, all payload is encrypted with the negotiated session key. The analyzer operates exclusively on pre-encryption data.

### What The Analyzer Does

The SSH analyzer is a **fully stateful, per-connection protocol inspector**. It:

- Tracks every SSH connection through a 6-state lifecycle
- Performs **TCP stream reassembly** (handles fragmented SSH packets and coalesced TCP reads)
- Extracts and fingerprints SSH version banners (client and server)
- Parses `SSH_MSG_KEXINIT` to extract algorithm negotiation data
- Computes **HASSH fingerprints** and cross-references against known attack tool signatures
- Detects weak/deprecated cryptographic algorithms
- Fires heuristic alerts for brute-force patterns and banner scanners on connection close

### What The Analyzer Does NOT Do

- **Does not decrypt** post-NEWKEYS traffic (not possible in passive mode without session keys)
- **Does not inspect** channel messages (SSH_MSG_CHANNEL_OPEN type 90 is encrypted)
- **Does not block** connections — it is a detection-only passive monitor
- **Does not inspect** SSH authentication messages (also encrypted after NEWKEYS)

---

## 2. Architecture

### 2.1 State Machine

Each SSH TCP connection is tracked through the following states:

```
   ┌──────────────────┐
   │  TCPEstablished  │   TCP SYN-ACK complete. No SSH data yet.
   └────────┬─────────┘
            │ first byte arrives
            ▼
   ┌──────────────────┐
   │ VersionExchange  │   ASCII banner exchange ("SSH-2.0-OpenSSH_8.9")
   │                  │   Rules fire: SSH-VER-001, SSH-TOOL-001, SSH-PROTO-001
   └────────┬─────────┘
            │ both sides sent version string
            ▼
   ┌──────────────────┐
   │    KEXInit       │   SSH_MSG_KEXINIT (type 20) — algorithm negotiation
   │                  │   Rules fire: SSH-HASSH-001, SSH-WEAK-KEX/CIPHER/MAC
   └────────┬─────────┘
            │ DH/ECDH exchange starts
            ▼
   ┌──────────────────┐
   │   KEXExchange    │   Key exchange messages (types 30/31).
   │                  │   No payload inspection.
   └────────┬─────────┘
            │ SSH_MSG_NEWKEYS (type 21) received
            ▼
   ┌──────────────────┐
   │  PostNewKeys     │   All traffic is now encrypted. ──▶ On TCP close:
   │                  │                                      SSH-BRUTE-001 heuristic
   └──────────────────┘

   ParseAbandoned     →   Entered if malformed packet detected.
                          Rule fires: SSH-MALFORM-001
                          Inspection halted. Forwarding continues.
```

### 2.2 TCP Stream Reassembly

The proxy reads TCP data in 32KB chunks. SSH protocol frames can be split across reads (fragmentation) or multiple SSH frames can arrive in one read (coalescing). The analyzer handles both:

- **Version exchange phase**: Line-oriented reassembly (buffers until `\n`)
- **Binary packet phase**: Length-prefix reassembly (`uint32 packet_length` field)
- **Buffer cap**: 64KB per direction per connection (`sshMaxReassemlyBuf = 65536`)

### 2.3 HASSH Fingerprint Construction

HASSH is an SSH client/server fingerprinting technique ([Salesforce/hassh](https://github.com/salesforce/hassh)).

```
Client HASSH = MD5( kex_algos ; enc_c2s ; mac_c2s ; comp_c2s )
Server HASSH = MD5( kex_algos ; enc_s2c ; mac_s2c ; comp_s2c )
```

Where fields are taken from the respective peer's own `SSH_MSG_KEXINIT` packet, in the exact name-list order from RFC 4253 §7.1:

| Index | Field |
|:------|:------|
| 0 | kex_algorithms |
| 1 | server_host_key_algorithms |
| 2 | encryption_algorithms_**client**_to_server |
| 3 | encryption_algorithms_**server**_to_client |
| 4 | mac_algorithms_**client**_to_server |
| 5 | mac_algorithms_**server**_to_client |
| 6 | compression_algorithms_**client**_to_server |
| 7 | compression_algorithms_**server**_to_client |

### 2.4 Tool Classification

The tool database categorizes SSH clients by threat profile:

| Class | Examples | Severity |
|:------|:---------|:---------|
| `brute-force-tool` | Ncrack, Hydra, Medusa, Crowbar, Brutespray | HIGH |
| `scanner` | Masscan, ZGrab | MEDIUM |
| `automation-client` | Paramiko, JSch, AsyncSSH | LOW–MEDIUM |
| `ssh-library` | libssh, libssh2, Go x/crypto | LOW |
| `known-ssh-client` | OpenSSH, PuTTY, WinSCP | INFO (no alert) |

---

## 3. Installation and Configuration

### 3.1 Prerequisites

| Requirement | Details |
|:---|:---|
| Go version | 1.21+ |
| Operating system | Linux (eBPF requires kernel 5.8+) |
| SSH backend | A real SSH server running on a local port |
| Proxy mode | Run NGFW as a TCP proxy in front of the SSH server |

### 3.2 Build the Security Component

```bash
cd /home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security

# Build the binary (includes eBPF object generation)
make build
# or
go build -o ngfw-monitor .
```

### 3.3 Configure the SSH Listener

Edit `proxy_config.yaml` to point the proxy listener at your SSH server:

```yaml
listeners:
  - listen_port: 22        # Port the proxy listens on (clients connect here)
    backend_addr: 127.0.0.1:2222   # Your actual sshd on a non-standard port
    transport: tcp
    service: ssh            # CRITICAL: must be "ssh" for SSH analyzer to activate
    enabled: true
```

> **Important:** Move your real `sshd` to port `2222` (or any non-22 port) so the proxy can bind port 22. Edit `/etc/ssh/sshd_config` and set `Port 2222`, then `sudo systemctl restart ssh`.

### 3.4 Run the NGFW Monitor

```bash
# Interactive mode (recommended for first run)
sudo ./ngfw-monitor

# Choose option:
#   [2]  Reverse Proxy          — proxy + SSH detection only
#   [3]  Integrated Mode        — eBPF + proxy combined

# Direct mode (non-interactive)
sudo ./ngfw-monitor --proxy --config proxy_config.yaml
```

### 3.5 Verify SSH Traffic is Proxied

```bash
# From another terminal — connect through the proxy port
ssh user@127.0.0.1 -p 22

# Check the detection log
tail -f /home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security/logs/detections.jsonl
```

### 3.6 Detection Thresholds (Tunable Constants)

Located in `Security/detect/ssh_analyzer.go` — adjust after baseline testing:

| Constant | Default | Meaning |
|:---------|:--------|:--------|
| `sshBruteWindow` | 10 seconds | Sliding window for brute-force counting |
| `sshBruteTeardownMax` | 3 seconds | Max NEWKEYS→close delay to count as "rapid" |
| `sshBruteThreshold` | 5 | Rapid teardowns in window to fire SSH-BRUTE-001 |
| `sshMaxReassemlyBuf` | 65,536 bytes | Reassembly buffer cap per direction per session |
| `sshSessionIdleExpiry` | 10 minutes | Idle session eviction time |

> ⚠️ **Warning:** The brute-force thresholds are empirically unvalidated. Do NOT deploy in blocking mode without first running baseline measurements against your environment's normal SSH automation traffic.

---

## 4. Required Information to Detect

### 4.1 What the Analyzer Needs From the Network

| Signal | Source | Available? | Used By |
|:-------|:-------|:-----------|:--------|
| SSH version banner (client) | Plaintext, pre-encryption | ✅ Always visible | SSH-VER-001, SSH-TOOL-001, SSH-PROTO-001 |
| SSH version banner (server) | Plaintext, pre-encryption | ✅ Always visible | SSH-VER-001, SSH-SCAN-001 |
| `SSH_MSG_KEXINIT` payload | Plaintext, pre-encryption | ✅ Always visible | SSH-HASSH-001, SSH-WEAK-KEX/CIPHER/MAC |
| Algorithm name-lists | Part of KEXINIT | ✅ Always visible | SSH-WEAK-* rules |
| Connection close timestamp | TCP teardown event | ✅ Via AnalyzeClose() hook | SSH-BRUTE-001, SSH-SCAN-001 |
| `SSH_MSG_NEWKEYS` timestamp | Plaintext marker | ✅ Visible | SSH-BRUTE-001 timing |
| Auth username/password | Encrypted post-NEWKEYS | ❌ Not available | — |
| Auth success/failure | Encrypted post-NEWKEYS | ❌ Not available | — |
| Channel type / command | Encrypted post-NEWKEYS | ❌ Not available | — |
| Session key material | Never exposed by SSH | ❌ Not available | — |

### 4.2 What the Analyzer Tracks Per Connection

```go
sshSession {
    connID        // UUID from proxy (per TCP connection)
    srcIP         // Client IP address
    srcPort       // Client port
    dstPort       // Proxy listen port
    state         // Current state machine state
    newKeysAt     // Timestamp when NEWKEYS was received
    clientVersion // e.g. "SSH-2.0-OpenSSH_8.9p1"
    serverVersion // e.g. "SSH-2.0-OpenSSH_9.3"
    clientHASSH   // MD5 fingerprint of client algorithm preferences
    clientBuf     // Reassembly buffer (client→server direction, max 64KB)
    serverBuf     // Reassembly buffer (server→client direction, max 64KB)
    lastActivity  // Updated on every data chunk (for cleanup)
}
```

---

## 5. Detection Rules and Output

### 5.1 Complete Rule Reference

| Rule ID | Trigger Condition | Severity | Category | State |
|:--------|:-----------------|:---------|:---------|:------|
| **SSH-VER-001** | SSH version banner received (client or server) | INFO | `protocol-detect` | VersionExchange |
| **SSH-PROTO-001** | SSH protocol version `1.x` detected | HIGH | `ssh-legacy-protocol` | VersionExchange |
| **SSH-TOOL-001** | Client banner matches known attack/automation tool | LOW–HIGH | `bot-scanner` | VersionExchange |
| **SSH-HASSH-001** | KEXINIT parsed; HASSH fingerprint computed | INFO–HIGH | `protocol-detect` | KEXInit |
| **SSH-WEAK-KEX** | Deprecated key-exchange algorithm advertised | MEDIUM | `ssh-weak-algo` | KEXInit |
| **SSH-WEAK-CIPHER** | Deprecated cipher advertised | MEDIUM | `ssh-weak-algo` | KEXInit |
| **SSH-WEAK-MAC** | Deprecated MAC algorithm advertised | MEDIUM | `ssh-weak-algo` | KEXInit |
| **SSH-MALFORM-001** | Malformed packet (invalid length, truncated KEXINIT) | MEDIUM | `ssh-malformed` | Any pre-NEWKEYS |
| **SSH-SCAN-001** | Server banner read, client disconnected before KEX | MEDIUM | `ssh-banner-scan` | On TCP close |
| **SSH-BRUTE-001** | ≥5 rapid teardowns (NEWKEYS→close <3s) in 10s window | HIGH | `ssh-brute-force` | On TCP close |

### 5.2 Sample Detection Output (JSONL)

**SSH-VER-001 — Version logged:**
```json
{
  "id": "SSH-VER-001",
  "timestamp": "2026-08-07T09:15:00.123456789Z",
  "severity": 0,
  "severity_str": "INFO",
  "category": "protocol-detect",
  "protocol": "SSH",
  "source_ip": "192.168.1.100",
  "source_port": 54321,
  "dest_port": 22,
  "summary": "SSH client version: SSH-2.0-OpenSSH_8.9p1",
  "conn_id": "a1b2c3d4-e5f6-...",
  "details": {
    "direction": "client",
    "protocol_version": "2.0",
    "software_version": "OpenSSH_8.9p1",
    "banner": "SSH-2.0-OpenSSH_8.9p1"
  }
}
```

**SSH-HASSH-001 — Client fingerprint:**
```json
{
  "id": "SSH-HASSH-001",
  "severity_str": "INFO",
  "category": "protocol-detect",
  "summary": "SSH client HASSH: ec7378c1a92f5a8dde7f93c69b56b8c2",
  "details": {
    "hassh": "ec7378c1a92f5a8dde7f93c69b56b8c2",
    "direction": "client",
    "kex_algorithms": "curve25519-sha256,diffie-hellman-group14-sha256",
    "enc_algorithms": "chacha20-poly1305@openssh.com,aes256-gcm@openssh.com",
    "mac_algorithms": "hmac-sha2-256-etm@openssh.com,hmac-sha2-512-etm@openssh.com",
    "comp_algorithms": "none,zlib@openssh.com",
    "known_attack_tool": "",
    "hash_input": "curve25519-sha256,...;chacha20-poly1305@openssh.com,...;hmac-sha2-256-etm,...;none,..."
  }
}
```

**SSH-WEAK-CIPHER — Deprecated cipher:**
```json
{
  "id": "SSH-WEAK-CIPHER",
  "severity_str": "MEDIUM",
  "category": "ssh-weak-algo",
  "summary": "Weak SSH cipher algorithms advertised: 3des-cbc, aes128-cbc",
  "details": {
    "algorithm_type": "cipher",
    "weak_algorithms": ["3des-cbc", "aes128-cbc"],
    "full_list": "3des-cbc,aes128-cbc,aes256-ctr,...",
    "recommendation": "Use chacha20-poly1305@openssh.com or aes256-gcm@openssh.com (AEAD preferred)"
  }
}
```

**SSH-TOOL-001 — Known attack tool:**
```json
{
  "id": "SSH-TOOL-001",
  "severity_str": "HIGH",
  "category": "bot-scanner",
  "summary": "SSH client identified as brute-force-tool: Ncrack (banner: Ncrack-0.7)",
  "details": {
    "tool_name": "Ncrack",
    "tool_class": "brute-force-tool",
    "tool_note": "Network authentication cracking tool",
    "tool_keyword": "ncrack",
    "software_ver": "Ncrack-0.7",
    "limitation": "Banner strings can be spoofed. Combine with HASSH for higher confidence."
  }
}
```

**SSH-BRUTE-001 — Heuristic rapid-teardown pattern:**
```json
{
  "id": "SSH-BRUTE-001",
  "severity_str": "HIGH",
  "category": "ssh-brute-force",
  "summary": "SSH heuristic: 192.168.1.50 made 7 rapid-teardown connections in 10s (NEWKEYS→close in 412ms) — possible automated auth attempts",
  "details": {
    "rapid_teardowns_in_window": 7,
    "window_seconds": 10,
    "threshold": 5,
    "teardown_delay_ms": 412,
    "confidence": "MEDIUM",
    "note": "Heuristic: connect→NEWKEYS→rapid-disconnect pattern. Cannot confirm auth failure in passive mode. False positives: health checks, CI/CD pipelines, BatchMode sessions."
  }
}
```

**SSH-SCAN-001 — Banner scanner:**
```json
{
  "id": "SSH-SCAN-001",
  "severity_str": "MEDIUM",
  "category": "ssh-banner-scan",
  "summary": "SSH heuristic: 10.0.0.5 read server banner and disconnected before key exchange (possible scanner)",
  "details": {
    "server_version": "SSH-2.0-OpenSSH_9.3",
    "phase_reached": "VERSION_EXCHANGE",
    "confidence": "MEDIUM",
    "note": "Heuristic indicator only. Legitimate clients can also disconnect early."
  }
}
```

**SSH-PROTO-001 — Legacy SSHv1:**
```json
{
  "id": "SSH-PROTO-001",
  "severity_str": "HIGH",
  "category": "ssh-legacy-protocol",
  "summary": "SSHv1 detected from client (SSH-1.99-OpenSSH_7.2) — cryptographically broken, deprecated by RFC 4253",
  "details": {
    "protocol_version": "1.99",
    "software_version": "OpenSSH_7.2",
    "direction": "client",
    "banner": "SSH-1.99-OpenSSH_7.2"
  }
}
```

---

## 6. Known Issues and Limitations

### 6.1 Encryption Boundary (Fundamental — Cannot Be Fixed)

| After `SSH_MSG_NEWKEYS`, the analyzer sees only ciphertext. |
|:----|
| This means the following are **permanently invisible** to a passive analyzer without session key access: authentication usernames and passwords, authentication success/failure messages (`SSH_MSG_USERAUTH_*`), channel open requests and channel types, commands executed in the session, file transfers (SFTP). |

**Impact on rules:**
- `SSH-BRUTE-001` cannot directly observe auth failures. It uses the timing heuristic (NEWKEYS → rapid close) as a proxy signal.
- `SSH-CHAN-001` (tunneling/port forwarding detection) is **not implemented** because `SSH_MSG_CHANNEL_OPEN` is encrypted. Any implementation would be false-positive-only.

### 6.2 SSH-BRUTE-001 — Heuristic Confidence

- **Confidence:** MEDIUM (not HIGH). Cannot confirm auth failure in passive mode.
- **Known false positive sources:**
  - `ssh -O exit` / `BatchMode=yes` sessions that complete quickly
  - Nagios / Prometheus SSH health checks
  - CI/CD pipelines running short commands (`ssh host echo ok`)
  - Connection multiplexers (`ControlMaster`) that probe server availability
- **Threshold values are empirically unvalidated.** Adjust `sshBruteThreshold`, `sshBruteWindow`, and `sshBruteTeardownMax` after baseline testing with your environment.

### 6.3 SSH-TOOL-001 — Banner Spoofing

- Any SSH client can set an arbitrary version string in `SSH-2.0-<softwareversion>`.
- A sophisticated attacker can set `SSH-2.0-OpenSSH_8.9p1` to avoid tool detection.
- **Mitigation (Phase 2 — not yet implemented):** Cross-reference banner with HASSH fingerprint. A client claiming to be OpenSSH but showing a Paramiko HASSH fingerprint is a strong anomaly signal.

### 6.4 SSH-SCAN-001 — Over-Broad Trigger

- A client that connects, receives the server banner, and disconnects before completing KEX fires SSH-SCAN-001.
- This also fires for: connection refused by application logic, network interruptions, timeout-based probes.
- **Confidence is MEDIUM.** Do not treat as confirmed scanning activity alone.

### 6.5 NAT Environment — Brute-Force Key Conflation

- The brute-force window is keyed by `srcIP:dstPort`.
- In a NAT environment where many clients share one IP, rapid teardowns from **different users** may accumulate in the same window and trigger a false positive.
- This is an accepted limitation for IDS detection. Fine-tune `sshBruteThreshold` for environments with heavy SSH NAT traffic.

### 6.6 Malformed Packet — Inspection Blindspot

- When `SSH-MALFORM-001` fires, the session transitions to `ParseAbandoned`.
- **Inspection halts but forwarding continues** — the proxy remains fully operational.
- A sophisticated attacker can intentionally send a malformed packet early in the handshake to blind the analyzer for the rest of that session.
- **Mitigation options (not yet implemented):** Rate-limit connections that trigger SSH-MALFORM-001; consider connection termination as an active response policy for ParseAbandoned sessions.

### 6.7 Concurrency and Race Safety

- `SSHAnalyzer.sessions` and `bfWindows` are protected by `sync.Mutex`.
- The implementation has been rigorously tested under high concurrency with Go's race detector (`go test -race`).
- **Verified:** No data races occur during concurrent handshakes, stream reassembly, or teardown events.

---

## 7. Remarks and Recommendations

### 7.1 Operational Deployment Checklist

Before deploying SSH detection in production:

- [ ] Move `sshd` to a non-standard port (e.g., 2222) and proxy port 22 through NGFW
- [ ] Run 48 hours of passive monitoring in **detection-only mode** before enabling any blocking
- [ ] Measure the SSH-BRUTE-001 false-positive rate for your environment's automation
- [ ] Adjust `sshBruteThreshold` if CI/CD pipelines generate excessive alerts
- [ ] Add your known legitimate SSH client HASSH fingerprints to an allowlist (Phase 2)
- [ ] If using OpenSSH ≥9.0 on both client and server, weak algorithms are disabled by default — SSH-WEAK-* rules will not fire for modern clients

### 7.2 Recommended Server SSH Configuration (Harden to Reduce Alerts)

Configuring your SSH server to only accept strong algorithms eliminates SSH-WEAK-* alerts for legitimate connections and makes anomalous algorithm preferences more visible:

```sshd_config
# /etc/ssh/sshd_config — recommended hardened settings
KexAlgorithms curve25519-sha256,diffie-hellman-group16-sha512
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com
MACs hmac-sha2-256-etm@openssh.com,hmac-sha2-512-etm@openssh.com
HostKeyAlgorithms ssh-ed25519,rsa-sha2-512
PasswordAuthentication no   # Disable password auth entirely
MaxAuthTries 3
LoginGraceTime 30
```

### 7.3 Phase 2 — Planned Enhancements

| Enhancement | Status | Priority |
|:---|:---|:---|
| Multi-signal tool correlation (banner + HASSH combined) | Planned | High |
| HASSH allowlist for known-good clients | Planned | High |
| Configurable thresholds via `proxy_config.yaml` (no recompile) | Planned | Medium |
| Per-connection HASSH cross-reference against threat intel feeds | Planned | Medium |
| SSH-CHAN-001 with TLS interception key (active mitm mode) | Research | Low |
| Unit tests with Go race detector | **Completed** | High |
| Negative test suite (legitimate traffic baseline) | **Completed** | High |

### 7.4 Relevant Source Files

| File | Purpose |
|:-----|:--------|
| [`detect/ssh_analyzer.go`](../detect/ssh_analyzer.go) | Main SSH analyzer — state machine, reassembly, all rules |
| [`detect/detection.go`](../detect/detection.go) | Detection types, severity levels, category constants |
| [`proxy/proxy.go`](../proxy/proxy.go) | `AnalyzerRouter` — dispatches to SSH analyzer; panic recovery |
| [`proxy/forwarder.go`](../proxy/forwarder.go) | TCP relay — calls `AnalyzeClose()` on teardown |
| [`proxy_config.yaml`](../proxy_config.yaml) | Listener configuration — SSH listener on port 22 → 2222 |
