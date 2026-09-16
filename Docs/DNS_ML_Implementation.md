# Definitive DNS ML-L4 Detection Implementation Documentation

> **Objective:** Use ML-L4 behavioral anomaly detection to identify abnormal DNS sessions
> (**DNS Tunneling / Data Exfiltration** via `CatDNSTunnel` and **DGA Botnet Domains**
> via `CatDGA`), while retaining rule-based detection for all deterministic DNS attack
> signatures. The ML model must add measurable **lift over the rule engine alone.**
>
> **Scope boundary:** Only `CatDNSTunnel` and `CatDGA` are ML-targeted per
> `Vulnerability_Test_Scope.md`. `CatZoneTransfer`, `CatNXDomainFlood`,
> `CatDNSAmplification`, `CatDNSRebind`, `CatDNSSpoofing` remain rule-only.

---

## 0. What Already Exists — Research Summary

| Layer | File | What it does for DNS |
|---|---|---|
| Rule engine | `dns_analyzer.go` | `shannonEntropy()` + heuristics for high-entropy subdomains, long TXT queries, TXID mismatch (`CatDNSSpoofing`), rebinding (`CatDNSRebind`). |
| Behavioral aggregator | `behavioral.go` | **No DNS trackers exist yet.** Only IP-level connection rate and SSH-level auth-fail trackers are present. |
| Flow tracking | `flow_tracker.go` | N/A for DNS — stateless UDP, no bidirectional flow to correlate. |
| DNS feature schema | `feature_encoder.py` | `DNS_FEATURE_COLUMNS` defined with 10 fields. **Needs expansion to 14 fields.** |
| DNS scoring route | `scoring_service.py` | `POST /score/dns` → `dns_tunnel_dga_classifier` — **stub exists; model untrained.** |
| ML client | `ml_client.go` | `ScoreHTTPPayload`, `ScoreFlow`, `ScoreSSH` exist. **`ScoreDNSBatch` missing.** |

**Critical gaps:**
1. `behavioral.go` has no DNS sliding-window tracking — needed for all behavioral features.
2. `DNS_FEATURE_COLUMNS` is missing 4 high-signal features identified in the literature.
3. No `DNSFeatureVector` Go struct exists; no schema-lock enforcement in Go.
4. `ml_client.go` lacks batch DNS scoring and a circuit breaker.

---

## 1. Architecture

```
Network Traffic (UDP 53)
      │
      └──── Proxy Layer
               │
               ▼
         DNS Analyzer ─────── stateless features (entropy, lengths, record type flag)
               │
               └──────────►  DNS Behavioral Aggregator  (behavioral.go)
                               ├── dnsSrcTracker (LRU-evicted map)
                               ├── EWMA counters — 1-min + 10-min decay
                               └── HyperLogLog — unique subdomain count
                                       │
                                       ▼
                              Feature Builder (dns_features.go)
                              SchemaVersion-stamped DNSFeatureVector
                                       │
                                       ▼
                     Bounded channel (non-blocking drop with metric)
                                       │
                                       ▼
                          Background drain goroutine (main.go)
                          ├── JSONL logger (domain hash/truncated)
                          └── Micro-batcher → ScoreDNSBatch (ml_client.go)
                                             ├── Circuit Breaker
                                             └── Config-reloadable threshold
                                                       │
                                                       ▼
                                          Alert De-duplication → DetectionBus
```

Unlike SSH, there is **no correlator** step — DNS is a single UDP request/response transaction rather than a long-lived TCP flow. The Feature Builder merges the stateless packet payload with historical per-IP aggregates.

---

## 2. Feature Schema — Expanded to 14 Columns

The revised schema expands `DNS_FEATURE_COLUMNS` from 10 to 14 fields.
`feature_encoder.py` **and** the Go `DNSFeatureVector` struct must both be updated atomically.

| # | Feature | Source | Description |
|---|---|---|---|
| 1 | `domain_entropy` | Stateless | Shannon entropy of the full QNAME |
| 2 | `label_count` | Stateless | Number of dot-separated segments |
| 3 | `max_label_length` | Stateless | **[NEW]** Max byte length of a single label (tunnelers pack data near the 63-byte limit) |
| 4 | `sld_entropy` | Stateless | Shannon entropy of the SLD specifically (DGA's primary target) |
| 5 | `digit_ratio` | Stateless | **[NEW]** Fraction of characters that are digits (DGA signal) |
| 6 | `vowel_consonant_ratio` | Stateless | **[NEW]** Vowels ÷ consonants (distinguishes word-DGA from random-string DGA) |
| 7 | `query_length` | Stateless | Total FQDN byte length |
| 8 | `any_query_flag` | Stateless | 1.0 if query type is ANY (amplification signal) |
| 9 | `uncommon_qtype_ratio_1m` | Behavioral | **[NEW]** EWMA (1-min) of TXT+NULL+CNAME queries ÷ total queries |
| 10 | `uncommon_qtype_ratio_10m` | Behavioral | EWMA (10-min) of TXT+NULL+CNAME queries ÷ total queries |
| 11 | `nxdomain_ratio_10m` | Behavioral | EWMA (10-min) of NXDOMAIN responses ÷ total queries |
| 12 | `unique_subdomain_count` | Behavioral | HyperLogLog estimate of distinct SLDs queried in 10-min window |
| 13 | `repeatability_factor` | Behavioral | **[NEW]** Unique SLD count ÷ total query count (high = tunneling; low = repeated fixed beaconing) |
| 14 | `avg_response_size_ewma` | Behavioral | EWMA of response payload bytes |

> **Why dual EWMA windows for `uncommon_qtype_ratio`?** Tunneling tools like `iodine`/`dnscat2`
> burst heavily in short windows that a 10-minute EWMA smooths out. The 1-minute fast window
> catches burst exfiltration; the 10-minute slow window catches slow DGA beaconing.

---

## 3. Implementation Plan — File by File

---

### Step 1 — [MODIFY] `Security/detect/behavioral.go`

**Goal:** Implement memory-safe DNS behavioral tracking using O(1) data structures.

#### 1A. `dnsSrcTracker` Struct (EWMAs + HLL)
Replace any raw timestamp-slice window with exponentially decaying counters:

```go
// dnsSrcTracker tracks per-source-IP DNS behavioral aggregates.
// All counters use exponential decay — O(1) memory regardless of query volume.
type dnsSrcTracker struct {
    // Fast (1-min) and slow (10-min) EWMAs
    uncommonQtypeEWMA1m  float64
    uncommonQtypeEWMA10m float64
    nxdomainEWMA10m      float64
    queryRateEWMA10m     float64
    avgRespSizeEWMA      float64

    // HyperLogLog for unique subdomain counting (~2% error, ~2 KB per IP)
    hll *HyperLogLog

    totalQueries    int64
    lastDecayAt     time.Time
    lastSeen        time.Time
}
```

#### 1B. LRU/TTL Eviction on `dnsSrcTracker` Map
Wrap the `dnsSrcTracker` map in a fixed-capacity LRU cache (e.g., cap 50,000 IPs).
On every eviction, the HLL is GC'd. This prevents unbounded growth from short-lived
or spoofed source IPs.

```go
// In BehavioralEngine:
dnsTrackers *lruCache[string, *dnsSrcTracker]  // keyed by src_ip
```

#### 1C. Methods Required
- `TrackDNSQuery(srcIP, qtype string)` — updates EWMA counters on each query.
- `TrackDNSResponse(srcIP string, respSize int, rcode uint8)` — updates NXDOMAIN ratio and response size EWMA.
- `GetDNSAggregates(srcIP string) DNSAggregates` — returns a snapshot of all behavioral fields for the Feature Builder.

---

### Step 2 — [NEW] `Security/detect/dns_features.go`

**Goal:** Define the strict schema-locked `DNSFeatureVector` and pure extraction functions.

#### 2A. Struct Definition
```go
// DNSFeatureVector is the ML feature vector for DNS tunnel/DGA scoring.
// SCHEMA_VERSION must match DNS_FEATURE_COLUMNS in feature_encoder.py.
// A CI test enforces this — see dns_features_test.go.
const DNSFeatureSchemaVersion = 1

type DNSFeatureVector struct {
    SchemaVersion       int     `json:"schema_version"`
    // Stateless
    DomainEntropy       float64 `json:"domain_entropy"`
    LabelCount          float64 `json:"label_count"`
    MaxLabelLength      float64 `json:"max_label_length"`
    SLDEntropy          float64 `json:"sld_entropy"`
    DigitRatio          float64 `json:"digit_ratio"`
    VowelConsonantRatio float64 `json:"vowel_consonant_ratio"`
    QueryLength         float64 `json:"query_length"`
    AnyQueryFlag        float64 `json:"any_query_flag"`
    // Behavioral
    UncommonQtypeRatio1m  float64 `json:"uncommon_qtype_ratio_1m"`
    UncommonQtypeRatio10m float64 `json:"uncommon_qtype_ratio_10m"`
    NXDomainRatio10m      float64 `json:"nxdomain_ratio_10m"`
    UniqueSubdomainCount  float64 `json:"unique_subdomain_count"`
    RepeatabilityFactor   float64 `json:"repeatability_factor"`
    AvgResponseSizeEWMA   float64 `json:"avg_response_size_ewma"`
    // Metadata (not a feature — stripped before ML call)
    SrcIP  string `json:"src_ip"`
    ConnID string `json:"conn_id"`
}
```

#### 2B. Pure Extraction Functions
All stateless computations are pure functions with no side effects:
- `computeDomainEntropy(fqdn string) float64` — reuse `shannonEntropy` already in `dns_analyzer.go`.
- `computeMaxLabelLength(fqdn string) float64`
- `computeDigitRatio(s string) float64`
- `computeVowelConsonantRatio(s string) float64`

#### 2C. Schema-Lock CI Test (`dns_features_test.go`)
A Go test that reads `feature_encoder.py` at test time and asserts that the 14 JSON tags
in `DNSFeatureVector` (excluding `schema_version`, `src_ip`, `conn_id`) exactly match
`DNS_FEATURE_COLUMNS` in the same order. **Fails CI if they drift.**

```go
func TestDNSFeatureVectorSchemaLock(t *testing.T) {
    // Parse DNS_FEATURE_COLUMNS from ../../ML/feature_encoder.py
    // Compare against json struct tags of DNSFeatureVector
    // t.Fatal on any mismatch
}
```

#### 2D. Unit Tests with Known Samples
Tests must pass before any ML training run:
- `base32.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tunnel.example.com` → `domain_entropy` > 3.5, `max_label_length` ≥ 63.
- `a1b2c3d4.jx7kp9.net` (Bambenek-feed DGA sample) → `sld_entropy` > 3.0, `digit_ratio` > 0.3.
- `www.google.com` (benign) → low entropy, `label_count` = 3, `digit_ratio` ≈ 0.

---

### Step 3 — [MODIFY] `Security/detect/dns_analyzer.go`

**Goal:** Push a `DNSFeatureVector` to the async pipeline on each completed DNS transaction.

#### 3A. Bounded Channel (Non-Blocking, Drop Policy)
```go
// Package-level, initialized in main.go
var DNSFeatureChan = make(chan DNSFeatureVector, 4096)  // bounded
var dnsDropped      = expvar.NewInt("dns_features_dropped")

func emitDNSVector(vec DNSFeatureVector) {
    select {
    case DNSFeatureChan <- vec:
    default:
        dnsDropped.Add(1)  // metric, never blocks packet ingestion
    }
}
```
The 4096 buffer gives the batcher ~50ms headroom at ~80k QPS before any drops occur.

---

### Step 4 — [MODIFY] `Security/detect/ml_client.go`

**Goal:** Add batch DNS scoring with circuit breaker.

#### 4A. `ScoreDNSBatch`
```go
// ScoreDNSBatch sends a batch of DNS feature vectors to /score/dns.
// Strips non-feature metadata (src_ip, conn_id, schema_version) before sending.
func ScoreDNSBatch(ctx context.Context, vecs []DNSFeatureVector) ([]*MLScoreResponse, error)
```

#### 4B. Circuit Breaker
Wrap the HTTP call with a lightweight circuit breaker (3-state: Closed / Open / HalfOpen):
- After 5 consecutive timeouts → Open (stop calling for 10 seconds).
- After 10-second cooldown → HalfOpen (allow 1 probe call).
- On success → Closed (resume normal operation).

This prevents a slow-but-alive ML service from backing up the drain goroutine with 50ms blocking calls at scale.

---

### Step 5 — [MODIFY] `Security/main.go`

**Goal:** Drain `DNSFeatureChan`, micro-batch, log, score, emit alerts with de-duplication.

#### 5A. JSONL Logger with Domain Hashing
```go
// logs/dns_features.jsonl — for retraining pipeline
// Raw domain strings are SHA-256-truncated (first 16 hex chars) before logging.
// This prevents sensitive hostnames from leaking if the log file is shipped
// to a SIEM or shared for retraining by another team.
```

#### 5B. Micro-Batching Drain Loop
```go
go func() {
    ticker := time.NewTicker(50 * time.Millisecond)
    defer ticker.Stop()
    batch := make([]DNSFeatureVector, 0, 100)
    for {
        select {
        case vec := <-detect.DNSFeatureChan:
            batch = append(batch, vec)
            if len(batch) >= 100 {
                flushDNSBatch(batch)
                batch = batch[:0]
            }
        case <-ticker.C:
            if len(batch) > 0 {
                flushDNSBatch(batch)
                batch = batch[:0]
            }
        }
    }
}()
```

#### 5C. Config-Reloadable Thresholds
Fixed compiled-in thresholds like `RiskScore > 70` will drift as the model is retrained.
Thresholds are loaded from a config file at startup and reloadable via SIGHUP:

```go
type DNSMLThresholds struct {
    TunnelMinScore float64 `json:"tunnel_min_score"` // default 72.0
    DGAMinScore    float64 `json:"dga_min_score"`    // default 68.0
}
```

#### 5D. Alert De-Duplication
Before emitting `ML-DNS-tunnel` or `ML-DNS-dga` to the DetectionBus, check a
5-second suppression window per `src_ip`:
- If `CatNXDomainFlood` already fired for this `src_ip` in the last 5s, suppress `ML-DNS-dga` (NXDOMAIN ratio is a shared feature signal).
- If `CatZoneTransfer` already fired for this `src_ip`, suppress `ML-DNS-tunnel` (TXT-heavy bursts overlap).

This prevents a single incident from producing two separate DetectionBus categories.

---

### Step 6 — [MODIFY] `Security/ML/feature_encoder.py`

Expand `DNS_FEATURE_COLUMNS` from 10 to 14 fields, matching the Go struct in Step 2A exactly:

```python
DNS_FEATURE_COLUMNS = [
    "domain_entropy",
    "label_count",
    "max_label_length",        # NEW
    "sld_entropy",
    "digit_ratio",             # NEW
    "vowel_consonant_ratio",   # NEW
    "query_length",
    "any_query_flag",
    "uncommon_qtype_ratio_1m", # NEW — renamed from txt_query_ratio
    "uncommon_qtype_ratio_10m",
    "nxdomain_ratio_10m",
    "unique_subdomain_count",
    "repeatability_factor",    # NEW
    "avg_response_size_ewma",
]
```

---

### Step 7 — [NEW] `Security/ML/synthetic_dns_generator.py`

**Goal:** Generate 1,500 adversarial, non-trivially-separable labeled samples.

| Class | Count | Generation Strategy |
|---|---|---|
| `benign` | 600 | Mix of standard A/AAAA, CDN-style (`img-5.cdn.example.com`), AWS S3 (`bucket.s3.us-east-1.amazonaws.com`), dynamic DNS (`home-1234.dyndns.org`) |
| `tunnel` | 450 | Base32/base64 encoded payloads in labels, labels near 63-byte limit, deeply nested (`AAAA...AA.encoded.c2.example.com`), both TXT and CNAME record types |
| `dga` | 450 | Mix of: (a) random-string DGA (high entropy, Bambenek-feed style), (b) dictionary-based DGA (`purplehouse.net`, `bluefish.org`), (c) low-volume IoT beaconing patterns |

> **Adversarial requirement:** Dictionary-based DGA **must** be included.
> Word-concatenated DGA families (Suppobox, Matsnu) have low character entropy and
> will evade a model trained only on random-string DGA. `vowel_consonant_ratio` and
> `repeatability_factor` are the discriminating features for this subtype.

---

### Step 8 — [MODIFY] `Security/ML/train_models.py`

**Goal:** Train a production-quality classifier with correct evaluation methodology.

#### 8A. Family-Based Train/Test Split
The existing `_train_generic_classifier` uses `train_test_split(stratify=y)` — a **random
record split**. For DNS, DGA domains from the same family are highly correlated, so a
random split leaks correlation and inflates reported accuracy. For the DNS classifier:

```python
# Split by domain family field, not by random record
# Each JSONL record must include a "family" field (e.g. "iodine", "bambenek-tinba", "benign-cdn")
from sklearn.model_selection import GroupShuffleSplit
gss = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=42)
train_idx, test_idx = next(gss.split(X, y, groups=df["family"]))
```

#### 8B. Class Imbalance Handling
Real DNS traffic is >99% benign. To prevent accuracy-masking:
- Use `class_weight="balanced"` in both RandomForest and XGBoost (already set in `_train_generic_classifier` for RandomForest — verify it carries through).
- Report `precision`, `recall`, and `F1` **per class**, not just overall accuracy.
  The existing `classification_report()` call already does this — explicitly assert that
  per-class F1 for `tunnel` and `dga` exceeds 0.92 before accepting the model.

#### 8C. Algorithm Evaluation — XGBoost vs. RandomForest
Train and compare two models:

| Model | Why |
|---|---|
| `RandomForestClassifier` | Existing baseline; ensemble of decision trees |
| `XGBClassifier` | Faster inference, native `feature_importances_`, typically stronger on tabular feature vectors in DNS classification literature |

The winner (by macro-F1 on the family-split test set) is saved as the production artifact.
XGBoost feature importances feed directly into the existing `ContributingFeatures` explainability
field in `MLScoreResponse`.

#### 8D. Ablation Pass (Documented Delta)
Train two additional models with feature subsets:

| Pass | Features Dropped | Expected Result |
|---|---|---|
| `dns_tunnel_dga_ablated_L4only` | All behavioral EWMAs, HLL, repeatability | Proves entropy + length alone can catch most random-string DGA and high-volume tunneling |
| `dns_tunnel_dga_ablated_behavioral_only` | All stateless entropy/length features | Proves behavioral patterns alone catch slow DGA beaconing even with low-entropy domains |

**The delta between full-feature and each ablation model must be explicitly reported in
the MLflow run summary and in the project writeup.** This is the key defensible research
contribution — showing both payload analysis and traffic analysis are complementary rather
than substitutable.

---

## User Review Required

> [!IMPORTANT]
> **HyperLogLog dependency:** The plan requires HLL in Go for `unique_subdomain_count`.
> Two options:
>
> **Option A (Recommended for MVP):** Pull in `github.com/axiomhq/hyperloglog` — battle-tested,
> sub-2% error, ~2KB/key. Adds one `go.mod` dependency.
>
> **Option B:** Write a minimal native HLL (b=14, ~16KB registers) directly in `detect/`
> — zero dependencies, but ~150 lines of error-prone bit-twiddling to maintain.
>
> For a final-year project with a tight scope, Option A is strongly recommended.
> The external dependency is small, well-maintained, and well-understood.

> [!NOTE]
> **One revision flagged as potentially over-engineered for MVP scope:**
>
> `GroupShuffleSplit` by domain family (Step 8A) requires every JSONL record to carry
> a `"family"` field populated at generation time (e.g., `"iodine"`, `"bambenek-tinba"`).
> For synthetic-only training data where families are already known at generation time,
> this is straightforward. **If training on externally sourced unlabeled PCAPs in the future,
> family labeling would require a separate preprocessing step.** For the current MVP scope
> using `synthetic_dns_generator.py`, the `"family"` field is trivially added at
> generation time — so this is not over-engineered and should be implemented.

---

## Verification Plan

### Automated Tests
1. `go build ./...` — verifies all new structs and channels compile cleanly.
2. `go test ./detect/... -run TestDNSFeatureVectorSchemaLock` — CI schema-lock test.
3. `go test ./detect/... -run TestComputeDomainEntropy` — unit tests for pure functions.

### Data Pipeline Validation
1. `python3 synthetic_dns_generator.py --output logs/dns_labeled.jsonl`
2. `python3 train_models.py dns-tunnel-dga --input logs/dns_labeled.jsonl`
3. Assert: per-class F1 for `tunnel` ≥ 0.92 and `dga` ≥ 0.92.
4. Assert: ablation delta is logged to MLflow with both full-feature and L4-only runs present.

---

## Changelog

| Section | Change | Reason |
|---|---|---|
| Feature schema | Expanded from 10 → 14 columns | Added `max_label_length`, `digit_ratio`, `vowel_consonant_ratio`, `repeatability_factor` per literature review |
| `behavioral.go` | EWMA + HLL replacing raw timestamp arrays | O(1) memory; scalable to high-volume resolvers |
| `behavioral.go` | Dual 1-min + 10-min EWMA windows | 1-min catches bursty tunneling tools; 10-min catches slow DGA beaconing |
| `behavioral.go` | LRU eviction on `dnsSrcTracker` map | Prevents spoofed-IP memory leak |
| `dns_features.go` | `SchemaVersion` field + Go CI schema-lock test | Catches Python/Go schema drift before it reaches production |
| `dns_features.go` | Unit tests with known DGA/tunnel samples | Catches entropy/length calculation regressions |
| `ml_client.go` | `ScoreDNSBatch` + circuit breaker | Per-query HTTP calls are not viable at line rate; slow services must not stall the drain goroutine |
| `main.go` | 50ms micro-batcher with bounded drop channel | Amortizes HTTP overhead; never blocks packet ingestion |
| `main.go` | Config-reloadable thresholds per category | Hard-coded `> 70` drifts on every model retrain |
| `main.go` | Alert de-duplication vs. `CatNXDomainFlood`/`CatZoneTransfer` | Prevents single-incident double-firing across rule and ML engines |
| `main.go` | Domain SHA-256 hash/truncation in JSONL | Prevents PII leakage if logs are shipped externally |
| `train_models.py` | Family-based `GroupShuffleSplit` | Random record split leaks DGA family correlation → inflated accuracy |
| `train_models.py` | Per-class F1 assertion (≥ 0.92) | Overall accuracy masks minority-class failure in skewed DNS data |
| `train_models.py` | XGBoost evaluated alongside RandomForest | Stronger on tabular features; native importances improve explainability |
| `train_models.py` | Dual ablation passes (L4-only + behavioral-only) | Proves both signal types are complementary; defensible research contribution |
| `synthetic_dns_generator.py` | Base32/base64 realistic encoding in tunnel labels | Random strings ≠ real tunneling patterns |
| `synthetic_dns_generator.py` | Dictionary-DGA and CDN/IoT adversarial samples | Prevents trivially separable classes; word-DGA evades pure entropy features |
