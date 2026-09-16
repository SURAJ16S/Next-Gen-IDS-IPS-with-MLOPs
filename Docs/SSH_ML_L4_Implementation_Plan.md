# Definitive SSH ML-L4 Detection Implementation Plan

> **Objective:** Use ML-L4 behavioral anomaly detection to identify abnormal SSH sessions,
> while retaining rule-based detection for deterministic SSH attack signatures and known
> vulnerabilities. The ML model must add measurable **lift over the rule engine alone.**

---

## 0. What Already Exists — Research Summary

Before designing new code, here is what is already built and working:

| Layer | File | What it does for SSH |
|---|---|---|
| Rule engine | `ssh_analyzer.go` | 6-state machine, HASSH computation, weak-algo checks, brute-force heuristic (timing), tunnel heuristic (volume) |
| Behavioral aggregator | `behavioral.go` | Per-`src_ip` auth-failure sliding window (`BEH-BRUTE-001`) — **already exists** |
| Flow tracking | `flow_tracker.go` | CICFlowMeter-style bidirectional stats; emits `FlowRecord` on FIN/RST/idle |
| Flow scoring | `flow_logger.go` | Scores every `FlowRecord` via `/score/flow` (45ms budget) |
| SSH feature schema | `feature_encoder.py` | `SSH_FEATURE_COLUMNS` already defined; `/score/ssh` route already exists in `scoring_service.py` |
| SSH scoring route | `scoring_service.py` | `POST /score/ssh` → `ssh_brute_classifier` model — **stub exists, model untrained** |

**Critical findings:**

1. `SSH_FEATURE_COLUMNS` already has the right shape: rolling counters from Redis + per-session flags. However, it only has **10 features** and is missing the eBPF flow statistics (IAT, pkt-size distributions), lifecycle timings (`kex_duration_ms`), and the new categorical fields.
2. `behavioral.go` already tracks `authFailures` per `src_ip` — this covers **local brute-force**. The **distributed (dst-side) aggregator is missing**.
3. `flow_tracker.go` already emits `FlowRecord` with IAT and size distributions, but `FlowRecord` has **no `FlowID` field that is collision-safe**, and it does **not** export `flow_id` in a way that `ssh_analyzer.go` can reference.
4. `ssh_analyzer.go` tracks `clientBytes` / `serverBytes` but does **not** emit a session-close summary record for the ML pipeline. The `AnalyzeClose()` path fires two rule-based detections (brute-force heuristic, banner-scan heuristic) but never emits an SSH session feature vector to the scoring service.
5. The `/score/ssh` endpoint already exists. The ML model (`ssh_brute_classifier`) just needs to be trained.

---

## 1. Two-Stage Architecture

```
Network Traffic
      │
      ├──── eBPF Monitor ──────────────────────► FlowTracker
      │                                               │
      └──── Proxy Layer                        FlowCompleteEvent
               │                                     │
               ▼                                     │
         SSH Analyzer ──── SSHSessionRecord ──────────┤
               │                                     │
               └──────────────────────────────────► Correlator
                                                       │
                                                  FeatureBuilder
                                                  (ssh_features.go)
                                                       │
                              ┌────────────────────────┤
                              ▼                        ▼
                    Generic ML-L4                SSH ML-L4
                   (/score/flow)                (/score/ssh)
                              │                        │
                              └──────────┬─────────────┘
                                         ▼
                                Rule Engine (existing)
                                         │
                                         ▼
                                  Hybrid Scorer
                                         │
                                         ▼
                              DetectionBus → Logger/TUI
```

**Why two models, not one:** The generic flow model (`flow_anomaly`) is trained on CIC-IDS2017/2018 across all protocols. Injecting SSH-specific fields (HASSH category, KEX timing) would degrade its calibration on HTTP, DNS, and FTP flows — and would add meaningless zero-filled columns for every non-SSH flow. Dedicated SSH model trains and versions independently.

---

## 2. Feature Set (Final, Locked Schema)

### 2A. Extended SSH Session Features
This expands `SSH_FEATURE_COLUMNS` in [`feature_encoder.py`](file:///home/kali/Next-Gen-IDS-IPS-with-MLOPs/Security/ML/feature_encoder.py#L65) from 10 to 26 fields:

| Feature | Source | Vulnerability Signal |
|---|---|---|
| `failed_login_count_10min` | Redis (existing) | Brute-force |
| `conn_count_10min` | Redis (existing) | Brute-force / scanning |
| `distinct_ports_touched` | Redis (existing) | Port sweep |
| `avg_session_duration_ms` | Session close | Brute-force (short), Tunnel (long) |
| `rapid_teardown_ratio` | `bruteForceWindow` | Brute-force |
| `hassh_seen_before` | Redis flag | Repeat tool |
| `hassh_known_bad` | `knownBadHASSH` map | Known attack tool |
| `banner_scan_flag` | Rule detection | Scanner |
| `weak_algo_flag` | Rule detection | Weak-algo attacker |
| `iat_std_ms` | eBPF IAT | Scripted vs human |
| **NEW** `kex_duration_ms` | State machine timer | CVE exploitation anomaly |
| **NEW** `tcp_syn_to_banner_ms` | State machine timer | Handshake anomaly |
| **NEW** `kexinit_to_newkeys_ms` | State machine timer | KEX anomaly |
| **NEW** `pkts_before_newkeys` | Pre-NEWKEYS packet count | Exploitation probing |
| **NEW** `bytes_before_newkeys` | Pre-NEWKEYS byte count | Exploitation probing |
| **NEW** `total_fwd_bytes` | eBPF FlowRecord | Tunnel / exfil |
| **NEW** `total_bwd_bytes` | eBPF FlowRecord | Tunnel |
| **NEW** `fwd_bwd_byte_ratio` | Derived | Tunnel directionality |
| **NEW** `fwd_bwd_pkt_ratio` | Derived | Tunnel directionality |
| **NEW** `fwd_pkt_size_mean` | eBPF FlowRecord | Post-NEWKEYS profile |
| **NEW** `fwd_pkt_size_std` | eBPF FlowRecord | Traffic burstiness |
| **NEW** `bwd_pkt_size_mean` | eBPF FlowRecord | Response profile |
| **NEW** `fwd_iat_mean_ms` | eBPF FlowRecord | Session cadence |
| **NEW** `fwd_iat_std_ms` | eBPF FlowRecord | Burstiness (tunnel) |
| **NEW** `client_software_cat` | HASSH + banner map | Soft tool signal |
| **NEW** `dst_failed_sessions_10min` | Dst-side aggregator | Distributed brute-force |

> [!IMPORTANT]
> **Post-NEWKEYS signal is padded/encrypted.** All size and IAT features collected **after** `SSH_MSG_NEWKEYS` are padded to the cipher's block size (8 or 16 bytes). The explainability output must **never** attribute a high-risk alert solely to a post-NEWKEYS size feature. Pre-NEWKEYS lifecycle timings (`kex_duration_ms`, `pkts_before_newkeys`) carry substantially stronger signal for exploitation detection.

### 2B. HASSH → `client_software_cat` Mapping

HASSH is trivially spoofable. Treat as a **soft** categorical feature only.
```
0 = known_standard_client  (OpenSSH, PuTTY, Dropbear — from knownTools map)
1 = automation             (Paramiko, AsyncSSH, JSch, libssh2)
2 = scanner_bruteforcer    (masscan, zgrab, ncrack, hydra, medusa — knownBadHASSH)
3 = unknown                (not in any known list)
```
Watch for **class imbalance**: legitimate embedded devices (e.g., IoT SSH stacks) will collapse into `3 = unknown` and become an FPR contributor. Collect a representative sample of legitimate unknown clients in your baseline.

---

## 3. Distributed Brute-Force Aggregator (Missing Component)

`behavioral.go` already has a per-`src_ip` auth-failure tracker (`TrackAuthFailure`). This covers **localized brute-force** (one attacker, many attempts). It does **not** detect **distributed credential stuffing** (many IPs, all hitting the same target).

Add a parallel `dst_ip`-keyed tracker to `behavioral.go`:

```go
// New field in BehavioralEngine:
dstTrackers map[string]*dstTracker  // keyed by "dst_ip:dst_port"

// dstTracker holds cross-source failure counts per destination.
type dstTracker struct {
    failedSrcIPs  map[string][]time.Time  // src_ip → failure timestamps
    lastAlertAt   time.Time
}
```

`dst_failed_sessions_10min` (count of distinct source IPs that have failed auth against this `dst_ip:port` in 10 min) feeds directly into `SSH_FEATURE_COLUMNS` as a new feature, not just a rule trigger.

---

## 4. Tunnel Detection — Disambiguating Interactive Sessions

Current heuristic: `totalBytes > 10MB && duration > 1min` → `SSH-TUNNEL-001`.

This false-positives on: `scp` transfers, `rsync`, long `tail -f` sessions, any file transfer over SSH.

Replace with a multi-signal behavioral profile:

| Feature | Interactive SSH | SSH Tunnel |
|---|---|---|
| `avg_session_duration_ms` | Low–Medium | Very High |
| `fwd_bwd_byte_ratio` | Near 1.0 (symmetric) | Skewed toward 1 direction |
| `fwd_iat_std_ms` | High (human typing cadence) | Low–Medium (sustained transfer) |
| `fwd_pkt_size_mean` | Small (keystroke-sized, ~40B) | Large (MTU-sized, ~1400B) |
| Active/idle cycles | Many idle gaps | Continuous active |

The ML model will learn these joint distributions. The rule engine will still fire `SSH-TUNNEL-001` on the volume heuristic as a quick catch — but the ML model provides the behavioral profile that reduces FPR for `SCP` and `rsync`.

---

## 5. Collision-Safe FlowID

Current `FlowRecord.FlowID` is a formatted string: `"srcIP:srcPort-dstIP:dstPort-Protocol"` — this collides when ports are reused.

**New FlowID:** SHA-256 of `srcIP|srcPort|dstIP|dstPort|protocol|startTimeUnixNano` → truncated to 16 hex chars. This is computed once at flow creation in `FlowTracker` and stored on `flowState`. The `ssh_analyzer.go` stores the matching `flow_id` on `sshSession` using the same 5-tuple + start time.

**Correlation:** The correlator holds a `map[flowID]*pendingCorrelation` keyed on `flow_id`. Both `SSHSessionRecord` and `FlowCompleteEvent` carry the `flow_id`. Whichever arrives first is held for up to 5 seconds, then evicted with a partial vector if the other hasn't arrived.

---

## 6. Proposed Codebase Changes

### 6A. [MODIFY] `flow_tracker.go`
*   Add `FlowID string` field to `FlowRecord` (truncated hash of 5-tuple + `startTime.UnixNano()`).
*   Add `fwd_pkt_size_min/max` and `bwd_pkt_size_min/max` (already collected in `fwdSizes`/`bwdSizes`, just not exported — trivial to add).
*   Expose `FlowID` on `flowState` so `ssh_analyzer.go` can read it during `getOrCreate`.

### 6B. [MODIFY] `ssh_analyzer.go`
*   Add to `sshSession`: `flow_id string`, `tcpSynAt time.Time`, `bannerAt time.Time`, `kexInitAt time.Time`, `newKeysAt time.Time` (ALREADY TRACKS `newKeysAt`), `pktsBeforeNewKeys int`, `bytesBeforeNewKeys int64`.
*   Populate `tcpSynAt` in `getOrCreate`, `bannerAt` in `handleVersionString`, `kexInitAt` in `parseKEXInit`.
*   On `AnalyzeClose`: build and emit an `SSHSessionRecord` to the correlator channel.
*   Keep all existing rule-based detections intact.

### 6C. [MODIFY] `behavioral.go`
*   Add `dstTrackers map[string]*dstTracker` and `TrackSSHFailAtDst(srcIP, dstIP string, dstPort uint16)` method.
*   Emit `BEH-DIST-BRUTE-001` when distinct failed `src_ip` count against a single `dst_ip:port` exceeds threshold in 10 min.
*   The `dst_failed_sessions_10min` count is written to a new Redis key (`roll:sshfail_dst:{dstip}:{dstport}`) at session close for ML feature extraction.

### 6D. [NEW] `flow_correlator.go`
```go
// SSHSessionRecord — emitted by ssh_analyzer.go on AnalyzeClose.
type SSHSessionRecord struct {
    FlowID              string
    ConnID              string
    SrcIP               string
    SrcPort             uint16
    DstPort             uint16
    ClientSoftwareCat   int     // 0=standard,1=auto,2=scanner,3=unknown
    HASSHKnownBad       bool
    WeakAlgoFlag        bool
    BannerScanFlag      bool
    TCPSynToBannerMs    float64
    KexInitToNewKeysMs  float64
    KexDurationMs       float64
    PktsBeforeNewKeys   int
    BytesBeforeNewKeys  int64
    ClosedAt            time.Time
}

// Correlator holds pending events and merges them when both sides arrive.
type FlowCorrelator struct {
    mu      sync.Mutex
    pending map[string]*pendingCorr  // keyed by flow_id
    outCh   chan SSHFeatureVector
}
```

### 6E. [NEW] `ssh_features.go`
*   `BuildSSHFeatureVector(sess SSHSessionRecord, flow FlowRecord, redis RedisCounters) SSHFeatureVector` — merges both sides into the full `SSH_FEATURE_COLUMNS`-aligned struct.
*   Computes derived ratios: `fwd_bwd_byte_ratio`, `fwd_bwd_pkt_ratio`.
*   Calls `/score/ssh` on the scoring service (within 45ms, fail-open).

### 6F. [MODIFY] `feature_encoder.py`
*   Expand `SSH_FEATURE_COLUMNS` from 10 to 26 fields.
*   Update `_flatten_ssh_record()` to extract all new fields.
*   Update `encode_single_ssh()` accordingly.
*   No changes needed to `scoring_service.py` — the `/score/ssh` route already accepts `ssh_record: dict`.

### 6G. [MODIFY] `Vulnerability_Test_Scope.md`
*   Move `CatSSHBruteForce` and `CatSSHTunnel` to **ML Training Scope**.
*   Keep `CatSSHCVEExploit`, `CatSSHWeakAlgo`, `CatSSHMalformed`, `CatSSHLegacyProto`, `CatSSHBannerScan` as **Rule-Based**.
*   Add new ML-L4 class count in the summary table.

---

## 7. ML Training Strategy

### 7A. Dataset Composition & Sourcing

To prevent train/serve skew and ensure our custom features are accurately populated, we will use a **Dogfooding Pipeline**: all raw traffic (PCAPs/live) will be fed directly through our Go proxy to extract the features, rather than writing a separate Python feature-extraction script.

| Label | Traffic Type | Source / Collection Method |
|---|---|---|
| `benign` | Interactive SSH | Real sessions: bash, vim, htop (diverse clients: PuTTY, libssh, OpenSSH) |
| `benign` | SCP / SFTP | File transfers (crucial for tunnel disambiguation) |
| `benign_long` | Long-lived sessions | `tmux`, `screen`, persistent monitoring |
| `brute_force` | Localized / Distributed | Synthetic: Hydra/Medusa with **mandatory timing jitter** |
| `brute_force` | Honeypot (Wild attacks) | **Cowrie Honeypot** (isolated segment) capturing real-world botnets |
| `ssh_tunnel` | Dynamic forwarding | `ssh -D`, `ssh -L`, `ssh -R` sessions |
| `pre_train` | Academic Baselines | CSE-CIC-IDS2018 / CICIDS2017 (used for sanity-checking and initial baselines before fine-tuning on our custom features) |

> [!WARNING]
> **Synthetic jitter is mandatory.** Hydra and Medusa produce near-zero-jitter, machine-paced inter-connection timing. Real attackers use randomized backoffs. We must inject jitter into ≥30% of our synthetic attack samples before training.

### 7B. Addressing Class Imbalance & Data Splits
*   **Class Imbalance:** Real-world brute-force traffic is a tiny fraction of total flows. If left unbalanced, the model will just predict "benign" to achieve 99% accuracy. We will use **SMOTE** (Synthetic Minority Over-sampling Technique) or strict class-weighting during model training.
*   **Temporal Splits:** We will use **temporal train/test splitting** (splitting by time), *never* random shuffling. Randomly shuffling flows from the same brute-force campaign leaks information into the test set and artificially inflates accuracy metrics.

### 7C. Schema Lock Checkpoint

> [!IMPORTANT]
> **Lock `SSH_FEATURE_COLUMNS` before bulk data collection.** Hand-label ≥50 real sessions and verify the feature vector is populated correctly. Changing the schema after bulk collection means re-extracting everything.

### 7D. Feature Ablation Pass
Train two models: one with all 26 features, one without rule-adjacent features (`banner_scan_flag`, `hassh_known_bad`). If recall is comparable, the rule-adjacent features add no independent ML signal — prune them.

---

## 8. Evaluation Plan

### 8A. Primary Metrics

| Metric | Target | Rationale |
|---|---|---|
| **Recall** | ≥ 0.90 | Missing attacks is operationally costly |
| **FPR** | ≤ 0.05 | SOC alert fatigue is a real deployment risk |
| **Inference Latency (P95)** | ≤ 45ms | Existing budget in `flow_logger.go` |
| **Lift over rule engine** | > 0 | Must catch cases the rules miss |

### 8B. Lift Measurement
Run the same attack set twice: once with rules only (disable `/score/ssh`), once with hybrid (rules + ML). Measure the delta in TPR. If delta ≈ 0, the ML adds no value and the architecture adds latency for nothing. This must be non-zero to justify the implementation.

### 8C. Explainability Output
The existing `scoring_service.py` already populates `contributing_features` (a `dict[str, float]` in `ScoreResponse`). Extend it to return the **top 3 feature names by magnitude** alongside their values in the alert `Details` map. This enables SOC analysts to reason about why a session was flagged.

---

## 9. Implementation Sequence

```
Step 1:  flow_tracker.go — add collision-safe FlowID, export fwd/bwd pkt size min/max
Step 2:  ssh_analyzer.go — add lifecycle timers, pkts/bytes before NEWKEYS, emit SSHSessionRecord
Step 3:  behavioral.go — add dst-side aggregator, TrackSSHFailAtDst()
Step 4:  flow_correlator.go — NEW: async correlator matching SSHSessionRecord + FlowRecord
Step 5:  ssh_features.go — NEW: feature builder, ratio computation, Redis counter reads
    ▼ [CHECKPOINT] ── Schema lock: hand-label 50 sessions, verify feature vector ──
Step 6:  feature_encoder.py — expand SSH_FEATURE_COLUMNS to 26 fields
Step 7:  Data collection — baseline + jittered attack traffic
Step 8:  train_models.py — train ssh_brute_classifier; ablation pass
Step 9:  Integration test — run Hydra attack + SCP + interactive SSH; verify detection + no false positives
Step 10: Evaluate lift — rules-only vs hybrid; record all 5 metrics
Step 11: Vulnerability_Test_Scope.md — promote SSH Brute-Force + Tunnel to ML Training scope
```
