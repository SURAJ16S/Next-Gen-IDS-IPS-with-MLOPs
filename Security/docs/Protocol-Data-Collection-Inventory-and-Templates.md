# Per-Protocol Data Collection Inventory — Current Fields, Sample Templates, Pending Work

This is a field-by-field inventory of what `Security/detect/*.go` actually emits today, pulled directly from the source (not from the architecture doc). For each protocol: **(1)** what's collected, **(2)** a single JSON template showing every field your system is capable of producing for that protocol (in reality these arrive as separate `Detection` events over time, not one combined object — the template below merges them so you can see the full available feature set at a glance), **(3)** what's still missing before the ML module can consume it properly. **§12 at the end gives the concrete implementation technique for each critical missing field** — not just what's missing, but how to build it.

Two things apply to **every** protocol and aren't repeated in each section:

- **Connection envelope** (from `ConnectionRecord`, emitted once per closed connection, all protocols): `conn_id`, `client_ip`, `client_port`, `listen_port`, `backend_addr`, `detected_protocol`, `expected_service`, `proto_mismatch`, `start_time`, `end_time`, `duration_ms`, `bytes_from_client`, `bytes_to_client`, `detection_count`, `max_severity`, `close_reason`.
- **L4 flow record** (from `FlowRecord` / `FlowTracker`, emitted once per flow close, protocol-agnostic, CICFlowMeter schema): identity (`flow_id`, `src_ip`, `dst_ip`, `src_port`, `dst_port`, `protocol`), timing, packet/byte counts (fwd/bwd), packet-size stats, TCP flag counts, `flow_pkts_per_sec`, `flow_bytes_per_sec`, forward/backward IAT stats, active/idle time stats. This is written to `logs/flow_stats.jsonl` independent of which L7 protocol is running.

---

## 1. HTTP / HTTPS

### Currently collected
- Request metadata: method, URI, HTTP version, host, user-agent, content-type, referer, cookie count
- **ML feature vector (`HTTP-FEAT-001`)**: URI length, query param count, content length, header count, header size, duplicate-header count, cookie count, JWT-present flag, auth-present flag, has-referer, has-origin, accept/accept-encoding, plus full `PayloadStats` (entropy, char ratios, encoding counts, SQL/XSS/traversal/cmd-injection/HTML/JS pattern counts) computed separately for URI, body, and user-agent
- Attack signature hits (40+ patterns): SQLi, XSS, path traversal, command injection, SSRF, XXE, Log4Shell, HTTP smuggling, CRLF injection, open redirect, credential-in-URL
- WebSocket upgrade detection
- **Response side (`HTTP-FEAT-002`)**: status code, response size, response time (ms), response header count, compression flag, content-type, cache-control, server header, missing-security-header count, response-body entropy/length/HTML-tag-count/JS-pattern-count
- Info leakage in response body (stack traces, tracebacks)
- Missing security headers (CSP, X-Frame-Options, X-Content-Type-Options, HSTS, X-XSS-Protection, Referrer-Policy)
- Bot/scanner tool fingerprint match (User-Agent string match: sqlmap, Nikto, python-requests, etc.)

### Sample collected-data template (merged view)
```json
{
  "conn_id": "a1b2c3d4",
  "protocol": "HTTP",
  "source_ip": "203.0.113.10",
  "source_port": 51422,
  "dest_port": 8080,
  "request": {
    "method": "POST",
    "uri": "/login",
    "uri_length": 6,
    "http_version": "HTTP/1.1",
    "host": "app.example.com",
    "user_agent": "Mozilla/5.0 ...",
    "content_type": "application/x-www-form-urlencoded",
    "referer": "",
    "cookie_count": 2,
    "query_param_count": 0,
    "content_length": 32,
    "header_count": 9,
    "header_size": 412,
    "duplicate_headers": 0,
    "jwt_present": false,
    "auth_present": false,
    "has_referer": false,
    "has_origin": true
  },
  "payload_stats": {
    "uri":  {"entropy": 3.1, "digit_ratio": 0.0, "special_char_ratio": 0.05, "sql_keyword_count": 0, "xss_pattern_count": 0, "path_traversal_count": 0, "cmd_injection_count": 0, "base64_count": 0, "hex_count": 0},
    "body": {"entropy": 4.8, "sql_keyword_count": 3, "xss_pattern_count": 0, "token_count": 4, "avg_token_length": 7.2},
    "user_agent": {"entropy": 4.2, "special_char_ratio": 0.08}
  },
  "response": {
    "status_code": 500,
    "response_size": 1820,
    "response_time_ms": 145,
    "resp_header_count": 6,
    "has_compression": false,
    "content_type": "text/html",
    "server": "nginx/1.18.0",
    "missing_security_headers": 4,
    "resp_body_entropy": 4.6,
    "resp_body_html_tag_count": 12,
    "resp_body_js_pattern_count": 0
  },
  "detections": [
    {"id": "HTTP-SQLI-001", "severity": "HIGH", "attack": "sqli-union", "location": "body"},
    {"id": "HTTP-LEAK-001", "severity": "MEDIUM", "summary": "Stack trace in response"}
  ]
}
```

### Pending / needed
1. **BOLA / BOPLA / SSRF-via-API / JWT structural checks** — promised in your defense matrix and OWASP API Top 10 scope, but there is no parameter-ID sequential-change tracker, no mass-assignment/schema validator, and no JWT signature/claims validator in `http_analyzer.go` today. This needs new detection logic, not just an ML model — an ML model has nothing to score until the raw signal exists.
2. **Session-level sequence features** — `SessionTracker` only stores `RequestCount` and a set of unique URIs; no inter-request timing, no parameter-value diversity tracking. Needed for BOLA/ID-enumeration and scraping detection.
3. **Labels.** All of the above is raw feature data, not attack/benign labels — needed before Model #2 (web attack classifier) in the design doc can be trained.
4. **Rate/threshold context merged in.** URI length, entropy etc. are emitted per-request but not yet joined with the `BehavioralEngine`'s per-IP rate counters in one record — worth doing at the feature-store layer.

---

## 2. TLS (wraps HTTPS, SMTPS, FTPS, etc.)

### Currently collected
- ClientHello (`TLS-HELLO-001`): **JA3 hash + full JA3 string**, TLS version, SNI, ALPN, cipher-suite count, extension count, supported-versions list, session-resumption attempt flag
- ServerHello (`TLS-HELLO-...`): **JA3S hash + string**, negotiated TLS version, selected cipher
- Certificate (`TLS-CERT-001`): issuer, subject, not-before/not-after, DNS names, IP addresses
- Weak cipher detection (client-offered and server-selected, separately)
- Downgrade detection (client only offers ≤TLS 1.1)
- Expired-certificate detection

### Sample collected-data template
```json
{
  "conn_id": "a1b2c3d4",
  "protocol": "TLS",
  "client_hello": {
    "ja3_hash": "e7d705a3286e19ea42f587b344ee6865",
    "ja3_string": "771,4865-4866-4867,0-23-65281,29-23-24,0",
    "tls_version": "TLS 1.3",
    "sni": "app.example.com",
    "alpn": ["h2", "http/1.1"],
    "cipher_suite_count": 14,
    "extension_count": 11,
    "supported_versions": ["1.3", "1.2"],
    "session_resumption_attempt": false
  },
  "server_hello": {
    "ja3s_hash": "b5001ab5309c0e484b8c1c0cd5c3e1c1",
    "ja3s_string": "771,4865,51-43",
    "tls_version": "TLS 1.3",
    "selected_cipher": "0x1301"
  },
  "certificate": {
    "issuer": "CN=R3,O=Let's Encrypt",
    "subject": "CN=app.example.com",
    "not_before": "2026-01-01T00:00:00Z",
    "not_after": "2026-04-01T00:00:00Z",
    "dns_names": ["app.example.com"],
    "ip_addrs": []
  },
  "detections": [
    {"id": "TLS-WEAK-001", "severity": "HIGH", "weak_ciphers": ["TLS_RSA_WITH_RC4_128_SHA"]}
  ]
}
```

### Pending / needed
1. **JA4 is not implemented** — only JA3/JA3S. Your synopsis/PPT names JA4 specifically; either implement it (a defined, published algorithm, moderate Go effort) or remove the claim from your documentation.
2. **Known-bad JA3 hash feed** — the hash is computed but never checked against a blocklist (Abuse.ch JA3 feed is the standard source). Without this, JA3 is logged but not actionable.
3. **TLS 1.3 certificate blindspot** — the code's own comment notes TLS 1.3 certs are encrypted and invisible to passive inspection; certificate-based detections (expired/self-signed) only work reliably on TLS 1.2 and earlier. Document this as a known limitation, don't claim full cert visibility.

---

## 3. SSH

### Currently collected
- Version exchange (`SSH-VER-001`): direction, protocol version, software version, full banner string
- Legacy protocol detection (`SSH-PROTO-001`): flags SSHv1
- **HASSH fingerprint (`SSH-HASSH-001`)**: MD5 HASSH hash, direction, full KEX/encryption/MAC/compression algorithm lists, hash input string, known-attack-tool match (against a small built-in table)
- Weak algorithm checks: separate rule IDs for weak KEX, weak cipher, weak MAC
- Known-tool fingerprint match (`SSH-TOOL-001`) from banner string
- Banner-scan heuristic (`SSH-SCAN-001`): server version, phase reached, confidence label
- Brute-force heuristic (`SSH-BRUTE-001`): rapid-teardown count in window, window size, threshold, teardown delay — **explicitly documented in the code as a heuristic with known false-positive sources** (health checks, CI/CD, BatchMode sessions)

### Sample collected-data template
```json
{
  "conn_id": "a1b2c3d4",
  "protocol": "SSH",
  "source_ip": "203.0.113.55",
  "dest_port": 22,
  "version": {
    "direction": "client",
    "protocol_version": "2.0",
    "software_version": "OpenSSH_9.2",
    "banner": "SSH-2.0-OpenSSH_9.2"
  },
  "hassh": {
    "direction": "client",
    "hassh": "ec7378c1a92f5a8dde7e8b7cd18d6cca",
    "kex_algorithms": "curve25519-sha256,ecdh-sha2-nistp256",
    "enc_algorithms": "aes128-gcm@openssh.com",
    "mac_algorithms": "hmac-sha2-256",
    "comp_algorithms": "none",
    "known_attack_tool": ""
  },
  "flow_timing": {
    "fwd_iat_mean_ms": 210.4,
    "fwd_iat_std_ms": 340.1
  },
  "detections": [
    {"id": "SSH-BRUTE-001", "severity": "HIGH", "rapid_teardowns_in_window": 6, "window_seconds": 300, "confidence": "MEDIUM"}
  ]
}
```

### Pending / needed
1. **A confirmed-vs-heuristic label for SSH-BRUTE-001.** The code itself flags this as a passive-inspection heuristic (auth outcome is encrypted, so it can't tell a real failed login from a fast health check). To turn this into a trained classifier (Model #4 in the design doc) you need ground truth — either your own labeled Hydra/Medusa runs (§6.2 of the design doc) or accept the heuristic as-is and don't oversell its precision in your report.
2. **HASSH known-attack-tool table is small/manual.** It currently only checks against a handful of hardcoded hashes (e.g., the empty-HASSH case). The public salesforce/hassh repository has a larger reference table worth importing.
3. **No IAT-vs-HASSH joined record.** Flow-level IAT stats (from `FlowRecord`) and SSH-level HASSH data are logged in separate files today; a feature-store join step is needed before Model #4 can train on both together.

---

## 4. DNS

### Currently collected
- Query logging (`DNS-QUERY-001`): transaction ID, qname, qtype, opcode
- Zone transfer attempt (`DNS-AXFR-001`): AXFR/IXFR query type + qname
- Response logging: transaction ID, qname, rcode
- NXDOMAIN flood detection: client IP, NXDOMAIN count in window, window size
- DNS rebinding detection (`DNS-REBIND-001`): domain, resolved private/loopback/link-local IP (checked for both A and AAAA records)
- Query domain entropy (computed, used internally for tunneling heuristics)

### Sample collected-data template
```json
{
  "conn_id": "a1b2c3d4",
  "protocol": "DNS",
  "source_ip": "203.0.113.20",
  "query": {
    "transaction_id": 51422,
    "qname": "a1b2c3d4e5f6.exfil.example.net",
    "qtype": "TXT",
    "opcode": 0,
    "domain_entropy": 4.9
  },
  "response": {
    "transaction_id": 51422,
    "qname": "a1b2c3d4e5f6.exfil.example.net",
    "rcode": "NXDOMAIN"
  },
  "detections": [
    {"id": "DNS-NXDOMAIN-FLOOD", "severity": "MEDIUM", "client_ip": "203.0.113.20", "nxdomain_count": 41, "window": "60s"}
  ]
}
```

### Pending / needed
1. **Domain entropy is computed but not consistently emitted as its own labeled field in every query record** — worth adding `domain_entropy`, `label_count`, and `subdomain_length` explicitly to `DNS-QUERY-001`'s Details map so the tunneling/DGA model has a stable, named feature to train on (right now it's used internally for a heuristic but isn't guaranteed present in the JSONL for every query).
2. **No DGA family classification** — only entropy-based/structural signals exist today; a labeled DGA domain feed (Bambenek, Netlab 360) is needed if you want family-level output rather than a binary anomaly flag.
3. **`ANY`-query-type blocking**, named in your PPT's DNS defense section, is not visible as a distinct rule in the analyzer — confirm whether it's implemented elsewhere (e.g., the proxy layer) or still pending.

---

## 5. FTP

### Currently collected
- PORT/PASV command tracking (`FTP-PORT` or similar): port IP, port port, client IP
- Suspicious path detection: path, command, matched pattern (dangerous path signatures)
- Glob/wildcard argument detection (`checkGlob`)
- Brute-force detection: threshold, window (config-driven, `bruteConf`)
- Full session state machine (login, transfer states) per RFC 959/2228/2428/5797

### Sample collected-data template
```json
{
  "conn_id": "a1b2c3d4",
  "protocol": "FTP",
  "source_ip": "203.0.113.30",
  "session": {
    "state": "transfer",
    "data_channel": {"port_ip": "203.0.113.30", "port_port": 51000, "client_ip": "203.0.113.30"}
  },
  "detections": [
    {"id": "FTP-PATH-001", "severity": "HIGH", "path": "/etc/passwd", "command": "RETR", "matched_pattern": "/etc/passwd"},
    {"id": "FTP-BRUTE-001", "severity": "HIGH", "threshold": 5, "window": "5m0s"}
  ]
}
```

### Pending / needed
1. **Exfiltration-volume anomaly** (your synopsis: "user usually downloads 5MB/day, suddenly requests 5GB at 3AM") is not present as an FTP-specific feature — this is better solved by joining FTP session records with the L4 `FlowRecord` byte counters (Model #3, flow-level anomaly detector) rather than building new FTP-specific collection.
2. **Anonymous-login flagging** — confirm it's emitting a distinct field/category consistently (the category constant `CatAnonLogin` exists in `detection.go`, but wasn't seen directly wired in the grep above — verify it's actually firing, not just declared).

---

## 6. Telnet

### Currently collected (your most mature analyzer)
- Short-connection/scan detection: short-connection count in window, threshold seconds
- Cleartext warning note (informational, every session)
- Credential capture: username, password-present flag, **credential fingerprint** (hash, not raw password)
- Brute-force detection: failure count in window, window size, username
- Password-spray detection: distinct-username count, credential fingerprint, window
- Credential-stuffing detection: unique username/password-pair count, window
- **IoT default-credential match**: username, password-present, credential fingerprint, vendor, device type, DB version (against a built-in default-credentials database)
- **Botnet-tag match**: same fields plus `botnet_tag` (matches known Mirai-family credential sets)

### Sample collected-data template
```json
{
  "conn_id": "a1b2c3d4",
  "protocol": "TELNET",
  "source_ip": "203.0.113.40",
  "session": {
    "username": "admin",
    "password_present": true,
    "cred_fingerprint": "9f86d081884c7d659a2feaa0c55ad015"
  },
  "detections": [
    {"id": "TELNET-DEFAULT-CREDS", "severity": "CRITICAL", "vendor": "Dahua", "device_type": "DVR", "botnet_tag": "Mirai"},
    {"id": "TELNET-SPRAY-001", "severity": "HIGH", "distinct_usernames": 12, "window": "5m0s"}
  ]
}
```

### Pending / needed
1. **This protocol is essentially feature-complete for rule-based detection.** The main remaining task is joining it with `FlowRecord` (Model #3) — nothing Telnet-specific is missing.
2. Credentials are hashed (`cred_fingerprint`), which is correct practice — just confirm the hash algorithm and salting strategy are documented somewhere for reproducibility if you reference this in your report.

---

## 7. SMTP

### Currently collected
- HELO/EHLO domain
- MAIL FROM sender address
- Phishing heuristic: HELO-domain vs. sender-domain mismatch (helo_domain, sender_domain, sender)
- RCPT TO tracking: recipient, cumulative rcpt count (open-relay/spam-blast indicator)
- AUTH method capture
- STARTTLS detection
- Recipient-count-per-message summary

### Sample collected-data template
```json
{
  "conn_id": "a1b2c3d4",
  "protocol": "SMTP",
  "source_ip": "203.0.113.50",
  "session": {
    "helo_domain": "mail.spoofed.com",
    "sender_domain": "totally-different.net",
    "sender": "user@totally-different.net",
    "rcpt_count": 340,
    "auth_method": "LOGIN"
  },
  "detections": [
    {"id": "SMTP-PHISH-001", "severity": "MEDIUM", "helo_domain": "mail.spoofed.com", "sender_domain": "totally-different.net"},
    {"id": "SMTP-RELAY-001", "severity": "HIGH", "recipient_count": 340}
  ]
}
```

### Pending / needed
1. **No content/body classification** — only envelope-level signals (HELO/MAIL FROM/RCPT TO) are captured; no subject-line or body-text feature extraction, so a text-based spam/phishing classifier has nothing to train on yet if you want to go beyond domain-mismatch heuristics. Lower priority per the design doc.

---

## 8. Database protocols (MySQL / PostgreSQL / Redis / MongoDB)

### Currently collected
- MySQL: server version (handshake), error packets (error code, message)
- Redis: command classification (dangerous command + description), generic command logging
- Generic DB: message length, direction (`from_client`), admin-command detection
- Query-level: raw query (truncated), SQL-injection pattern match on query text

### Sample collected-data template
```json
{
  "conn_id": "a1b2c3d4",
  "protocol": "DB-MYSQL",
  "source_ip": "203.0.113.60",
  "session": {
    "server_version": "8.0.34",
    "msg_length": 128,
    "from_client": true
  },
  "query": {
    "query": "SELECT * FROM users WHERE id=1 OR 1=1--",
    "matched_sqli": true
  },
  "detections": [
    {"id": "DB-SQLI-001", "severity": "CRITICAL", "query": "SELECT * FROM users WHERE id=1 OR 1=1--"},
    {"id": "DB-REDIS-CMD", "severity": "HIGH", "command": "FLUSHALL", "description": "Destructive command"}
  ]
}
```

### Pending / needed
1. **This is inherently structured protocol data** — rule-based coverage is genuinely sufficient here (per the earlier design doc's recommendation); don't allocate ML-model-building time to this protocol.
2. Confirm MongoDB wire-protocol parsing is as deep as MySQL/Redis (the grep shows MySQL and Redis have richer field extraction than the generic block covering the rest) — if MongoDB detection is currently riding on the generic admin-command fallback only, note that as a smaller gap.

---

## 9. Generic protocols (RDP, VNC, LDAP, IMAP, POP3, SOCKS, NTP, SNMP)

### Currently collected
- RDP: packet size, X.224 connection-request flags (NLA check)
- VNC: protocol version, direction
- NTP: mode, version (request/response distinguished)
- SNMP: community string extraction
- Fallback: byte count + direction for anything unrecognized

### Sample collected-data template
```json
{
  "conn_id": "a1b2c3d4",
  "protocol": "SNMP",
  "source_ip": "203.0.113.70",
  "detections": [
    {"id": "GEN-SNMP-COMMUNITY", "severity": "MEDIUM", "community": "public"}
  ]
}
```

### Pending / needed
1. **Left as fallback signature scanning is the right call for a final-year project** — do not build dedicated ML models for this bucket per the priority list in the design doc; the effort-to-value ratio is poor given your protocol scope already covers the 7 primary protocols in depth.

---

## 10. Cross-protocol behavioral (applies across all of the above)

### Currently collected (`behavioral.go`, `BehavioralEngine`)
Per-source-IP, in-memory tracking of:
- Connection timestamps (rate)
- Unique ports seen with timestamps (port-scan detection)
- (Also drives cross-protocol categories already defined: `brute-force`, `port-scan`, `ddos`, `slowloris`, `data-exfiltration`, `beaconing`, `tunneling`, `c2`, `lateral-movement`, `protocol-mismatch`, `time-anomaly`)

### Sample collected-data template
```json
{
  "source_ip": "203.0.113.80",
  "window_stats": {
    "connections_last_60s": 340,
    "unique_ports_seen": 22,
    "port_scan_threshold": 10
  },
  "detections": [
    {"id": "BEHAV-PORTSCAN-001", "severity": "HIGH", "category": "port-scan"}
  ]
}
```

### Pending / needed
1. **Nothing persists across process restarts** — `ipTracker` state is in-memory only. This is the exact gap that Model #6 (IP reputation) and Tier 2 (threat intel) need filled: a persistent store (Redis, per your own architecture doc) with time-decay, not just a live counter.
2. **No collaborative-filtering or cross-source aggregation** — each IP's history is tracked in isolation; there's no mechanism today to correlate an IP's behavior across restarts, across multiple protected services, or against external reputation feeds.

---

## 11. Summary — pending tasks across all protocols, in priority order

| # | Task | Blocks |
|---|---|---|
| 1 | Persistent IP-reputation store (Redis) with time-decay, replacing in-memory `ipTracker` | Model #6, Tier 2 threat-intel matching |
| 2 | External threat feed ingestion job (AbuseIPDB, Spamhaus, JA3 blocklist, GeoIP) | Tier 2, Model #6, Model #7 |
| 3 | BOLA/BOPLA/SSRF-via-API/JWT structural checks in `http_analyzer.go` | Any API-attack ML scoring — currently no raw signal exists to score |
| 4 | Session-level sequence features (inter-request timing, parameter-value diversity) in `SessionTracker` | BOLA/scraping detection, session-based anomaly models |
| 5 | Labeled attack traffic generation (sqlmap/Nikto/Hydra/wfuzz against a sandboxed target) | Model #2 (web attack classifier), Model #4 (SSH brute-force classifier) supervised training |
| 6 | JA4 implementation (or drop the claim) | TLS bot-fingerprint matching parity with stated architecture |
| 7 | Explicit `domain_entropy`/`label_count` fields guaranteed on every `DNS-QUERY-001` record | DNS tunneling/DGA model training stability |
| 8 | Feature-store export (JSONL → Parquet, joined across flow + protocol logs) | All model training — currently logs are write-only audit trails, not ML-ready tables |
| 9 | Confirm `CatAnonLogin` (FTP) and MongoDB deep parsing are actually wired, not just declared | FTP/DB coverage completeness |

---

## 12. Implementation guide — how to build each critical missing field

This section takes the priority list in §11 and turns each row into: the exact field(s) to add, the technique/algorithm to use, where it goes in the existing codebase, and what library (if any) to bring in. Ordered the same as §11, since #1–#4 are the ones that block everything else.

### 12.1 Persistent IP-reputation store (replaces in-memory `ipTracker`)

**Fields to add per IP:** `reputation_score` (0–100), `first_seen`, `last_seen`, `total_detections`, `detections_by_category` (map), `decayed_score_updated_at`.

**Technique — exponential time-decay scoring, not raw accumulation:**
Each new detection contributes a severity-weighted point value; the *stored* score is decayed toward 0 continuously so old bad behavior matters less than recent bad behavior. This is the standard, explainable approach (and the one to describe in your report instead of "collaborative filtering," which your data doesn't support).

```
score_new = score_old * exp(-λ * Δt_seconds) + severity_weight(detection)

severity_weight: INFO=0, LOW=1, MEDIUM=3, HIGH=8, CRITICAL=20
λ chosen so score halves roughly every 24h: λ = ln(2) / 86400
```

**Where it goes:** new file `detect/reputation.go`, subscribed to the `DetectionBus` the same way `StatsCollector` already is (`OnDetection(d Detection)` — reuse that pattern, don't build a new event path).

**Storage:** Redis (already named in your architecture doc) — one hash key per IP (`reputation:{ip}`), with `HSET` on update and a Redis `EXPIRE` as a backstop cleanup for IPs that go permanently quiet. Go library: `github.com/redis/go-redis/v9`.

**Process:**
1. `RepEngine.OnDetection(d)` computes `severity_weight(d.Severity)`, reads current score from Redis, applies decay based on elapsed time since `decayed_score_updated_at`, adds the new weight, writes back.
2. Expose `GetReputation(ip) (score float64, err error)` for the Cross-Layer Decision Engine to query before allow/block decisions.
3. Add a `GET /reputation/{ip}` route on the eventual FastAPI service (or directly in the Go dashboard API) so the frontend can display it.

### 12.2 External threat feed ingestion job

**Fields to add:** `threat_feed_hit` (bool), `threat_feed_source` (string), `threat_feed_last_updated` — attached to the reputation record above, not a separate structure.

**Technique — scheduled pull, not push:** these feeds are plain-text IP/CIDR lists or CSVs published on a fixed cadence (hourly/daily). Use a Go ticker goroutine, not a webhook.

```go
ticker := time.NewTicker(1 * time.Hour)
for range ticker.C {
    for _, feed := range feeds {
        list, _ := fetchAndParse(feed.URL)          // plain-text/CSV → []string (CIDRs)
        redisClient.Del(ctx, "feed:"+feed.Name)      // replace, don't append (feeds churn)
        redisClient.SAdd(ctx, "feed:"+feed.Name, list...)
    }
}
```

**Matching:** on each new connection, check `src_ip` against each feed set. For CIDR-based feeds (Spamhaus DROP), don't use a Redis Set directly — parse into `net.IPNet` ranges once per refresh and keep them in memory (a sorted slice with binary search, or `github.com/yl2chen/cidranger`), since Redis has no native CIDR-contains lookup.

**Feeds to start with (free tiers, no auth needed for basic use):** AbuseIPDB blacklist export, Spamhaus DROP/EDROP, FireHOL level1 list, Abuse.ch JA3 fingerprint feed (matched against `ja3_hash` from §2, not IP).

### 12.3 BOLA / BOPLA / SSRF-via-API / JWT checks in `http_analyzer.go`

This is the biggest genuine coding gap (not an ML gap — there's no raw signal to score yet). Four separate techniques:

**BOLA (parameter-ID tampering):** track, per session (keyed by session cookie or JWT subject), the set of numeric/UUID path and query parameter values a client has requested (e.g. `/api/orders/{id}`). On each request, extract ID-shaped tokens with a regex (`\b\d{3,}\b|[0-9a-f]{8}-[0-9a-f]{4}-...` for UUIDs), and flag when a client's requested ID value is **not sequential/expected relative to their own prior history** — i.e. compare against a per-session running set, not a global one. Emit a new category `CatBOLA` with `Details: {"prior_ids": [...], "requested_id": ..., "session_id": ...}`.

**BOPLA / Mass Assignment:** requires a lightweight expected-schema definition per endpoint (even a simple allowlist of JSON field names is enough for a final-year project — don't build a full OpenAPI validator). Parse the JSON body, diff its top-level keys against the allowlist, flag any unexpected field (e.g., `"role": "admin"` appearing in a `/register` body that should only accept `email`/`password`). Go library: standard `encoding/json` into `map[string]interface{}`, no external dependency needed.

**SSRF-via-API:** for any request body/query field that looks like a URL (regex `https?://`), resolve the hostname and check the resolved IP against RFC 1918 private ranges, loopback, and link-local (reuse the same private-IP check already written for DNS rebinding in `dns_analyzer.go` — `ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast()`, this logic already exists, just needs to be called from the HTTP path too).

**JWT structural checks:** use `github.com/golang-jwt/jwt/v5` to parse (not necessarily verify, since you may not hold the signing key) the token from the `Authorization: Bearer` header. Check: `alg` field is not `none` (classic JWT bypass), expiry (`exp`) is present and not already passed, and flag tokens with no signature segment at all. Emit `Details: {"alg": "none", "exp_present": false}`.

### 12.4 Session-level sequence features (`SessionTracker`)

**Fields to add to `SessionStats`:** `RequestTimestamps []time.Time` (bounded ring buffer, e.g. last 50), `ParamValueSets map[string]map[string]bool` (param name → set of distinct values seen), `URISequence []string` (bounded, for n-gram analysis).

**Technique:**
- **Inter-request timing:** compute mean/std of deltas between consecutive `RequestTimestamps` — a human browsing has high variance; a scraping/enumeration script has near-constant deltas (same statistical logic already used for SSH IAT in `flow_tracker.go` — reuse the mean/std helper functions rather than rewriting them).
- **Parameter-value diversity:** for each named query/path parameter, track a bounded set (cap at ~200 entries, evict oldest) of distinct values seen from that session. A session that touches an unusually large number of distinct ID values in a short window is enumerating — this is the concrete signal BOLA detection in §12.3 should key off, at the session level.
- **URI n-grams:** store the last N URIs visited; a bigram/trigram frequency table per session, compared against normal-traffic baselines, flags directory-brute-force-style traversal patterns that don't match any single Tier-1 regex.

**Where:** extend `TrackRequest` in `session_tracker.go`; keep all buffers bounded (fixed-size ring buffers, not unbounded slices) since this is per-session in-memory state and needs a memory ceiling.

### 12.5 Labeled attack traffic generation (process, not code)

This is an operational process, not a Go change:

1. Stand up an isolated Docker network with DVWA (or OWASP Juice Shop) behind your existing reverse proxy, on a listener not exposed to the internet.
2. Run each tool with logging on, and tag the resulting JSONL log lines with a `label` field before archiving them (a simple post-processing Python script that reads `logs/detections.jsonl` for the time window of a specific tool run and stamps `"label": "sqli-sqlmap"` etc. is sufficient — don't build a live auto-labeling pipeline for this).
3. Tools → label mapping: `sqlmap` → `sqli`, `Nikto` → `bot-scanner`/mixed, `OWASP ZAP` active scan → `xss`/mixed, `Hydra`/`Medusa` against the SSH/FTP/Telnet listeners → `brute-force`, `dnschef`/`iodine` → `dns-tunnel`.
4. Interleave with organic benign traffic (browse the sandboxed app normally) so the resulting dataset isn't 100% attack traffic — a classifier trained on attack-only data won't have learned what benign looks like.

### 12.6 JA4 implementation

**Technique:** JA4 (unlike JA3, which is a raw-value MD5) is a structured, human-readable fingerprint string built from: TLS version, SNI presence, cipher-suite count, extension count, ALPN value, and **sorted, truncated-hash** components of the cipher list and extension list (using SHA256, then first-12-hex-chars, not MD5). The full algorithm is published at `github.com/FoxIO-LLC/ja4` (already in your own References slide) — implement it as a pure function operating on the same parsed ClientHello struct `tls_inspect.go` already builds for JA3 (cipher suites, extensions, ALPN are already extracted; JA4 just recombines them differently). No new TLS parsing needed, only a new formatting/hashing function alongside the existing `computeJA3`.

### 12.7 Explicit `domain_entropy` / `label_count` on every DNS query record

**Technique:** the entropy function already exists (reuse `payloadShannonEntropy` from `payload_stats.go` — don't write a second entropy function) — the only change needed is calling it inside the query-handling path in `dns_analyzer.go` and adding the result plus `strings.Count(qname, ".") + 1` (label count) into the `Details` map of `DNS-QUERY-001` unconditionally, not just when a tunneling heuristic already fires. This turns an internal, conditional signal into a guaranteed feature column for every row — required for Model training since ML pipelines need the feature present even on negative/benign examples, not just on rows that already tripped a rule.

### 12.8 Feature-store export (JSONL → training-ready tables)

**Technique — scheduled batch ETL, not a live pipeline:**
1. A Python script (runs offline, e.g. nightly via cron) reads `logs/detections.jsonl`, `logs/connections.jsonl`, `logs/flow_stats.jsonl`, and `logs/protocols/<proto>.jsonl`.
2. Join on `conn_id` (present in all of them already — this is exactly why that field exists) to produce one row per connection with flow features + protocol features + any detection labels attached.
3. Write out as Parquet (`pandas.DataFrame.to_parquet`, needs `pyarrow`) partitioned by date and protocol — Parquet over CSV because it preserves types (your `PayloadStats` floats, bools, ints) without re-parsing, and is what every mainstream ML library reads natively.
4. Keep the join script itself under version control (e.g. `ml/etl/build_training_set.py`) — this becomes part of your MLOps story for the report (reproducible, scheduled data pipeline, not manual CSV wrangling).

### 12.9 Verify `CatAnonLogin` wiring and MongoDB depth

**Technique — this is an audit task, not a build task:** grep the codebase for `CatAnonLogin` usage (`grep -rn "CatAnonLogin" Security/detect/`) to confirm it's actually passed into an `EmitDetection` call and not just declared as an unused constant. If unused, wire it into the FTP login-command handler (checking `USER anonymous` case-insensitively, which `ftp_analyzer.go`'s state machine already parses). For MongoDB, compare the wire-protocol op-code coverage in `db_analyzer.go` against MySQL's — if MongoDB traffic is only hitting the generic byte-count fallback rather than parsing OP_QUERY/OP_MSG op-codes, that's a real gap worth a small, scoped implementation pass (MongoDB's wire protocol is documented and simpler than MySQL's, so this is lower effort than it sounds).
