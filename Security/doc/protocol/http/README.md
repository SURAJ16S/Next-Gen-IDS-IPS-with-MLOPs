# HTTP Protocol — Detection Engine Documentation

> **File:** `Security/detect/http_analyzer.go`  
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

**Category:** Application-Layer Protocol Analyzer (L7)  
**Protocol:** HTTP/1.1 (Hypertext Transfer Protocol)  
**Port:** 80, 8080 (default) — configurable in `proxy_config.yaml`  
**Transport:** TCP  
**Inspection Mode:** Passive — the analyzer reads and reconstructs HTTP requests and responses in transit.

### What The Analyzer Does

The HTTP analyzer is an extensively developed **deep packet inspection module** that reconstructs and parses HTTP traffic on the fly. It is responsible for:

- **Attack Signature Scanning**: Scans over 40+ specific regex patterns across URIs, headers, bodies, and cookies to detect attacks such as SQL Injection (SQLi), Cross-Site Scripting (XSS), Path Traversal, SSRF, Command Injection, XXE, and Log4Shell.
- **Machine Learning Feature Extraction**: Computes statistical payload metadata (entropy, digit ratios, character anomalies, base64/hex encoding prevalence) for the URI, Body, and User-Agent (`HTTP-FEAT-001`). This metadata is passed directly to the MLOps pipeline.
- **Session & Rate Tracking**: Correlates requests over time to identify bot scanners, rapid connection bursts, and L7 DDoS attempts.
- **Security Misconfigurations**: Inspects server responses for missing security headers (HSTS, CSP, X-XSS-Protection).
- **HTTP Smuggling Analysis**: Analyzes potentially malformed or conflicting `Content-Length` and `Transfer-Encoding` headers.

---

## 2. Installation and Configuration Steps

### 2.1 Prerequisites

The HTTP analyzer requires the NGFW monitor to be running as a TCP reverse proxy in front of an actual web application or API server.

### 2.2 Configure the HTTP Listener

Edit `proxy_config.yaml` to point the proxy listener at your web backend. The `service` field **must** be set to `http`.

```yaml
listeners:
  - listen_port: 80        # The port your clients will connect to
    backend_addr: 127.0.0.1:8080   # Your actual web server (e.g., Node.js, Nginx, Python)
    transport: tcp
    service: http          # CRITICAL: Triggers the HTTP Analyzer
    enabled: true
```

### 2.3 Run the NGFW Monitor

Because port 80 is a privileged port, you must run the monitor with `sudo`.

```bash
cd /home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security
sudo ./ngfw-monitor --proxy --config proxy_config.yaml
```

### 2.4 Verify Traffic

Generate a simple HTTP request using curl and check if `HTTP-REQ-001` or any attack detections are logged:
```bash
curl -s "http://127.0.0.1:80/?search=<script>alert(1)</script>"
tail -f /home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security/logs/detections.jsonl
```

---

## 3. Required Information to Detect

The HTTP analyzer relies on the reverse proxy extracting the raw byte stream of the connection. For proper analysis, it reconstructs:

| Signal | Source | Used By |
|:-------|:-------|:--------|
| **Request URI** | Request Line | SQLi, XSS, Path Traversal, Command Injection, SSRF |
| **HTTP Headers** | Request/Response Headers | Log4Shell, User-Agent Fingerprinting, HTTP Smuggling, Security Header Checks |
| **HTTP Body** | Request/Response Payload | File Upload detection, XXE, SQLi, ML Feature Extraction |
| **Connection ID & IP** | TCP Connection Metadata | Rate limiting and session tracking |

> **Note:** The analyzer automatically URL-decodes and double-decodes URIs to prevent evasion via encoded characters (`%3Cscript%3E` → `<script>`).

---

## 4. Detection Output and Rules

### 4.1 Categories of Detected Attacks

The analyzer includes over 40 highly specific detection signatures. Here are the primary categories:

- `sqli`: SQL Injection (UNION based, Error based, Time-based blind, Boolean blind, Hex Encodings).
- `xss`: Cross-Site Scripting (Script tags, Event handlers, Data URIs).
- `path-traversal`: Directory traversal (`../`, null byte `%00`, sensitive file access like `/etc/passwd`).
- `command-injection`: Shell injection (`$()`, backticks, piping).
- `ssrf`: Server-Side Request Forgery targeting cloud metadata IPs (`169.254.169.254`) or internal ranges.
- `xxe` & `log4shell`: XML External Entity and JNDI lookups.
- `http-smuggling`: CL.TE / TE.CL desync attacks.

### 4.2 Sample Detection JSON

**HTTP-SQLI-002 — SQL Injection Example:**
```json
{
  "id": "HTTP-SQLI-002",
  "timestamp": "2026-08-01T02:26:15.901663646+06:00",
  "severity": 3,
  "severity_str": "HIGH",
  "category": "sqli",
  "protocol": "HTTP",
  "source_ip": "127.0.0.1",
  "source_port": 58088,
  "dest_port": 80,
  "summary": "SQL OR 1=1 detected in decoded_uri",
  "details": {
    "attack": "SQL OR 1=1",
    "location": "decoded_uri",
    "method": "GET",
    "uri": "/?search=1'%20OR%20'1'='1"
  },
  "raw_evidence": "OR '1'='1",
  "conn_id": "8ae246dd-5bd8-44f7-a5ff-4322b3af4ee7"
}
```

**HTTP-FEAT-001 — ML Feature Extraction:**
Every HTTP request generates a feature vector for the MLOps pipeline.
```json
{
  "id": "HTTP-FEAT-001",
  "category": "ml-features",
  "summary": "Request features: GET /index.html",
  "details": {
    "uri_entropy": 3.42,
    "uri_special_char_ratio": 0.15,
    "uri_sql_keyword_count": 0,
    "body_entropy": 0,
    "ua_length": 68,
    "header_count": 8,
    "duplicate_headers": 0
  }
}
```

---

## 5. Issues and Limitations

### 5.1 TLS / HTTPS Traffic
Because the engine is currently acting as a passive TCP reverse proxy (without TLS termination/interception configured), **encrypted HTTPS traffic on port 443 cannot be inspected**. To inspect HTTPS, the proxy would need to be configured for active TLS termination.

### 5.2 Large Body Payloads
Extremely large file uploads (e.g., video uploads) are partially buffered and inspected, but inspecting gigabytes of data per request synchronously will significantly increase latency and proxy memory consumption.

### 5.3 False Positives with Generic Signatures
Certain signatures (e.g., SQL `OR` statements, shell commands like `cat` or `id`) may trigger false positives if the application naturally handles this kind of text (e.g., a blogging platform discussing programming). Fine-tuning and allowlisting specific routes might be required for production.

---

## 6. Remarks

The HTTP analyzer represents the most comprehensive protocol inspector in the NGFW currently. It successfully bridges the gap between rule-based IDS (via regex signatures) and Machine Learning (via `HTTP-FEAT-001` metadata extraction). 

**Recommended Next Steps:**
1. Connect the `HTTP-FEAT-001` logs to the MLOps pipeline to begin training behavioral anomaly models.
2. Implement the active blocking IPS rules to dynamically drop connections that flag Critical vulnerabilities like `HTTP-CMDI-001` (Command Injection) or `HTTP-LOG4-001` (Log4Shell).
