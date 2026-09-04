# Comprehensive Threat Coverage Matrix (Scoped)

**Purpose:** This document is the definitive reference for what the NGFW IDS/IPS defends against,
how each threat is detected, and — critically — which threats are in scope for ML model training.

**Two distinct scopes are tracked:**
- **System scope** — everything the system detects (rules, signatures, feed lookups, or ML).
- **ML training scope** — the subset fed into the two ML models below.

**Detection method key:**
- **ML-L7** → L7 Payload Classifier (web/API, trained on CSIC-2010 / GoTestWAF / tool-generated traffic)
- **ML-L4** → L3/L4 Flow Anomaly Detector (behavioral/network, trained on CIC-IDS2017/2018, CTU-13, CIC-DDoS2019)
- **Rule** → Tier-1 Go rule/regex in existing analyzer code — deterministic, already implemented
- **Rule (planned)** → Constant defined in `detection.go`, analyzer logic not yet written — low effort, deferred
- **Feed** → Tier-2 Redis reputation/fingerprint lookup — no ML needed, refreshed on a schedule
- **Rule (stretch)** → Constant defined, implementation deferred until core is complete

> **Key principle:** Items are only removed from *ML training scope*, never from *system scope*.
> If the code already emits a detection category, the threat stays in this matrix as a Rule entry.

---

## 1. Web Application & API (HTTP/HTTPS)

### ML Training Scope

| Attack | Detection | ML Training | Notes |
|---|---|---|---|
| SQL Injection (SQLi) | Rule + **ML-L7** | ✅ In scope | `CatSQLi` — live in `http_analyzer.go` |
| NoSQL Injection | Rule + **ML-L7** | ✅ In scope | `CatNoSQLi` — constant defined, Tier-1 + ML |
| Command Injection (RCE) | Rule + **ML-L7** | ✅ In scope | `CatCommandInjection` — live |
| Server-Side Template Injection (SSTI) | Rule + **ML-L7** | ✅ In scope | `CatSSTI` — constant defined, Tier-1 + ML |
| Path/Directory Traversal | Rule + **ML-L7** | ✅ In scope | `CatPathTraversal` — live |
| Local File Inclusion (LFI) | Rule + **ML-L7** | ✅ In scope | `CatLFI` — constant defined, Tier-1 + ML |
| Cross-Site Scripting (XSS) | Rule + **ML-L7** | ✅ In scope | `CatXSS` — live |
| API Resource Abuse (unbounded pagination) | Rule + **ML-L7** | ✅ In scope | `CatAPIResourceAbuse` — flow-rate based |
| Slowloris / Slow-POST | Rule + **ML-L4** | ✅ In scope | `CatSlowloris` — live |
| Volumetric DDoS (HTTP flood) | Rule + **ML-L4** | ✅ In scope | `CatDDoS` — live |

**ML-L7 classes: 8 pure payload classes (SQLi, NoSQLi, CMDi, SSTI, Path Traversal, LFI, XSS, API Resource Abuse)**
**ML-L4 classes (HTTP): 2 flow-based classes (Slowloris, DDoS)**

### Rule-Based — In System Scope (Not ML Training)

| Attack | Detection | Code Status | Notes |
|---|---|---|---|
| Malicious File Upload (webshells, oversized) | Rule | Live — `CatFileUpload` | Deterministic magic-byte + size check |
| Cross-Site Request Forgery (CSRF) | Rule | `CatCSRF` (planned) | Origin/Referer header check; proxy can only flag, not fix |
| Broken Object-Level Authorization (BOLA) | Rule | `CatBOLA` (planned) | Session ID-sequence tracker, alert only |
| JWT `alg:none` bypass | Rule | `CatJWTAlgNone` (planned) | Deterministic header check |
| JWT Algorithm Confusion (RS256→HS256) | Rule | `CatJWTAlgConfusion` (planned) | Deterministic |
| Expired JWT acceptance | Rule | `CatJWTExpiredAccepted` (planned) | Deterministic `exp` claim check |
| Log4Shell (`${jndi:}`) | Rule | Live — `CatLog4Shell` | Fixed-literal regex; ML adds no value |
| XML External Entity (XXE) / Billion Laughs | Rule | Live — `CatXXE` | Deterministic |
| Server-Side Request Forgery (SSRF) | Rule / Hybrid | Live — `CatSSRF` | Tier-1 regex + cloud metadata IP match |
| Open Redirect | Rule | Live — `CatOpenRedirect` | Deterministic |
| Bot/Scanner traffic | Rule | Live — `CatBotScanner` | UA + request-rate pattern |
| Directory/Endpoint Brute-Force | Rule | Live — `CatDirBruteForce` | Rate tracker |
| Credential Leaks (response inspection) | Rule | Live — `CatCredentialLeak` | DLP regex on response body |
| Information Leakage (stack traces, debug) | Rule | Live — `CatInfoLeakage` | Response pattern match |
| Missing Security Headers | Rule | Live — `CatMissingHeaders` | Static header checklist |
| Clickjacking (`X-Frame-Options`) | Rule | `CatClickjacking` (planned) | Folds into `CatMissingHeaders` |
| HTTP Request Smuggling (CL.TE / TE.CL) | Rule | **Live — `CatHTTPSmuggling`** | ⚠ Was wrongly removed; 3 active rules in `http_analyzer.go` |
| CRLF Injection / HTTP Response Splitting | Rule | **Live — `CatCRLFInjection`** | ⚠ Was wrongly removed; live rule in `http_analyzer.go` |
| LDAP Injection | Rule | **Live — `CatLDAPInjection`** | ⚠ Was wrongly removed; live in `http_analyzer.go` + `generic_analyzer.go` |
| Host-Header Injection | Rule | `CatHostHeaderInjection` (planned) | ⚠ Was wrongly removed; constant defined |
| Remote File Inclusion (RFI) | Rule | `CatRFI` (planned) | ⚠ Was wrongly removed; constant defined. Rule is trivial regex; low FP |
| XPath Injection | Rule | `CatXPathInjection` (planned) | ⚠ Was wrongly removed; constant defined |
| Insecure Deserialization | Rule | `CatInsecureDeserialization` (planned) | Correctly removed from ML; kept as Rule (ysoserial/pickle markers) |
| Mass Assignment | Rule (alert-only) | `CatMassAssignment` (planned) | Correctly removed from ML; alert-only, never auto-block |
| Broken Function-Level Authorization (BFLA) | Rule | `CatBFLA` (planned) | Correctly removed from ML; role/endpoint matrix check |
| GraphQL Abuse | Rule (stretch) | `CatGraphQLAbuse` (planned) | Deferred unless demo app uses GraphQL |
| WebSocket Hijacking | Rule (stretch) | `CatWebSocketAbuse` (planned) | Deferred unless demo app uses WebSockets |

---

## 2. Secure Shell (SSH)

> All in system scope — all Rule-based. No ML training needed.

| Attack | Detection | Code Status |
|---|---|---|
| SSH Brute-Force Login | Rule | Live — `CatSSHBruteForce` |
| Weak/Legacy Key-Exchange Algorithms | Rule | Live — `CatSSHWeakAlgo`, `CatSSHLegacyProto` |
| SSH Tunneling / Port-Forwarding Abuse | Rule | Live — `CatSSHTunnel` |
| Malformed SSH Packets | Rule | Live — `CatSSHMalformed` |
| Banner/Version Scanning | Rule | Live — `CatSSHBannerScan` |
| Known-Malicious Client Fingerprints (HASSH) | Feed | `CatSSHKnownBadFingerprint` — Tier-2 lookup |
| CVE-based Exploitation (e.g., regreSSHion) | Rule | `CatSSHCVEExploit` — Nuclei/NVD feed signatures |

---

## 3. Domain Name System (DNS)

| Attack | Detection | ML Training | Code Status | Notes |
|---|---|---|---|---|
| DNS Tunneling (Data exfiltration) | Rule + **ML-L4** | ✅ In scope | Live — `CatDNSTunnel` | Entropy + query-length features |
| DGA (Domain Generation Algorithm) Botnet Domains | Rule + **ML-L4** | ✅ In scope | Live — `CatDGA` | Trained on Bambenek/Netlab360 feed |
| Unauthorized Zone Transfers (AXFR) | Rule | ❌ Rule only | Live — `CatZoneTransfer` | Deterministic |
| NXDOMAIN Floods (DoS) | Rule | ❌ Rule only | Live — `CatNXDomainFlood` | Rate threshold |
| DNS Amplification (Reflection DoS) | Rule | ❌ Rule only | `CatDNSAmplification` (planned) | ANY query + response-size ratio |
| DNS Rebinding | Rule | ❌ Rule only | **Live — `CatDNSRebind`** | ⚠ Was wrongly removed; active detection in `dns_analyzer.go` L453,463 |
| DNS Cache Poisoning / Spoofing | Rule | ❌ Rule only | `CatDNSSpoofing` (planned) | ⚠ Was wrongly removed; constant defined. Tx-ID / source-port check |

---

## 4. File Transfer Protocol (FTP)

> All Rule-based. No ML training.

| Attack | Detection | Code Status | Notes |
|---|---|---|---|
| Anonymous Login Abuse | Rule | Live — `CatAnonLogin` | |
| FTP Bounce Attack (Port scanning via `PORT`) | Rule | **Live — `CatFTPBounce`** | ⚠ Was wrongly removed; active detection in `ftp_analyzer.go` L511 |
| Data-Channel Abuse (Exfiltration) | Rule | Live — `CatFTPData` | |
| Brute-Force Login | Rule | Live — `CatBruteForce` | |
| Cleartext Credential Exposure (no FTPS) | Rule | `CatFTPCleartextCreds` (planned) | |

---

## 5. Telnet

> All Rule-based — merged into one credential-attack module. No ML training.

| Attack | Detection | Code Status |
|---|---|---|
| IoT Default-Credential Login (Mirai-style) | Rule | Live — `CatTelnetIoT` |
| Banner Scanning / Reconnaissance | Rule | Live — `CatTelnetScan` |
| Credential Stuffing (unified brute-force module) | Rule | Live — `CatCredStuff` |
| Password Spraying | Rule | Live — `CatPwdSpray` |
| Cleartext Session Hijacking | Rule | Live — `CatMalformed` / `CatUnauthAccess` |

---

## 6. Email (SMTP)

| Attack | Detection | ML Training | Code Status | Notes |
|---|---|---|---|---|
| Open Relay Abuse | Rule | ❌ Rule only | Live — `CatOpenRelay` | |
| Spam Origination | Rule | ❌ Rule only | **Live — `CatSpam`** | ⚠ Was wrongly removed; active in `smtp_analyzer.go` L189. Rule-based (header/volume pattern). ML stretch only. |
| Phishing Content | Rule | ❌ Rule only | **Live — `CatPhishing`** | ⚠ Was wrongly removed; active in `smtp_analyzer.go` L104. Rule-based (URL/keyword match). NLP/ML is stretch-only. |
| STARTTLS Stripping / Downgrade | Rule | ❌ Rule only | `CatSMTPSTARTTLSStrip` (planned) | |

---

## 7. Databases (MySQL, PostgreSQL, Redis, MongoDB)

> All Rule-based. No ML training.

| Attack | Detection | Code Status |
|---|---|---|
| Dangerous Administrative Commands (`DROP`, `FLUSHALL`) | Rule | Live — `CatDangerousCmd` |
| Unauthenticated Access Attempts | Rule | Live — `CatUnauthAccess` |
| Direct SQLi bypassing the app layer | Rule | Live — `CatSQLi` (shared) |

---

## 8. Transport Layer Security (TLS)

| Attack | Detection | ML Training | Code Status | Notes |
|---|---|---|---|---|
| Weak Cipher Suites | Rule | ❌ Rule only | Live — `CatTLSWeakCipher` | |
| Protocol Downgrades (SSLv3, TLS 1.0/1.1) | Rule | ❌ Rule only | Live — `CatTLSDowngrade` | |
| Expired Certificates | Rule | ❌ Rule only | Live — `CatTLSExpired` | Deterministic X.509 `notAfter` |
| JA3 / JA4 Fingerprinting | Feed | ❌ Feed only | `CatTLSKnownBadFingerprint` (planned) | Tier-2 lookup; usable as ML-L4 feature |
| SNI / Certificate Mismatch | Rule | ❌ Rule only | `CatTLSSNIMismatch` (planned) | ⚠ Was wrongly removed; constant defined |
| Self-Signed Certificates | Rule | ❌ Rule only | `CatTLSSelfSigned` (planned) | ⚠ Was wrongly removed; constant defined. Alert-only, never auto-block |

---

## 9. Generic & Fallback (RDP, VNC, SNMP, UDP)

> All Rule-based. No ML training.

| Attack | Detection | Code Status |
|---|---|---|
| Known Exploit Traffic Signatures (Nuclei/Snort) | Rule | Live — generic signature set |
| RDP Brute-Force & BlueKeep-class exploits | Rule | `CatRDPExploit` (planned) |
| NTP/SNMP Amplification Abuse | Rule | `CatUDPAmplification` (planned) |
| SNMP Default Community Strings (`public`/`private`) | Rule | `CatSNMPDefaultCreds` (planned) |

---

## 10. Cross-Protocol & Behavioral (Network-Wide)

| Attack | Detection | ML Training | Code Status | Notes |
|---|---|---|---|---|
| Port Scanning (SYN, FIN, Xmas) | Rule + **ML-L4** | ✅ In scope | Live — `CatPortScan` | CIC-IDS2017 PortScan subset |
| Cross-Protocol Brute-Force Rates | Rule + **ML-L4** | ✅ In scope | Live — `CatBruteForce` | Flow-rate feature |
| C2 Beaconing (Beaconing + C2 merged) | **ML-L4** | ✅ In scope | Live — `CatBeaconing`, `CatC2` | CTU-13 botnet dataset; IAT regularity feature |
| Data Exfiltration (abnormal outbound volume) | **ML-L4** | ✅ In scope | Live — `CatDataExfil` | `bytes_out` rolling store via Redis |
| Lateral Movement (low-and-slow flow pattern) | **ML-L4** | ✅ In scope | Live — `CatLateralMove` | CIC-IDS2018 infiltration subset |
| Protocol/Port Mismatch (e.g., SSH on port 80) | Rule | ❌ Rule only | Live — `CatProtoMismatch` | Deterministic banner vs. expected-service check |
| Known-Bad IP Reputation | Feed | ❌ Feed only | `CatReputationBlock` — Tier-2 | AbuseIPDB, Spamhaus, FireHOL, Tor exits |
| Generic Tunneling (Protocol-in-protocol) | Rule | ❌ Rule only | `CatTunneling` — constant defined | ⚠ Was wrongly removed; distinct from `CatDNSTunnel` (covers SSH-over-HTTP etc.) |
| Time-Based Access Anomalies | Rule | ❌ Rule only | `CatTimeAnomaly` — constant defined | ⚠ Was wrongly removed; deferred (not cut). Alert-only until organic baseline exists |

---

## Summary

### ML Training Scope (Final)

| Model | Classes | Attacks |
|---|---|---|
| **ML-L7 Payload Classifier** | **8** | SQLi, NoSQLi, CMDi, SSTI, Path Traversal, LFI, XSS, API Resource Abuse |
| **ML-L4 Flow Anomaly Detector** | **7** | Slowloris, DDoS, DNS Tunneling, DGA, Port Scan, Cross-Protocol Brute-Force, C2 Beaconing + Data Exfil + Lateral Movement |

> Note: C2 Beaconing, Data Exfiltration, and Lateral Movement share the same ML-L4 flow feature space and may be trained as a multi-class problem or a single anomaly score. Counted as 3 classes above.

### Full System Scope

| Category | Rule (Live) | Rule (Planned) | Feed/Lookup | ML-L7 | ML-L4 |
|---|---|---|---|---|---|
| Web & API (HTTP/HTTPS) | 13 | 9 | 0 | 8 | 2 |
| SSH | 5 | 2 | 1 | 0 | 0 |
| DNS | 3 | 2 | 0 | 0 | 2 |
| FTP | 4 | 1 | 0 | 0 | 0 |
| Telnet | 5 | 0 | 0 | 0 | 0 |
| SMTP | 3 | 1 | 0 | 0 | 0 |
| Databases | 3 | 0 | 0 | 0 | 0 |
| TLS | 2 | 2 | 1 | 0 | 0 |
| Generic & Fallback | 1 | 3 | 0 | 0 | 0 |
| Cross-Protocol & Behavioral | 5 | 2 | 1 | 0 | 5 |
| **Total** | **44** | **22** | **3** | **8** | **9** |

**Total detectable attack classes: ~69** (44 live + 22 planned + 3 feed-based)
**ML training classes: 15** (8 L7 + 7 L4) — focused, defensible, backed by public datasets
