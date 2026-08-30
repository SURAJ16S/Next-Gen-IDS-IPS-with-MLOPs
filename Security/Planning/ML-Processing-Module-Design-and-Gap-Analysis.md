# Processing / ML Module — Detailed Design, Data Gap Analysis & Development Plan

**Project:** Next-Gen Multi-Protocol IDS/IPS with WAF and Autonomous DevOps Orchestration
**Scope of this document:** Everything downstream of data collection — Tier 2 (Threat Intel) and Tier 3 (ML Anomaly Engine) from your own architecture diagram, plus what the data collection layer is and isn't giving you.
**Grounded in:** `Security/` Go source (analyzers, flow tracker, logger), `Docs/Security-Workflow.md`, and the synopsis/PPT you submitted.

---

## 1. Where the project actually stands right now

I read through your `Security/detect/` package rather than just the docs, and here's the honest state: **the data collection layer is genuinely strong — CICFlowMeter-grade — but the "ML/AI module" described in your synopsis (Isolation Forest, Gradient-Boosted Trees, HASSH-based SSH bot detection, IP reputation via collaborative filtering) does not exist in code yet.** There is no Python service, no `requirements.txt`, no training script, no model file anywhere in the repo. What exists is:

- **Tier 1 (Rule Engine)** — fully implemented, in Go, per protocol (regex/signature matching).
- **Tier 2 (Threat Intelligence)** — designed (Redis-backed IP reputation lookup) but not implemented — no Redis client, no reputation store, no external feed ingestion found in the codebase.
- **Tier 3 (ML Anomaly Engine)** — not implemented. No FastAPI service, no `.pkl`/`.onnx` model, no scikit-learn/XGBoost dependency anywhere.

This isn't a criticism — it means your data collection module (which you say is "almost complete") is precisely the right thing to have finished first, because Tier 3 is entirely dependent on it. The rest of this document tells you exactly what to build on top of it.

---

## 2. What your data collection module already gives you (feature inventory)

### 2.1 Three parallel data streams

| Stream | Source | File | Granularity |
|---|---|---|---|
| **L3/L4 packet stream** | eBPF (`monitor.c`, TC ingress/egress hooks) | `output.txt` | Per-packet |
| **L4 flow statistics** | `FlowTracker` (`flow_tracker.go`) — CICFlowMeter-compatible | `logs/flow_stats.jsonl` | Per-flow (aggregated on flow close) |
| **L7 protocol + detection events** | Per-protocol analyzers in `detect/` | `logs/detections.jsonl`, `logs/connections.jsonl`, `logs/protocols/<proto>.jsonl` | Per-request / per-connection |

### 2.2 L4 flow features (`FlowRecord`, `flow_tracker.go`)

This is your strongest asset for ML — it already mirrors the CIC-IDS2017/2018 feature schema, which means public labeled datasets are a near-perfect training-data drop-in later (see §6). Fields already computed per flow:

- **Volume:** `total_fwd_packets`, `total_bwd_packets`, `total_fwd_bytes`, `total_bwd_bytes`
- **Packet size stats (fwd/bwd):** max, min, mean, std
- **TCP flag tallies:** SYN, ACK, FIN, RST, PSH, URG counts
- **Rate:** `flow_pkts_per_sec`, `flow_bytes_per_sec`
- **Inter-arrival time (IAT), forward and backward:** mean, std, max, min — this is exactly the feature your synopsis says will catch SSH brute-force timing signatures ("humans type with variable timing; scripts send at mathematically perfect intervals")
- **Active/idle time distributions:** mean, std, max, min

This is a 35+ dimension numeric vector per flow, ready for an unsupervised model with almost no additional engineering.

### 2.3 L7 payload features (`PayloadStats`, `payload_stats.go`)

Computed per HTTP payload (URI, body, header) — this is your **statistical/anomaly feature set for Tier 3**, explicitly built for ML ("what ML anomaly models need to detect zero-day attacks that bypass signature-based detectors", per the file's own header comment):

- Shannon entropy (obfuscation indicator)
- Character-class ratios: digit, upper, lower, special, whitespace, non-printable
- Encoding indicator counts: base64-like substrings, hex sequences, unicode escapes
- **Graded (not binary) attack-pattern counts:** SQL keyword count, XSS pattern count, path-traversal count, command-injection count, HTML tag count, JS pattern count
- Token statistics: count, average length, max length

This is a genuinely good feature vector — the "graded counts" design (counts, not booleans) is specifically what lets a downstream classifier learn severity rather than just triggering on presence, which is more useful than your Tier-1 regex alone.

### 2.4 Detection events (`Detection`, `detection.go`)

Every rule hit becomes a structured event: `severity` (5-level), `category` (49 category constants across web/network/TLS/DNS/SSH/email/FTP/Telnet/DB), `protocol`, `source_ip`, `source_port`, `dest_port`, `summary`, `details` (free-form map), `raw_evidence` (truncated offending bytes), `conn_id`.

### 2.5 Connection-level records (`ConnectionRecord`)

Per closed connection: client IP/port, listen port, backend, detected protocol vs. expected service (protocol-mismatch flag — useful for tunneling/C2 detection), duration, bytes in/out, detection count, max severity, close reason.

### 2.6 Protocol-specific deep features already extracted

| Protocol | File | What's extracted today (rule-based, working) |
|---|---|---|
| HTTP/HTTPS | `http_analyzer.go` (804 lines) | 40+ signature checks (SQLi, XSS, path traversal, cmd-injection, SSRF, XXE, Log4Shell, HTTP smuggling, CRLF injection, open redirect); **response-side** inspection too — info leakage (stack traces), missing security headers, credential leaks in response body |
| TLS | `tls_inspect.go` (682 lines) | ClientHello parsing, **JA3** fingerprinting, cipher suite/weak-cipher detection, cert inspection (self-signed, expired) — note: JA4 is mentioned in your synopsis/PPT as the fingerprinting method, but only **JA3** is implemented |
| SSH | `ssh_analyzer.go` (1025 lines) | 6-state protocol state machine, KEX/cipher/MAC extraction (HASSH-style fingerprint), stream reassembly |
| DNS | `dns_analyzer.go` (578 lines) | Query entropy calc, tunneling/DGA/rebinding/zone-transfer/NXDOMAIN-flood signatures |
| FTP | `ftp_analyzer.go` (788 lines) | Full state machine (RFC 959/2228/2428/5797), anonymous login, bounce, brute-force |
| Telnet | `telnet_analyzer.go` (1133 lines) | Two-level state (per-connection + per-source-IP), IoT default-credential checks, password-spray detection (same password fingerprint → multiple usernames) |
| SMTP | `smtp_analyzer.go` (300 lines) | Open relay, brute-force auth, spam/phishing indicators |
| DB (MySQL/PostgreSQL/Redis/MongoDB) | `db_analyzer.go` (515 lines) | Auth tracking, dangerous-command detection, SQLi-in-query, unauthenticated access |
| Generic (RDP/VNC/LDAP/IMAP/POP3/SOCKS/NTP/SNMP) | `generic_analyzer.go` (484 lines) | Catch-all signature scanning |
| Cross-protocol behavioral | `behavioral.go` (338 lines) | Port scan, brute-force rate, beaconing/C2, exfiltration volume, time anomalies — per-source-IP tracker |

**Bottom line: your data collection module is not just "traffic logging" — it is already doing real feature engineering.** The gap is entirely on the modeling/serving side.

---

## 3. What doesn't make sense yet / is missing (honest gap list)

Going protocol-by-protocol and claim-by-claim against what's actually collected:

1. **No labels exist anywhere.** Every log line is unlabeled real/rule-triggered traffic. You cannot train a *supervised* classifier (your synopsis names Random Forest / Gradient-Boosted Trees for "Traffic Classification") until you generate or source labeled attack traffic. This is the single biggest blocker — see §6.2 and §8 Phase A.
2. **JA4 is promised, JA3 is built.** Your PPT's defense matrix explicitly calls out "JA4 TLS Fingerprinting." The code has JA3 only. JA4 is a meaningfully different (and now more widely adopted) fingerprint algorithm — decide whether to implement JA4 in Go or drop it from the claimed feature list, don't leave it as a documentation-only feature.
3. **IP reputation "engine" (collaborative filtering) is not implemented.** `BehavioralEngine` tracks per-IP counters in memory (`ipTracker`) but there is no persistent store, no decay function, no external feed ingestion, and nothing resembling collaborative filtering. Your ML/AI Integration slide names this explicitly — right now it's a diagram, not code.
4. **Device/MAC-based fingerprinting**, mentioned in your synopsis ("IP/Device ID/MAC-based Blocking"), is **not technically obtainable** for traffic arriving over the internet through a reverse proxy — MAC addresses don't survive past the first router hop. This claim should either be dropped from scope or explicitly redefined as *device/client fingerprinting via TLS+HTTP header combination* (which is realistic and something JA3/JA4 + User-Agent + header-order already gets you close to).
5. **Session-level sequence features are shallow.** `SessionTracker` currently stores only `RequestCount` and a set of unique URIs per session. For anomaly detection on session behavior (e.g., BOLA-style ID enumeration, scraping, credential-stuffing sequences) you need a request *sequence* feature (URI n-grams, timing between requests within a session, parameter-value diversity) — not currently captured.
6. **No feature-vector persistence/store.** JSONL logs are great for audit trails but not for training — there's no columnar/parquet export, no feature store, no train/test split mechanism.
7. **Some collected fields will be low-signal on their own** and should be treated as *context*, not standalone ML inputs: e.g., `non_printable_ratio` is meaningless for DB protocol traffic (binary by nature) — feed it only for HTTP/text protocols, not blindly to a shared model. Don't build one universal model across protocols; build **per-protocol models** as your architecture diagram (Tier 3, "protocol-specific") already implies.
8. **Vulnerability database referenced in the architecture ("Predefined Vulnerability DB", "ThreatView integration") has no concrete source picked.** This needs to be a real, versioned dataset (see §6.1) — not a to-be-determined component.

---

## 4. Proposed Processing / ML Module — full design

### 4.1 Principle: keep Tier 1/2 fast-path in Go, put Tier 3 in Python, connect via a scoring API

This matches what you already have in `Docs/Security-Workflow.md` and in the "Recommended Technology Stack" advice in your synopsis: **don't put ML inside the packet interceptor.** Concretely:

```
Go Proxy (Tier 1 + Tier 2, in-process, µs latency)
        │  (payload passed Tier 1 + Tier 2)
        ▼
FastAPI Scoring Service (Tier 3, Python) — one endpoint per protocol model
        │  returns { risk_score: 0-100, model_version, contributing_features }
        ▼
Cross-Layer Decision Engine (Go) — combines Tier1/2/3 → Allow / Alert / Auto-Block / Tarpit
```

The Go side already emits everything the Python side needs as JSON (`Detection`, `FlowRecord`, `PayloadStats` fields) — no format translation work needed, just an HTTP client in Go and a FastAPI server in Python.

### 4.2 Model inventory — what to actually build, mapped to your existing data

| # | Model | Task type | Technique | Input (already-collected fields) | Detects | Protocol scope |
|---|---|---|---|---|---|---|
| 1 | **HTTP Payload Anomaly Scorer** | Unsupervised | Isolation Forest (or One-Class SVM) | `PayloadStats` vector (16 dims: entropy, ratios, encoding counts, pattern counts, token stats) | Zero-day / obfuscated web payloads that bypass Tier-1 regex | HTTP/HTTPS |
| 2 | **Web Attack Classifier** | Supervised, multiclass | Gradient-Boosted Trees (XGBoost / LightGBM) | Same `PayloadStats` vector + URI length, header count, method | SQLi / XSS / cmd-injection / path-traversal / SSRF, with confidence score (not just yes/no) | HTTP/HTTPS |
| 3 | **Flow-level Network Anomaly Detector** | Unsupervised | Isolation Forest or Autoencoder | `FlowRecord` (35+ CICFlowMeter fields) | Port scanning, DDoS/slowloris shape, data-exfil volume anomalies, beaconing intervals | All (protocol-agnostic, L4) |
| 4 | **SSH Brute-force / Bot Classifier** | Supervised (binary) | Logistic Regression or small Random Forest | `fwd_iat_mean/std`, `bwd_iat_*`, HASSH/KEX fingerprint (categorical, one-hot), auth-failure rate from `BehavioralEngine` | Automated brute-force vs. a human with a flaky connection | SSH |
| 5 | **DNS Tunneling / DGA Detector** | Supervised or hybrid | Random Forest on entropy + n-gram + statistical features (or a small char-CNN if you want to go deeper) | Query domain entropy (already computed), label count, query rate, `ANY`-query ratio | DNS tunneling, DGA domains, amplification recon | DNS |
| 6 | **IP Reputation Score** | Rule + statistics (not deep learning — don't over-engineer this one) | Weighted exponential-decay scoring, *not* true collaborative filtering (that term in your slide is aspirational; a decayed weighted sum is what's actually buildable and defensible in a viva) | `BehavioralEngine` per-IP counters + external threat feed hits (§6.3) + historical `Detection` counts by that IP | Persistent bad actors across sessions/time | Cross-protocol |
| 7 | **TLS Fingerprint Bot Matcher** | Lookup / similarity, not ML | JA3 hash → known-bad list match (Abuse.ch feed); add JA4 computation if implementing | JA3 hash (already computed) | Known scanner/bot TLS stacks (sqlmap, curl, python-requests default TLS configs, etc.) | HTTPS |

**Why traditional ML, not deep learning:** your own synopsis (§11.3) already made the right call — "efficient traditional machine learning models rather than complex deep learning architectures" — this is correct for a final-year project: faster to train on modest hardware, explainable (important for a viva/demo where you need to explain *why* something was flagged), and matches the CICFlowMeter-style tabular data you're already producing. Stick with that decision; don't be tempted into LSTMs/transformers for this dataset size.

### 4.3 Model serving contract (concrete, so Go↔Python integration isn't hand-wavy)

Single FastAPI service, one route per model family:

```
POST /score/http-payload
POST /score/flow
POST /score/ssh
POST /score/dns
GET  /reputation/{ip}
```

Response shape, consistent across all routes so the Go `Detection.Details` map can absorb it directly:

```json
{
  "risk_score": 0-100,
  "predicted_category": "sqli" | "benign" | "anomaly" | ...,
  "confidence": 0.0-1.0,
  "model_version": "webattack-clf-v1.2",
  "contributing_features": {"sql_keyword_count": 3, "entropy": 4.8}
}
```

`contributing_features` matters for your "Academic Contribution" goal (benchmarking rule-based vs. ML accuracy) and for explainability during evaluation/demo.

### 4.4 Training/retraining loop (MLOps, since that's literally your project's domain tag)

1. **Offline, scheduled batch retraining** (your synopsis §11.7 already specifies this — don't build online/continuous learning, it's unnecessary complexity and a false-positive risk for a project this size).
2. Export JSONL logs → labeled feature tables (Parquet/CSV) on a schedule.
3. Train → validate against a held-out set → compare metrics to currently-deployed model version.
4. Only promote a new model if it beats the current one on precision/recall for the minority (attack) classes specifically — accuracy alone is meaningless on imbalanced traffic.
5. Version models (`model_version` field above) so the dashboard can show which model flagged what, and so a regression is traceable.
6. Feed dashboard analyst overrides (when a human marks a Tier-3 flag as false positive) back into the next training batch as corrected labels — this is your actual "continuous learning feedback loop" from the architecture diagram, and it's realistic to build (unlike full online learning).

---

## 5. Is the currently collected data enough? — direct answer per model

| Model | Feature data available today? | What's still missing |
|---|---|---|
| HTTP anomaly scorer (unsupervised) | **Yes, fully sufficient.** `PayloadStats` is a complete, well-formed feature vector already. | Nothing structural — just needs volume of real/varied traffic to fit the Isolation Forest baseline. |
| Web attack classifier (supervised) | **No — missing labels.** Features exist; ground-truth labels don't. | Labeled attack traffic (§6.2) |
| Flow anomaly detector | **Yes, fully sufficient**, arguably your best-prepared model. | Nothing — `FlowRecord` schema already matches CIC-IDS2017/2018 |
| SSH brute-force classifier | **Mostly yes.** IAT stats and behavioral counters exist. | Need labeled "known automated" vs "known human" SSH sessions for supervised version; can start unsupervised (IAT variance thresholding) with zero new data |
| DNS tunneling/DGA | **Yes for entropy-based unsupervised**, no for supervised DGA family classification | DGA-labeled domain lists (public, see §6.1) if you want family-level classification, not just anomaly flagging |
| IP reputation | **Partially.** In-memory counters exist; nothing persists across restarts, nothing external is merged in. | Persistent store (Redis/Postgres) + external feed ingestion job (§6.3) |
| TLS fingerprint bot matcher | **Partially.** JA3 exists; matching list doesn't. | Known-bad JA3 hash feed (§6.3); JA4 implementation if you want to match your own slide's claim |

---

## 6. External resources you still need to acquire

### 6.1 Public labeled network datasets (train the flow-level and general IDS models)

- **CIC-IDS2017 / CIC-IDS2018** (Canadian Institute for Cybersecurity) — highest priority; your `FlowRecord` schema was explicitly modeled to match it (per the file's own comment), so this is close to a direct fit. Covers brute-force, DoS/DDoS, infiltration, botnet, port scan, web attacks.
- **CSIC 2010 HTTP dataset** — labeled normal/anomalous HTTP requests, good for bootstrapping the web attack classifier before you have your own labeled traffic.
- **UNSW-NB15** — modern attack categories (fuzzers, backdoors, exploits, reconnaissance, shellcode), useful as a secondary flow-level dataset.
- **DGA domain lists** (e.g., Bambenek Consulting DGA feed, Netlab 360 DGA feed) — only needed if you commit to DGA-family classification rather than pure entropy-based anomaly flagging.

### 6.2 Self-generated labeled attack traffic (fills the gap datasets can't — your own protocol quirks)

Your synopsis (§11.7) already names this correctly. Concretely, run against a sandboxed target (DVWA, OWASP Juice Shop, bWAPP — spin these up in isolated containers, never against anything real):

- **sqlmap** — SQLi payload generation across all its tamper/encoding scripts (gives you the obfuscated/encoded payloads your entropy features are specifically designed to catch)
- **Nikto** — web scanner traffic, populates your `bot-scanner` / User-Agent detection training set
- **OWASP ZAP / wfuzz / dirb** — XSS, fuzzing, directory brute-force traffic
- **Hydra / Medusa** — SSH/FTP/Telnet brute-force traffic, directly feeds the IAT-based SSH classifier and the FTP/Telnet brute-force detectors
- **dnschef / iodine** — DNS tunneling traffic generation for the DNS model

This is the only realistic way to get *labeled positive examples* matched to your exact detection categories — public datasets won't cover your specific 49 category taxonomy.

### 6.3 Threat intelligence feeds (for Tier 2 and the IP reputation model)

- **AbuseIPDB**, **Spamhaus DROP/EDROP**, **FireHOL IP lists**, **CINS Army list**, **GreyNoise Community API** — free/community tiers exist for all of these, sufficient for a final-year project
- **Abuse.ch JA3 fingerprint feed** — known-malicious TLS client fingerprints, directly usable by Model #7 above
- **Tor exit node list** — cheap, useful reputation signal
- **MaxMind GeoLite2** — free GeoIP database, gives you geographic features for the reputation model and for the "geographic distribution" dashboard feature already in your UI mockups

### 6.4 Payload/signature reference libraries (to strengthen Tier 1 regex *and* to bootstrap weak labels for Tier 3)

- **PayloadsAllTheThings** (GitHub) and **SecLists** — comprehensive payload libraries across every category you already track (SQLi, XSS, SSRF, XXE, command injection, path traversal)
- **OWASP Core Rule Set (CRS)** — mature, production regex rule set; useful both as a Tier-1 upgrade reference and as a weak-labeling function (i.e., "if CRS would have flagged this, weak-label it as attack" — a standard technique for bootstrapping supervised training data before you have enough hand-labeled traffic)
- **Nuclei templates** (already referenced in your architecture as your YAML rule format) — good source of additional signature coverage per CVE
- **NVD/CVE feed** — needed for the "Vulnerability Advisor" (RAG + CVE database) box on your ML/AI Integration slide; this is a separate, simpler component (retrieval, not a trained model) — an NVD API pull + a vector store (e.g., a local FAISS index) is enough, no custom model training required here.

---

## 7. Protocol-by-protocol vulnerability coverage — current status

| Protocol | Vulnerabilities targeted (per your synopsis/PPT) | Currently implemented (Tier 1, Go, working today) | Still needed for full ML coverage |
|---|---|---|---|
| **HTTP/HTTPS** | SQLi, XSS, cmd-injection/RCE, path traversal/LFI/RFI, SSRF, XXE, Log4Shell, HTTP smuggling, CRLF injection, open redirect, file upload, bot/scanner traffic, credential leak, missing headers, info leakage, OWASP API Top 10 (BOLA, BOPLA, resource abuse, JWT flaws) | Signature detection for the first 17 categories is live (`http_analyzer.go`); response-side DLP (info leakage, missing headers) is live | Models #1 and #2 above; **BOLA/BOPLA/JWT/API-specific checks are not yet in the analyzer** — these need either new Go rules (parameter-ID sequential-change tracking, JWT structural validation) or a dedicated API-analyzer module before ML can score them |
| **SSH** | Brute-force, weak algorithms, tunneling, banner scanning, malformed protocol | All live (`ssh_analyzer.go`), state-machine based | Model #4; HASSH-to-known-tool-fingerprint mapping (a small static lookup, not ML) |
| **DNS** | Tunneling, DGA, rebinding, zone transfer, NXDOMAIN flood, amplification (`ANY` query blocking) | All live (`dns_analyzer.go`) | Model #5 for DGA family classification specifically; entropy-based tunneling detection can already run unsupervised today with zero new data |
| **FTP** | Anonymous login, bounce attacks, data-channel abuse, brute-force, exfil volume anomaly | All live (`ftp_analyzer.go`, RFC-compliant state machine) | Exfil-volume anomaly is a natural fit for Model #3 (flow-level) rather than a new FTP-specific model |
| **Telnet** | IoT default creds, reconnaissance, credential stuffing, password spray | All live (`telnet_analyzer.go`) — this is your most mature analyzer (1133 lines, two-level state tracking) | Nothing ML-specific needed beyond Model #3; the existing password-spray/cred-stuffing logic is already behaviorally sound |
| **SMTP** | Open relay, spam, phishing | All live (`smtp_analyzer.go`) | Phishing/spam classification could use a simple Naive Bayes/text classifier later, but this is lower priority than the web/flow models |
| **DB (MySQL/PgSQL/Redis/MongoDB)** | Dangerous commands, SQLi-in-query, unauthenticated access | All live (`db_analyzer.go`) | Nothing ML-specific — this protocol is inherently structured enough that rule-based coverage is sufficient; don't spend model-building time here |
| **TLS** | Weak cipher, downgrade, SNI mismatch, expired/self-signed cert, bot fingerprinting | Cipher/cert checks live; **JA3 live, JA4 not implemented** | Model #7; decide on JA4 (§3.2) |
| **Generic (RDP/VNC/LDAP/IMAP/POP3/SOCKS/NTP/SNMP)** | Fallback signature scanning | Live (`generic_analyzer.go`) | Out of scope for dedicated ML models given the project timeline — leave as rule-based, this is the right call |
| **Cross-protocol behavioral** | Port scan, brute-force rate, beaconing/C2, exfiltration, protocol mismatch | Live (`behavioral.go`) | This *is* the natural home for Model #3 (flow anomaly) and Model #6 (reputation) — no new collection needed, just modeling on top of what's tracked |

**Net assessment: rule-based (Tier 1) coverage across all seven protocols is genuinely thorough and matches or exceeds what you promised in the synopsis, except for the API-specific OWASP Top 10 items (BOLA/BOPLA/SSRF-via-API/JWT) under HTTP, which need new detection logic before they can be scored at all.** Everything else is ready for Tier 3 to be layered on top without touching the Go collection code.

---

## 8. Next development plan (phased, in build order)

### Phase A — Labeling & data pipeline (2–3 weeks)
1. Stand up an isolated sandbox (DVWA / Juice Shop / bWAPP containers) behind your existing reverse proxy.
2. Run the attack-generation tools from §6.2 against it, capturing labeled JSONL logs alongside organic/benign traffic.
3. Write an export script: JSONL logs → Parquet feature tables (one per model, per §4.2's input columns), with train/validation/test splits.
4. Download and reshape CIC-IDS2017/2018 and CSIC-2010 into the same schema, to supplement your still-small self-generated dataset.

### Phase B — Baseline models (2 weeks)
1. Train Model #1 (HTTP payload Isolation Forest) and Model #3 (flow-level Isolation Forest) first — both are unsupervised, need no labels, and can run on organic traffic you're already collecting.
2. Train Model #2 (web attack classifier) on the Phase A labeled set; evaluate precision/recall per attack class (not just overall accuracy — your classes are imbalanced).
3. Benchmark ML vs. Tier-1-only detection on a held-out attack set — this is your "Benchmark: Rule-based vs. ML detection accuracy" academic contribution goal, so build the comparison harness now, not at the end.

### Phase C — Serving integration (1–2 weeks)
1. Build the FastAPI scoring service with the routes in §4.3.
2. Add an HTTP client call from the Go proxy after Tier 1/2 pass, feeding results into `Detection.Details`.
3. Wire the combined score into the Cross-Layer Decision Engine's Allow/Alert/Auto-Block/Tarpit logic (currently only Tier 1/2 can trigger this).

### Phase D — IP reputation & threat intel (1–2 weeks)
1. Add persistent storage (Redis is the right choice — matches your architecture doc) for per-IP scores with time-decay.
2. Build a scheduled job to ingest the feeds in §6.3.
3. Implement the weighted-scoring function (Model #6) — keep it simple and explainable, not a black box, since you'll need to defend it academically.

### Phase E — Protocol-specific models (2–3 weeks, parallelizable across team members)
1. SSH brute-force classifier (Model #4) — smallest, good first protocol-specific model.
2. DNS tunneling/DGA (Model #5).
3. TLS fingerprint matching (Model #7) — mostly a data-engineering task (feed ingestion + lookup), not real ML.

### Phase F — Retraining loop & dashboard feedback (1–2 weeks)
1. Scheduled batch retraining job (per §4.4).
2. Dashboard "mark as false positive" action → feeds back into next training batch.
3. Model versioning + simple A/B comparison before promoting a new model version.

### Immediately out of scope (don't build, note as future work in your report)
- Online/continuous learning — unnecessary risk for a project this size, and your own synopsis already rules it out.
- Deep learning (LSTM/transformer/CNN) — the tabular, moderate-volume nature of your data doesn't need it, and traditional ML is more defensible in a viva.
- True MAC-address-based device fingerprinting — not obtainable through a reverse proxy; reframe as TLS+header-based client fingerprinting instead.
- "Collaborative filtering" IP reputation exactly as named on your slide — build the defensible weighted-decay version instead and describe it accurately in your report.

---

## 9. Priority summary (if you can only do a subset before submission)

1. **Model #1 + Model #3 (both unsupervised, zero labeling required)** — fastest path to a working, demoable ML component using data you already have today.
2. **Phase A labeling pipeline + Model #2** — this is what lets you claim a real "rule-based vs. ML" benchmark, which is your strongest academic-contribution point.
3. **FastAPI scoring service + Go integration (Phase C)** — without this, the models are notebooks, not a product; this is what makes the architecture diagram real.
4. Everything else (reputation engine, protocol-specific models, retraining loop) is genuine value-add but can be scoped down or left as "future work" in your report without weakening the core deliverable.
