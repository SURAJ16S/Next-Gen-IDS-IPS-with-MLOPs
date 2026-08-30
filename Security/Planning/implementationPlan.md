# Next-Gen IDS/IPS — ML Pipeline Completion Plan

> **Branch**: `suraj/ml-pipeline-phase-a-to-d` | **Last Reviewed**: 2026-08-30

---

## 1. Ground Truth & Audit

### Ground Truth: Commit History (Last 5 Pushes)

| Commit | Phase | Summary |
|---|---|---|
| `3d7f8ef` | Docs | `LOCAL_TESTING_GUIDE.md` — live app + NGFW proxy attack payload test guide |
| `b33588a` | Docs | `TESTING.md` — comprehensive 127-point checklist |
| `1094b6d` | D | DVWA+JuiceShop sandbox, labeled traffic script, planning docs committed |
| `79f7d3f` | D/E | ML pipeline directory: `feature_encoder.py`, `train_models.py`, `scoring_service.py`, `redis_reputation.py` |
| `e94f934` | B | 28 new detection categories, `jwt_analyzer.go`, BOLA tracker in `session_tracker.go` |

### Phase Completion Audit

| Phase | What | Status | Evidence |
|---|---|---|---|
| **A** | Redis reputation + rolling feature store | ⚠️ PARTIAL | `redisSecurityClient.js` ✅ created in `services/` ; `redis_reputation.py` ✅ ; Go proxy has no `go-redis` dep and no reputation package — the Go short-circuit (rep score > 80 → skip Tier 1) is not implemented |
| **B** | JWT analyzer, BOLA tracker, new 28 categories | ✅ COMPLETE | `jwt_analyzer.go` ✅ ; `session_tracker.go` BOLA extension ✅ ; 28 constants in `detection.go` ✅ |
| **C** | CAPTCHA gate | ⚠️ PARTIAL | `captcha.middleware.js` ✅ in `middleware/` ; `CaptchaGate.jsx` ✅ in `components/` ; not wired into `Login.jsx`/`Register.jsx` (no import CaptchaGate found in `pages/`) ; captcha middleware not applied on any route |
| **D** | Sandbox target + labeled traffic generation | ✅ COMPLETE | `sandbox/docker-compose.sandbox.yml` ✅ ; `sandbox/generate_labeled_traffic.sh` ✅ |
| **E** | Train Models #1 & #3 (unsupervised, no labels) | ❌ NOT STARTED | `ML/models/` is empty (only `.gitkeep`) ; `train_models.py` http-anomaly / flow-anomaly not yet run |
| **F** | Train Model #2 (web attack classifier, supervised) | ❌ NOT STARTED | Needs Phase D sandbox run + labeled JSONL first |
| **G** | FastAPI scoring service + Go proxy wiring | ⚠️ PARTIAL | `scoring_service.py` ✅ written ; uvicorn never started ; Go proxy has no `net/http` call to ML service — `ml_client.go` doesn't exist |
| **H** | Dashboard: blocklist page, block/unblock, live feed | ⚠️ PARTIAL | Backend APIs live (`/api/admin/blocked` registered in `server.js`) ; `block.controller.js` + `block.routes.js` ✅ ; `AdminManageBlocklist.jsx` does not exist ; no socket `block:new` listener in frontend ; sidebar has no link to blocklist |

---

## 2. Architecture Overview

```text
Traffic → Go Proxy
    → Tier 1: Go rules/regex (behavioral.go, http_analyzer.go, jwt_analyzer.go, etc.)
    → Tier 2: Redis reputation lookup  ← GO SIDE NOT WIRED
    → Tier 3: FastAPI ML service       ← NOT STARTED
    → Cross-Layer Decision Engine → Allow / Alert / Auto-Block / Tarpit
    → MongoDB + Socket.IO → Web Dashboard (block/unblock, live feed)  ← UI MISSING
```

---

## 3. Pending Work — Ordered Execution Plan

> [!IMPORTANT]
> Start with **Phase A** (Go Redis gap) → then **Phase E** (train models) in parallel with **Phase G** (Go wiring) → then **Phase F** → then **Phase H** (dashboard). This is the same ordering the Master Plan specifies. Do not skip Go Redis — without it, the Tier-2 short-circuit never fires.

---

### ✅ PHASE A (partial) — Complete Go Redis Reputation Package

> Remaining work only — Node and Python Redis are already done.

#### Task A.1 — Add go-redis dependency to `Security/go.mod`
- **File**: `Security/go.mod`
- **Command**:
```bash
cd Security && go get github.com/redis/go-redis/v9
```
- **Verify**: `go.mod` now lists `github.com/redis/go-redis/v9`

#### Task A.2 — Create `Security/reputation/` Go package
- **New file**: `Security/reputation/reputation.go`
- **Contents**:
```go
package reputation

import (
    "context"
    "fmt"
    "strconv"
    "time"

    "github.com/redis/go-redis/v9"
)

const repDB = 0

type Client struct {
    rdb *redis.Client
}

func New(addr string) *Client {
    return &Client{
        rdb: redis.NewClient(&redis.Options{Addr: addr, DB: repDB}),
    }
}

// GetScore returns the current reputation score (0-100) for an IP.
// Returns 0 if not found (unknown IP = not yet bad).
func (c *Client) GetScore(ctx context.Context, ip string) (int, error) {
    key := fmt.Sprintf("rep:ip:%s", ip)
    val, err := c.rdb.HGet(ctx, key, "score").Result()
    if err == redis.Nil {
        return 0, nil
    }
    if err != nil {
        return 0, err
    }
    return strconv.Atoi(val)
}

// IsKnownBad checks the threat-intel feed SET for a given IP.
func (c *Client) IsKnownBad(ctx context.Context, ip string) (bool, error) {
    feeds := []string{"rep:feed:abuseipdb", "rep:feed:spamhaus_drop", "rep:feed:firehol"}
    for _, feed := range feeds {
        ok, err := c.rdb.SIsMember(ctx, feed, ip).Result()
        if err != nil {
            return false, err
        }
        if ok {
            return true, nil
        }
    }
    return false, nil
}

// BumpScore increments the reputation score on a detection event.
func (c *Client) BumpScore(ctx context.Context, ip string, delta int) error {
    key := fmt.Sprintf("rep:ip:%s", ip)
    pipe := c.rdb.Pipeline()
    pipe.HIncrBy(ctx, key, "score", int64(delta))
    pipe.HSet(ctx, key, "last_seen", time.Now().Unix())
    pipe.Expire(ctx, key, 24*time.Hour)
    _, err := pipe.Exec(ctx)
    return err
}

// IsBlocked checks the fast-path gate:blocked key (Mongo is source of truth).
func (c *Client) IsBlocked(ctx context.Context, ip string) (bool, error) {
    key := fmt.Sprintf("gate:blocked:%s", ip)
    exists, err := c.rdb.Exists(ctx, key).Result()
    return exists > 0, err
}
```
- **Verify**: `cd Security && go build ./reputation/`

#### Task A.3 — Wire reputation into Go proxy's per-connection handler
- **File to modify**: `Security/proxy/proxy.go` (or `listener.go` — wherever per-connection handling begins)
- **What to do**:
  1. Instantiate `reputation.New(os.Getenv("REDIS_SECURITY_URL"))` at startup.
  2. At the top of each connection handler, call `GetScore(ctx, srcIP)`:
     - If score > 80 → short-circuit to block, skip Tier 1 regex.
     - If `IsBlocked(ctx, srcIP)` → short-circuit to block.
  3. After Tier 1 fires a detection, call `BumpScore(ctx, srcIP, delta)` where delta is severity-weighted (e.g. CRITICAL=20, HIGH=10, MEDIUM=5, LOW=1).
  4. **Environment variable**: Add `REDIS_SECURITY_URL` to `.env` / `proxy_config.yaml`.
- **Verify**: `go build ./...` from `Security/` passes.

#### Task A.4 — Feed ingestion cron script
- **New file**: `Security/reputation/feed_ingest.go` (standalone binary, main package, or a goroutine launched at proxy startup)
- **Feeds to implement first**:
  - AbuseIPDB — HTTP GET with API key, write each IP to `SADD rep:feed:abuseipdb {ip}`
  - Spamhaus DROP plain text: `https://www.spamhaus.org/drop/drop.txt`
  - FireHOL Level 1: `https://iplists.firehol.org/files/firehol_level1.netset`
- **Schedule**: Run as a goroutine with `time.Ticker` every 6 hours.
- **Verify**: After running, `redis-cli -n 0 SCARD rep:feed:abuseipdb` returns > 0.

---

### ❌ PHASE E — Train Unsupervised Models (#1 HTTP Anomaly, #3 Flow Anomaly)

> [!NOTE]
> These need no labeled data. Just run baseline (non-attack) traffic through the Go proxy, collect the JSONL logs, then run `train_models.py`. Do this before Phase F.

#### Task E.1 — Collect baseline traffic logs
- **Action**:
  1. Start the Go proxy in front of a real or sandboxed benign target.
  2. Browse normally for 30–60 min OR replay a benign synthetic script.
  3. Confirm zero attack-category detections fired during the window (check logs).
- **Output files needed by `train_models.py`**:
  - `logs/protocols/http.jsonl` — one `PayloadStats` JSON per line (already emitted by `payload_stats.go`).
  - `logs/protocols/flow.jsonl` — one `FlowRecord` JSON per line (emitted by `flow_logger.go`).
- **Verify**: Each file has > 500 lines for a usable model.

#### Task E.2 — Train Model #1 (HTTP Payload Anomaly — Isolation Forest)
- **Command**:
```bash
cd ML
pip install -r requirements.txt
python train_models.py http-anomaly \
    --input ../logs/protocols/http.jsonl \
    --output models/http_anomaly_v1.pkl
```
- **Expected output**: `models/http_anomaly_v1.pkl` created ; training metrics printed to stdout.
- **Sanity-check**: Run against a held-out attack log (e.g. a single sqlmap line). Attack rows should score noticeably higher (more anomalous) than benign rows.
- **Verify**: `ls -lh ML/models/http_anomaly_v1.pkl` shows the file.

#### Task E.3 — Train Model #3 (Flow-level Anomaly — Isolation Forest)
- **Command**:
```bash
cd ML
python train_models.py flow-anomaly \
    --input ../logs/protocols/flow.jsonl \
    --output models/flow_anomaly_v1.pkl
```
- **Bootstrap option**: If your own baseline log is too small (< 500 rows), bootstrap with CIC-IDS2017 benign-only subset (download from UNB CIC Datasets). Convert its CSV to `FlowRecord` JSON using the column mapping in `feature_encoder.py`'s `FLOW_FEATURE_COLUMNS`.
- **Verify**: `ls -lh ML/models/flow_anomaly_v1.pkl`

---

### ⚠️ PHASE G — FastAPI Scoring Service + Go Proxy Wiring

> [!IMPORTANT]
> The FastAPI code (`scoring_service.py`) is already written. Step G.1 just runs it. Step G.2 is the missing Go HTTP client.

#### Task G.1 — Start the FastAPI scoring service
- **Command**:
```bash
cd ML
uvicorn scoring_service:app --host 0.0.0.0 --port 8500 --reload
```
- **Health check**: `curl http://localhost:8500/health` → returns JSON with loaded model versions.
- **Note**: Service will start even if model `.pkl` files don't exist yet — it will return `risk_score=0` with `model_version="unavailable"` until models are trained (Phase E).
- **For production / always-on**: Add a systemd unit or docker-compose service for the ML service.
- **Verify**:
```bash
curl -s -X POST http://localhost:8500/score/http-payload \
    -H "Content-Type: application/json" \
    -d '{"payload_stats": {"entropy": 4.2, "length": 120}}' | jq .
```

#### Task G.2 — Create `Security/detect/ml_client.go` (Go → FastAPI HTTP client)
- **New file**: `Security/detect/ml_client.go`
- **Full implementation**:
```go
package detect

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

const mlServiceURL = "http://localhost:8500"
const mlTimeout = 50 * time.Millisecond  // HARD REQUIREMENT: fail-open on timeout

var mlHTTPClient = &http.Client{Timeout: mlTimeout}

type MLScoreRequest struct {
    PayloadStats map[string]interface{} `json:"payload_stats,omitempty"`
    FlowRecord   map[string]interface{} `json:"flow_record,omitempty"`
}

type MLScoreResponse struct {
    RiskScore         float64 `json:"risk_score"`
    PredictedCategory string  `json:"predicted_category"`
    Confidence        float64 `json:"confidence"`
    ModelVersion      string  `json:"model_version"`
}

// ScoreHTTPPayload calls the ML service for HTTP payload anomaly + classification.
// On timeout or service-down, returns risk_score=0 (fail-open — ML outage must
// never block the proxy).
func ScoreHTTPPayload(ctx context.Context, stats map[string]interface{}) (*MLScoreResponse, error) {
    return scoreML(ctx, mlServiceURL+"/score/http-payload", MLScoreRequest{PayloadStats: stats})
}

// ScoreFlow calls the ML service for flow-level anomaly scoring.
func ScoreFlow(ctx context.Context, flow map[string]interface{}) (*MLScoreResponse, error) {
    return scoreML(ctx, mlServiceURL+"/score/flow", MLScoreRequest{FlowRecord: flow})
}

func scoreML(ctx context.Context, url string, payload MLScoreRequest) (*MLScoreResponse, error) {
    body, err := json.Marshal(payload)
    if err != nil {
        return failOpen(), nil  // serialization error → fail-open
    }
    req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
    if err != nil {
        return failOpen(), nil
    }
    req.Header.Set("Content-Type", "application/json")
    resp, err := mlHTTPClient.Do(req)
    if err != nil {
        // timeout, connection refused, etc → fail-open
        return failOpen(), nil
    }
    defer resp.Body.Close()

    var result MLScoreResponse
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return failOpen(), nil
    }
    return &result, nil
}

func failOpen() *MLScoreResponse {
    return &MLScoreResponse{
        RiskScore:    0,
        ModelVersion: "unavailable",
    }
}
```
- **Verify**: `cd Security && go build ./detect/`

#### Task G.3 — Call ML client from HTTP analyzer after Tier 1
- **File to modify**: `Security/detect/http_analyzer.go`
- **Where**: After existing Tier-1 checks run and before the function returns, add:
```go
// Tier 3 — ML scoring (fail-open: if ML service is slow/down, mlScore = 0)
statsMap := payloadStatsToMap(ps)   // ps is the PayloadStats already computed
mlScore, _ := ScoreHTTPPayload(ctx, statsMap)
if mlScore != nil && mlScore.RiskScore > 0 {
    // Combine with existing risk signal
    // If ML score is HIGH but Tier-1 missed it, still emit a detection
    if mlScore.RiskScore > 70 && len(detections) == 0 {
        detections = append(detections, Detection{
            ID:       fmt.Sprintf("ML-HTTP-%s", mlScore.PredictedCategory),
            Category: mlScore.PredictedCategory,
            Severity: SevMedium,  // ML-only detections default to MEDIUM until validated
            Detail:   fmt.Sprintf("ML anomaly score %.1f (model %s)", mlScore.RiskScore, mlScore.ModelVersion),
        })
    }
}
```
- **Verify**: `go build ./...` passes ; in logs after a sqlmap run, you see `ML-HTTP-` prefixed detections alongside Tier-1 hits.

---

### ❌ PHASE F — Train Supervised Model #2 (Web Attack Classifier)

> [!NOTE]
> Needs Phase D sandbox output. Run after you've completed at least one full `generate_labeled_traffic.sh` run against DVWA/Juice Shop.

#### Task F.1 — Run the sandbox and generate labeled traffic
- **Commands**:
```bash
# 1. Start the sandbox
docker compose -f sandbox/docker-compose.sandbox.yml up -d

# 2. Configure Go proxy to forward to the sandbox containers
# Edit Security/proxy_config.yaml: backend = http://dvwa-container:80

# 3. Run the labeling script
bash sandbox/generate_labeled_traffic.sh

# 4. Confirm output
ls -lh logs/protocols/http.jsonl  # should be >> 500 lines now with attack rows
```
- **Verify**: JSONL log has a `label` field on attack rows (`sqli`, `xss`, `recon`, `bot_scanner`).

#### Task F.2 — Train Model #2 (Random Forest web attack classifier)
- **Command**:
```bash
cd ML
python train_models.py web-classifier \
    --input ../logs/protocols/http.jsonl \
    --output models/web_attack_v1.pkl
```
- **Expected output**:
  - `models/web_attack_v1.pkl` saved.
  - Per-class precision/recall/F1 printed (`classification_report`).
  - Top-10 feature importances printed (viva slide content).
  - 5-fold CV macro-F1 with std printed.
- **Sanity target**: Recall on `sqli` class ≥ 0.80 (acceptable for first iteration).
- **If recall is poor**: Check for class-imbalance (add more benign traffic rows via normal browsing). Do NOT retune hyperparameters first — fix data quality first.
- **Verify**: `ls -lh ML/models/web_attack_v1.pkl`

#### Task F.3 — (Stretch) Train Model #4 — SSH Brute-Force Classifier
- Only after F.2 is working.
- **Requires**: Hydra/Medusa SSH traffic through the proxy labeled `bruteforce`.
- **Command**:
```bash
python train_models.py ssh-brute-classifier \
    --input ../logs/protocols/ssh.jsonl \
    --output models/ssh_brute_v1.pkl
```

#### Task F.4 — (Stretch) Train Model #5 — DNS Tunneling/DGA Detector
- **Requires**: dnscat2/iodine tunnel traffic labeled `dns_tunnel` and Bambenek DGA domain list.
- **Command**:
```bash
python train_models.py dns-tunnel-dga \
    --input ../logs/protocols/dns.jsonl \
    --output models/dns_dga_v1.pkl
```

---

### ⚠️ PHASE C (partial) — Wire CAPTCHA into Frontend & Backend

Files exist but are not connected. This is pure wiring — no new code to write.

#### Task C.1 — Import and render `<CaptchaGate>` in `Login.jsx` & `Register.jsx`
- **File to modify**: `Web/frontend/src/pages/Login.jsx` (and `Register.jsx`)
- **Logic**:
  1. On form submit, if backend returns `{ captcha_required: true }` with HTTP 403, set state `showCaptcha = true`.
  2. Render `<CaptchaGate sitekey={import.meta.env.VITE_CAPTCHA_SITEKEY} onToken={handleCaptchaToken} />` when `showCaptcha` is true.
  3. On `onToken(token)`, re-submit the login form with header `X-Captcha-Token: <token>`.

#### Task C.2 — Apply `captcha.middleware.js` on login/register routes
- **File to modify**: `Web/backend/src/routes/auth.routes.js`
- **Change**:
```javascript
const captchaMiddleware = require('../middleware/captcha.middleware');

// Apply before the login handler:
router.post('/login', captchaMiddleware, authController.login);
router.post('/register', captchaMiddleware, authController.register);
```
- **Environment variable**: `CAPTCHA_SECRET_KEY` must be set in `.env` (from Cloudflare Turnstile or hCaptcha dashboard).
- **Verify**: Rapid repeated login attempts trigger a `captcha_required: true` response from the backend.

---

### ⚠️ PHASE H — Dashboard: Blocklist Page

Backend is live. Only frontend is missing.

#### Task H.1 — Create `AdminManageBlocklist.jsx`
- **New file**: `Web/frontend/src/pages/AdminManageBlocklist.jsx`
- **Features required**:
  - Fetch `GET /api/admin/blocked` on mount → display table of `BlockedEntity` records.
  - Columns: IP / Target, Type, Action, Reason, Mode (auto/manual), Risk Score at Block, Expires At, Status, Unblock.
  - Unblock button → `PATCH /api/admin/blocked/:id/unblock`.
  - Manual Block form: input IP, select action (block/tarpit/rate_limit), reason → `POST /api/admin/blocked`.
  - Filter buttons: All | Active | Unblocked | Manual | Automatic.
  - Live updates: Socket.IO listener for `block:new` event → prepend new record to table without full reload.
  - Auto-block settings panel: Form to GET/PATCH `/api/admin/thresholds` for `autoBlockEnabled`, `autoBlockThreshold`, `autoAlertThreshold`.
- **Design reference**: Follow the same table/filter pattern as `AdminManageNetwork.jsx` and `AdminManageThreats.jsx`.

#### Task H.2 — Register `/admin/blocklist` route in App router
- **File to modify**: `Web/frontend/src/App.jsx`
- **Change**: Add:
```jsx
import AdminManageBlocklist from './pages/AdminManageBlocklist';
// ...
<Route path="/admin/blocklist" element={<AdminRoute><AdminManageBlocklist /></AdminRoute>} />
```

#### Task H.3 — Add sidebar navigation link
- **File to modify**: `Web/frontend/src/components/AdminSidebar.jsx`
- **Change**: Add a nav entry for "Blocklist" (after Network or Threats section), linking to `/admin/blocklist`. Use a ShieldX or Ban icon from `lucide-react` (already installed).

#### Task H.4 — Add "Block" action button to `AdminManageNetwork.jsx`
- **File to modify**: `Web/frontend/src/pages/AdminManageNetwork.jsx`
- **Change**: For each row with a source IP, add a Block button that calls `POST /api/admin/blocked` with `mode: "manual"`. Show a confirmation modal before submitting.

---

## 4. Progress Tracker & End-to-End Verification

### Progress Tracker

Update this table as you complete each task. Mark `[x]` when done.

| Task | Description | Status | Owner |
|---|---|---|---|
| A.1 | `go get github.com/redis/go-redis/v9` | [ ] | Suraj |
| A.2 | Create `Security/reputation/reputation.go` | [ ] | Suraj |
| A.3 | Wire reputation check into proxy connection handler | [ ] | Suraj |
| A.4 | Feed ingestion goroutine (AbuseIPDB, Spamhaus, FireHOL) | [ ] | Yash |
| E.1 | Collect baseline traffic JSONL logs (http + flow) | [x] | All |
| E.2 | Train Model #1 — http-anomaly Isolation Forest | [x] | Shraddha / Abhijit |
| E.3 | Train Model #3 — flow-anomaly Isolation Forest | [x] | Shraddha / Abhijit |
| G.1 | Start FastAPI scoring service on port 8500 | [ ] | Yash |
| G.2 | Create `Security/detect/ml_client.go` | [ ] | Suraj |
| G.3 | Call ML client from `http_analyzer.go` after Tier 1 | [ ] | Suraj |
| F.1 | Run sandbox + `generate_labeled_traffic.sh` | [ ] | Abhijit |
| F.1a| Run GoTestWAF for evasive API payload generation| [ ] | Suraj |
| F.1b| Download/Ingest LLM Jailbreak dataset payloads  | [ ] | Suraj |
| F.2 | Train Model #2 — web-classifier Random Forest | [ ] | Shraddha / Abhijit |
| F.3 | (Stretch) Train Model #4 — SSH brute-force | [ ] | Abhijit |
| F.4 | (Stretch) Train Model #5 — DNS DGA | [ ] | Abhijit |
| C.1 | Wire `<CaptchaGate>` into `Login.jsx` + `Register.jsx` | [ ] | Shraddha |
| C.2 | Apply `captcha.middleware.js` on auth routes | [ ] | Suraj |
| H.1 | Create `AdminManageBlocklist.jsx` | [ ] | Shraddha |
| H.2 | Register `/admin/blocklist` route in App router | [ ] | Shraddha |
| H.3 | Add Blocklist link to `AdminSidebar.jsx` | [ ] | Shraddha |
| H.4 | Add "Block" button to `AdminManageNetwork.jsx` | [ ] | Shraddha |

### End-to-End Verification Checklist (Phase I equivalent)

Run this when all tasks above are checked:

- [ ] `cd Security && go build ./...` passes cleanly
- [ ] `uvicorn scoring_service:app --port 8500` starts, `/health` returns loaded model versions
- [ ] `docker compose -f sandbox/docker-compose.sandbox.yml up -d` brings up DVWA + Juice Shop
- [ ] Normal browsing through the Go proxy → no false-positive blocks, ML service returns `risk_score < 30`
- [ ] `sqlmap -u "http://localhost:<port>/vulnerabilities/sqli/?id=1&Submit=Submit" --batch` → Tier-1 fires + ML service returns `risk_score > 70` on attack rows
- [ ] `BlockedEntity` record appears in MongoDB for the sqlmap source IP
- [ ] `AdminManageBlocklist.jsx` shows the blocked IP live via Socket.IO `block:new`
- [ ] Clicking "Unblock" clears `gate:blocked:{ip}` in Redis and `BlockedEntity.status = "unblocked"` in Mongo
- [ ] sqlmap restarts and succeeds (confirming the IP is truly unblocked end-to-end)
- [ ] Rapid login attempts to `/api/auth/login` → `captcha_required: true` response after threshold

---

## 5. Scope & Datasets Reference

### Explicit Out-of-Scope (state in report)

| Item | Reason |
|---|---|
| Online/continuous learning | Scheduled batch retraining only (too risky without robust human-in-the-loop) |
| Deep learning (LSTM/Transformer) | Traditional ML sufficient and more defensible for tabular, moderate-volume data |
| Custom CAPTCHA image generation | Use Cloudflare Turnstile; our contribution is the adaptive trigger logic |
| L2 threats (ARP spoofing, MAC flooding) | Proxy operates at L3/4/7 — correct out-of-scope for proxy-based IDS |
| Model #8 SMTP spam classifier | Lowest priority; build only if time remains after items E/F/G/H are done |

### Datasets — Manual Download List

> [!IMPORTANT]
> Download these manually and place them in `ML/datasets/<dataset-name>/`. Do **NOT** commit raw dataset files to git — add `ML/datasets/` to `.gitignore`. Only your processed/feature Parquet files go in the repo.

#### Category 1 — Public Labeled Network/Flow Datasets
*(Used to train and bootstrap Models #1, #2, #3, #4, #5)*

| # | Dataset | Models it feeds | Size (approx) | Download URL | Format | Priority |
|---|---|---|---|---|---|---|
| D1 | CIC-IDS2017 (Canadian Institute for Cybersecurity) | #3 Flow Anomaly (primary bootstrap); also #4 SSH-Patator subset | ~1.2 GB CSV | `https://www.unb.ca/cic/datasets/ids-2017.html` — fill in free form, get direct download link | CSV (CICFlowMeter format — matches your FlowRecord schema directly) | 🔴 CRITICAL |
| D2 | CIC-IDS2018 (Canadian Institute for Cybersecurity) | #3 Flow Anomaly (secondary/extended); infiltration + lateral movement patterns | ~7 GB CSV | `https://www.unb.ca/cic/datasets/ids-2018.html` — AWS S3 bucket link provided after form fill | CSV | 🟠 HIGH |
| D3 | CIC-DDoS2019 | #3 Flow Anomaly for DDoS shapes; CatDDoS, CatDNSAmplification, CatUDPAmplification | ~2 GB CSV | `https://www.unb.ca/cic/datasets/ddos-2019.html` | CSV | 🟠 HIGH |
| D4 | CSIC 2010 HTTP Dataset | #1 HTTP Anomaly + #2 Web Classifier bootstrap (labeled normal/anomalous HTTP) | ~130 MB | `https://www.isi.csic.es/dataset/` — request via email form | ARFF / CSV | 🟠 HIGH |
| D5 | UNSW-NB15 | #3 Flow Anomaly cross-validation; fuzzers, backdoors, exploits, shellcode | ~100 MB CSV | `https://research.unsw.edu.au/projects/unsw-nb15-dataset` | CSV + PCAP | 🟡 MEDIUM |
| D6 | CTU-13 Botnet Dataset (Stratosphere IPS) | #3 Flow Anomaly — beaconing, C2, lateral movement; CatBeaconing, CatC2 | ~5 GB PCAP | `https://www.stratosphereips.org/datasets-ctu13` | PCAP + NetFlow CSV | 🟡 MEDIUM |
| D7 | Bambenek Consulting DGA Feed (snapshot archive) | #5 DNS DGA Detector — known DGA domain families | Daily/archive | `https://osint.bambenekconsulting.com/feeds/` — free non-commercial; use dga.txt | Plain text (one domain per line) | 🟡 MEDIUM |
| D8 | Netlab 360 DGA Feed | #5 DNS DGA Detector — DGA family labels (alternative/complement to Bambenek) | Variable | `https://data.netlab.360.com/dga/` | Plain text | 🟡 MEDIUM |
| D9 | SpamAssassin Public Corpus | #8 SMTP Spam Classifier (stretch) | ~24 MB | `https://spamassassin.apache.org/old/publiccorpus/` | mbox/text files | 🟢 LOW |
| D10 | Enron-Spam Dataset | #8 SMTP Spam Classifier (stretch) | ~50 MB | `http://www.aueb.gr/users/ion/data/enron-spam/` | Plain text email files | 🟢 LOW |
| D11 | Nazario Phishing Corpus | #8 Phishing Classifier (stretch) | ~10 MB | Hosted publicly on GitHub: search "Nazario phishing corpus" — multiple mirror repos | mbox | 🟢 LOW |

#### Category 2 — Payload / Signature Reference Libraries
*(Strengthen Tier-1 regex AND bootstrap weak-labels for Tier-3 training)*

| # | Resource | Purpose | URL | Notes |
|---|---|---|---|---|
| P1 | PayloadsAllTheThings | Comprehensive payload library — SQLi, XSS, SSRF, XXE, SSTI, cmd-injection, LFI/RFI, BOLA, deserialization, path traversal, JWT attacks | `https://github.com/swisskyrepo/PayloadsAllTheThings` | git clone into `ML/datasets/payloads/` |
| P2 | SecLists | Wordlists for brute-force, fuzzing, directory discovery, credential stuffing | `https://github.com/danielmiessler/SecLists` | Large (~1.3 GB) — clone selectively or use sparse checkout |
| P3 | OWASP Core Rule Set (CRS) | Production-grade Tier-1 regex upgrade reference AND weak-labeling function (CRS match → weak attack label) | `https://github.com/coreruleset/coreruleset` | Use `rules/*.conf` files as reference |
| P4 | Nuclei Templates | Per-CVE attack signatures in YAML — SSH, RDP, HTTP CVEs (Model #11 CVE matcher) | `https://github.com/projectdiscovery/nuclei-templates` | Focus on `network/`, `http/cves/` folders |
| P5 | OWASP API Security Top 10 Test Suite | BOLA, BFLA, Mass Assignment, API Resource Abuse test cases (feeds Model #9) | `https://github.com/OWASP/API-Security` | Use alongside crAPI sandbox |
| P6 | crAPI (Completely Ridiculous API) | Sandboxed vulnerable API app for BOLA/BFLA/mass-assignment labeled traffic generation | `https://github.com/OWASP/crAPI` | `docker compose up` |
| P7 | DVGA (Damn Vulnerable GraphQL App) | Labeled GraphQL abuse traffic (introspection, batching/alias DoS, injection) for CatGraphQLAbuse | `https://github.com/dolevf/Damn-Vulnerable-GraphQL-Application` | `docker run` |
| P8 | ysoserial | Java deserialization gadget-chain payload generation for CatInsecureDeserialization | `https://github.com/frohoff/ysoserial` | Payload generation only — do not use against live systems |

---

## 6. External Feeds & Integration List

> [!NOTE]
> These are live, recurring data sources. Unlike the datasets above (one-time downloads), feeds must be ingested on a schedule (cron/goroutine). Integration point: Task A.4 (`Security/reputation/feed_ingest.go`) + Task A.2 (`rep:feed:*` Redis keys in DB 0).

#### Tier 2 — IP Reputation Feeds (populate `rep:feed:*` Redis sets)

| # | Feed | What it provides | Refresh | Integration method | Auth needed | URL / API |
|---|---|---|---|---|---|---|
| F1 | AbuseIPDB Blacklist | Known-bad IPs (confidence ≥ 100) | 6–12h | GET `https://api.abuseipdb.com/api/v2/blacklist` → parse JSON array → `SADD rep:feed:abuseipdb {ip}` | Free API key (register at abuseipdb.com) | `https://www.abuseipdb.com/api` |
| F2 | Spamhaus DROP (Don't Route Or Peer) | Known-bad CIDR ranges — top-tier spam/malware netblocks | 6–12h | Plain text: GET `https://www.spamhaus.org/drop/drop.txt` → parse CIDRs → store in memory (not Redis SET — use `cidranger` Go library for lookup) | None | `https://www.spamhaus.org/drop/` |
| F3 | Spamhaus EDROP (Extended DROP) | Hijacked/leased CIDR ranges used by criminals | 6–12h | Same as F2 — `https://www.spamhaus.org/drop/edrop.txt` | None | Same page |
| F4 | FireHOL Level 1 | Aggregated top-priority bad-IP list (composite of multiple feeds) | 6–12h | Plain text: GET `https://iplists.firehol.org/files/firehol_level1.netset` → `SADD rep:feed:firehol_l1 {ip}` | None | `https://iplists.firehol.org/` |
| F5 | CINS Army List | Hosts actively attacking honeypots | 6–12h | Plain text: GET `http://cinsscore.com/list/ci-badguys.txt` → `SADD rep:feed:cins {ip}` | None | `http://cinsscore.com/` |
| F6 | GreyNoise Community API | Internet-scanner/noise classification (good-noise vs. bad-noise vs. unknown) | Per-lookup (not batch) | GET `https://api.greynoise.io/v3/community/{ip}` per IP — returns noise: true/false, riot: true/false | Free API key | `https://www.greynoise.io/docs/api` |
| F7 | Tor Exit Node List | Tor exit relay IPs (reputation signal — not auto-block by default) | Daily | GET `https://check.torproject.org/torbulkexitlist` → `SADD rep:feed:tor_exit {ip}` | None | `https://check.torproject.org/torbulkexitlist` |
| F8 | Abuse.ch Feodo Tracker (botnet C2 IPs) | Active botnet C2 server IPs | 1h | GET `https://feodotracker.abuse.ch/downloads/ipblocklist.txt` → `SADD rep:feed:botnet_c2 {ip}` | None | `https://feodotracker.abuse.ch/` |
| F9 | AlienVault OTX (Open Threat Exchange) | Broad threat intel: IPs, domains, hashes, CVEs | Daily | OTX DirectConnect API: GET `https://otx.alienvault.com/api/v1/pulses/subscribed` — parse indicators | Free API key (register at otx.alienvault.com) | `https://otx.alienvault.com/api` |

#### Tier 2 — TLS / SSH Fingerprint Feeds (populate `rep:feed:ja3_bad` Redis set)

| # | Feed | What it provides | Refresh | Integration method | Auth needed | URL |
|---|---|---|---|---|---|---|
| F10 | Abuse.ch JA3 Feed | Known-malicious TLS client JA3 hashes (scanners, bots, malware) | Weekly | GET `https://sslbl.abuse.ch/blacklist/ja3_fingerprints.csv` → parse CSV → `SADD rep:feed:ja3_bad {ja3_hash}` | None | `https://sslbl.abuse.ch/blacklist/` |
| F11 | FoxIO JA4+ Database | Extended JA4/JA4S fingerprints (modern replacement for JA3) | As published | CSV download from their GitHub releases | None | `https://github.com/FoxIO-LLC/ja4/tree/main/technical_details` |
| F12 | HASSH Bad Fingerprint List (Salesforce) | Known SSH attack-tool HASSH hashes | As published | git pull snapshot into `rep:feed:hassh_bad` SET | None | `https://github.com/salesforce/hassh` — see `fingerprints/` folder |

#### Tier 2 — GeoIP (Dashboard + Reputation context)

| # | Feed | What it provides | Refresh | Integration method | Auth needed | URL |
|---|---|---|---|---|---|---|
| F13 | MaxMind GeoLite2 | Free GeoIP database (country, city, ASN) — geographic dashboard features + reputation context | Monthly | Download `.mmdb` binary DB from MaxMind, load with `github.com/oschwald/geoip2-golang` | Free account + license key | `https://dev.maxmind.com/geoip/geolite2-free-geolocation-data` |

#### Tier 1 — CVE / Vulnerability Feeds (Model #11 — CVE Signature Matcher)

| # | Feed | What it provides | Refresh | Integration method | Auth needed | URL |
|---|---|---|---|---|---|---|
| F14 | NVD (National Vulnerability Database) API 2.0 | Structured CVE data (CVSS score, CPE, description) | Daily | GET `https://services.nvd.nist.gov/rest/json/cves/2.0?cpeName=cpe:2.3:a:openssh:openssh:*` — filter by CPE per protocol | None (rate-limited; optional API key for higher limits) | `https://nvd.nist.gov/developers/vulnerabilities` |
| F15 | CISA KEV (Known Exploited Vulnerabilities) | CISA's list of actively-exploited CVEs — highest-priority patching/detection targets | Daily | GET `https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json` | None | `https://www.cisa.gov/known-exploited-vulnerabilities-catalog` |
| F16 | PhishTank Feed | Verified phishing URLs and domains | Daily | GET `http://data.phishtank.com/data/online-valid.csv` → extract domain column | Free API key | `https://www.phishtank.com/developer_info.php` |

### Feed Integration Priority Order

```text
Week 1 (unblocks Tier 2 completely):
  F1  AbuseIPDB          → rep:feed:abuseipdb        (needs API key — get first)
  F2  Spamhaus DROP      → CIDR in-memory ranger     (no auth, start here)
  F4  FireHOL Level 1    → rep:feed:firehol_l1       (no auth)
  F7  Tor Exit List      → rep:feed:tor_exit         (no auth)
  F10 Abuse.ch JA3 Feed  → rep:feed:ja3_bad          (no auth)
  F13 MaxMind GeoLite2   → mmdb file                 (needs free account)

Week 2 (extends coverage):
  F3  Spamhaus EDROP     → CIDR in-memory ranger
  F5  CINS Army          → rep:feed:cins
  F8  Feodo Tracker      → rep:feed:botnet_c2
  F12 HASSH bad list     → rep:feed:hassh_bad
  F14 NVD CVE API        → CVE signature store
  F15 CISA KEV           → high-priority CVE overlay

Week 3+ (stretch / lower priority):
  F6  GreyNoise          → per-lookup (needs API key)
  F9  AlienVault OTX     → needs API key + JSON parsing
  F11 JA4+ Database      → only if JA4 is implemented in Go
  F16 PhishTank          → only if building Model #8 SMTP classifier
```

### Feed Data Storage Map (Redis DB 0 keys)

```text
rep:feed:abuseipdb           → SET  of known-bad IPs
rep:feed:firehol_l1          → SET  of known-bad IPs
rep:feed:cins                → SET  of known-bad IPs
rep:feed:tor_exit            → SET  of Tor exit IPs
rep:feed:botnet_c2           → SET  of C2 IPs (Feodo Tracker)
rep:feed:ja3_bad             → SET  of known-bad JA3 hashes
rep:feed:hassh_bad           → SET  of known-bad HASSH hashes
spamhaus:drop:cidrs          → in-memory []net.IPNet (NOT Redis — needs CIDR lookup)
spamhaus:edrop:cidrs         → in-memory []net.IPNet
rep:feed:last_updated:{name} → STRING  ISO timestamp of last successful refresh
```

---

## 7. Self-Generated Attack Traffic — Tools & Labels

> [!NOTE]
> Run these against the sandbox only (`docker compose -f sandbox/docker-compose.sandbox.yml up -d`). Never against live systems. The labeling script `sandbox/generate_labeled_traffic.sh` already orchestrates the main tools — this table is the complete reference.

| Tool | Attack Category Generated | Labels to apply | Install command |
|---|---|---|---|
| `sqlmap --batch --tamper=all` | SQLi (blind, UNION, time-based, all encodings) | `sqli` | `pip install sqlmap` or `apt install sqlmap` |
| `nikto -h <target>` | Bot scanner, recon, info leakage probes | `bot_scanner`, `recon` | `apt install nikto` |
| `owasp-zap active scan` | XSS, SSRF, injection (mixed) | `xss`, `ssrf`, `mixed` | ZAP GUI or `docker run zaproxy/zap-stable` |
| `wfuzz` / `gobuster` / `dirb` | Directory brute-force, path traversal | `dir_bruteforce`, `path_traversal` | `apt install dirb gobuster` |
| `hydra -l root -P /usr/share/wordlists/rockyou.txt ssh://<target>` | SSH brute-force | `ssh_bruteforce` | `apt install hydra` |
| `hydra -l admin -P <wordlist> ftp://<target>` | FTP brute-force | `ftp_bruteforce` | Same |
| `medusa -h <target> -u root -P <list> -M ssh` | SSH/FTP/Telnet brute-force (Hydra alternative) | `ssh_bruteforce` | `apt install medusa` |
| `dnscat2` / `iodine` | DNS tunneling (data exfil simulation) | `dns_tunnel` | `apt install iodine` ; dnscat2 from GitHub |
| `commix --url=<target>` | Command injection / RCE | `cmd_injection` | `pip install commix` or `apt install commix` |
| `ssrfmap -r <request_file>` | SSRF, cloud-metadata targeting | `ssrf` | `https://github.com/swisskyrepo/SSRFmap` |
| `tplmap -u <url>` | SSTI (server-side template injection) | `ssti` | `https://github.com/epinna/tplmap` |
| `nosqlmap` | NoSQL injection | `nosqli` | `https://github.com/codingo/NoSQLMap` |
| `jwt_tool -t <target> -M at` | JWT alg:none, algorithm confusion | `jwt_attack` | `https://github.com/ticarpi/jwt_tool` |
| `inql` / `graphql-cop` vs DVGA | GraphQL introspection/batching abuse | `graphql_abuse` | `pip install inql graphql-cop` |
| `slowhttptest -c 1000 -H` | Slowloris DoS | `slowloris` | `apt install slowhttptest` |
| `hping3 --flood -S <target>` | SYN flood / volumetric DoS | `ddos_flood` | `apt install hping3` |
| Manual normal browsing (DVWA + Juice Shop) | Benign baseline | `benign` | (no tool — just browse normally) |

---

## 8. Reference Files

| File | Purpose |
|---|---|
| `00_MASTER_PLAN` | Build order, phase specs, Redis schema, CAPTCHA flow, ML training step-by-step |
| `01_Protocol_Threat_Matrix` | Every threat → tier → model → response → training data |
| `feature_encoder.py` | JSONL → numeric feature vectors for all models |
| `train_models.py` | All 5 training subcommands |
| `scoring_service.py` | FastAPI app: `/score/http-payload`, `/score/flow`, `/score/ssh`, `/score/dns` |
| `redis_reputation.py` | Python Redis client for reputation + behavioral feature building |
| `block.controller.js` | Block/unblock API — already live at `/api/admin/blocked` |
| `captcha.middleware.js` | Rate+IAT check → captcha challenge — needs wiring |
| `CaptchaGate.jsx` | React CAPTCHA widget — needs wiring into Login/Register |