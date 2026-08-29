# Protocol-Wise Threat Matrix, ML Detection/Blocking Integration & Training Data Sources
## The single consolidated reference — Group 10, Intelligent Multi-Protocol IDS/IPS with MLOps

**Purpose of this document.** The three existing planning docs (`Gap Analysis`, `ML Module Documentation`, `Protocol Data Collection Inventory`) each cover part of the picture — data fields, model design, or protocol status — separately. This document is the **single place that ties every threat your system claims to defend against to (a) the protocol it lives on, (b) the exact detection tier and ML model that catches it, (c) the response action, and (d) where the training/reference data for that specific threat comes from.** It also lists the threats your current 49-category taxonomy (`Security/detect/detection.go`) does **not yet cover**, so nothing you promised in the synopsis — or that a viva panel would reasonably expect — is left unaddressed.

Everything below is grounded in your actual code (`Security/detect/*.go`), not generic textbook content. Where a gap exists, it is marked **[NEW]** with a ready-to-paste Go constant and a concrete build note.

---

## 0. How to read the matrices

Every row follows the same seven columns:

| Column | Meaning |
|---|---|
| **Threat / Vulnerability** | The attack or weakness, in industry-standard naming (so it maps cleanly to OWASP/CWE/CVE in your report) |
| **Category constant** | The exact Go constant in `detection.go`, or **[NEW]** if it doesn't exist yet |
| **Tier** | 1 = Go rule/regex (fast path), 2 = Redis threat-intel lookup, 3 = ML scoring (FastAPI) |
| **ML model** | Which model (from §3's model inventory) scores this; "—" if rule-only by design |
| **Response action** | Allow / Alert / Auto-Block / Rate-Limit / Tarpit, per your Graded Response Layer |
| **Blocking mechanism** | Where the block is enforced: app-layer (proxy 403/reset), kernel-layer (Cross-Layer Decision Engine → L3/4 firewall rule), or protocol-specific tarpit |
| **Training/reference data source** | Exact dataset, feed, or generation tool (all cross-referenced in §6) |

---

## 1. HTTP / HTTPS — full threat matrix

| Threat / Vulnerability | Category constant | Tier | ML model | Response | Blocking mechanism | Training data source |
|---|---|---|---|---|---|---|
| SQL Injection (incl. blind, time-based, UNION, tamper-encoded) | `CatSQLi` | 1 + 3 | #1 HTTP Anomaly, #2 Web Classifier | Auto-Block | App-layer + kernel-layer (repeat offenders) | sqlmap-generated traffic (all tamper scripts); CSIC-2010; PayloadsAllTheThings/SQLi |
| Cross-Site Scripting (reflected/stored/DOM) | `CatXSS` | 1 + 3 | #1, #2 | Auto-Block | App-layer | OWASP ZAP active scan; PayloadsAllTheThings/XSS; CSIC-2010 |
| Path Traversal / Directory Traversal | `CatPathTraversal` | 1 + 3 | #1, #2 | Auto-Block | App-layer | dirb/wfuzz wordlists; SecLists `Fuzzing/`; PayloadsAllTheThings/Path-Traversal |
| Local File Inclusion (LFI) | **[NEW]** `CatLFI` | 1 + 3 | #1, #2 | Auto-Block | App-layer | PayloadsAllTheThings/File-Inclusion; DVWA "File Inclusion" module traffic |
| Remote File Inclusion (RFI) | **[NEW]** `CatRFI` | 1 + 3 | #1, #2 | Auto-Block | App-layer | Same as LFI + self-hosted malicious-include sandbox test |
| Command Injection / RCE | `CatCommandInjection` | 1 + 3 | #1, #2 | Auto-Block + kernel | App-layer + kernel-layer | Commix-generated traffic; PayloadsAllTheThings/Command-Injection |
| Server-Side Request Forgery (SSRF), incl. cloud-metadata (`169.254.169.254`) targeting | `CatSSRF` | 1 + 3 | #1, #2 | Auto-Block | App-layer | SSRFmap tool output; PayloadsAllTheThings/SSRF |
| XML External Entity (XXE) incl. billion-laughs/entity expansion DoS | `CatXXE` | 1 + 3 | #1, #2 | Auto-Block | App-layer | PayloadsAllTheThings/XXE; OWASP WSTG XXE test cases |
| Log4Shell / JNDI-lookup style RCE (`${jndi:...}`) | `CatLog4Shell` | 1 | — (regex is definitive here; ML adds no value on a fixed literal signature) | Auto-Block + kernel | App-layer + kernel-layer | Public Log4Shell payload corpus (widely published, defensive use only) |
| HTTP Request Smuggling (CL.TE / TE.CL / TE.TE) | `CatHTTPSmuggling` | 1 + 3 | #1 | Alert → Auto-Block on repeat | App-layer | Burp Suite HTTP smuggling test scripts (self-generated against sandbox) |
| CRLF Injection / HTTP Response Splitting | `CatCRLFInjection` | 1 | — | Auto-Block | App-layer | PayloadsAllTheThings/CRLF-Injection |
| Open Redirect | `CatOpenRedirect` | 1 | — | Alert | App-layer | PayloadsAllTheThings/Open-Redirect |
| Malicious File Upload (webshell, polyglot, oversized) | `CatFileUpload` | 1 + 3 | #2 | Auto-Block | App-layer | PayloadsAllTheThings/Upload-Insecure-Files; DVWA "File Upload" module |
| Bot / Scanner traffic (User-Agent + behavioral) | `CatBotScanner` | 1 + 3 | #1, #3 (flow) | Rate-Limit → Tarpit | App-layer tarpit (slow one-byte headers, §9.2 of synopsis) | Nikto scan logs; known bad-UA list (from OWASP CRS); your own baseline |
| Directory / Endpoint Brute-Force | `CatDirBruteForce` | 1 + 3 | #3 (flow, request-rate) | Rate-Limit → Auto-Block | App-layer | dirb/gobuster/wfuzz-generated traffic |
| Credential Leak (secrets in response body/headers) | `CatCredentialLeak` | 1 | — | Alert | App-layer (DLP — response inspection) | Regex/entropy rules only; no ML needed |
| Missing Security Headers (CSP, HSTS, X-Frame-Options, etc.) | `CatMissingHeaders` | 1 | — | Alert | N/A (advisory) | OWASP Secure Headers Project checklist |
| Information Leakage (stack traces, version banners, debug pages) | `CatInfoLeakage` | 1 | — | Alert | App-layer (response inspection) | N/A — static rule |
| LDAP Injection | `CatLDAPInjection` | 1 + 3 | #1 | Auto-Block | App-layer | PayloadsAllTheThings/LDAP-Injection |
| **Cross-Site Request Forgery (CSRF)** | **[NEW]** `CatCSRF` | 1 | — (state-token/Origin-Referer check, deterministic) | Alert (advisory — CSRF is a backend-app defect, proxy can only flag missing anti-CSRF token/Origin mismatch) | App-layer advisory | PortSwigger CSRF labs traffic; DVWA "CSRF" module |
| **Clickjacking (missing `X-Frame-Options`/`frame-ancestors`)** | **[NEW]** `CatClickjacking` | 1 | — | Alert | N/A (advisory, folds into `CatMissingHeaders`) | OWASP checklist |
| **Server-Side Template Injection (SSTI)** | **[NEW]** `CatSSTI` | 1 + 3 | #1, #2 | Auto-Block | App-layer | tplmap-generated traffic; PayloadsAllTheThings/Server Side Template Injection |
| **Insecure Deserialization** | **[NEW]** `CatInsecureDeserialization` | 1 + 3 | #1 | Auto-Block | App-layer | ysoserial payload signatures (Java), PHP/Python pickle gadget-chain markers |
| **NoSQL Injection** (MongoDB operator injection `$where`, `$ne`, etc.) | **[NEW]** `CatNoSQLi` | 1 + 3 | #1, #2 | Auto-Block | App-layer | NoSQLMap tool output; PayloadsAllTheThings/NoSQL-Injection |
| **XPath Injection** | **[NEW]** `CatXPathInjection` | 1 | — | Auto-Block | App-layer | PayloadsAllTheThings/XPATH-Injection |
| **GraphQL abuse** (introspection leakage, batching/alias DoS, injection via variables) | **[NEW]** `CatGraphQLAbuse` | 1 + 3 | #2 | Alert → Auto-Block | App-layer | InQL / graphql-cop scan traffic; DVGA (Damn Vulnerable GraphQL App) sandbox |
| **WebSocket hijacking / origin-check bypass** | **[NEW]** `CatWebSocketAbuse` | 1 | — | Alert | App-layer | Manual PoC traffic against a sandboxed WS endpoint |
| **HTTP Host-Header Injection / cache poisoning** | **[NEW]** `CatHostHeaderInjection` | 1 | — | Auto-Block | App-layer | PortSwigger Web Cache Deception / Host Header labs |
| **API — BOLA (Broken Object-Level Authorization)** | `CatSSRF`-adjacent, currently **[NEW]** `CatBOLA` | 1 + 3 | #2 (needs ID-sequence feature, §5) | Alert → Auto-Block | App-layer | crAPI (Completely Ridiculous API) sandbox; OWASP API Top-10 test suite |
| **API — BFLA (Broken Function-Level Authorization)** | **[NEW]** `CatBFLA` | 1 | — (role/endpoint matrix check) | Alert | App-layer | crAPI sandbox |
| **API — Mass Assignment** | **[NEW]** `CatMassAssignment` | 1 (alert-only per Phase B design) | — | Alert only (never auto-block, per false-positive risk noted in master plan §3.3) | N/A | crAPI sandbox; self-generated schema-drift test cases |
| **API — Resource/Rate Abuse (excessive data exposure, unbounded pagination)** | **[NEW]** `CatAPIResourceAbuse` | 1 + 3 | #3 (flow rate) | Rate-Limit | App-layer | crAPI sandbox; synthetic high-volume API scripts |
| **JWT — `alg:none` bypass** | **[NEW]** `CatJWTAlgNone` | 1 | — | Auto-Block | App-layer | JWT_Tool-generated traffic |
| **JWT — algorithm confusion (RS256→HS256)** | **[NEW]** `CatJWTAlgConfusion` | 1 | — | Alert | App-layer | JWT_Tool |
| **JWT — expired-but-accepted token** | **[NEW]** `CatJWTExpiredAccepted` | 1 | — | Alert | App-layer | Manual sandbox test with expired tokens |
| DoS / Slow-Rate DoS (Slowloris, RUDY/Slow-POST) | `CatSlowloris` | 1 + 3 | #3 (flow) | Rate-Limit → kernel drop | Kernel-layer | slowhttptest tool traffic |
| Volumetric DDoS (HTTP flood) | `CatDDoS` | 1 + 3 | #3 (flow) | Rate-Limit → kernel drop + CAPTCHA gate | Kernel-layer + CAPTCHA (Phase C) | hping3/locust-generated flood traffic; CIC-DDoS2019 |

---

## 2. Non-HTTP protocol threat matrices

### 2.1 SSH

| Threat | Category | Tier | ML model | Response | Blocking | Training data |
|---|---|---|---|---|---|---|
| Brute-force login | `CatSSHBruteForce` | 1 + 3 | #4 SSH Brute/Bot Classifier | Auto-Block + Tarpit (endless verification loop, per synopsis §9.2) | App + kernel | Hydra/Medusa-generated SSH traffic; CIC-IDS2017 SSH-Patator subset |
| Weak/legacy key-exchange or cipher algorithms | `CatSSHWeakAlgo`, `CatSSHLegacyProto` | 1 | — | Alert | N/A | NIST SP 800-131A deprecated-algorithm list (static rule) |
| SSH tunneling / port-forward abuse | `CatSSHTunnel` | 1 + 3 | #3 (flow) | Alert → Auto-Block | Kernel-layer | Self-generated `ssh -D`/`-L`/`-R` sandbox traffic |
| Malformed SSH protocol / packet-size abuse | `CatSSHMalformed` | 1 | — | Auto-Block | App-layer | Fuzzed SSH packets (`ssh-audit`, boofuzz) |
| Banner/version scanning (recon) | `CatSSHBannerScan` | 1 | — | Alert | N/A | Nmap `-sV` scan logs |
| **Known-malicious client fingerprint (HASSH)** | Already implemented via `knownBadHASSH` lookup — formalize as **[NEW]** `CatSSHKnownBadFingerprint` | 2 | — (lookup, not ML) | Auto-Block | App-layer | [HASSH project](https://github.com/salesforce/hassh) public bad-fingerprint list |
| **CVE-based exploitation (e.g. libssh auth bypass, OpenSSH regreSSHion CVE-2024-6387-class bugs)** | **[NEW]** `CatSSHCVEExploit` | 1 | — (signature per CVE, updated via feed) | Auto-Block | App + kernel | NVD/CVE feed filtered to `cpe:*:openssh*`; Nuclei SSH CVE templates |

### 2.2 DNS

| Threat | Category | Tier | ML model | Response | Blocking | Training data |
|---|---|---|---|---|---|---|
| DNS Tunneling (data exfil over TXT/NULL/CNAME records) | `CatDNSTunnel` | 1 + 3 | #5 DNS Tunneling/DGA Detector | Auto-Block | App-layer | dnscat2/iodine-generated tunnel traffic; entropy-based unsupervised scoring needs zero labels |
| DGA (Domain Generation Algorithm) botnet C2 domains | `CatDGA` | 1 + 3 | #5 | Auto-Block | App-layer | Bambenek Consulting DGA feed; Netlab 360 DGA feed |
| DNS Rebinding | `CatDNSRebind` | 1 | — | Alert → Auto-Block | App-layer | Self-generated rebinding PoC (public rebinding-toolkit) |
| Zone Transfer abuse (unauthorized AXFR) | `CatZoneTransfer` | 1 | — | Auto-Block | App-layer | `dig axfr` test traffic against sandboxed authoritative server |
| NXDOMAIN Flood (resource-exhaustion recon/DoS) | `CatNXDomainFlood` | 1 + 3 | #3 (flow rate) | Rate-Limit | Kernel-layer | Self-generated random-subdomain flood script |
| **DNS Amplification (used as reflection DDoS source)** | **[NEW]** `CatDNSAmplification` | 1 | — (response-size/query-type ratio rule; `ANY` query blocking already scoped in synopsis §8) | Auto-Block | Kernel-layer | CIC-DDoS2019 DNS-amplification subset |
| **DNS Cache Poisoning / spoofed responses** | **[NEW]** `CatDNSSpoofing` | 1 | — (transaction-ID / source-port randomness check) | Alert | App-layer | dnsspoof (self-generated in isolated sandbox only) |

### 2.3 FTP

| Threat | Category | Tier | ML model | Response | Blocking | Training data |
|---|---|---|---|---|---|---|
| Anonymous login abuse | `CatAnonLogin` | 1 | — | Alert | N/A | RFC 959 baseline + your own FTP server config |
| FTP Bounce attack (port-scanning via `PORT` command) | `CatFTPBounce` | 1 | — | Auto-Block | App-layer | RFC 2577 test cases; nmap `-b` (bounce scan) traffic |
| Data-channel abuse (unexpected/oversized transfer) | `CatFTPData` | 1 + 3 | #3 (flow, exfil-volume anomaly) | Alert → Auto-Block | Kernel-layer | Self-generated large-transfer baseline + anomalous transfer test |
| Brute-force login | `CatBruteForce` | 1 + 3 | #4-style classifier (reuse SSH pattern) | Auto-Block + Tarpit | App + kernel | Hydra FTP module traffic |
| **Cleartext credential exposure (no `AUTH TLS`/FTPS)** | **[NEW]** `CatFTPCleartextCreds` | 1 | — | Alert | N/A (advisory) | RFC 4217 baseline |

### 2.4 Telnet

| Threat | Category | Tier | ML model | Response | Blocking | Training data |
|---|---|---|---|---|---|---|
| IoT default-credential login (Mirai-style) | `CatTelnetIoT` | 1 + 3 | #4-style / #3 (flow) | Auto-Block + Tarpit | App + kernel | Public default-credential lists (router/IoT vendor manuals); Mirai source's own credential list (defensive reference only) |
| Reconnaissance / banner scanning | `CatTelnetScan` | 1 | — | Alert | N/A | Nmap Telnet scan logs |
| Credential stuffing | `CatCredStuff` | 1 + 3 | #4-style | Auto-Block | App + kernel | Have I Been Pwned-style breach-derived wordlists (public credential-stuffing lists) + Hydra traffic |
| Password spraying | `CatPwdSpray` | 1 + 3 | #4-style | Auto-Block | App + kernel | Hydra `-L`/`-P` spray-mode traffic |
| Cleartext session hijack risk | `CatMalformed`/`CatUnauthAccess` (generic) | 1 | — | Alert | N/A | RFC 854 baseline |

### 2.5 SMTP

| Threat | Category | Tier | ML model | Response | Blocking | Training data |
|---|---|---|---|---|---|---|
| Open relay abuse | `CatOpenRelay` | 1 | — | Auto-Block | App-layer | RFC 5321 relay-test suite (self-hosted sandbox only) |
| Spam origination | `CatSpam` | 1 + 3 (stretch) | **[NEW]** #8 Phishing/Spam Text Classifier (Naive Bayes / simple TF-IDF + Logistic Regression) | Alert → Rate-Limit | App-layer | SpamAssassin public corpus; Enron-Spam dataset |
| Phishing content | `CatPhishing` | 1 + 3 (stretch) | #8 | Alert | App-layer | Nazario Phishing Corpus (public, research use); PhishTank feed |
| **STARTTLS stripping / downgrade** | **[NEW]** `CatSMTPSTARTTLSStrip` | 1 | — | Alert | N/A | RFC 3207 baseline |

### 2.6 Database protocols (MySQL / PostgreSQL / Redis / MongoDB)

| Threat | Category | Tier | ML model | Response | Blocking | Training data |
|---|---|---|---|---|---|---|
| Dangerous administrative commands (`DROP`, `FLUSHALL`, `SHUTDOWN`, etc.) | `CatDangerousCmd` | 1 | — | Auto-Block | App-layer | Command allow/deny list (static, RFC/vendor-doc derived — inherently rule-friendly, per Gap Analysis §7's own assessment) |
| Unauthenticated access attempt | `CatUnauthAccess` | 1 | — | Auto-Block | App-layer | RFC/protocol-spec baseline |
| SQLi reaching the DB tier directly (bypass of app-layer WAF) | `CatSQLi` (shared) | 1 | — | Auto-Block | App-layer | Same sqlmap corpus as §1 |

### 2.7 TLS (wraps HTTPS/SMTPS/FTPS)

| Threat | Category | Tier | ML model | Response | Blocking | Training data |
|---|---|---|---|---|---|---|
| Weak cipher suite negotiated | `CatTLSWeakCipher` | 1 | — | Alert | N/A | Mozilla SSL Configuration Generator "modern"/"intermediate" baseline |
| Protocol downgrade (TLS 1.0/1.1, SSLv3) | `CatTLSDowngrade` | 1 | — | Alert → Auto-Block | App-layer | Same baseline |
| SNI/certificate mismatch | `CatTLSSNIMismatch` | 1 | — | Alert | N/A | Cert validation logic (deterministic) |
| Expired certificate | `CatTLSExpired` | 1 | — | Alert | N/A | Deterministic (X.509 `notAfter`) |
| Self-signed certificate in production context | `CatTLSSelfSigned` | 1 | — | Alert | N/A | Deterministic |
| Malicious TLS client (bot/scanner/known-bad tool) | JA3 lookup (implemented) — **[NEW]** formalize `CatTLSKnownBadFingerprint` for JA4 once built | 2 | #7 TLS/JA3-JA4 Fingerprint Matcher (lookup, not ML) | Auto-Block | App-layer | Abuse.ch JA3 feed; JA4+ database (FoxIO) |

### 2.8 Generic fallback protocols (RDP, VNC, LDAP, IMAP, POP3, SOCKS, NTP, SNMP)

| Threat | Category | Tier | ML model | Response | Blocking | Training data |
|---|---|---|---|---|---|---|
| Signature-matched known exploit traffic (fallback scan) | Existing generic signature set | 1 | — | Alert → Auto-Block | App-layer | Nuclei templates (protocol-tagged); Suricata/Snort community ruleset (reference only, not redistributed) |
| **RDP brute-force / BlueKeep-class pre-auth RCE probes (CVE-2019-0708 family)** | **[NEW]** `CatRDPExploit` | 1 | — | Auto-Block | App + kernel | NVD/CVE feed filtered `cpe:*:rdp*`; Nuclei RDP templates |
| **NTP/SNMP amplification abuse (reflection source)** | **[NEW]** `CatUDPAmplification` | 1 | — | Auto-Block | Kernel-layer | CIC-DDoS2019 NTP/SNMP-amplification subsets |
| **SNMP default community-string access (`public`/`private`)** | **[NEW]** `CatSNMPDefaultCreds` | 1 | — | Auto-Block | App-layer | Default-community-string wordlist (public reference) |

### 2.9 Cross-protocol / behavioral (applies to all of the above)

| Threat | Category | Tier | ML model | Response | Blocking | Training data |
|---|---|---|---|---|---|---|
| Port scanning | `CatPortScan` | 1 + 3 | #3 (flow) | Rate-Limit → Auto-Block | Kernel-layer | Nmap scan logs (all scan types: SYN, FIN, Xmas, etc.); CIC-IDS2017 PortScan subset |
| Cross-protocol brute-force rate | `CatBruteForce` | 1 + 3 | #4-style / #3 | Auto-Block | App + kernel | Hydra/Medusa multi-protocol runs |
| Beaconing (periodic C2 check-in pattern) | `CatBeaconing` | 3 | #3 (flow, IAT regularity) | Alert → Auto-Block | Kernel-layer | CTU-13 botnet dataset (Stratosphere IPS) |
| Generic tunneling (protocol-in-protocol abuse) | `CatTunneling` | 1 + 3 | #3 | Alert | App-layer | Self-generated (iodine/dnscat2/ssh -D reused across categories) |
| Command-and-control traffic | `CatC2` | 3 | #3 | Auto-Block + kernel | Kernel-layer | CTU-13; MITRE ATT&CK-mapped C2 traffic samples where publicly available |
| Lateral movement | `CatLateralMove` | 3 | #3 | Alert | App-layer | CIC-IDS2018 infiltration subset |
| Protocol/port mismatch (service on wrong port — your Protocol-Agnostic Proxy's own detection) | `CatProtoMismatch` | 1 | — | Alert | N/A | Deterministic (banner vs. expected-service comparison) |
| Time-based access anomaly (off-hours admin login, etc.) | `CatTimeAnomaly` | 3 | #3 / #6 reputation | Alert | N/A | Your own organic baseline (time-of-day distribution) |
| Data exfiltration (abnormal outbound volume) | `CatDataExfil` | 3 | #3 (flow, `bytes_out` from Redis rolling store) | Auto-Block | Kernel-layer | CIC-IDS2018 infiltration + your own baseline |
| Known-bad IP reputation match | — (Tier 2, not a Detection category) | 2 | #6 IP Reputation (weighted-decay, rule-based, **not ML** — keep this framing for your viva, per Gap Analysis §8) | Auto-Block | Kernel-layer | AbuseIPDB, Spamhaus DROP/EDROP, FireHOL, CINS Army, GreyNoise Community, Tor exit list |

---

## 3. Updated ML model inventory (extends master plan §6.2 from 7 to 12 entries)

| # | Model | Type | Protocol(s) | Needs labels? | Priority |
|---|---|---|---|---|---|
| 1 | HTTP Payload Anomaly Scorer | Unsupervised (Isolation Forest) | HTTP | No | Phase E — build first |
| 2 | Web Attack Classifier | Supervised (Random Forest / XGBoost, multiclass) | HTTP | Yes | Phase F |
| 3 | Flow-level Anomaly Detector | Unsupervised (Isolation Forest) | All (cross-protocol) | No | Phase E — build first |
| 4 | SSH/FTP/Telnet Brute-Force & Bot Classifier | Supervised (or IAT-threshold rule to start simple) | SSH, FTP, Telnet | Yes (or no if starting rule-based) | Phase F (stretch) |
| 5 | DNS Tunneling/DGA Detector | Supervised/hybrid (entropy features + classifier for DGA family) | DNS | Yes for DGA family, no for entropy-only tunneling | Phase F (stretch) |
| 6 | IP Reputation Score | Rule + weighted decay — **not ML** | All | No | Phase A |
| 7 | TLS/JA3+JA4 Fingerprint Matcher | Lookup — **not ML** | TLS | No | Phase A (feed-based) |
| **8** [NEW] | Phishing/Spam Text Classifier | Supervised (TF-IDF + Logistic Regression, or Naive Bayes) | SMTP | Yes | Stretch / lowest priority per Gap Analysis §7 |
| **9** [NEW] | API Abuse Sequence Model (BOLA/ID-enumeration scorer) | Rule-first (session ID-sequence tracker, §3.2 of master plan), promotable to a lightweight sequence classifier later | HTTP (API) | No (rule-first) | Phase B, before ML |
| **10** [NEW] | GraphQL Query-Cost/Abuse Scorer | Rule-first (query depth/complexity + introspection-flag check) | HTTP (GraphQL) | No | Stretch — only if the team's app stack uses GraphQL |
| **11** [NEW] | CVE/Exploit Signature Matcher | Lookup against NVD/CVE feed + Nuclei templates — **not ML** | SSH, RDP, generic | No | Phase A alongside reputation feeds |
| **12** [NEW] | CAPTCHA Trigger Model (rate + IAT-variance gate) | Rule-based threshold, not ML (per master plan §4.1's own explicit design choice — defensible in viva) | HTTP | No | Phase C |

**Why several "models" above are explicitly rule-based, not ML:** your Gap Analysis (§7, §8) and ML Module Documentation both already make the correct call that IP reputation, TLS fingerprint matching, CVE signature matching, and the CAPTCHA trigger are better as deterministic/weighted-decay logic, not trained models — cite this explicitly in your report as an intentional design decision ("we used ML where it adds value — anomaly scoring and multiclass attack classification — and rules where determinism is more defensible and auditable"), not a gap. This is a stronger academic position than claiming "everything is ML."

---

## 4. New Go detection categories to add (`Security/detect/detection.go`)

Paste this block into the existing `const (...)` category list — it is additive only, nothing existing is renamed, so no other file needs to change just from adding these:

```go
// ── HTTP/API additions ──
CatLFI                   = "lfi"
CatRFI                   = "rfi"
CatCSRF                  = "csrf"
CatClickjacking          = "clickjacking"
CatSSTI                  = "ssti"
CatInsecureDeserialization = "insecure-deserialization"
CatNoSQLi                = "nosqli"
CatXPathInjection        = "xpath-injection"
CatGraphQLAbuse          = "graphql-abuse"
CatWebSocketAbuse        = "websocket-abuse"
CatHostHeaderInjection   = "host-header-injection"
CatBOLA                  = "bola"
CatBFLA                  = "bfla"
CatMassAssignment        = "mass-assignment"
CatAPIResourceAbuse      = "api-resource-abuse"
CatJWTAlgNone            = "jwt-alg-none"
CatJWTAlgConfusion       = "jwt-alg-confusion"
CatJWTExpiredAccepted    = "jwt-expired-accepted"

// ── SSH additions ──
CatSSHKnownBadFingerprint = "ssh-known-bad-fingerprint"
CatSSHCVEExploit          = "ssh-cve-exploit"

// ── DNS additions ──
CatDNSAmplification = "dns-amplification"
CatDNSSpoofing      = "dns-spoofing"

// ── FTP additions ──
CatFTPCleartextCreds = "ftp-cleartext-creds"

// ── SMTP additions ──
CatSMTPSTARTTLSStrip = "smtp-starttls-strip"

// ── TLS additions ──
CatTLSKnownBadFingerprint = "tls-known-bad-fingerprint"

// ── Generic protocol additions ──
CatRDPExploit       = "rdp-exploit"
CatUDPAmplification = "udp-amplification"
CatSNMPDefaultCreds = "snmp-default-creds"
```

**Build note:** most of these are Tier-1 regex/signature additions (small, incremental diffs to the existing analyzer files) — they do not require new ML models to ship value; they only need labeled examples (§6.2 below) once you're ready to let Tier-3 score them too.

---

## 5. How detection connects to ML scoring and blocking — the actual wiring

This is the same pipeline as your synopsis Fig. 2, made explicit per threat class:

1. **Every threat in §1–2.9 above is first attempted at Tier 1** (Go regex/signature/state-machine — this is what's "live today" per the Gap Analysis §7 status column).
2. **Threats with a Tier-2 entry** (IP reputation, HASSH, JA3/JA4, CVE-feed matches) get a Redis lookup **before** Tier 3 runs — this is a performance win (§2.5 of master plan): a `rep:ip:{ip}` score > 80 short-circuits straight to block.
3. **Threats with a Tier-3/ML-model entry** get scored by the matching FastAPI route:
   - HTTP payload threats → `POST /score/http-payload` (models #1, #2)
   - Any protocol's flow-level/behavioral threats → `POST /score/flow` (model #3)
   - **[NEW routes needed, extending scoring_service.py — see §7 code below]:**
     - `POST /score/ssh` (model #4)
     - `POST /score/dns` (model #5)
     - `POST /score/smtp-text` (model #8)
4. **The Cross-Layer Decision Engine combines Tier 1 + Tier 2 + Tier 3 scores** into the single 0–100 `risk_score` and picks the response action per your Graded Response Layer (Allow/Alert/Auto-Block/Tarpit), exactly as in Fig. 2 of the synopsis.
5. **Blocking mechanism selection follows this rule of thumb** (already implicit in your architecture, made explicit here for the report):
   - **App-layer block** (proxy returns 403/resets the connection) — used for HTTP/API-specific threats that only make sense in the context of one request.
   - **Kernel-layer block** (Cross-Layer Decision Engine triggers an L3/4 firewall rule across *all* ports for that source IP) — used for anything behavioral/flow-based (port scan, DDoS, brute-force, C2, exfiltration) where the attacker will simply retry on another port if only blocked at L7.
   - **Tarpit** — reserved for the cases your synopsis explicitly calls out as active-defense targets: web scanners (slow one-byte HTTP headers) and Telnet/SSH brute-forcers (endless fake verification loop) — never used for one-shot exploit attempts like Log4Shell where you want an immediate hard block, not a delay.

---

## 6. Training data sources — consolidated, per protocol, nothing left out

This section supersedes and expands Gap Analysis §6 into one complete reference, organized so you can go straight from "I need to train model X for protocol Y" to "here is exactly where the data comes from."

### 6.1 Public labeled network datasets (flow-level / general IDS models — feeds Model #3, bootstraps #4/#5)

| Dataset | Covers | Use for |
|---|---|---|
| **CIC-IDS2017 / CIC-IDS2018** (Canadian Institute for Cybersecurity) | Brute-force, DoS/DDoS, infiltration, botnet, port scan, web attacks — your `FlowRecord` schema was modeled to match this directly | Model #3 (flow anomaly), primary bootstrap dataset |
| **CIC-DDoS2019** | Reflection/amplification DDoS (DNS, NTP, SNMP, SSDP, etc.), volumetric floods | `CatDDoS`, `CatDNSAmplification`, `CatUDPAmplification`, `CatSlowloris` |
| **CSIC 2010 HTTP dataset** | Labeled normal/anomalous HTTP requests | Model #1, #2 bootstrap before your own labeled traffic exists |
| **UNSW-NB15** | Fuzzers, backdoors, exploits, reconnaissance, shellcode | Secondary flow-level dataset, cross-validation for Model #3 |
| **CTU-13** (Stratosphere IPS project) | Real botnet traffic — beaconing, C2 | `CatBeaconing`, `CatC2`, `CatLateralMove` |
| **Bambenek Consulting DGA feed / Netlab 360 DGA feed** | Known DGA domain families | Model #5 (DNS DGA classification) |

### 6.2 Self-generated labeled attack traffic (your own protocol quirks — irreplaceable by public datasets)

Run against a sandboxed target only (DVWA, OWASP Juice Shop, bWAPP, crAPI, DVGA — isolated containers, never a live/real system):

| Tool | Generates traffic for | Feeds |
|---|---|---|
| **sqlmap** (all tamper/encoding scripts) | SQLi, obfuscated/encoded payloads | `CatSQLi`, Model #1's entropy features |
| **Nikto** | Bot/scanner User-Agent + request patterns | `CatBotScanner` |
| **OWASP ZAP / wfuzz / dirb / gobuster** | XSS, fuzzing, directory brute-force | `CatXSS`, `CatDirBruteForce` |
| **Hydra / Medusa** | SSH/FTP/Telnet brute-force, credential stuffing, password spray | `CatSSHBruteForce`, `CatCredStuff`, `CatPwdSpray`, Model #4 |
| **dnschef / iodine / dnscat2** | DNS tunneling | `CatDNSTunnel`, Model #5 |
| **Commix** | Command injection | `CatCommandInjection` |
| **SSRFmap** | SSRF, cloud-metadata targeting | `CatSSRF` |
| **tplmap** | SSTI | `CatSSTI` |
| **ysoserial** (Java gadget chains) | Insecure deserialization | `CatInsecureDeserialization` |
| **NoSQLMap** | NoSQL injection | `CatNoSQLi` |
| **jwt_tool** | JWT `alg:none`, algorithm confusion, expired-token acceptance | `CatJWTAlgNone`, `CatJWTAlgConfusion`, `CatJWTExpiredAccepted` |
| **InQL / graphql-cop** (against DVGA) | GraphQL introspection/batching abuse | `CatGraphQLAbuse` |
| **slowhttptest / hping3 / locust** | Slowloris, RUDY, volumetric floods | `CatSlowloris`, `CatDDoS` |
| **crAPI** (Completely Ridiculous API) app itself, driven manually + scripted | BOLA, BFLA, mass assignment, API resource abuse | `CatBOLA`, `CatBFLA`, `CatMassAssignment`, `CatAPIResourceAbuse`, Model #9 |
| **Nuclei** (with CVE-tagged templates) | Signature coverage per known CVE, across all protocols | Tier-1 rule strengthening, Model #11 |
| Your own **normal browsing / legitimate API traffic** through the same sandboxed apps | The `benign` label for every supervised model | All supervised models — this is as important as the attack traffic itself |

This remains the only realistic way to get labeled positive examples matched to your exact 49+18-new-category taxonomy — public datasets do not cover project-specific categories like `CatBOLA` or `CatSSTI` at all.

### 6.3 Threat intelligence feeds (Tier 2 reputation + fingerprint lookups — no training required, refreshed on a schedule)

| Feed | Populates | Refresh |
|---|---|---|
| **AbuseIPDB** | `rep:feed:*` known-bad IP set | 6–12h cron |
| **Spamhaus DROP/EDROP** | Known-bad CIDR ranges | 6–12h cron |
| **FireHOL IP lists** | Aggregated bad-IP lists | 6–12h cron |
| **CINS Army list** | Known-bad IP set | 6–12h cron |
| **GreyNoise Community API** | Internet-scanner/noise classification | 6–12h cron |
| **Tor exit node list** | Reputation signal (not auto-block by default — many legitimate users use Tor) | Daily |
| **MaxMind GeoLite2** | GeoIP for reputation model + dashboard geographic view | Monthly (per MaxMind's own update cadence) |
| **Abuse.ch JA3 feed / JA4+ database (FoxIO)** | `rep:feed:ja3_bad`, TLS fingerprint matcher (Model #7) | Weekly |
| **HASSH project public bad-fingerprint list** | SSH client fingerprint matcher | As published |
| **NVD/CVE feed** (filtered by CPE per protocol) | Model #11 (CVE/exploit signature matcher), also feeds the "Vulnerability Advisor" RAG box on your ML/AI Integration slide | Daily |
| **PhishTank feed** | Phishing URL/domain reputation for Model #8 | Daily |

### 6.4 Payload/signature reference libraries (strengthens Tier-1 regex + bootstraps weak labels for Tier-3)

| Source | Use |
|---|---|
| **PayloadsAllTheThings** (GitHub) | Comprehensive payload library across every category in §1–2.9 |
| **SecLists** | Wordlists for brute-force/fuzzing/directory discovery |
| **OWASP Core Rule Set (CRS)** | Mature regex rule set — both a Tier-1 upgrade reference and a **weak-labeling function** ("if CRS would flag it, weak-label it as attack" — standard technique to bootstrap supervised data before enough hand-labeled traffic exists) |
| **Nuclei templates** | Signature coverage per CVE, YAML format already matches your architecture's rule format |
| **OWASP API Security Top 10 (2023) test suite** | BOLA/BFLA/mass-assignment/resource-abuse test cases |
| **SpamAssassin public corpus / Enron-Spam dataset** | Model #8 (SMTP spam classifier) |
| **Nazario Phishing Corpus** | Model #8 (phishing classifier) — research/defensive use |

### 6.5 Text-based summary — "I need data for X, where do I get it" quick index

- **Web/API attacks (SQLi, XSS, SSRF, XXE, SSTI, deserialization, NoSQLi, GraphQL, JWT, BOLA/BFLA)** → §6.2 self-generated tools against DVWA/Juice Shop/crAPI/DVGA, weak-labeled/cross-checked with OWASP CRS (§6.4), bootstrapped with CSIC-2010 (§6.1).
- **Flow-level/behavioral (port scan, DDoS, brute-force rate, beaconing, exfiltration)** → CIC-IDS2017/2018, CIC-DDoS2019, CTU-13 (§6.1), supplemented with your own sandbox captures.
- **SSH/FTP/Telnet brute-force & bot detection** → Hydra/Medusa traffic (§6.2), CIC-IDS2017 SSH-Patator subset (§6.1).
- **DNS tunneling/DGA** → dnschef/iodine/dnscat2 traffic (§6.2), Bambenek/Netlab 360 DGA feeds (§6.1).
- **SMTP spam/phishing** → SpamAssassin, Enron-Spam, Nazario corpus, PhishTank (§6.3–6.4).
- **IP/TLS/SSH reputation and fingerprinting** → AbuseIPDB, Spamhaus, FireHOL, CINS, GreyNoise, Tor list, JA3/JA4, HASSH (§6.3) — no training needed, these are lookup feeds.
- **CVE/exploit signatures (SSH, RDP, generic protocols)** → NVD/CVE feed + Nuclei CVE templates (§6.3–6.4).

---

## 7. Code additions needed in `ML_Planning/` to match this matrix

The three Python files already in this folder cover models #1, #2, #3 end-to-end. To reach full coverage of the matrix above without changing their existing structure, add:

1. **`feature_encoder.py`** — add `SSH_FEATURE_COLUMNS` (failed-attempt rate, IAT stats reused from `FlowRecord` for the SSH port, HASSH-seen-before flag, banner-scan flag) and `DNS_FEATURE_COLUMNS` (query entropy, label count, NXDOMAIN ratio, query-type distribution, response-size ratio) plus matching `_flatten_ssh_record` / `_flatten_dns_record` functions, mirroring the existing `_flatten_flow_record` pattern exactly.
2. **`train_models.py`** — add `ssh-brute-classifier` and `dns-tunnel-dga` subcommands, same shape as `train_web_classifier` (supervised, needs the `label` field from the Hydra/dnscat2-generated batches in §6.2).
3. **`scoring_service.py`** — add `POST /score/ssh` and `POST /score/dns` routes, loaded the same way as the existing two routes, with the same 50ms-timeout/fail-open contract on the Go side (master plan §6.7 — do not weaken this for the new routes).
4. **Model #8 (SMTP spam/phishing)** is lower priority (per Gap Analysis §7, §9) — build only if time remains after the priority checklist in master plan §8 is complete; if built, it's a standalone `TfidfVectorizer` + `LogisticRegression` pipeline, not part of the tabular-feature pattern the other models use, so keep it in a separate `train_text_classifier.py` rather than forcing it into `feature_encoder.py`'s numeric-only contract.

These are incremental additions to existing files — nothing above requires restructuring `redis_reputation.py`, the Node.js block-management files, or the CAPTCHA files, which already fully implement §5's blocking/gating logic as designed.

---

## 8. Cross-reference to existing docs (so you know where else to look)

| If you need... | Go to |
|---|---|
| Raw data fields currently collected per protocol, with sample JSON | `Protocol-Data-Collection-Inventory-and-Templates.md` |
| Why Isolation Forest / Random Forest were chosen over deep learning / LLMs | `Processing_ML_Module_Documentation.md` §1 |
| Original protocol-by-protocol implementation status table | `ML-Processing-Module-Design-and-Gap-Analysis.md` §7 |
| Week-by-week build order, Redis schema, CAPTCHA flow, dashboard block/unblock model | `00_MASTER_PLAN_ML_Detection_Redis_Dashboard.md` |
| Runnable code for reputation, feature encoding, training, serving, CAPTCHA, blocklist | `redis_reputation.py`, `feature_encoder.py`, `train_models.py`, `scoring_service.py`, `captcha.middleware.js`, `CaptchaGate.jsx`, `BlockedEntity.js`, `block.controller.js`, `block.routes.js`, `redisSecurityClient.js` (this folder) |
| **Every threat this project defends against, mapped to protocol → detection tier → ML model → response → blocking mechanism → training data source** | **this document** |

---

## 9. What is still explicitly out of scope (state this in the report, don't leave it silently absent)

Per the existing Gap Analysis §8 "immediately out of scope" call, plus additions specific to this matrix:

- **Online/continuous learning** — scheduled batch retraining only (master plan §6.6 point 5).
- **Deep learning (LSTM/CNN/Transformer-based IDS)** — traditional ML is sufficient for tabular, moderate-volume data and is more defensible in a viva.
- **Custom CAPTCHA image generation** — use Cloudflare Turnstile/hCaptcha (master plan §4.2); your novel contribution is the adaptive triggering logic, not CAPTCHA-solving resistance.
- **L2 threats (ARP spoofing, MAC flooding)** — your architecture operates at L3/4/7 via a reverse proxy and eBPF at the host, not at the switch/L2 level; correctly out of scope for a proxy-based system, note this explicitly if asked in viva rather than silently omitting L2 from your threat list.
- **True MAC-address device fingerprinting** — not obtainable through a reverse proxy; you already correctly reframe this as TLS/header-based client fingerprinting (Gap Analysis §8).
- **"Collaborative filtering" IP reputation exactly as worded on the PPT slide** — build and describe the defensible weighted-decay version instead (Gap Analysis §8) — this document's §3 model #6 entry reflects that correction.
