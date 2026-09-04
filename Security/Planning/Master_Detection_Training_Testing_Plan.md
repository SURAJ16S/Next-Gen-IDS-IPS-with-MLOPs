# Master Detection, Training & Testing Plan — Full Threat Coverage

> Covers every category in the Comprehensive Threat Coverage Matrix. Items already detailed in the earlier `Detection_Engine_ML_Improvement_Plan.md` (SQLi, XSS, SSTI, NoSQLi, command injection, path traversal, SSRF, XXE, JWT, CSRF, GraphQL, insecure deserialization) are referenced, not repeated in full — this document fills every remaining gap and adds the training/testing procedure for each. A small number of genuinely rare/low-value items are explicitly marked skipped, with reasoning, per your instruction.

---

## 1. Web Application & API (HTTP/HTTPS)

### 1.1 Already covered in the previous document (reference, not repeated)
SQLi, NoSQLi, Command Injection, SSTI, LFI/RFI, XSS, CSRF, BOLA/BOPLA (called Mass Assignment here), JWT flaws, Log4Shell, XXE/Billion Laughs, Insecure Deserialization, SSRF, GraphQL Abuse, User-Agent/scanner fingerprinting, information leakage.

### 1.2 New items from this matrix

| Vulnerability | Detection technique | ML integration |
|---|---|---|
| **LDAP Injection** | Regex on filter metacharacters in parameters known to build LDAP queries: `*`, `(`, `)`, `\`, `NUL`, plus keyword patterns `(cn=`, `(uid=`, `(objectClass=` — you already partially have this (`HTTP-LDAP-001`); extend to also flag blind-LDAP timing patterns (`(&(uid=admin)(userPassword=*))`-style boolean probes) | Add `ldap_metachar_count` and `ldap_filter_depth` (nested-parenthesis depth) as features to `web_classifier` |
| **XPath Injection** | Regex for XPath metacharacters/functions in parameters feeding XML queries: `' or '1'='1`, `count(/*)`, `substring(`, `translate(` | Low priority for a dedicated ML model — rare enough that Tier-1 regex is proportionate; don't over-invest ML effort here |
| **Host-Header Injection** | Compare `Host` header against the server's actual configured hostname/IP; flag mismatches, and flag `Host` values containing another domain used for cache-poisoning or password-reset-link poisoning attacks | Track `host_header_entropy` and `host_header_mismatch_flag` as features — cheap signal, catches password-reset-poisoning attempts specifically |
| **BFLA (Broken Function-Level Authorization)** | Cannot be purely regex — requires knowing your app's actual role/endpoint map. Minimum viable: log (role claimed in JWT/session) × (endpoint called), and flag calls to admin-prefixed or known-privileged endpoints from non-admin-role tokens | This is fundamentally an **anomaly-over-behavior** problem — feed (user_id, endpoint, expected_role) tuples into a per-user access-pattern anomaly model, not the per-flow HTTP model |
| **API Resource Abuse (unbounded pagination)** | Flag requests with `limit`/`page_size` parameters above a configured max, or requests with no pagination bound on endpoints known to return large collections | Track `response_size_to_request_size_ratio` as a feature — an unusually large response relative to a tiny request is the generic signature of this class regardless of specific parameter names |
| **Open Redirect** | Flag `redirect`/`url`/`next`/`return_to`-style parameters whose value is an absolute URL to a different domain, or a scheme-relative URL (`//evil.com`) | Not high-value for ML — deterministic rule is sufficient and low-false-positive here |
| **HTTP Request Smuggling** | Already covered (`HTTP-SMUG-001/002/003`) — add detection for **0.CL** (Transfer-Encoding present, Content-Length absent, malformed chunk) which is a newer smuggling variant beyond the CL+TE pair already checked | No ML value here — this is a strict protocol-parsing correctness check, not a statistical pattern |
| **WebSocket Hijacking** | Validate `Origin` header on WebSocket upgrade requests against an allowlist; flag upgrade requests missing `Sec-WebSocket-Key` validation or from unexpected origins | Low priority for ML — treat as a rule-based protocol-compliance check |
| **Clickjacking** | Response-side check: flag responses on sensitive pages (login, payment, admin) missing both `X-Frame-Options` and a `frame-ancestors` CSP directive | Already partially covered under `HTTP-HDR-001` (missing security headers) — just make sure `frame-ancestors` is explicitly checked, not only `X-Frame-Options` |
| **Slowloris / Slow-POST** | Track time-to-complete-headers and time-to-complete-body per connection; flag connections that hold the socket open far longer than the byte count justifies (this is the literal inverse of your own tarpit technique — recognize it as a real DoS pattern arriving from outside, not just something you do to attackers) | Feed connection-duration vs. bytes-transferred ratio into `flow_anomaly` — this is a flow-level feature you likely already compute |
| **Volumetric DDoS (HTTP flood)** | Rate-limiting is your primary control here (already scoped in your architecture); detection is the `BEH-RATE-001` rule you have, extended to per-endpoint (not just per-IP global) rate tracking, since a flood against one expensive endpoint can stay under a global per-IP threshold | `flow_anomaly` on aggregate request-rate time series, not per-flow — this needs a windowed aggregation feature, not a single-flow feature |

---

## 2. SSH — remaining items beyond what's already built

| Vulnerability | Detection technique | ML integration |
|---|---|---|
| **SSH Tunneling / Port-Forwarding Abuse** | SSH protocol allows `-L`/`-R`/`-D` forwarding negotiated post-auth; detect via unusually long-lived SSH sessions carrying sustained bidirectional byte flow inconsistent with an interactive terminal session (interactive SSH is bursty; a tunnel carrying other traffic is steady) | This is exactly what your flow-level IAT/byte-ratio features are good at — feed post-auth SSH session flow stats into `ssh_brute_classifier`'s sibling model, or a new lightweight `ssh_tunnel_anomaly` model |
| **Malformed SSH Packets** | Protocol-compliance check at parse time — reject/flag packets violating SSH framing (length prefix mismatch, invalid message type for current protocol state) | Rule-based only, no ML value — malformed framing is deterministic |
| **CVE-based exploitation (e.g. regreSSHion / CVE-2024-6387)** | Version-fingerprint the SSH banner against a small maintained list of known-vulnerable OpenSSH version strings; flag connections attempting to exploit the specific race-condition timing pattern associated with that CVE if you choose to implement the detection signature | This is a moving target — **document as requiring a manually maintained CVE-version watchlist**, updated as new SSH CVEs are published (see Section 6, manual items) |
| **HASSH known-malicious fingerprints** | Already have SSH client fingerprinting infrastructure implied by your Hassh mention — maintain a blocklist of known-malicious Hassh values the same way you maintain IP reputation | Not ML — this is a lookup-table match, same pattern as JA3 blocklist |

---

## 3. DNS — remaining item

| Vulnerability | Detection technique | ML integration |
|---|---|---|
| **DNS Cache Poisoning / Spoofing** | Detect DNS responses where the transaction ID doesn't match an outstanding query, or where multiple differing responses arrive for the same query ID in a short window (classic poisoning-race signature) | Track `dns_response_id_mismatch_count` per source as a feature — mostly rule-based, ML adds value only in distinguishing legitimate anycast/load-balanced variation from actual spoofing attempts, which is a genuinely hard problem worth flagging as a known limitation rather than over-claiming detection accuracy |

*(Tunneling, DGA, rebinding, AXFR, NXDOMAIN flood, and amplification are already well covered in your existing rule set and the previous improvement document.)*

---

## 4. FTP — remaining items

| Vulnerability | Detection technique | ML integration |
|---|---|---|
| **FTP Bounce Attack** | Already scoped in the previous document (PASV IP mismatch) — extend to also flag `PORT` commands specifying an IP/port that isn't the connecting client's own address, which is the classic bounce-scan setup | Not ML — deterministic protocol check |
| **Data-Channel Abuse (Exfiltration)** | Already scoped (volume-vs-baseline anomaly) | `flow_anomaly` on the data-channel connection specifically, separate from the control-channel connection — treat FTP as two correlated flows, not one |
| **Cleartext Credential Exposure** | Flag `USER`/`PASS` commands sent before/without any TLS upgrade (FTPS) — informational/compliance-style flag rather than an attack detection, but worth logging since it's a real risk on your own monitored infrastructure too | No ML needed |

---

## 5. Telnet — remaining items

| Vulnerability | Detection technique | ML integration |
|---|---|---|
| **IoT Default-Credential Login (Mirai-style)** | Maintain a small list of known IoT default credential pairs (`admin/admin`, `root/12345`, `admin/1234`) commonly targeted by IoT botnets; flag successful or attempted logins matching these specific pairs distinctly from generic brute-force, since it signals botnet reconnaissance specifically, not a targeted human attacker | This is a lookup-table match, not ML — but the *pattern of scanning many IPs with the same fixed credential list* is exactly what your beaconing/behavioral detection should correlate against Telnet specifically |
| **Password Spraying** | Structurally the inverse of brute-force: **one password, many usernames**, often distributed across many source IPs to evade per-IP rate limits. Needs the per-account rolling counter (already flagged as a gap in the previous document's `BEH-CREDSTUFF-001`) applied specifically to Telnet | This is exactly the kind of pattern that benefits from the per-IP-and-per-account feature store — flag as depending on that infrastructure being built first |
| **Cleartext Session Hijacking** | You can't prevent Telnet's lack of encryption, but you can flag any Telnet session that appears immediately after a period of ARP-spoofing-consistent network behavior on the local segment, if you have that visibility — otherwise, treat as an inherent-risk-of-protocol note rather than a detectable attack event | Low priority — document as a protocol-level limitation, not a detection gap you can close |

---

## 6. Email (SMTP) — remaining items

| Vulnerability | Detection technique | ML integration |
|---|---|---|
| **Spam Origination** | Already partially covered via excessive-recipients (`SMTP-SPAM-001`); extend with content-based heuristics: high ratio of URLs to text length, known spam-trigger phrase density | A lightweight text classifier on the DATA body (bag-of-words or simple TF-IDF + logistic regression — deliberately not a heavy NLP model, this doesn't need one) trained on public spam/ham datasets (e.g., SpamAssassin's public corpus) |
| **Phishing Content** | Detect sender-domain lookalike patterns (typosquatting distance from your own or common target domains — Levenshtein distance check), urgent-language keyword density, mismatched display-name vs. actual sender address | Same lightweight text classifier as spam detection can be extended with a phishing-specific label — a single small model can realistically cover both, don't build two separate heavy pipelines |
| **STARTTLS Stripping/Downgrade** | Already flagged as planned — detect by tracking whether a STARTTLS negotiation attempt from the client is followed by a plaintext continuation instead of a TLS handshake, which indicates a MITM stripped the upgrade | Rule-based/protocol-state-machine check, not ML |

---

## 7. Databases — remaining item

| Vulnerability | Detection technique | ML integration |
|---|---|---|
| **Direct SQLi bypassing the app layer** | You already apply the SQLi regex patterns at the DB wire-protocol layer (`db_analyzer.go`) — the key addition is correlating a DB-layer detection with whether it arrived via your monitored application's connection pool or a *direct, unexpected* connection to the DB port from outside the expected app-server IP range, since the second case is far more suspicious | Feed `source_is_known_app_server` (boolean) as a feature into whatever scores DB-layer detections — a SQLi-shaped query from an unexpected source is a much stronger signal than the same query from your own app server (which might be a false positive from a legitimate complex query) |

---

## 8. TLS — remaining item

| Vulnerability | Detection technique | ML integration |
|---|---|---|
| **SNI / Certificate Mismatch** | Compare the SNI hostname in the ClientHello against the actual certificate's Subject/SAN presented in the ServerHello — a mismatch indicates either misconfiguration or a MITM presenting the wrong cert | Rule-based, deterministic — no ML value, this is a straightforward equality check |

*(Weak ciphers, downgrades, expired/self-signed certs, and JA3 fingerprinting are already well covered.)*

---

## 9. Generic & Fallback (RDP, VNC, SNMP, UDP)

| Vulnerability | Detection technique | ML integration |
|---|---|---|
| **RDP Brute-Force** | Same pattern as SSH brute-force — track failed auth attempts per source IP on port 3389/RDP protocol signature | Reuse the `ssh_brute_classifier` pattern/architecture, retrained on RDP-specific flow features — don't build a new pipeline from scratch, generalize the existing one |
| **BlueKeep-class exploits (CVE-2019-0708)** | Signature match on the specific malformed Virtual Channel PDU sequence associated with the BlueKeep RCE chain, if you choose to implement it — this is a narrow, CVE-specific signature | Not ML-appropriate — CVE-specific exploit signatures are exact-match problems, not statistical ones |
| **NTP/SNMP Amplification Abuse** | Track response-size-to-request-size ratio for UDP protocols known to be amplification vectors (NTP `monlist`, SNMP `GetBulk`, DNS `ANY` already covered) — any ratio above a threshold (e.g., 10x) from your monitored infrastructure acting as a *reflector* is the signal to catch, not just requests arriving *at* you | Track `udp_amplification_factor` as a feature — genuinely useful shared feature across NTP/SNMP/DNS amplification, build once, apply to all three |
| **SNMP Default Community Strings** | Already scoped in the previous document | No ML needed — exact string match |

---

## 10. Cross-Protocol & Behavioral — remaining items

Most of this category (port scanning, brute-force rate, beaconing, protocol/port mismatch, IP reputation) is already built or scoped in the previous document. Remaining:

| Item | Detection technique | ML integration |
|---|---|---|
| **Generic Tunneling (protocol-in-protocol)** | Detect protocol signatures appearing *inside* the payload of a different, unexpected protocol — e.g., HTTP-looking bytes inside a DNS TXT response, or SSH banner bytes inside what claims to be an HTTP body. This needs a lightweight secondary protocol-sniff pass on payloads that already passed primary protocol detection | Genuinely hard to do cheaply with rules alone at scale — a good candidate for a dedicated lightweight classifier trained to recognize "this payload's byte-entropy/structure looks like protocol X, not protocol Y as claimed" |
| **Lateral Movement** | Requires session-graph correlation: same source IP/credential touching multiple *internal* hosts in a short window, especially hosts it hasn't previously talked to. This is the first item in this document that genuinely can't be caught by any single-flow or single-protocol feature — it needs the cross-protocol correlation architecture described in Section 11 | This is exactly the motivating case for the "session graph" idea in the advanced architecture section below — flag as depending on that infrastructure |
| **Time-Based Access Anomalies** | Track a rolling per-account/per-IP baseline of normal access hours; flag access far outside the established pattern (e.g., a service account that only ever connects 9am–6pm suddenly connecting at 3am) | Genuinely good fit for a small per-account time-of-day model — doesn't need to be complex, a simple baseline + standard-deviation check goes a long way before reaching for anything heavier |

---

## 11. Automated Security Tools & Scanner Detection

Your existing User-Agent fingerprint list already covers the majority of tools listed. Gaps to close, matched against the tool list you provided:

| Tool category | Missing tools to add to `HTTP-UA-002`-style fingerprinting | Additional detection layer needed |
|---|---|---|
| Web/vuln scanners | Acunetix, Nessus, Qualys, Arachni, W3AF | Already flagged as "Improvement Ideas" in your own rules doc — implement as written |
| Directory brute-forcers | ffuf, feroxbuster, Kiterunner (specifically, since it targets API/Swagger routes — worth a dedicated flag given your project's API focus) | Behavioral: high 404/403 ratio + high request rate to path-varying URLs on the same host, independent of User-Agent — this catches the tools even if they spoof their UA string, which sqlmap/ffuf/etc. can all be configured to do |
| NoSQL exploitation | NoSQLMap | Its traffic pattern (systematic `$ne`/`$gt`/`$regex` operator sweeps) is exactly what your new `HTTP-NOSQL-001/002` rules catch regardless of tool UA |
| Network scanners | ZMap, Unicornscan, RustScan | Your port-scan behavioral rule already catches the *pattern*; add these UA/banner strings where they appear (RustScan in particular sometimes leaves a distinctive SYN timing signature — very fast, very regular — which your beaconing coefficient-of-variation check already partially catches) |
| CMS scanners | WPScan, JoomScan, Droopescan, WhatWeb, Wappalyzer | Add UA strings; also flag rapid sequential requests to known CMS-fingerprint paths (`/wp-login.php`, `/administrator/manifests/`, `/CHANGELOG.txt`) as a CMS-recon behavioral signal independent of UA |
| TLS scanners | testssl.sh, SSLyze, sslscan | These often present distinctive JA3 fingerprints (particular cipher-suite orderings) — add to your JA3 blocklist once you've captured a few samples in your own test lab |
| Brute-force frameworks | Hydra, Medusa, Ncrack, Patator, Crowbar | Already have Hydra in your fingerprint table — add the others; behaviorally these all produce the exact BEH-BRUTE-001 pattern regardless of tool identity, so the tool-name signal is a nice-to-have, not the primary defense |
| C2/exploit frameworks | Metasploit, Cobalt Strike, Empire, Sliver, Havoc | Metasploit has known default TLS/JA3 signatures for its handler stack — maintain in your JA3 blocklist. Cobalt Strike/Empire/Sliver/Havoc are far more evasive by design (this is their whole purpose) — realistic detection here is **behavioral beaconing** (your `BEH-BEACON-001` rule), not signature matching. Be honest in your report that fully evading a modern C2 framework's traffic shaping is a genuinely hard, actively-researched problem — claiming otherwise would be the kind of overclaim a security-literate panelist would catch immediately |
| Decoy/canary endpoints | *(new)* | Add honeytoken paths (`/.env`, `/wp-config.php.bak`, `/.git/config`, `/phpmyadmin/`, `/admin.php`, `/.aws/credentials`) that serve no real function — any request to these paths is inherently malicious (a legitimate user never requests them), making this your single highest-confidence, lowest-false-positive detection signal in the entire system. **Recommend implementing this first among the new items** — it's cheap, deterministic, and essentially zero false positives |

---

## 12. Explicitly skipped — genuinely rare, low value to implement

Per your instruction to skip only true rarities, with reasoning for each:

- **XPath Injection dedicated ML model** — real but uncommon outside XML-heavy enterprise/SOAP APIs; Tier-1 regex is proportionate, a dedicated model isn't worth the training-data effort for a project targeting modern web/API stacks
- **BlueKeep and other single-CVE exploit signatures beyond the one example given** — these are individually rare, narrow, and multiply endlessly (a new one exists for nearly every major RDP/SMB CVE); rather than hand-coding each, note this as an area better served by periodically importing Nuclei/Suricata community signatures (see Section 6 of the previous document) than building bespoke detections one CVE at a time
- **Cleartext Telnet session hijacking via local ARP spoofing** — requires network-segment-level visibility your proxy-based architecture doesn't have; document as an inherent protocol risk, not a gap in your detection logic

---

## 13. Training procedure, by protocol

| Protocol | Data sources | Procedure |
|---|---|---|
| **HTTP/API** | DVWA, OWASP Juice Shop, your own test API, PayloadsAllTheThings, SecLists, public spam/phishing corpora (for SMTP-style content models reused if you build a text classifier for phishing content in HTTP forms too) | Run each payload category against the test targets through your own proxy, capturing the 24-field feature vector per request; label by category. Capture equal-sized benign traffic (normal browsing/form use) for the "benign" class. Balance classes — don't let SQLi examples outnumber XSS 10:1 or the model will be biased |
| **SSH** | Your own SSH honeypot/test server, Hydra/Medusa/Ncrack run against it with SecLists credential lists, CIC-IDS2017's SSH-Patator subset if schema-compatible | Capture flow-level features (IAT, byte ratios) for labeled brute-force sessions vs. normal interactive login sessions (have a human actually log in normally several times to generate benign examples — don't skip this, it's the class that's easy to forget) |
| **DNS** | Iodine/dnscat2 (legitimate DNS tunneling tools) run against your own test domain for tunneling-positive examples, real DGA domain lists (several public malware DGA seed lists exist), normal DNS query logs from your own test environment for benign | Label by category: tunneling, DGA, normal. Entropy-based features transfer well here — you likely need less data than for HTTP given fewer, cleaner feature dimensions |
| **FTP** | Your own FTP test server, normal file transfer sessions vs. simulated bounce/anonymous-abuse/exfiltration-volume sessions | Smaller protocol surface — a simpler model (or even well-tuned rules) may be sufficient; don't over-invest ML effort relative to how much FTP traffic you'll realistically see |
| **Telnet** | Cowrie honeypot (a real, widely-used SSH/Telnet honeypot you can point Mirai-style scanners at safely in an isolated lab) — genuinely useful here since Mirai and its variants are still actively scanning the internet for default Telnet credentials, so a honeypot will passively collect real-world labeled attack traffic for you | Run the honeypot for a defined capture window, label the interaction logs by pattern (default-cred login, password spray, banner-scan-only) |
| **SMTP** | SpamAssassin's public corpus (spam/ham labeled email dataset), your own test mail server for relay/phishing simulation | Train the lightweight text classifier on the public corpus first, fine-tune/validate against your own simulated phishing attempts |
| **TLS** | Capture JA3 fingerprints from your own attack-tool test runs (sqlmap, Nikto, Metasploit, testssl.sh, etc. — you're already running these for other protocol testing, capture their TLS fingerprints as a side effect) plus normal browser traffic (Chrome/Firefox JA3) for benign baseline | This is mostly a lookup-table-building exercise, not a trained model — build your JA3 blocklist directly from your own lab's attack-tool runs rather than trying to source a comprehensive public list, since tool fingerprints do change across versions |
| **Databases** | Your own test DB instances, sqlmap/NoSQLMap run against a proxied connection, normal application query patterns for benign baseline | Smaller, more structured feature space than HTTP — a supervised classifier trained on query-shape features should generalize well with a modest dataset |

---

## 14. Testing procedure, by protocol

For every protocol, the testing loop should follow the same shape — **don't treat this as one-and-done, treat it as a repeatable regression suite** you re-run every time you touch a rule or retrain a model:

| Protocol | Attack simulation | Validation method | Key metric to track |
|---|---|---|---|
| **HTTP/API** | Replay categorized PayloadsAllTheThings payload sets programmatically against your test target through the live proxy | Confirm each payload category triggers the expected `Detection.category`; separately replay a captured sample of real benign traffic and confirm it does **not** trigger false detections | Per-category recall (did we catch it) AND overall false-positive rate on benign replay — track both, not just recall, or you'll silently build a system that flags everything |
| **SSH** | Hydra/Medusa against your test SSH server with a known credential list; separately, script several genuine interactive logins | Confirm brute-force triggers `BEH-BRUTE-001` within the expected attempt count; confirm genuine logins never trigger it | False positive rate on the benign-login set specifically — this is the number that matters most for a feature your real users will hit constantly |
| **DNS** | dnscat2/iodine tunneling test, DGA domain list replay, legitimate zone-transfer request from an authorized test client | Confirm tunneling/DGA detection fires; confirm the legitimate AXFR (if you have one configured for testing) doesn't false-positive if it's from an authorized source | Recall on tunneling/DGA + explicit check that authorized DNS admin operations aren't blocked |
| **FTP** | Automated PASV-mismatch bounce attempt, anonymous login attempt, deliberate large-volume off-hours transfer | Confirm each triggers its respective rule | Recall per sub-category |
| **Telnet** | Cowrie-logged real-world Mirai-style attempts (reuse training data as held-out test set), plus your own manual default-credential attempts | Confirm detection; confirm a legitimate Telnet admin session (if you maintain one for testing) doesn't false-positive | Recall + benign false-positive check |
| **SMTP** | Send test spam/phishing content through your test mail server; send genuine test emails | Confirm classifier correctly separates them | Precision/recall on the held-out portion of your labeled email set — never test on emails used in training |
| **TLS** | Connect with each attack tool in your JA3 blocklist-building set; connect with a normal browser | Confirm blocklisted fingerprints are flagged; confirm normal browser traffic is never flagged | False-positive rate on real browser traffic — critical, since blocking real users' TLS handshakes is a severe usability failure |
| **Databases** | sqlmap/NoSQLMap against the proxied DB connection; normal application query traffic replay | Confirm detection fires on attack traffic; confirm zero false positives on your application's actual normal query patterns (capture these from your own app's real usage, not synthetic examples) | False-positive rate on real app queries — this is the one most likely to break your own application if miscalibrated, test it hardest |

**One testing principle to apply everywhere:** always test with **held-out data your model never saw during training**, generated in a *separate* run of the attack tools if possible (different payload subset, different session) — testing on the exact same captured session you trained on will always look better than the system actually performs in production.

---

## 15. Advanced architecture — pushing past current standard practice

Framed honestly: these are ambitious, technically sound directions that go beyond what's implemented in most open-source IDS/IPS tools today, not a claim that the result is unbeatable — no real system earns that claim. Treat this as your "if we had more time" / stretch-goals section for the report, clearly distinguished from what you're actually shipping.

### 15.1 Cross-protocol session-graph correlation engine
The single biggest thing your current per-protocol, per-flow architecture structurally can't do is **see an attack that spans protocols and time** — recon via DNS, initial access via HTTP, lateral movement via SSH, exfiltration via DNS tunneling, each individually low-signal, but the *sequence* from one source identity across all four is a textbook attack chain. Build a lightweight graph store (even a simple adjacency table in Redis/Postgres is enough to start) keyed by source identity (IP, or better, a stitched-together "actor" identity if you can correlate IP + session/credential), with edges for "touched this host via this protocol at this time." Run a periodic (not real-time-critical) graph query looking for multi-protocol, multi-host sequences matching known attack-chain shapes (recon → exploit → lateral move → exfil). This is genuinely close to what real enterprise XDR platforms are built around, and it's the most defensible "novel contribution" claim available to you if you build even a basic version of it.

### 15.2 Continuous adversarial self-testing ("detection regression as CI")
Wire Section 14's testing loop into your actual CI/CD pipeline (which you already have for the DevOps side) — every time a rule or model changes, automatically replay your full labeled attack/benign test suite and fail the build if recall drops or false-positive rate rises beyond a set threshold. This is a real, established practice (detection engineering teams at mature security orgs call this "detection-as-code" with regression testing) and it directly prevents the common failure mode where a rule change silently breaks detection for something else.

### 15.3 Explainable narrative layer (where the LLM discussion from earlier fits)
Once the session-graph engine (15.1) exists, feed a detected multi-stage attack chain into Qwen/Dolphin (already integrated in your DevOps agent) to generate a human-readable incident narrative for the analyst dashboard — *"Actor 41.x.x.x performed DNS reconnaissance against 3 internal hostnames, then attempted SQLi against /api/login (blocked), then successfully authenticated via SSH using credentials matching a known-leaked list, then initiated a DNS tunnel to exfiltrate data."* This is explanation of a real detected graph, not the LLM doing the detecting — consistent with the boundary established earlier.

### 15.4 Adaptive, self-calibrating thresholds
Rather than fixed thresholds (85/70, portScanThreshold=10, etc.) tuned once and left static, implement a lightweight online recalibration: periodically (e.g., weekly) recompute the precision-recall curve against the accumulated human-reviewed detections (from the review queue in the previous document) and auto-propose (not auto-apply — keep human sign-off) an updated threshold. This closes the loop between "we have a review queue" and "the system actually gets better calibrated over time" rather than the review queue just accumulating unused data.

### 15.5 Deception mesh, wired directly into enforcement
Extend the honeytoken endpoints from Section 11 into a small deception mesh — several decoy services (fake admin panel, fake DB port, fake internal API) that serve no real function and exist purely to be attacked. Any interaction with them is definitionally malicious (real users/traffic never touch them), making this your highest-confidence signal in the whole system, and it can trigger **immediate, high-confidence blocking** without waiting on ML scoring at all — a fast-path parallel to your existing Tier-2 Redis reputation gate.

### 15.6 Honest limitation to document
State plainly in your report: fully defeating a modern, professionally-built C2 framework (Cobalt Strike, Sliver) that deliberately mimics legitimate traffic patterns and uses domain-fronting/jitter/sleep-timing evasion is an open, actively-researched problem industry-wide — your beaconing detection and session-graph correlation raise the cost and reduce the window of an attacker using these tools, they don't guarantee detection. Claiming full coverage here would be the single most likely thing to undermine your credibility with a technically literate panel; claiming *meaningful, architecturally-grounded improvement* over baseline rule-only systems is both true and impressive on its own.
