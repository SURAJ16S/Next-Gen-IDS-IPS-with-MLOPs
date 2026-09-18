# Wave 6 — Pending Implementation Plan
> **Architecture-Verified** | 2026-09-16 | Stored in `Security/Planning/`

---

## Architecture Confirmation ✅

The system follows a **multi-tenant, node-scoped architecture**:

```
User (logs in) → Dashboard (their view only)
                      ↑
              Node.owner = User._id
                      ↑
          VPS (user's project deployed)
                      ↑
          Go Security Proxy (ngfw-monitor)
          → enrolls via token → gets nodeId + nodeSecret
          → sends detections to /api/agent/telemetry/detections
            with X-Node-Id + X-Node-Secret headers
          → backend attaches req.node (with req.node.owner = user._id)
          → all SecurityEvents / BlockedEntities tagged with node.owner
          → user sees ONLY their own node's data
```

**Key facts verified from code:**
- `Node.js` model has `owner: ObjectId → User` — the VPS belongs to the user who generated the enrollment token
- `EnrollmentToken.createdBy` = `req.user._id` → passes to `Node.owner`
- `agent.middleware.js` sets `req.node = node` (full node doc, including `.owner`)
- `SecurityEvent`, `NetworkEvent`, `BlockedEntity` models currently **do NOT have a `nodeId` or `owner` field** → **This is the critical gap to fix**
- Without `nodeId` on events, all users would see all detections — which is wrong

---

## Critical Gap: Event Models Need Node Scoping

Currently `SecurityEvent.js`, `NetworkEvent.js`, and `BlockedEntity.js` have **no node ownership field**. Fix this before any telemetry wiring.

---

## Wave 6 Tasks (Sequential Execution Order)

### WAVE 6A — Sidebar Nav Link (5 min, zero risk)

#### 6A.1 — Add "IP Blocklist" to AdminSidebar.jsx

- **File**: `Web/frontend/src/components/AdminSidebar.jsx`
- **Change**: Add `ShieldOff` to lucide-react import. Add to `adminNavItems`:
  ```js
  { to: '/admin/blocklist', label: 'IP Blocklist', icon: ShieldOff },
  ```
- **Position**: After `Cluster Nodes` entry (last in list).
- **Verify**: Admin panel shows "IP Blocklist" nav link → click → AdminManageBlocklist.jsx loads.

---

### WAVE 6B — Node-Scoped Telemetry Wiring (Core Integration)

> All 6B tasks must be done in order. 6B.1 is prerequisite for all others.

#### 6B.1 — Add nodeId + nodeOwner to event models

- **Files**: `SecurityEvent.js`, `NetworkEvent.js`, `BlockedEntity.js`
- **Add to each schema**:
  ```js
  nodeId:    { type: String, index: true },
  nodeOwner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  ```
- **Edge cases**: Existing docs in MongoDB get null fields — no migration needed. Old records simply won't appear in scoped queries.
- **Verify**: `npm run dev` in Web/backend — no crash.

#### 6B.2 — Create Security/streamer/dashboard_streamer.go

- **New file**: `Security/streamer/dashboard_streamer.go`
- **Purpose**: Non-blocking batched HTTP POST of Detection objects to `/api/agent/telemetry/detections`
- **Config env vars**: `DASHBOARD_URL`, `AGENT_NODE_ID`, `AGENT_NODE_SECRET`
- **Key design**: 500-event buffer, 2s flush interval, 5s HTTP timeout, drops silently when channel full
- **Edge cases**:
  - Empty `DASHBOARD_URL` → flush exits immediately, proxy unaffected
  - Dashboard down → 5s timeout fires, error logged, proxy continues
- **Verify**: `cd Security && go build ./...` passes.

#### 6B.3 — Wire DashboardStreamer into Security/main.go

- Import `"ngfw-monitor/streamer"`, create `s := streamer.New()`, launch `go s.Run(ctx)`
- Subscribe `s.Send(detection)` wherever DetectionBus emits to logger/TUI
- Use existing ctx so streamer flushes on SIGINT
- **Verify**: Proxy running → test request → backend logs show "Ingested"

#### 6B.4 — Update agent.controller.js: map Go fields + stamp nodeId/nodeOwner

- **Fix field mapping**: Go sends `Protocol`, `SrcIP`, `DstIP`, `Category`, `ID`, `SeverityStr`, `Detail`, `MLRiskScore`
- **Add normalization**: Protocol enum map (`http → HTTP`, etc.)
- **Stamp each event**: `nodeId: req.node.nodeId`, `nodeOwner: req.node.owner`
- **Use `{ ordered: false }`** in `insertMany` so one bad doc doesn't block the batch
- **Socket.IO**: Emit to both `owner:${req.node.owner}` room AND global broadcast
- **Verify**: Detection from Go proxy → Dashboard WebSocket tab shows `new_detection`

#### 6B.5 — Add per-user Socket.IO room join

- **File**: `Web/backend/src/websocket/socket.js`
- **Add** inside `io.on('connection')` for non-agent clients:
  ```js
  socket.on('join:myroom', (userId) => { socket.join(`owner:${userId}`); });
  ```
- **Frontend**: After socket connect, emit `socket.emit('join:myroom', user._id)`
- **Verify**: User A's browser only receives `owner:userA_id` scoped events

#### 6B.6 — Wire createAutomaticBlock for CRITICAL detections

- **File**: `Web/backend/src/controllers/agent.controller.js`
- After `insertMany`, loop detections: if `SeverityStr === 'critical'` and `SrcIP` present and no existing active block → call `createAutomaticBlock()`
- Stamp block with `nodeId` and `nodeOwner`
- Set `autoExpireSeconds: 3600` (1 hour, prevents permanent test blocks)
- Emit `block:new` to both owner room and global
- **Verify**: Critical detection from Go → BlockedEntities has new record → AdminManageBlocklist shows it live

#### 6B.7 — Scope user-facing queries by nodeOwner

- **Files**: `threat.controller.js`, `network.controller.js`, `logs.controller.js`
- **Pattern**: Add `{ nodeOwner: req.user._id }` to all `.find()` queries on user-facing routes
- **Admin routes** (`/api/admin/*`) must NOT scope — admins see all
- **Verify**: Two users logged in → each sees only their own node's events

---

### WAVE 6C — ML Model #2 Training

#### 6C.1 — Run sandbox + generate labeled traffic
```bash
cd Security
docker compose -f sandbox/docker-compose.sandbox.yml up -d
bash sandbox/generate_labeled_traffic.sh
```
- Verify: `wc -l logs/protocols/http.jsonl` > 500

#### 6C.2 — Train Model #2 (web-classifier)
```bash
cd Security/ML
python train_models.py web-classifier \
    --input ../logs/protocols/http.jsonl \
    --output models/web_attack_v1.pkl
```
- Target: sqli recall >= 0.80

#### 6C.3 — Restart FastAPI scoring service
```bash
uvicorn scoring_service:app --host 0.0.0.0 --port 8500 --reload
```
- Verify: `curl http://localhost:8500/health` shows all 3 models loaded

---

### WAVE 6D — GoTestWAF Benchmarking

#### 6D.1 — Pull image + clone testcases
```bash
docker pull wallarm/gotestwaf
git clone --depth=1 https://github.com/wallarm/gotestwaf.git /tmp/gotestwaf
```

#### 6D.2 — Verify prerequisites
- Go proxy on port 80, FastAPI on 8500, Redis running, proxy returns HTTP 403 for blocks

#### 6D.3 — Run scan
```bash
mkdir -p Security/reports
docker run --network="host" --rm -it \
  -v $(pwd)/Security/reports:/app/reports \
  wallarm/gotestwaf \
  --url=http://localhost:80 \
  --blockStatusCodes=403 \
  --noEmailReport
```
- Edge case: `--network=host` is required on Linux for localhost to resolve inside container

#### 6D.4 — Analyze + retrain if needed
- Target: overall >= 70% detection, <= 10% FP
- Weak category (< 50%) → add labeled rows → retrain (6C.2) → restart (6C.3) → re-scan (6D.3)

---

### WAVE 6E — DevOps + Security Deployment Integration

#### 6E.1 — Add ML scoring service to DevOps/docker-compose-devops.yml
```yaml
ml-scoring-service:
  build:
    context: ../Security/ML
    dockerfile: Dockerfile
  ports:
    - "8500:8500"
  volumes:
    - ../Security/ML/models:/app/models
  environment:
    - REDIS_SECURITY_URL=${REDIS_SECURITY_URL:-redis://redis:6379}
  restart: unless-stopped
```

#### 6E.2 — Create Security/ML/Dockerfile + .dockerignore
```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8500
CMD ["uvicorn", "scoring_service:app", "--host", "0.0.0.0", "--port", "8500"]
```
.dockerignore: `mlflow.db`, `mlruns/`, `__pycache__/`, `notebooks/`, `datasets/`

#### 6E.3 — Add env vars to Security/.env
```
DASHBOARD_URL=http://localhost:5000
AGENT_NODE_ID=<from-enrollment>
AGENT_NODE_SECRET=<plain-text-from-enrollment-response>
REDIS_SECURITY_URL=redis://localhost:6379
```
CAUTION: AGENT_NODE_SECRET must never be committed to git.

#### 6E.4 — Update LOCAL_TESTING_GUIDE.md
Full startup order: Redis → Backend → FastAPI → Go Proxy → Frontend → Enroll proxy → Monitor dashboard

---

## End-to-End Verification Checklist

- [ ] go build ./... passes in Security/
- [ ] Admin Sidebar shows "IP Blocklist" nav entry
- [ ] User A enrolls VPS → detections appear ONLY in User A's dashboard
- [ ] User B's dashboard shows nothing from User A's node
- [ ] Critical detection → BlockedEntities gets record with nodeId + nodeOwner
- [ ] AdminManageBlocklist.jsx shows live block via block:new Socket.IO
- [ ] Unblock from UI → Redis cleared → Mongo status = unblocked
- [ ] GoTestWAF report in Security/reports/ with detection >= 70%
- [ ] docker compose -f DevOps/docker-compose-devops.yml up brings up ML service

---

## Task Tracker Additions (copy to task_tracker.md)

```
## WAVE 6 — Dashboard Integration & DevOps Automation
- [ ] 6A.1  Add Blocklist link to AdminSidebar.jsx
- [ ] 6B.1  Add nodeId + nodeOwner to SecurityEvent, NetworkEvent, BlockedEntity models
- [ ] 6B.2  Create Security/streamer/dashboard_streamer.go
- [ ] 6B.3  Wire DashboardStreamer into Security/main.go DetectionBus
- [ ] 6B.4  Update agent.controller.js: map Go Detection fields + stamp nodeId/nodeOwner
- [ ] 6B.5  Add per-user Socket.IO room join (join:myroom event)
- [ ] 6B.6  Wire createAutomaticBlock for CRITICAL severity in agent.controller.js
- [ ] 6B.7  Scope user-facing API queries by nodeOwner in threat/network/logs controllers
- [ ] 6C.1  Run sandbox + generate_labeled_traffic.sh (http.jsonl > 500 rows)
- [ ] 6C.2  Train Model #2 (web-classifier Random Forest, recall sqli >= 0.80)
- [ ] 6C.3  Restart FastAPI scoring service, verify all 3 models loaded
- [ ] 6D.1  Pull GoTestWAF Docker image + clone testcases
- [ ] 6D.2  Verify all prerequisites before scan
- [ ] 6D.3  Run GoTestWAF scan → save report to Security/reports/
- [ ] 6D.4  Analyze report; retrain if category detection < 50%
- [ ] 6E.1  Add ml-scoring-service to DevOps/docker-compose-devops.yml
- [ ] 6E.2  Create Security/ML/Dockerfile + .dockerignore
- [ ] 6E.3  Add DASHBOARD_URL, AGENT_NODE_ID, AGENT_NODE_SECRET to .env files
- [ ] 6E.4  Update LOCAL_TESTING_GUIDE.md with full startup sequence
```
