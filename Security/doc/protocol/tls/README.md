# TLS / HTTPS Protocol — Detection Engine Documentation

> **File:** `Security/detect/tls_inspect.go`  
> **Component:** Protocol-specific analyzer within the NGFW Reverse Proxy detection pipeline  
> **Author:** Next-Gen IDS/IPS Project  

---

## Table of Contents

1. [Type — What This Analyzer Does](#1-type)
2. [Installation and Configuration Steps](#2-installation-and-configuration-steps)
3. [Required Information to Detect](#3-required-information-to-detect)
4. [Detection Output and Rules](#4-detection-output-and-rules)
5. [Issues and Limitations](#5-issues-and-limitations)
6. [Remarks](#6-remarks)

---

## 1. Type

**Category:** Transport-Layer Security Inspector (L4/L7)  
**Protocol:** SSLv3, TLS 1.0, 1.1, 1.2, 1.3  
**Port:** 443 (default) — configurable in `proxy_config.yaml`  
**Transport:** TCP  
**Inspection Mode:** Passive — the analyzer reads and reconstructs TLS Handshake records without terminating the TLS connection.

### What The Analyzer Does

The TLS analyzer is a deeply stateful, passive inspection module that reconstructs fragmented TCP streams to parse the TLS Handshake. It is responsible for:

- **JA3 / JA3S Fingerprinting**: Extracts cipher suites, extensions, and elliptic curves from `ClientHello` and `ServerHello` packets to compute MD5 behavioral hashes. This includes robust filtering of randomized "GREASE" values (`0x?A?A`) to ensure fingerprint stability for modern browsers.
- **Weak Cipher Detection**: Scans the advertised and selected cipher suites for deprecated, weak, or export-grade cryptography (e.g., RC4, 3DES, NULL ciphers, MD5).
- **Protocol Downgrade Detection**: Flags clients attempting to negotiate severely deprecated protocols (SSLv3 or TLS 1.0).
- **Certificate Threat Analysis (TLS 1.2)**: Extracts server X.509 Certificates and evaluates them for expiration (`NotAfter` checks), self-signing (Subject matching Issuer), and weak signature algorithms (MD5/SHA1).
- **Server Name Indication (SNI)**: Extracts the destination hostname the client is attempting to reach before the traffic is encrypted.

---

## 2. Installation and Configuration Steps

### 2.1 Prerequisites

The TLS analyzer requires the NGFW monitor to be running as a TCP reverse proxy. 

### 2.2 Configure the TLS Listener

Edit `proxy_config.yaml` to point the proxy listener at your HTTPS backend. The `service` field **must** be set to `tls`.

```yaml
listeners:
  - listen_port: 443        # The port your clients will connect to
    backend_addr: 127.0.0.1:8443   # Your actual HTTPS server
    transport: tcp
    service: tls          # CRITICAL: Triggers the TLS Inspector
    enabled: true
```

### 2.3 Run the NGFW Monitor

Because port 443 is a privileged port, you must run the monitor with `sudo`.

```bash
cd /home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security
sudo ./ngfw-monitor --proxy --config proxy_config.yaml
```

---

## 3. Required Information to Detect

The TLS analyzer operates by reassembling the raw TCP stream and extracting TLS Records (Type `0x16`). It relies on the unencrypted portions of the handshake:

| Signal | Source | Used By |
|:-------|:-------|:--------|
| **ClientHello** | Initial Client Handshake (Type 0x01) | JA3 Hash, SNI, Weak Ciphers, Downgrades |
| **ServerHello** | Initial Server Response (Type 0x02) | JA3S Hash, Weak Selected Cipher |
| **Certificate** | Server Handshake (Type 0x0B) | Expired Certs, Self-Signed Certs, Weak Signatures |

> **Note:** The module contains a sophisticated state machine that gracefully halts inspection upon detecting a `ChangeCipherSpec` (0x14) or `ApplicationData` (0x17) record, as all subsequent traffic is encrypted.

---

## 4. Detection Output and Rules

### 4.1 Categories of Detected Attacks

- `TLS-HELLO-001` (INFO): Baseline tracking of `ClientHello` metadata (SNI, JA3).
- `TLS-SHELLO-001` (INFO): Baseline tracking of `ServerHello` metadata (JA3S).
- `TLS-WEAK-001` (HIGH): Client offered weak/deprecated cipher suites.
- `TLS-WEAK-SEL` (CRITICAL): Server explicitly selected a weak cipher suite.
- `TLS-DOWNGRADE` (HIGH): Client advertises maximum version ≤ TLS 1.0.
- `TLS-CERT-EXPIRED` (MEDIUM): The server's certificate `NotAfter` date has passed.
- `TLS-CERT-SELFSIGNED` (LOW): The server's certificate is self-signed.
- `TLS-CERT-WEAK-SIG` (HIGH): The server's certificate uses MD5 or SHA1 for signatures.

### 4.2 Sample Detection JSON

**TLS-HELLO-001 — Client JA3 Fingerprint:**
```json
{
  "id": "TLS-HELLO-001",
  "severity_str": "INFO",
  "category": "protocol-detect",
  "protocol": "TLS",
  "summary": "TLS ClientHello: TLS 1.3, SNI=api.example.com, JA3=cd08e31494f9531f560d64c695473da9",
  "details": {
    "alpn": ["h2", "http/1.1"],
    "cipher_suite_count": 15,
    "extension_count": 11,
    "ja3_hash": "cd08e31494f9531f560d64c695473da9",
    "sni": "api.example.com",
    "tls_version": "TLS 1.3"
  }
}
```

**TLS-CERT-EXPIRED — Certificate Threat:**
```json
{
  "id": "TLS-CERT-EXPIRED",
  "severity_str": "MEDIUM",
  "category": "protocol-detect",
  "protocol": "TLS",
  "summary": "Expired TLS Certificate: dummy.example.com",
  "conn_id": "8ae246dd-5bd8-44f7-a5ff-4322b3af4ee7"
}
```

---

## 5. Issues and Limitations

### 5.1 TLS 1.3 Encryption Blindspot
In modern TLS 1.3, the entire handshake following the `ServerHello` is encrypted under the Handshake Traffic Key. Because this inspector operates purely passively (without intercepting/terminating the TLS connection), **it cannot view TLS 1.3 Certificates**. 
- The `TLS-CERT-*` rules will only fire against servers negotiating **TLS 1.2 or lower**. 

### 5.2 Decrypting HTTPS Application Data
Because the proxy does not terminate TLS, the underlying HTTP traffic (such as URIs and HTTP bodies) cannot be inspected. To inspect the application layer for SQLi/XSS, you must configure the NGFW to terminate the TLS connection and pass the unencrypted payload to the `HTTP Analyzer`.

---

## 6. Remarks

The TLS module sets a rigorous standard for passive network inspection. Its TCP stream reassembly guarantees stability against extreme packet fragmentation, while its meticulous handling of JA3 GREASE values ensures highly reliable behavioral signatures for the MLOps pipeline.

**Recommended Next Steps:**
1. Connect the `JA3` and `JA3S` fingerprints to the MLOps pipeline to train clustering models that can identify malware/botnets (which often have unique, static JA3 hashes) without relying on IP addresses.
2. Implement **Active TLS Termination** (MITM proxying) to allow the `HTTP Analyzer` to inspect encrypted application-layer traffic.
