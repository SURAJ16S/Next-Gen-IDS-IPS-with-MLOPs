# Processing & Machine Learning Module — Full Technical Documentation

## 0. Where this module sits in the overall system

```
Data Collection Engine (Tier 1: rules)  →  Processing & ML Module (Tier 2: reputation, Tier 3: ML)  →  Decision Engine  →  Enforcement
        [almost complete]                         [this document]                    [next]              [next]
```

This module takes the clean, joined record that Data Collection produces per connection and turns it into two things: an **IP reputation score** and an **ML-based risk score**. It does not block anything itself — it hands a number to the Decision Engine, which is a separate, later component.

---

## 1. Techniques and models used — and why each one

### 1.1 Isolation Forest — unsupervised anomaly detection

**What it is:** An ensemble of randomly-built decision trees. Each tree repeatedly picks a random feature and a random split value and cuts the data in half. Normal, "typical" traffic takes many random cuts before it ends up alone in its own tiny partition. Rare, unusual traffic — because it's already different from everything else — gets isolated in just a few cuts. The average number of cuts needed across all trees becomes the anomaly score: **short path = anomalous, long path = normal.**

**Why this one specifically:** It doesn't need labeled attack examples to train — it only needs a sample of "normal" traffic and learns what "normal" looks like for *your specific deployment*. This matters because a brand-new attack technique that's never been seen before (a zero-day) won't have a label anyone could have trained on, but it will still look statistically different from your baseline — and that's exactly what Isolation Forest is built to catch.

**What it's trained on:** A window of traffic captured while the system is running clean (no attacks), covering `FlowFeatureRecord` numeric features (below). Output: a continuous anomaly score, typically rescaled to 0–100.

### 1.2 Random Forest / Gradient-Boosted Trees (e.g. LightGBM or XGBoost) — supervised classification

**What it is:** Also an ensemble of decision trees, but this time each tree is trained on *labeled* examples ("this flow was SQLi", "this flow was clean", "this flow was a port scan") and learns which feature thresholds best separate the categories. Gradient boosting builds trees one after another, each new tree specifically correcting the mistakes of the trees before it.

**Why this one specifically:** Tree-based models handle a mix of numeric and categorical features well without needing heavy preprocessing, train fast on modest hardware (no GPU needed), and — critically for a security tool — give you **feature importance**: you can point to exactly which input (e.g. "payload entropy" or "IAT variance") drove a given classification. That's something you can put in a viva slide and defend; a neural network's internal weights are much harder to explain in the same way.

**What it's trained on:** Labeled `FlowFeatureRecord`s, where the label is the attack category (or "benign"). Output: a class prediction plus a confidence/probability score.

### 1.3 Why not deep learning (LSTM/CNN/Transformer-based IDS)

These exist in the research literature and can achieve strong results, but for this project specifically:
- They need far more labeled training data than a final-year timeline realistically allows to avoid overfitting.
- They're harder to explain (no clean feature-importance story) — a real weakness in a project whose synopsis explicitly promises "explainable, localized models" (Section 11.8 of your own doc).
- They cost more to train and serve, for a benefit that's not guaranteed to matter at your traffic volume.
Your synopsis already made the right call scoping this out (Section 11.3) — this document keeps that decision, it doesn't reopen it.

### 1.4 Why not an LLM (Qwen, Dolphin, etc.) for scoring

Already covered in earlier discussion, restated briefly for completeness: LLMs are too slow (100ms+ per call vs. the microseconds you need at proxy line rate), too expensive to run per-flow at volume, and not naturally suited to producing a stable, reproducible numeric score. Their correct role in this system is **explaining a decision after a classical model has made it** (turning "risk_score=87, top features: IAT_std=0.002, entropy=7.1" into a one-sentence analyst summary) — not making the decision itself.

### 1.5 The combined score — how the three techniques fit together

```
final_risk_score (0-100) =
      w1 × rule_weight          (from Data Collection's Tier-1 Detection.Weight field)
    + w2 × reputation_score     (IP reputation, from threat feeds + local detection history)
    + w3 × ml_anomaly_score     (Isolation Forest)
    + w4 × ml_classification_confidence   (Random Forest/GBT, only if it fired a non-benign class)
```
Start with equal-ish weights (e.g. 0.3/0.2/0.25/0.25), log every component alongside the final score, and treat weight tuning as a calibration exercise once you have real traffic — this is explicitly listed in the Decision Engine's job, not this module's.

---

## 2. Input data — what the model actually consumes

The model does not see raw packets. It sees the joined per-connection record from Data Collection, turned into a numeric feature vector:

| Feature group | Source field(s) | Type | Used by |
|---|---|---|---|
| Flow timing | IAT mean/std/max/min, active/idle time, packets-per-second | Numeric | Isolation Forest + RF/GBT |
| Byte/packet volume | bytes/packets each direction, avg packet size | Numeric | Both |
| TCP flag counts | SYN/ACK/FIN/RST counts | Numeric | Both |
| Payload statistics | entropy, char-class ratios, encoded-content flags, attack-keyword counts | Numeric | Both — **entropy and keyword counts are your strongest signal against obfuscated/unseen payloads** |
| Protocol identity | detected_service (HTTP/SSH/FTP/DNS/Telnet/SMTP/TLS/DB), proto_mismatch flag | Categorical (one-hot) | Both |
| TLS/SSH fingerprint | JA3 hash, cipher suite, Hassh (SSH) | Categorical / hashed-to-bucket | Both — catches attack tools lying about their identity |
| Tier-1 rule signal | detection category, severity, weight, count-in-this-flow | Numeric + categorical | RF/GBT mainly (this becomes your training *label* for supervised learning, and a live *feature* at inference time) |
| Behavioral flags | port_scan / brute_force / beaconing booleans | Boolean | Both |
| Reputation (added by this module, not Data Collection) | feed_score, local_hits, category_history | Numeric | Feeds the combined score directly, not the ML model itself |

---

## 3. Is the current data collection sufficient? Gap analysis

**What's already sufficient — genuinely strong, keep as is:**
- Flow timing statistics (IAT) — exactly the feature that separates bots from humans
- Payload entropy/char-ratio stats — your main defense against obfuscated/unseen attacks
- TLS/SSH fingerprinting — catches tools regardless of what they claim to be
- Tier-1 category+severity — gives you ready-made labels for supervised training

**What's missing and should be added, specifically for ML (not covered in the Data Collection doc, because these are ML-specific needs, not general collection gaps):**

1. **No cross-flow, per-IP historical features.** Right now every `FlowFeatureRecord` describes a single connection in isolation. ML models — especially for things like credential stuffing, slow scanning, or low-and-slow DDoS — benefit enormously from features like *"how many distinct ports has this IP touched in the last hour," "how many failed logins from this IP in the last 10 minutes," "how many total connections has this IP made today."* Your Behavioral Engine already tracks some of this internally for its own threshold rules, but it isn't exposed as a reusable feature for the ML model. **Action: build a small per-IP rolling feature store** (Redis is fine — you'll already have Redis for reputation) that both the Behavioral Engine and the ML feature pipeline read from, so this data is computed once and used twice.

2. **No labeled dataset — this is the single biggest actual gap.** You have no attack/benign labels sitting anywhere ready for training. This needs two parallel tracks (detailed in Section 6):
   - Public datasets, since your flow schema already matches the CICFlowMeter format
   - Self-generated labeled traffic, using real attack payloads against a deliberately vulnerable target

3. **No "normal traffic" baseline capture procedure.** Isolation Forest needs to learn what *your* deployment's normal traffic looks like — this is different for every deployment. You need a documented procedure: run the system in a monitored, attack-free environment for a defined period (e.g. a week of real or synthetic legitimate traffic) and capture that as the training baseline before going live.

4. **Full protocol parity.** If Telnet post-login behavior and the generic/unrecognized-protocol analyzer are still stubs (as flagged in the Data Collection audit), the ML model will have a blind spot for those protocols specifically — it can only learn from features that actually exist. Not a new gap, just worth restating here: finishing those two stubs directly improves ML coverage too, not just rule-based coverage.

---

## 4. Extra resources required: vulnerability data, cheat sheets, and payload libraries

You do need these, for two distinct reasons: (a) to **generate realistic labeled attack traffic** for training/testing, and (b) to **keep your Tier-1 rule signatures current** as new attack patterns emerge. Recommended, all free/open:

| Resource | What it is | How you use it |
|---|---|---|
| **OWASP Top 10 / OWASP API Security Top 10** | Canonical list of the most critical web/API vulnerability classes | Already referenced in your synopsis — use it as the checklist for which vulnerability classes your rule engine and ML labels must cover |
| **OWASP Cheat Sheet Series** | Detailed, per-vulnerability technical reference on attack patterns and defenses | Use when writing/reviewing detection rules — each cheat sheet lists real attack pattern variants you can turn into signatures |
| **PayloadsAllTheThings** (GitHub: swisskyrepo) | The most widely used open collection of real attack payloads — SQLi, XSS, SSRF, LFI/RFI, command injection, XXE, and more, organized by vulnerability class | Your primary source for generating labeled *attack* traffic — replay these payloads against a test target to produce your "malicious" training examples |
| **SecLists** (GitHub: danielmiessler) | Wordlists for fuzzing, common usernames/passwords, discovery paths | Use for generating realistic brute-force/credential-stuffing/directory-scanning training traffic |
| **Nuclei Templates** (GitHub: projectdiscovery) | YAML-based vulnerability detection templates | Your synopsis already claims "Nuclei-compatible YAML" rule templates — actually pulling from this repo, rather than writing YAML syntax from scratch, both saves time and gives you a real, industry-recognized rule source to cite |
| **MITRE ATT&CK Framework** | Standardized taxonomy of attacker tactics/techniques (e.g. T1110 = Brute Force, T1046 = Network Service Scanning) | Map every detection category to an ATT&CK technique ID. This is a small addition with a large credibility payoff — it's the industry-standard way SOC tools classify detections, and it gives your dashboard/report a recognizable structure instead of an invented taxonomy |
| **CVE / NVD feed** (nvd.nist.gov API) | Structured database of known vulnerabilities with severity scores (CVSS) | Less relevant to per-flow ML scoring, more relevant if you want to correlate a detected attack pattern with a specific known CVE for the dashboard's "what is this and how bad is it" explanation text |
| **Public labeled traffic datasets: CIC-IDS2017/2018, CIC-DDoS2019, UNSW-NB15** | Full labeled network traffic captures used across IDS research | Since your `FlowRecord` schema already matches CICFlowMeter's column layout, these can be used almost directly for pretraining/benchmarking — a genuine credibility boost for your report |
| **Threat intel feeds: AbuseIPDB, Spamhaus DROP, Emerging Threats, Tor exit list, GreyNoise** | Live lists of known-malicious IPs | Already scoped for the Reputation subsystem — not new, just listed here for completeness |

**One caution to build in from day one:** anything you pull from ExploitDB or run using PayloadsAllTheThings/SecLists must only ever be executed against your own isolated test targets (DVWA, Juice Shop, or your own dummy app) — never against anything outside your control. Document this explicitly in your report's ethics section; it's exactly the kind of thing a panel will ask about given the offensive tooling involved.

---

## 5. Vulnerabilities targeted, by protocol — current status and detection mechanism

| Protocol | Vulnerability / attack | Detected by (today) | ML's added value |
|---|---|---|---|
| **HTTP/HTTPS** | SQL injection | Tier-1 regex/keyword rules | Catches obfuscated/encoded variants via entropy + anomaly scoring |
| | XSS | Tier-1 rules | Same — catches novel encoding tricks |
| | Command injection / RCE | Tier-1 rules | Same |
| | Path traversal / LFI/RFI | Tier-1 URI normalization rules | Anomaly scoring on unusual URI structure |
| | SSRF, BOLA, BOPLA/mass assignment (OWASP API Top 10) | Tier-1 schema/parameter checks | ML flags parameter-tampering *patterns* rules didn't anticipate |
| | Malicious bot / scanner traffic (sqlmap, Nikto, python-requests) | User-Agent blacklist + JA3 fingerprint | ML can flag bots that spoof both UA and TLS fingerprint, based on timing alone |
| **SSH** | Brute-force / credential stuffing | Behavioral Engine threshold (5 failed attempts) | ML replaces the fixed "5 attempts" threshold with a learned pattern — catches slow, distributed brute-force that stays under the fixed threshold |
| **FTP** | Anonymous login abuse, data exfiltration volume spikes | Tier-1 login/volume rules | ML anomaly detection on volume-vs-baseline (e.g. "this account normally transfers 5MB/day, not 5GB at 3AM") |
| **DNS** | Tunneling, amplification | Tier-1 entropy-of-subdomain rule | ML refines the entropy threshold per-domain rather than one fixed cutoff |
| **Telnet** | Any external connection (obsolete protocol) | Tier-1: flagged automatically | Low ML value here — this one is correctly rule-only, don't force ML onto it |
| **TLS** | Weak cipher suites, known-bad JA3 fingerprints | Tier-1 rules | ML clusters fingerprints into "likely automated tool" buckets even for fingerprints not yet on a blocklist |
| **SMTP** | Open relay abuse | Tier-1 rules (assumed present, verify) | Lower priority for ML — rule-based is usually sufficient here |

**Read this table as:** rule-based detection (already mostly built) catches *known* attack patterns; ML's whole value-add is catching *variants of known patterns that were obfuscated or slowed down to avoid the fixed rule/threshold*, plus flagging genuinely novel patterns that don't match any rule at all. If your report needs one sentence to justify why you need both layers, that's it.

---

## 6. Training pipeline (offline)

```
┌─────────────────────┐     ┌──────────────────────┐     ┌───────────────────────┐
│ Public datasets      │     │ Self-generated attack │     │ Live benign baseline   │
│ (CIC-IDS2017/2018,    │     │ traffic (PayloadsAll- │     │ capture from your own  │
│ already schema-       │     │ TheThings + SecLists  │     │ deployment, attack-free│
│ compatible)           │     │ against DVWA/Juice     │     │ window                 │
│                       │     │ Shop, via your own     │     │                        │
│                       │     │ proxy)                │     │                        │
└──────────┬────────────┘     └──────────┬────────────┘     └──────────┬─────────────┘
           └──────────────────┬──────────┴──────────────┬─────────────┘
                              ▼                          ▼
                   ┌────────────────────┐      ┌───────────────────────┐
                   │  Labeled dataset    │      │  Benign-only dataset   │
                   │  (attack category)  │      │  (for anomaly training)│
                   └─────────┬────────────┘      └────────────┬───────────┘
                             ▼                                ▼
                  ┌────────────────────┐          ┌─────────────────────────┐
                  │ Random Forest/GBT   │          │  Isolation Forest        │
                  │ (supervised)        │          │  (unsupervised)          │
                  └─────────┬────────────┘          └────────────┬────────────┘
                             └───────────────┬────────────────────┘
                                             ▼
                                 Evaluate: precision/recall/F1
                                 per category, false-positive rate
                                 on held-out benign traffic
                                             ▼
                                 Log run to MLflow (metrics, params,
                                 model artifact) → model registry
```

---

## 7. Serving pipeline (real-time, online)

```
Completed connection record (from Data Collection)
              │
              ▼
   Feature vector construction
   (encode categoricals, assemble numeric array)
              │
              ▼
   FastAPI /score endpoint
   ┌─────────────────────────────┐
   │  Isolation Forest.score()    │──► anomaly_score
   │  RF/GBT.predict_proba()      │──► classification, confidence
   └─────────────────────────────┘
              │
              ▼
   Combine with rule weight + reputation score (Decision Engine, next module)
```
Call this endpoint with a strict timeout (e.g. 50ms) and fail open to a rule-only decision if it doesn't respond in time — an ML outage should never disable the whole system.

---

## 8. MLOps requirements — currently 0% built, needed for this to be "MLOps" and not just "ML"

- **Experiment tracking:** MLflow (or a lighter alternative) logging every training run's parameters, metrics, and artifact — this is what actually justifies "MLOps" in your project title
- **Model registry & versioning:** keep old model versions retrievable, with an explicit "current production model" pointer, so a bad retrain can be rolled back
- **Evaluation metrics to track every run:** precision/recall/F1 per attack category, overall false-positive rate against held-out benign traffic, AUC for the anomaly detector
- **Retraining loop:** scheduled (e.g. weekly) retraining using accumulated production detections, ideally with a human-review step in the dashboard where an analyst confirms/rejects borderline calls before they re-enter the training set
- **Drift monitoring:** periodically compare live traffic's feature distributions to the training baseline — if they've drifted significantly, that's a signal the model needs retraining sooner than scheduled

---

## 9. Next development plan — in order

1. **Per-IP rolling feature store** (Redis) — shared by Behavioral Engine and the future ML feature pipeline, so cross-flow context (recent port count, recent failed logins, recent connection count) is computed once
2. **Feature vector encoder** — the Python-side function that turns a `FlowFeatureRecord` JSON object into the numeric array the models need (categorical encoding, scaling, missing-value handling)
3. **Dataset assembly** — pull CIC-IDS2017/2018; generate self-labeled attack traffic using PayloadsAllTheThings + SecLists against DVWA/Juice Shop through your own proxy; capture a clean baseline window from your own deployment
4. **Train and evaluate** Isolation Forest + Random Forest/GBT; log to MLflow; document metrics per attack category for your report
5. **Build the FastAPI `/score` service**, wired with a timeout + fail-open behavior
6. **Wire the Go agent** to call `/score` per completed connection and populate the currently-empty `MLResult` collection
7. **Map every detection category to a MITRE ATT&CK technique ID** — small effort, adds real credibility to the dashboard and report
8. **Add the retraining loop + drift check**, closing the MLOps loop
9. Only after 1–8: hand off risk_score + reputation_score to the Decision Engine (separate module, separate document) for the actual allow/alert/block/tarpit decision

Want me to start with the feature vector encoder and the Isolation Forest + Random Forest training script as actual runnable code next, since that's step 2–4 above and the first thing that produces a real, testable model?
