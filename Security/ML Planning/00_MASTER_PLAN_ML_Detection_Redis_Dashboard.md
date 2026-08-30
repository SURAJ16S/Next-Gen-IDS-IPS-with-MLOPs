# ML + Detection Rules + Redis + CAPTCHA + Dashboard — Complete Build Plan

**For:** Suraj (Sole Developer) — Intelligent Multi-Protocol IDS/IPS
**Assumes:** Zero prior ML background. Every ML term is explained the first time it's used.
**Grounded in:** your actual `Security/detect/*.go` code, `Web/backend/*`, and your prior planning docs (Gap Analysis + ML Module Documentation + Protocol Data Collection Inventory). This plan does not repeat those — it turns them into an execution order with concrete files, commands, and a testing procedure.

**See also — `01_Protocol_Threat_Matrix_ML_Integration_and_Training_Data_Sources.md`** (in this same folder). That document is the single consolidated reference for **every threat this project defends against**, protocol by protocol, mapped to: detection tier → ML model → response action → blocking mechanism → exact training/reference data source. It also lists 30+ common vulnerabilities (CSRF, SSTI, insecure deserialization, NoSQLi, GraphQL abuse, JWT attacks, BOLA/BFLA, DNS amplification/spoofing, RDP/SNMP exploits, etc.) that your current 49-category taxonomy doesn't yet cover, with ready-to-paste Go constants. Read it alongside this plan — this plan tells you *when* to build things; that document tells you *what, for which protocol, using what data*. It also extends the model inventory below from 7 to 12 entries (adding an SSH/FTP/Telnet brute-force classifier, a DNS DGA classifier, and others) and the code deliverables in this folder (`feature_encoder.py`, `train_models.py`, `scoring_service.py`) have already been updated to match — `ssh-brute-classifier` and `dns-tunnel-dga` training commands and `/score/ssh` / `/score/dns` serving routes now exist alongside the original three.

---

## 0. The one-sentence architecture you're building

```
Traffic → Go Proxy (Tier1 rules + Tier2 Redis reputation, done in Go)
        → FastAPI ML service (Tier3, Python, new)
        → Decision Engine (Go, combines all 3 tiers → allow/alert/block/tarpit)
        → MongoDB + Socket.IO → Web Dashboard (block/unblock, live feed)
```

Nothing you build below changes this shape. It fills in Tier 2 (Redis), Tier 3 (ML), the missing Tier-1 rules (API/JWT), the CAPTCHA gate, and the dashboard's block/unblock control loop.

---

## 1. Build order (do not reorder — each phase unblocks the next)

| Phase | What | Why this order | Duration (team of 4, parallel where noted) |
|---|---|---|---|
| **A** | Redis reputation + rolling per-IP feature store | Tier 2 is small, self-contained, and Model #6/#4/#3 all read from it. Build it first so later phases aren't blocked on it. | 3–4 days |
| **B** | Missing Tier-1 rules: JWT structural checks, BOLA/ID-sequence tracker, mass-assignment check | ML has nothing to score for API attacks until these raw signals exist (per your gap analysis §3.1). Also needed before CAPTCHA, since CAPTCHA piggybacks on the same rate-tracking code. | 4–5 days |
| **C** | CAPTCHA / human-verification gate | Needs Phase A's Redis (to count request rate per IP/session) | 2–3 days |
| **D** | Sandbox target + attack traffic generation (labeling data) | Needed before you can train anything supervised | 3–4 days |
| **E** | Train Model #1 (HTTP anomaly) + Model #3 (flow anomaly) — unsupervised, no labels needed | Fastest path to a demoable model; run in parallel with Phase D | 3–4 days |
| **F** | Train Model #2 (web attack classifier) — supervised, needs Phase D's labels | 4–5 days |
| **G** | FastAPI scoring service + Go integration | Makes the models real, not notebooks | 3–4 days |
| **H** | Dashboard: block/unblock, manual/auto mode, live feed wiring | Can start in parallel with E/F/G once Phase A's Redis schema is fixed | 4–5 days |
| **I** | End-to-end live test against the sandbox target | Proves the whole pipeline works | 2 days |
| **J** | Retraining loop + model versioning | Closes the "MLOps" loop, do last | 3–4 days |

Total: ~5–6 weeks with 4 people working in parallel per your proposal's role split (Suraj = security/detection engine, Yash = DevOps/Redis/CI, Shraddha = ML + dashboard frontend, Abhijit = ML training + pen-testing/labeling).

---

## 2. Phase A — Redis implementation (do this first)

### 2.1 What Redis is for here (three separate uses, one Redis instance)

1. **Tier-2 IP reputation** — "is this IP already known-bad?" — a fast lookup before wasting Tier-3 ML time on it.
2. **Per-IP rolling feature store** — "how many requests / failed logins / distinct ports has this IP touched in the last N minutes?" — both the Go Behavioral Engine and the Python ML feature encoder read this so it's computed once, not twice.
3. **CAPTCHA / rate-gate state** — "has this IP/session been challenged, did it pass, when does the challenge expire?"

Use **separate key prefixes and separate logical DBs (Redis `SELECT 0/1/2`)** so you can flush/inspect each independently without breaking the others.

### 2.2 Concrete key schema

```
# --- DB 0: IP reputation (Tier 2) ---
rep:ip:{ip}                → HASH  { score: int 0-100, last_seen, category_history: json, source: "local|feed" }
rep:feed:abuseipdb         → SET   of known-bad IPs (refreshed on schedule)
rep:feed:spamhaus_drop     → SET   of CIDR ranges (checked separately, not a plain SET lookup)
rep:feed:ja3_bad           → SET   of known-malicious JA3 hashes

# --- DB 1: Rolling per-IP behavioral counters (sliding window via sorted sets) ---
roll:conn:{ip}             → ZSET  member=conn_id, score=unix_ts   (trim entries older than window on read)
roll:failedlogin:{ip}      → ZSET  member=attempt_id, score=unix_ts
roll:ports:{ip}            → SET   distinct dest ports touched (TTL 3600s, refreshed on each hit)
roll:bytes_out:{ip}        → STRING (INCRBY per connection close, TTL 86400s)  # for exfil-volume anomaly

# --- DB 2: CAPTCHA / rate gate ---
gate:reqrate:{ip}          → STRING counter, TTL 10s   (sliding-window request rate)
gate:challenge:{ip_or_sid} → HASH  { status: pending|passed|failed, issued_at, expires_at }
gate:blocked:{ip}          → STRING "1", TTL = block duration  (manual or automatic block — see §5)
```

Why sorted sets (ZSET) for rolling counters instead of a plain counter with TTL: a ZSET lets you do `ZREMRANGEBYSCORE key -inf (now-window)` to drop old entries, then `ZCARD key` to get "count in the last N minutes" — a true sliding window, not a fixed-bucket approximation. This is what gives you "5 failed logins in the last 10 minutes" instead of a leaky fixed-reset counter.

### 2.3 Where this plugs into what you already have

- Your `Web/backend/package.json` **already lists `ioredis`** as a dependency and `Web/backend/src/services/agent-memory.service.js` already shows the connect-with-fallback pattern — reuse that exact pattern (don't write a second Redis client). Create a **second, separate ioredis instance** pointed at DB 0–2 for security use, so a DevOps-agent Redis outage never takes down IDS blocking, and vice versa.
- Your Go proxy (`Security/proxy/`, `Security/detect/behavioral.go`) is the other Redis client. Use the **`go-redis/redis/v9`** library on the Go side (add to `go.mod`).
- **Golden rule:** Redis is a cache/accelerator, never the source of truth for "is this IP currently blocked." The source of truth for a block is Mongo (`BlockedEntity` collection, §5) + the Go firewall rule. Redis's `gate:blocked:{ip}` is a **fast-path cache with a TTL matching the Mongo record**, refreshed by a background sync job — this way a Redis flush/restart degrades to "check Mongo," not "briefly unblock everyone."

### 2.4 Deliverable code for this phase

See `ml-service/redis_reputation.py` (Python side, used by the ML/reputation scoring) and `backend-additions/redisSecurityClient.js` (Node side, used by the dashboard/block-management API) included with this plan.

### 2.5 Concrete tasks for Phase A

1. Add a second Redis logical connection in the backend (`redisSecurityClient.js`), env var `REDIS_SECURITY_URL` separate from any agent Redis URL.
2. In Go: add a small `reputation` package that does `GET rep:ip:{ip}` before running Tier 1 regex — if `score > 80`, short-circuit straight to block without running full Tier 1 (this is a performance win you get for free).
3. Write the scheduled feed-ingestion job (§6.3 of your Gap Analysis doc — AbuseIPDB, Spamhaus, FireHOL, GreyNoise, Abuse.ch JA3) that populates `rep:feed:*` sets on a cron (every 6–12h is enough for a student project — don't over-engineer refresh frequency).
4. Verify: `redis-cli -n 0 HGETALL rep:ip:1.2.3.4` returns a real record after a synthetic bad-IP feed load.

---

## 3. Phase B — Missing Tier-1 detection rules (do before ML, not after)

Your gap analysis correctly identifies that **ML has nothing to score until the raw signal exists.** These three are missing and block both the API security claims in your synopsis and two of your ML models:

### 3.1 JWT structural validation (new file: `Security/detect/jwt_analyzer.go`)
Check, per HTTP request with an `Authorization: Bearer` header:
- Is it 3 base64url segments separated by `.`? (malformed → flag)
- Does `alg` in the header equal `none`? (classic JWT bypass attack → flag HIGH)
- Is `alg` `HS256` when your app expects `RS256` (algorithm confusion attack)? — needs a per-app expected-algorithm config, keep it simple: flag if `alg` changes between requests from the same client/session.
- Is the token expired (`exp` in the past) but still being accepted downstream? — you can only flag "expired token presented," you can't know if the backend rejected it (that's the backend's job, not the proxy's) — so log it as `MEDIUM`, not enforce a block, unless you also inspect backend response codes for a 200 on an expired token, which is a strong signal.

### 3.2 BOLA / ID-enumeration tracker (extend `SessionTracker` in `session_tracker.go`)
Add to the existing session struct: a sliding list of `(uri_template, id_value, timestamp)`. When you see the same URI *template* (e.g. `/api/orders/{id}`) hit with sequentially incrementing or wildly varying `{id}` values from one session/IP in a short window, flag `BOLA-ENUM`. This is exactly the "session-level sequence feature" your Gap Analysis doc §3.5 flagged as missing — implement it as a rule first (cheap, deterministic), and it becomes a labeled training signal for the ML classifier later for free.

### 3.3 Mass-assignment / schema drift check (extend `http_analyzer.go` body parsing)
For JSON POST/PUT/PATCH bodies: maintain a rolling "seen field names" set per endpoint (first N clean requests establish the baseline). Flag a request whose JSON body contains a field name never seen before at that endpoint (e.g. a client suddenly sending `"isAdmin": true` to `/api/users/update`). Keep this behind a feature flag / whitelist mode since it will have false positives on legitimately evolving APIs — start it in `alert`-only mode, never `auto-block`.

**Deliverable:** stub Go files with function signatures + comments (not full implementation — that's your Go/security team's work) are included in `backend-additions/detection-rule-stubs/` so whoever picks this up has the exact shape to fill in.

---

## 4. Phase C — CAPTCHA / "is this a human typing" gate

### 4.1 The actual signal you're using (not "detect CAPTCHA-worthy" magically — be concrete)

You already have the primitive from Phase A: `gate:reqrate:{ip}` sliding counter. The rule:

1. On every request, `INCR gate:reqrate:{ip}` with an expiring window (e.g. a 10-second sliding bucket using the same ZSET pattern as §2.2).
2. If requests-per-10-seconds from one IP/session exceeds a threshold **for form-submission or login-type endpoints specifically** (not static assets — don't CAPTCHA someone loading images fast), issue a challenge.
3. Also combine with **inter-request timing variance** — humans have irregular gaps between form fields being filled and submitted; scripts submit at near-constant intervals. You already compute `fwd_iat_std` (inter-arrival-time standard deviation) in `FlowRecord` — a very low IAT std across repeated identical-shaped requests (e.g. repeated login POSTs) is your second, stronger signal beyond raw rate. This reuses data you already collect; no new instrumentation needed for this part.
4. If challenged, set `gate:challenge:{ip_or_sid}` to `pending`; block/tarpit further requests to that endpoint from that key until `passed`.

### 4.2 What CAPTCHA to actually use

Don't build your own CAPTCHA image-generation/OCR-resistance system — that's a research problem in itself and out of scope for a final-year timeline. Two realistic choices:
- **Cloudflare Turnstile** (free tier, privacy-friendlier, no user puzzle-solving in most cases — it's mostly invisible/behavioral) — recommended, since your project already positions itself as free/open-source-friendly and Turnstile's free tier fits that.
- **hCaptcha** (also free tier) if you specifically want a visible challenge for your demo/viva to *show* the mechanism working.

Either way, the **decision of when to show the challenge is yours** (built in §4.1) — the CAPTCHA provider only handles the human-verification widget + server-side token verification. This split (your own rate/timing detector decides *when*, a proven provider handles *how*) is both the realistic scope and the more defensible design in a viva ("why didn't you build your own CAPTCHA?" → "because solving CAPTCHA image generation robustly is its own multi-year research problem; our contribution is the *adaptive triggering logic*, which is novel to this project").

### 4.3 Flow, concretely

```
Request to /login or /api/* form endpoint
        │
        ▼
Check gate:reqrate + IAT-variance signal (Phase A data)
        │
   ┌────┴─────┐
   │ Normal    │ High rate / low IAT variance
   ▼           ▼
 Proceed    Return 403 + { "captcha_required": true, "sitekey": "..." }
              │
        Frontend renders Turnstile/hCaptcha widget
              │
        User completes it → frontend re-submits with captcha token
              │
        Backend verifies token server-side with provider's siteverify API
              │
        On success: gate:challenge:{key} = passed (TTL 15 min), allow request through
        On failure: increment a separate failure counter → escalate to temporary IP block after N failures
```

### 4.4 Deliverable

- `frontend-captcha/CaptchaGate.jsx` — a React component matching your existing frontend's patterns (fits into `Login.jsx`/`Register.jsx` flow), plus
- `backend-additions/captcha.middleware.js` — Express middleware that checks the Redis rate/IAT signal and either passes through or returns the challenge-required response, and verifies the provider token.

---

## 5. Dashboard integration — block/unblock, manual + automatic

### 5.1 New data model

You already have `Threat`, `SecurityEvent`, `NetworkEvent` collections but **no explicit "blocked entity" record with an unblock action** — add one:

```js
// Web/backend/src/models/BlockedEntity.js
{
  targetType: "ip" | "ip_range" | "ja3_fingerprint" | "device_fingerprint",
  targetValue: String,          // "203.0.113.10" or a JA3 hash etc.
  reason: String,                // "auto: risk_score 92 (sqli)" or "manual: analyst override"
  blockedBy: "system" | "<adminUserId>",
  mode: "manual" | "automatic",
  action: "block" | "tarpit" | "rate_limit",
  riskScoreAtBlock: Number,
  expiresAt: Date,                // null = indefinite, else auto-expire (esp. for automatic blocks)
  status: "active" | "unblocked" | "expired",
  unblockedBy: String,
  unblockedAt: Date,
}
```

### 5.2 Data flow: detection → dashboard → (un)block, both directions

```
Go Cross-Layer Decision Engine decides "Auto-Block" for an IP
        │
        ├──► writes local firewall rule immediately (kernel-level, already in your architecture)
        │
        └──► POSTs event to backend /api/agent/security-event
                   │
                   ▼
         Node backend: creates SecurityEvent + BlockedEntity(mode="automatic") in Mongo
                   │
                   ├──► Socket.IO emit("block:new", {...}) → dashboard updates live (you already have socket.js)
                   │
                   └──► sets rep:ip:{ip} score + gate:blocked:{ip} in Redis (fast-path cache)

Analyst on dashboard clicks "Unblock":
        │
        ▼
  PATCH /api/admin/blocked/:id/unblock
        │
        ├──► Mongo: BlockedEntity.status = "unblocked", unblockedBy = req.user.id
        ├──► DEL gate:blocked:{ip} in Redis
        └──► backend calls the Go agent's control endpoint (you already have an agent-facing
             control channel per devops.controller.js's SSH/agent patterns) to remove the
             kernel-level firewall rule — this is the step that actually restores access;
             without it you've only "unblocked" in the dashboard's opinion, not on the wire.

Analyst clicks "Block" manually on any IP shown in Logs/Threats/Network pages:
        │
        ▼
  POST /api/admin/blocked  { targetValue, action: "block"|"tarpit"|"rate_limit", mode: "manual" }
        same downstream effects as above, mode="manual", blockedBy=analyst id
```

### 5.3 Manual vs automatic — the toggle your synopsis promises

Add a single system-wide (and optionally per-protocol) setting, e.g. `AdminThreshold` (you already have this model — extend it):
```js
autoBlockEnabled: Boolean,          // global kill-switch
autoBlockThreshold: Number,         // risk_score above which auto-block fires, default 85
autoAlertThreshold: Number,         // risk_score above which it's alert-only, default 60
```
When `autoBlockEnabled = false`, the Decision Engine still computes risk scores and creates `BlockedEntity` records with `status: "pending_review"` instead of enforcing — this gives you a "recommend, don't act" mode useful for your demo (show that the system *would* have blocked it, without live-blocking during a presentation).

### 5.4 New/updated dashboard pages

- `AdminManageNetwork.jsx` (exists) — add a "Block" action button per row, and a status column.
- New `AdminManageBlocklist.jsx` — dedicated table of all `BlockedEntity` records (active + history), with Unblock button, filter by mode (manual/automatic), and the threshold settings form from §5.3.
- Live updates: your `socket.js` already exists — just add `block:new` / `block:removed` event emit/listen pairs, following the same pattern as your existing threat/log sockets.

### 5.5 Deliverable code

`backend-additions/BlockedEntity.js`, `backend-additions/block.controller.js`, `backend-additions/block.routes.js` are included, following your existing controller/route conventions exactly (same style as `threat.controller.js`).

---

## 6. The ML module itself — full beginner-level plan

### 6.1 What "training a model" actually means, in one paragraph

You are not writing an algorithm that detects SQL injection. You are collecting a table where each row is one connection/request, described by a set of numbers (a **feature vector** — e.g. "payload entropy = 4.8, SQL-keyword-count = 3, URI length = 42..."), and — for supervised models only — a label ("this row was an SQL injection" / "this row was normal"). The **training procedure** hands this table to a library function (`model.fit(X, y)`), which finds statistical patterns that separate the labeled classes (or, for unsupervised models, finds what "normal" looks like). The **model** that comes out is just a saved set of decision thresholds (for tree models) — at prediction time, you feed it one new row's numbers and it outputs a score. Nothing here writes new detection *logic*; it learns thresholds/patterns from data your Go collector already produces.

### 6.2 Model inventory (from your Gap Analysis doc — restated as the build list)

| # | Model | Type | Needs labels? | Build first? |
|---|---|---|---|---|
| 1 | HTTP Payload Anomaly Scorer (Isolation Forest) | Unsupervised | No | **Yes — Phase E, day 1** |
| 3 | Flow-level Anomaly Detector (Isolation Forest) | Unsupervised | No | **Yes — Phase E, day 1** |
| 2 | Web Attack Classifier (Random Forest / XGBoost, multiclass) | Supervised | Yes | Phase F |
| 4 | SSH Brute-force/Bot Classifier | Supervised (or start unsupervised via IAT threshold) | Yes (or no, if you start simple) | Phase F (stretch) |
| 5 | DNS Tunneling/DGA Detector | Supervised/hybrid | Yes for DGA family | Phase F (stretch) |
| 6 | IP Reputation Score | Rule + weighted decay, **not ML** | No | Phase A (already covered, §2) |
| 7 | TLS/JA3 Fingerprint Matcher | Lookup, **not ML** | No | Phase A (feed-based) |

**Do models #1 and #3 first.** They need zero labeled data — just a sample of your own "normal" traffic — so they're the fastest way to get a real, demoable ML component running before you've built the labeling pipeline.

### 6.3 Step-by-step: Model #1 (HTTP Payload Anomaly Scorer)

**Step 1 — Collect a clean baseline.** Run your reverse proxy in front of a real or simulated normal web app for a defined window (recommend: at least a few thousand real/synthetic benign requests — more is better but don't over-block on volume; even a few hours of realistic traffic through DVWA/Juice Shop's normal (non-attack) flows is enough to start). Confirm via your own detection logs that **zero attack signatures fired** during this window — this is your "clean" label by construction, not because you hand-labeled it.

**Step 2 — Turn `PayloadStats` JSONL into a numeric table.** This is the "feature encoder" — see `ml-service/feature_encoder.py`. It reads your `logs/protocols/http.jsonl` (or wherever `PayloadStats` lands) and produces a Pandas DataFrame with one row per request, columns = the 16-ish numeric fields already listed in your Gap Analysis §4.2 (entropy, ratios, encoding counts, pattern counts, token stats).

**Step 3 — Train.**
```python
from sklearn.ensemble import IsolationForest
import joblib

# X_train: DataFrame of ONLY clean-baseline rows, numeric columns only
model = IsolationForest(
    n_estimators=200,       # number of random trees — more = more stable score, slower to train
    contamination=0.01,     # your *assumption* of what % of "clean" baseline might still be noisy/mislabeled — start low
    random_state=42,        # fixes randomness so results are reproducible for your report
)
model.fit(X_train)
joblib.dump(model, "models/http_anomaly_v1.pkl")
```

**Step 4 — What the score means.** `model.decision_function(X)` gives a continuous score (more negative = more anomalous). Rescale to 0–100 with a simple min-max transform fit on your training data (code included in `train_models.py`) so it matches the `risk_score` contract in your Gap Analysis §4.3.

**Step 5 — Sanity-check it, don't just trust it.** Run it against a **held-out set that includes real attacks** (from Phase D) that it never saw during training — confirm attack rows score noticeably higher than benign rows on average. If they don't separate at all, your feature set or `contamination` assumption needs adjusting before you move on — this is normal, expect 1–2 iterations here, it's not a sign you did something wrong.

### 6.4 Step-by-step: Model #3 (Flow-level Anomaly Detector) — same procedure, different input

Identical training code, different input table: use `FlowRecord` fields (35+ CICFlowMeter-style columns) instead of `PayloadStats`. Because your schema already matches CIC-IDS2017/2018's feature set, you can (and should) **pre-train an initial version on the public CIC-IDS2018 benign-traffic subset** before you have much of your own baseline — this gives you a reasonable starting model on day one, which you then fine-tune/retrain on your own deployment's traffic once you've collected enough of it (this is explicitly the "public dataset bootstraps you, your own traffic specializes you" pattern, and it's fine to say exactly that in your report).

### 6.5 Step-by-step: Model #2 (Web Attack Classifier) — the supervised one, needs Phase D first

**Step 1 — Generate labeled attack traffic (Phase D).** Stand up DVWA + OWASP Juice Shop in isolated containers behind your proxy (compose file included: `sandbox/docker-compose.sandbox.yml`). Run:
- `sqlmap` against DVWA's SQLi pages (`--batch --level=3 --risk=2` is a reasonable non-destructive default) → labels every request it sends as `sqli`.
- `OWASP ZAP` active scan or manual XSS payloads from **PayloadsAllTheThings** → label `xss`.
- `dirb`/`wfuzz` for path traversal / forced browsing → label `path_traversal` / `recon`.
- Your own normal browsing of the same apps (click through DVWA/Juice Shop's legitimate flows) → label `benign`.

Because you control the attacking tool, **you already know the label** — write the label into the log record at generation time (simplest: run each tool in its own labeled batch, tag the whole batch, don't try to infer labels after the fact).

**Step 2 — Assemble the table.** Same `PayloadStats` columns as Model #1, plus a `label` column now (`benign`, `sqli`, `xss`, `path_traversal`, `cmd_injection`, ...). Split 70/15/15 into train/validation/test — **stratified by label** (`sklearn.model_selection.train_test_split(..., stratify=y)`) so rare attack classes aren't accidentally left out of one split.

**Step 3 — Train.**
```python
from sklearn.ensemble import RandomForestClassifier
# or: from xgboost import XGBClassifier  -- similar API, often better accuracy, slightly more setup

clf = RandomForestClassifier(
    n_estimators=300,
    max_depth=12,             # cap tree depth to reduce overfitting on a small dataset
    class_weight="balanced",  # IMPORTANT: your classes are imbalanced (way more benign than sqli) —
                               # this reweights the loss so rare attack classes aren't ignored
    random_state=42,
)
clf.fit(X_train, y_train)
```

**Step 4 — Evaluate correctly (this is the part people get wrong).** Do **not** report plain accuracy — with imbalanced classes, a model that predicts "benign" for everything can score 95%+ accuracy while catching zero attacks. Instead:
```python
from sklearn.metrics import classification_report, confusion_matrix
print(classification_report(y_test, clf.predict(X_test)))   # per-class precision/recall/F1
print(confusion_matrix(y_test, clf.predict(X_test)))          # see exactly what's confused with what
```
Look at **recall per attack class** specifically — missing a real SQLi (false negative) is worse than over-flagging a weird-but-benign request (false positive) for a security tool, so if you have to trade off, favor recall on attack classes, and treat false positives as something the CAPTCHA/alert-not-block tier absorbs rather than something the classifier must eliminate to zero.

**Step 5 — Feature importance (for your viva, and for the "explainable AI" claim in your synopsis).**
```python
import pandas as pd
importances = pd.Series(clf.feature_importances_, index=X_train.columns).sort_values(ascending=False)
print(importances.head(10))
```
This gives you the exact slide content for "why did the model flag this" — e.g. if `sql_keyword_count` and `entropy` dominate, that's your defensible explanation.

### 6.6 Refinement loop — how the score actually improves over time

1. **Threshold tuning, not just retraining.** After Step 4, plot precision-recall curves (`sklearn.metrics.precision_recall_curve`) and pick the score threshold that gives your target false-positive rate (your synopsis's own benchmark target: ≤5% FPR, ≥85% recall on anomaly detection) — this is a free, no-retraining way to improve the practical outcome.
2. **Error analysis.** Pull every false negative (missed attack) and false positive (wrongly flagged benign) from the test set and actually read a sample of them. Look for a pattern — e.g. "all the missed SQLi used a specific tamper encoding sqlmap applies" — and either add that encoding to `PayloadStats`' feature extraction or add more labeled examples of that exact pattern for the next training round. This is the single highest-leverage activity in the whole ML pipeline; don't skip it in favor of just "training more."
3. **Cross-validation for a more honest number than one train/test split**, especially since your labeled dataset will be modest in size:
```python
from sklearn.model_selection import cross_val_score
scores = cross_val_score(clf, X, y, cv=5, scoring="f1_macro")
print(scores.mean(), scores.std())   # report both — the std tells you how stable the model is
```
4. **Hyperparameter search**, only after the above (don't tune before you've fixed feature/label problems — tuning a model on bad data just overfits to the bad data faster):
```python
from sklearn.model_selection import GridSearchCV
param_grid = {"n_estimators": [200, 300, 500], "max_depth": [8, 12, 16], "min_samples_leaf": [1, 3, 5]}
search = GridSearchCV(RandomForestClassifier(class_weight="balanced", random_state=42),
                       param_grid, scoring="f1_macro", cv=5, n_jobs=-1)
search.fit(X_train, y_train)
print(search.best_params_)
```
5. **Retraining trigger, not continuous learning.** Per your own synopsis's scope, retrain on a schedule (weekly is reasonable) or when an analyst has marked enough dashboard false positives/negatives to meaningfully change the training set — not on every new request. Version every model file (`http_anomaly_v{N}.pkl`) and log metrics per version so a regression is traceable and you can roll back (this is literally what makes the project "MLOps" instead of "a notebook").

### 6.7 Serving — connecting the trained model to live traffic

`ml-service/scoring_service.py` (FastAPI) — one process, loads all `.pkl` models at startup, exposes:
```
POST /score/http-payload   { payload_stats: {...} }        → { risk_score, predicted_category, confidence, model_version }
POST /score/flow           { flow_record: {...} }          → { risk_score, model_version }
GET  /reputation/{ip}                                        → reads Redis rep:ip:{ip}, not ML — but same service for convenience
GET  /health
```
Go side: add an HTTP client call in `Security/proxy/` after Tier 1+2 pass, with a **strict timeout (50ms) and fail-open to rule-only decision** if the ML service is slow/down — an ML outage must never take down the whole proxy. This exact requirement is already called out in your ML Module Documentation §7 — implement it as written.

### 6.8 Running it live against a real application (your explicit ask)

1. `docker compose -f sandbox/docker-compose.sandbox.yml up -d` — brings up DVWA (port 80 inside its container) and Juice Shop (port 3000), both **only reachable through your reverse proxy**, not directly exposed.
2. Point your Go proxy's `proxy_config.yaml` listener at the sandbox container's internal address as the backend, with your normal public-facing listen port in front.
3. Confirm normal browsing works end-to-end (proxy → DVWA login page loads).
4. Run `sqlmap -u "http://<proxy-host>:<listen-port>/vulnerabilities/sqli/?id=1&Submit=Submit" --cookie="..." --batch` — watch:
   - Tier 1 fires immediately on the raw signature hits (should already work today).
   - Once Phase G is wired, the FastAPI `/score/http-payload` call should return an elevated `risk_score` even for sqlmap's obfuscated/tamper-encoded payloads that Tier 1 might miss.
   - The dashboard should show a live `SecurityEvent` via Socket.IO within your event's timestamp + a few hundred ms.
   - If risk score crosses `autoBlockThreshold`, a `BlockedEntity` record should appear and the sqlmap process should start getting connection resets/tarpit behavior on subsequent requests — this is your end-to-end proof.
5. Repeat with Nikto (`nikto -h http://<proxy-host>:<listen-port>/`) to test the bot/scanner detection path, and Hydra against your sandboxed SSH/FTP if you've routed those protocols too.
6. **Capture this entire run's logs** — this is your demo video content (§13.4/deliverable #6 in your proposal) and also becomes your next round of labeled training data (feed it back into Phase F's dataset with fresh `sqlmap`-tamper-script coverage).

---

## 7. Suggested file/repo layout to create

```
Next-Gen-IDS-IPS-with-MLOPs/
├── ML/                              # NEW top-level directory
│   ├── requirements.txt
│   ├── feature_encoder.py
│   ├── train_models.py
│   ├── scoring_service.py           # FastAPI app
│   ├── redis_reputation.py
│   ├── models/                      # .pkl artifacts, gitignored except a checked-in v1 baseline
│   └── notebooks/                   # exploratory analysis, error-analysis notebooks
├── Security/                        # existing Go code
│   └── detect/
│       ├── jwt_analyzer.go          # NEW (Phase B)
│       └── (BOLA logic added into session_tracker.go)
├── Web/backend/src/
│   ├── models/BlockedEntity.js      # NEW
│   ├── controllers/block.controller.js   # NEW
│   ├── routes/block.routes.js       # NEW
│   ├── middleware/captcha.middleware.js  # NEW
│   └── services/redisSecurityClient.js   # NEW
├── Web/frontend/src/
│   ├── components/CaptchaGate.jsx   # NEW
│   └── pages/AdminManageBlocklist.jsx    # NEW
└── sandbox/
    └── docker-compose.sandbox.yml   # NEW — DVWA + Juice Shop for testing/labeling
```

---

## 8. Priority checklist if the deadline is tight (per your Phase 4 milestone, ML due 18 Nov 2026)

1. Redis reputation (§2) — small, unblocks everything else.
2. Model #1 + Model #3, unsupervised, no labeling needed (§6.3–6.4) — your fastest real demoable ML.
3. FastAPI service + Go wiring with fail-open (§6.7) — turns models into a real system.
4. Sandbox + labeled traffic + Model #2 (§6.5) — your strongest academic-contribution claim (rule-based vs ML benchmark).
5. Dashboard block/unblock (§5) — needed for any live demo to look complete.
6. CAPTCHA (§4) — valuable but the most cuttable item if time runs out; note it as "designed, integration pending" in the report if needed.
7. JWT/BOLA rules (§3), retraining loop (§6.6 point 5) — genuine value-add, explicitly fine to leave as "future work" per your own Gap Analysis doc's own priority call.
8. **Model #4 (SSH/FTP/Telnet brute-force classifier) and Model #5 (DNS DGA/tunneling classifier)** — see the new threat-matrix doc §3 and §7; code stubs (`ssh-brute-classifier`, `dns-tunnel-dga` in `train_models.py`, `/score/ssh` and `/score/dns` in `scoring_service.py`) are already in this folder. Build after item 4 above once you have Hydra/Medusa (SSH) and dnscat2/iodine + DGA-feed (DNS) labeled batches.
9. **The Tier-1 rule additions listed in the threat-matrix doc §4** (CSRF header check, SSTI/NoSQLi/JWT regex additions, DNS amplification/spoofing rules, etc.) — cheap, incremental diffs to existing analyzer files; do these opportunistically whenever a team member has spare cycles between the phases above, since they cost little and materially widen your "vulnerabilities covered" claim in the final report.
