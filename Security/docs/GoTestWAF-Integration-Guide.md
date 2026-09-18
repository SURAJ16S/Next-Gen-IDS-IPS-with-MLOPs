# GoTestWAF Integration Guide

**Status:** Planned — not yet implemented
**Relevant phase:** After `train_models.py web-classifier` produces a trained model
**Source:** [github.com/wallarm/gotestwaf](https://github.com/wallarm/gotestwaf)

---

## What GoTestWAF Is

GoTestWAF (by Wallarm) sends a large pre-built library of attack payloads at a WAF
or IDS/IPS proxy, then scores how many were blocked vs. bypassed. It also sends
benign traffic to measure false-positive rate. Think of it as a standardised mock
exam for the detection engine — the same tool Wallarm uses to benchmark ModSecurity,
AWS WAF, and Cloudflare, so our results are directly comparable.

**Three ingredients combine to generate requests:**

| Ingredient | Example |
|---|---|
| Payload | `' or 1=1--` |
| Encoder | URL-encoding, Base64, JS Unicode escape |
| Placeholder | URL parameter, JSON body, form field, header |

All combinations are sent. Each response is classified as `Blocked`, `Bypassed`,
or `Unresolved`. The final report is a `%blocked` score per attack category plus
an overall score (PDF / HTML / JSON).

---

## How It Fits Into This Project

Our project has a specific, already-implemented ML and proxy pipeline. GoTestWAF's
role must be understood relative to the existing code — not generically.

### 1. Training Data Gap for `train_models.py web-classifier`

[`train_models.py`](file:///home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security/ML/train_models.py)
expects a labeled JSONL file where every row has a `"label"` field
(`"benign"`, `"sqli"`, `"xss"`, `"path_traversal"`, `"cmd_injection"`, etc.).

The current plan uses CSIC-2010 + self-generated tool traffic (sqlmap, Commix, ZAP).
The problem: **static datasets don't cover all 8 ML-L7 classes**, and tool-generated
traffic risks ML overfitting to the tool's own behaviour rather than the attack
structure itself.

GoTestWAF's `testcases/*.yaml` files are pre-labeled with an attack `type` field
(e.g. `"SQL Injection"`, `"XSS"`, `"SSTI"`) and cover **multiple encodings and
placements of each payload** — exactly what prevents tool-overfitting. The YAML
payloads can be used to **reconstruct HTTP requests** and pass them through the
existing [`ComputePayloadStats()`](file:///home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security/detect/payload_stats.go)
feature extractor to produce rows compatible with
[`HTTP_FEATURE_COLUMNS`](file:///home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security/ML/feature_encoder.py#L34).

**ML-L7 classes and GoTestWAF coverage:**

| ML-L7 class | GoTestWAF bundled | Notes |
|---|---|---|
| `sqli` | ✅ Yes | `SQL Injection` type, multiple encoders/placeholders |
| `xss` | ✅ Yes | `XSS` type |
| `cmd_injection` | ✅ Yes | `RCE` type |
| `path_traversal` | ✅ Yes | `Path Traversal` type |
| `ssti` | ✅ Yes | `SSTI` type |
| `nosqli` | ✅ Yes | `NoSQL Injection` type |
| `lfi` | ❌ Not bundled | Use PayloadsAllTheThings (already in `download_all.sh`) |
| `api_resource_abuse` | ⚠ Partial | GoTestWAF has REST/API tests, but rate-abuse patterns need custom YAMLs |

GoTestWAF payloads for **rule-only categories** (Log4Shell, XXE, LDAP, CRLF) are
also valuable — they can be replayed against the Tier-1 rule layer in Workflow B
to confirm those specific regexes in
[`http_analyzer.go`](file:///home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security/detect/http_analyzer.go)
fire correctly.

---

### 2. Benchmarking the Proxy — `POST /score/http-payload`

Our IDS proxy listens on the ports defined in
[`proxy_config.yaml`](file:///home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security/proxy_config.yaml)
— HTTP on **port 80** (→ backend 8080) and **port 8080** (→ backend 9090).

Once running, GoTestWAF can be pointed at `http://localhost:80` or
`http://localhost:8080`. The proxy will pass each request through:

```
GoTestWAF request
    → proxy listener (port 80/8080)
    → http_analyzer.go  ← Tier-1 rule check
    → ml_client.go      ← POST /score/http-payload  (50ms timeout, fail-open)
        → scoring_service.py
            → http_anomaly IsolationForest (Model #1)
            + web_classifier RandomForest  (Model #2) → predicted_category
    → if risk_score > threshold → 403 Forbidden  ← GoTestWAF sees "Blocked"
    → else → forward to backend               ← GoTestWAF sees "Bypassed"
```

The `403` our proxy returns maps directly to GoTestWAF's `--blockStatusCodes=403`
flag, so no custom configuration is needed.

**What the report gives us:**
- Detection rate per attack category (directly usable in the evaluation chapter)
- Per-layer breakdown: if a class is caught only at Tier-1 but not Tier-3, the
  ML model needs more training data for that class
- Comparable baseline: same tool + scoring method as commercial WAF benchmarks

---

### 3. False-Positive Rate — Required for Evaluation Chapter

The same scan produces a **Positive Tests** section showing what percentage of
benign requests our system wrongly blocked. This number is **required** alongside
the detection rate in the evaluation chapter — a 90% detection rate with a 30%
FP rate is not a good result.

[`generate_baseline.py`](file:///home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security/ML/generate_baseline.py)
currently generates synthetic baseline traffic for training, but it is not suitable
for FP evaluation because it is built from the same statistical distribution the
model trained on. GoTestWAF's positive test set is independently authored benign
traffic — a better FP measurement.

---

## Feature Compatibility Check

GoTestWAF payloads need to produce rows compatible with `HTTP_FEATURE_COLUMNS`
in [`feature_encoder.py`](file:///home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security/ML/feature_encoder.py#L34).

The columns are computed by
[`ComputePayloadStats()`](file:///home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security/detect/payload_stats.go#L78)
in Go and replicated in `_flatten_http_record()` in Python. GoTestWAF payloads
dropped into HTTP request fields will populate these columns naturally:

| Column | Populated by GoTestWAF payload? |
|---|---|
| `uri_entropy`, `uri_sql_keyword_count`, `uri_xss_pattern_count` | ✅ Yes, via URLParam placeholder |
| `body_entropy`, `body_sql_keyword_count`, `body_xss_pattern_count` | ✅ Yes, via JSONBody/HTMLForm placeholder |
| `uri_base64_count`, `uri_hex_count` | ✅ Yes, via Base64/URLEncoded encoders |
| `ua_entropy`, `ua_special_char_ratio` | ⚠ GoTestWAF uses a fixed UA — set a scanner-like UA for realistic features |
| `uri_length`, `query_param_count`, `header_count` | ✅ Yes, from reconstructed request metadata |
| `content_length`, `cookie_count` | ✅ Yes, standard request fields |

No changes to `feature_encoder.py` or `payload_stats.go` are needed — the schemas
are already compatible.

---

## Step-by-Step: Running GoTestWAF

### Step 1 — Pull the Docker image

```bash
docker pull wallarm/gotestwaf
```

### Step 2 — Clone for YAML extraction (training data — no live target needed)

```bash
git clone --depth=1 https://github.com/wallarm/gotestwaf.git /tmp/gotestwaf
ls /tmp/gotestwaf/testcases/
```

Each `.yaml` file contains `payload`, `encoder`, `placeholder`, and `type` fields.
The `type` field is your ML class label.

### Step 3 — (Optional) Validate against the built-in ModSecurity demo first

```bash
cd /tmp/gotestwaf
make modsec                  # starts ModSecurity demo WAF on port 8080
make gotestwaf               # builds the GoTestWAF image
make scan_local_from_docker  # full scan against it — sanity check the tool works
```

### Step 4 — Run against our proxy

Make sure the proxy is running (`./ngfw-monitor --config proxy_config.yaml`)
and the ML scoring service is up (`uvicorn scoring_service:app --port 8500`).

```bash
mkdir -p reports

docker run --network="host" --rm -it \
  -v ${PWD}/reports:/app/reports \
  wallarm/gotestwaf \
  --url=http://localhost:80 \
  --blockStatusCodes=403 \
  --noEmailReport
```

Our proxy returns `403` for blocked requests, matching `--blockStatusCodes=403`.

### Step 5 — Read the report

Open the file in `reports/`. Three sections matter:

| Section | What to record |
|---|---|
| **Negative Tests** | % blocked per category (SQLi, XSS, RCE, Path Traversal, SSTI, NoSQLi...) → evaluation chapter detection table |
| **Positive Tests** | % wrongly blocked → evaluation chapter FP rate |
| **Summary Score** | Single overall % → headline result for the evaluation chapter |

### Step 6 — (Optional) Add custom YAMLs for gaps

For `lfi` and `api_resource_abuse` (not bundled), create YAMLs in
`/tmp/gotestwaf/testcases/custom/`:

```yaml
# lfi_example.yaml
payload:
  - "../../../../etc/passwd"
  - "%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd"
encoder:
  - Plain
  - URL
placeholder:
  - URLParam
  - JSONBody
type: "LFI"
```

---

## Three Workflows — Grounded in Project Code

### Workflow A — Extract Labels for `web-classifier` Training

**When:** Before `python train_models.py web-classifier`.
**No live target or Docker required.**

```python
# parse_gotestwaf_payloads.py  (to be created in Security/ML/)
import yaml
import json
from pathlib import Path
from detect_stub import ComputePayloadStatsStub  # or call Go via subprocess

TESTCASES_DIR = Path("/tmp/gotestwaf/testcases")

# Map GoTestWAF type labels → our train_models.py label strings
LABEL_MAP = {
    "SQL Injection":    "sqli",
    "XSS":              "xss",
    "RCE":              "cmd_injection",
    "Path Traversal":   "path_traversal",
    "SSTI":             "ssti",
    "NoSQL Injection":  "nosqli",
    "LFI":              "lfi",
    # rule-only (don't train on, but still useful for rule regression):
    "Log4Shell":        None,   # skip for ML training
    "XXE":              None,
    "LDAP Injection":   None,
    "CRLF Injection":   None,
}

rows = []
for yaml_file in TESTCASES_DIR.rglob("*.yaml"):
    data = yaml.safe_load(yaml_file.read_text())
    label = LABEL_MAP.get(data.get("type"), "unknown")
    if label is None:
        continue  # skip rule-only categories
    for payload in data.get("payload", []):
        for encoder in data.get("encoder", []):
            for placeholder in data.get("placeholder", []):
                # Reconstruct a minimal HTTP-like context,
                # compute payload_stats, emit a JSONL row
                rows.append({
                    "label": label,
                    "payload": payload,
                    "encoder": encoder,
                    "placeholder": placeholder,
                    # feature fields computed by equivalent of ComputePayloadStats()
                })

with open("ML/datasets/gotestwaf_labeled.jsonl", "w") as f:
    for row in rows:
        f.write(json.dumps(row) + "\n")
```

Then merge with CSIC-2010 and feed into the training pipeline:

```bash
python train_models.py web-classifier \
  --input Security/ML/datasets/gotestwaf_labeled.jsonl
```

**Why this matters specifically for our project:**
- CSIC-2010 is a 2010 dataset with plain-text payloads. GoTestWAF adds modern
  encodings (Base64-wrapped SQLi, Unicode-escaped XSS, JSON-body payloads) that
  stress-test our `uri_base64_count`, `uri_hex_count`, and `body_*` features — the
  exact columns `web_classifier` uses that CSIC-2010 rarely exercises.

---

### Workflow B — Benchmark Our Live Proxy

**When:** After `train_models.py web-classifier` + `scoring_service.py` is running.

```bash
# Terminal 1 — start the proxy
cd Security && ./ngfw-monitor --config proxy_config.yaml

# Terminal 2 — start the ML scoring service
cd Security/ML && uvicorn scoring_service:app --host 0.0.0.0 --port 8500 --workers 2

# Terminal 3 — run GoTestWAF
mkdir -p reports
docker run --network="host" --rm -it \
  -v ${PWD}/reports:/app/reports \
  wallarm/gotestwaf \
  --url=http://localhost:80 \
  --blockStatusCodes=403 \
  --noEmailReport
```

**Interpretation:**
- Classes where our proxy scores high → rule layer OR ML layer catching them
- Classes where proxy scores low → investigate whether it's Tier-1 (regex not
  firing) or Tier-3 (ML not trained well on that class)
- To distinguish: check `predicted_category` in the proxy JSON logs
  (`Security/proxy-output.json`) alongside the GoTestWAF bypass list

---

### Workflow C — False-Positive Validation

**Same run as Workflow B — no separate scan needed.**

Read the **Positive Tests** section of the report. Record the FP rate.

**Important nuance for our project:** Our `ml_client.go` uses a **50ms fail-open
timeout** — if the ML service is slow, it returns `risk_score=0` and the proxy
passes the request. This means a slow scoring service will artificially lower
our FP rate (fewer wrong blocks). Ensure the scoring service is healthy
(`curl localhost:8500/health`) before recording FP numbers for the report.

---

## Adding GoTestWAF to `download_all.sh`

GoTestWAF's testcase files should be cloned alongside the other payload libraries
already in [`download_all.sh`](file:///home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security/ML/datasets/download_all.sh).
Add this block in **Section 1 — Cheatsheets & Payload Libraries**:

```bash
# GoTestWAF testcases — pre-labeled attack YAML payloads for ML-L7 training
clone_or_pull "GoTestWAF-testcases" \
  "https://github.com/wallarm/gotestwaf.git" \
  "$SCRIPT_DIR/cheatsheets/gotestwaf"
success "GoTestWAF testcases available at cheatsheets/gotestwaf/testcases/"
```

No Docker is needed for the YAML extraction step — just the cloned repo.

---

## Implementation Checklist

- [ ] **Step 1 — Extract training data (no infrastructure)**
  - [ ] Add GoTestWAF clone to `download_all.sh` (Section 1)
  - [ ] Write `Security/ML/parse_gotestwaf_payloads.py` to parse `testcases/*.yaml`
        → labeled JSONL using `HTTP_FEATURE_COLUMNS`-compatible schema
  - [ ] Merge with CSIC-2010 rows; verify class balance per ML-L7 label
  - [ ] Run `python train_models.py web-classifier` with merged dataset
  - [ ] Re-run MLflow and compare macro-F1 before/after GoTestWAF augmentation

- [ ] **Step 2 — ModSecurity baseline run (sanity check)**
  - [ ] `make modsec && make scan_local_from_docker` inside cloned GoTestWAF repo
  - [ ] Save the ModSecurity report as comparison baseline in `reports/`

- [ ] **Step 3 — Live benchmark against our proxy**
  - [ ] Confirm proxy + scoring service both running and healthy
  - [ ] Run GoTestWAF with `--url=http://localhost:80 --blockStatusCodes=403`
  - [ ] Save report with timestamp; record per-category detection rate
  - [ ] Cross-reference bypassed categories with `proxy-output.json` log

- [ ] **Step 4 — False-positive validation**
  - [ ] Read Positive Tests section from Step 3 report
  - [ ] Verify ML scoring service had no timeouts during the run
        (`grep "unavailable" proxy-output.json | wc -l` should be near 0)
  - [ ] Record FP rate alongside detection rate in evaluation chapter

- [ ] **Step 5 — Targeted retraining for weak classes**
  - [ ] For each class with low detection rate, pull more GoTestWAF YAMLs
        or add custom YAMLs for that type
  - [ ] Re-run `train_models.py web-classifier` and re-run Step 3

---

## Quick Reference

| Aspect | Detail |
|---|---|
| **What it is** | Open-source OWASP/API attack simulator — same tool used to benchmark ModSecurity, AWS WAF, Cloudflare |
| **Docker image** | `wallarm/gotestwaf` |
| **Block status code** | Our proxy returns `403` → use `--blockStatusCodes=403` |
| **Proxy HTTP port** | Port `80` (→ backend 8080) or port `8080` (→ backend 9090) — see `proxy_config.yaml` |
| **ML service port** | `8500` — `scoring_service.py` (uvicorn) |
| **Feature schema** | GoTestWAF payloads → `ComputePayloadStats()` → `HTTP_FEATURE_COLUMNS` — fully compatible, no changes needed |
| **Training labels** | GoTestWAF `type` field maps to `train_models.py` label strings |
| **For LFI training** | GoTestWAF doesn't bundle LFI — use PayloadsAllTheThings (already in `download_all.sh`) |
| **FP rate caveat** | ML client has 50ms fail-open timeout — ensure scoring service is healthy before recording FP numbers |
