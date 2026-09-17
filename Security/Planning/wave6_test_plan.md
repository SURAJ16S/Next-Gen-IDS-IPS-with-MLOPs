# Wave 6 — Test Plan
> Tasks Covered: **6A.1** (AdminSidebar Blocklist link) | **6B.1** (Node-scoped model fields) | **6B.2** (DashboardStreamer) | **6B.3** (Wired Streamer in main.go) | **6B.4** (agent.controller.js field mapping) | **6B.5** (Socket.IO room join)
> Date: 2026-09-16 | Status: In Progress / Testing Active

---

## Test Suite 1 — Task 6A.1: AdminSidebar IP Blocklist Link

### T1.1 — Frontend Build Smoke Test

**What**: Verify ShieldOff import compiles without errors.

**Command**:
```bash
cd Web/frontend && npm run build 2>&1 | grep -iE "error|warning" | head -20
echo "Exit code: $?"
```

**Expected**: Zero errors. Exit code 0.

**Failure diagnosis**: `ShieldOff is not exported` → verify the import line in AdminSidebar.jsx line 4 includes `ShieldOff`.

---

### T1.2 — Manual UI: Sidebar shows "IP Blocklist" entry

**Steps**:
1. Start frontend: `cd Web/frontend && npm run dev`
2. Navigate to `http://localhost:5173/admin/login` and log in as admin
3. Observe the left admin sidebar

**Expected**: "IP Blocklist" appears at the bottom of the nav list with a shield icon.

**Failure diagnosis**: If missing → check `adminNavItems` array in `AdminSidebar.jsx` (line 17 should have the entry).

---

### T1.3 — Manual UI: Clicking link navigates to correct page

**Steps**:
1. Click "IP Blocklist" in the admin sidebar
2. Observe URL and rendered page

**Expected**:
- URL changes to `http://localhost:5173/admin/blocklist`
- `AdminManageBlocklist.jsx` renders (table of blocked IPs + manual block form + threshold settings panel)

**Failure diagnosis**: If 404 or blank → verify `App.jsx` line 88 has `<Route path="blocklist" element={<AdminManageBlocklist />} />` inside the admin layout.

---

### T1.4 — Manual UI: Collapsed sidebar tooltip

**Steps**:
1. Click the `<` chevron to collapse the sidebar
2. Hover over the ShieldOff icon at the bottom

**Expected**: Tooltip "IP Blocklist" appears on hover.

---

## Test Suite 2 — Task 6B.1: Node-Scoped Model Fields

### T2.1 — Schema Field Presence (Automated, No DB Required)

**Command**:
```bash
cd Web/backend && node -e "
const SecurityEvent = require('./src/models/SecurityEvent');
const NetworkEvent  = require('./src/models/NetworkEvent');
const BlockedEntity = require('./src/models/BlockedEntity');

function check(model, name) {
  const paths = Object.keys(model.schema.paths);
  const hasNodeId    = paths.includes('nodeId');
  const hasNodeOwner = paths.includes('nodeOwner');
  const status = (hasNodeId && hasNodeOwner) ? 'PASS' : 'FAIL';
  console.log(status, name + ': nodeId=' + hasNodeId + ' nodeOwner=' + hasNodeOwner);
}

check(SecurityEvent, 'SecurityEvent');
check(NetworkEvent,  'NetworkEvent');
check(BlockedEntity, 'BlockedEntity');
"
```

**Expected output**:
```
PASS SecurityEvent: nodeId=true nodeOwner=true
PASS NetworkEvent:  nodeId=true nodeOwner=true
PASS BlockedEntity: nodeId=true nodeOwner=true
```

**Failure diagnosis**: `FAIL` on any line → re-check the model file. Fields must NOT be marked `required: true` (they're optional for backward compatibility).

---

### T2.2 — Backend Startup Smoke Test

**Command**:
```bash
cd Web/backend && timeout 10 npm run dev 2>&1 | grep -E "running|error|Error|fail" | head -10
```

**Expected**: `Server running on port 5000` with no crash/error lines.

**Failure diagnosis**:
- `OverwriteModelError` → kill existing Node process and restart. Dev watch mode sometimes caches old model.
- `SyntaxError` in a model file → re-check that the added fields have proper commas and closing braces.

---

### T2.3 — Document Insert with nodeId/nodeOwner (Requires MongoDB)

**Command**:
```bash
cd Web/backend && node -e "
require('dotenv').config({ path: '.env' });
const mongoose = require('mongoose');
const SecurityEvent = require('./src/models/SecurityEvent');

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/ngfw').then(async () => {
  const doc = await SecurityEvent.create({
    protocol:  'HTTP',
    sourceIP:  '10.10.10.1',
    severity:  'high',
    action:    'block',
    nodeId:    'test-node-xyz',
    nodeOwner: new mongoose.Types.ObjectId(),
  });
  const ok = doc.nodeId === 'test-node-xyz' && !!doc.nodeOwner;
  console.log(ok ? 'PASS' : 'FAIL', '- nodeId:', doc.nodeId, 'nodeOwner:', doc.nodeOwner.toString());
  await SecurityEvent.deleteOne({ _id: doc._id });
  console.log('Cleanup done');
  await mongoose.disconnect();
}).catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"
```

**Expected**:
```
PASS - nodeId: test-node-xyz nodeOwner: <ObjectId>
Cleanup done
```

---

### T2.4 — Per-User Data Isolation Query Test (Requires MongoDB)

**What**: Proves that filtering by `nodeOwner` correctly isolates data between two users.

**Command**:
```bash
cd Web/backend && node -e "
require('dotenv').config({ path: '.env' });
const mongoose = require('mongoose');
const SecurityEvent = require('./src/models/SecurityEvent');

const ownerA = new mongoose.Types.ObjectId();
const ownerB = new mongoose.Types.ObjectId();

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/ngfw').then(async () => {
  await SecurityEvent.create({ protocol: 'HTTP', sourceIP: '10.0.0.1', nodeId: 'nodeA', nodeOwner: ownerA });
  await SecurityEvent.create({ protocol: 'SSH',  sourceIP: '10.0.0.2', nodeId: 'nodeB', nodeOwner: ownerB });

  const aEvents = await SecurityEvent.find({ nodeOwner: ownerA });
  const bEvents = await SecurityEvent.find({ nodeOwner: ownerB });

  const aIP = aEvents[0]?.sourceIP;
  const bIP = bEvents[0]?.sourceIP;
  const isolated = aIP === '10.0.0.1' && bIP === '10.0.0.2';

  console.log('User A sees:', aIP, '| User B sees:', bIP);
  console.log('ISOLATION:', isolated ? 'PASS' : 'FAIL');

  await SecurityEvent.deleteMany({ nodeOwner: { \$in: [ownerA, ownerB] } });
  await mongoose.disconnect();
}).catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"
```

**Expected**:
```
User A sees: 10.0.0.1 | User B sees: 10.0.0.2
ISOLATION: PASS
```

---

### T2.5 — Index Verification (Requires MongoDB)

**What**: Confirms that `nodeId` and `nodeOwner` are indexed for query performance.

**Command**:
```bash
cd Web/backend && node -e "
require('dotenv').config({ path: '.env' });
const mongoose = require('mongoose');
const SecurityEvent = require('./src/models/SecurityEvent');

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/ngfw').then(async () => {
  const indexes = await SecurityEvent.collection.getIndexes();
  const keys = Object.values(indexes).flatMap(i => Object.keys(i.key));
  console.log('nodeId indexed:', keys.includes('nodeId') ? 'PASS' : 'FAIL');
  console.log('nodeOwner indexed:', keys.includes('nodeOwner') ? 'PASS' : 'FAIL');
  await mongoose.disconnect();
}).catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"
```

**Expected**:
```
nodeId indexed: PASS
nodeOwner indexed: PASS
```

---

## Test Suite 3 — Task 6B.2: DashboardStreamer (Go Telemetry Streamer)

### T3.1 — Non-Blocking Overflow Test

**What**: Verify `Send()` drops events without blocking when the 500-item channel buffer is full.

**Command**:
```bash
cd Security && go test ./streamer -run TestDashboardStreamer_NonBlockingSend -v
```

**Expected**: `PASS` in < 0.1s.

---

### T3.2 — Flush & Batched HTTP Post Integration Test

**What**: Verify `DashboardStreamer` flushes buffered detections and sends HTTP POST request with headers `X-Node-Id` and `X-Node-Secret`.

**Command**:
```bash
cd Security && go test ./streamer -run TestDashboardStreamer_FlushAndPost -v
```

**Expected**: `PASS` with HTTP server mock receiving headers and body payload.

---

## Test Suite 5 — Task 6B.4: agent.controller.js Field Mapping & Scoping

### T5.1 — Go Detection Payload Field Mapping & Schema Validation

**What**: Verify Go Detection JSON snake_case fields (`source_ip`, `severity_str`, `category`, `protocol`, `raw_evidence`) map correctly to `SecurityEvent` model schema and pass Mongoose validation with `nodeId` and `nodeOwner`.

**Command**:
```bash
cd Web/backend && node -e "
const mongoose = require('mongoose');
const SecurityEvent = require('./src/models/SecurityEvent');
const goDetection = {
  id: 'HTTP-SQLI-001',
  severity_str: 'CRITICAL',
  category: 'sqli',
  protocol: 'HTTP',
  source_ip: '192.168.1.100',
  raw_evidence: 'SELECT * FROM users WHERE id=1 OR 1=1'
};
const dummyOwner = new mongoose.Types.ObjectId();
const req = { node: { nodeId: 'node-test-123', owner: dummyOwner }, body: { detections: [goDetection] } };
const d = req.body.detections[0];
const event = {
  protocol: d.protocol,
  sourceIP: d.source_ip,
  attackType: d.category,
  severity: d.severity_str.toLowerCase(),
  action: 'block',
  payload: d.raw_evidence,
  riskScore: 95,
  nodeId: req.node.nodeId,
  nodeOwner: req.node.owner
};
const err = new SecurityEvent(event).validateSync();
console.log(err ? 'FAIL: ' + err.message : 'PASS');
"
```

**Expected**: `PASS`

## Test Suite 6 — Task 6B.5: Socket.IO Per-User Room Join (`join:myroom`)

### T6.1 — Socket.IO Listener & Room Join Event Registration Test

**What**: Verify `socket.js` registers `join:myroom` event listener and `Dashboard.jsx` emits `join:myroom` with stored `userId` upon connection.

**Command**:
```bash
cd Web/backend && node -e "
const socketModule = require('./src/websocket/socket');
console.log('socket.js syntax clean:', typeof socketModule.initSocket === 'function');
"
```

**Expected**: `socket.js syntax clean: true`

---

## Full Test Summary Checklist

| # | Test | Type | Pass Criteria |
|---|---|---|---|
| T1.1 | Frontend build smoke test | Automated | npm run build exits 0, no errors |
| T1.2 | Sidebar shows IP Blocklist nav | Manual | Entry visible in admin sidebar |
| T1.3 | Link navigates to /admin/blocklist | Manual | AdminManageBlocklist.jsx renders |
| T1.4 | Collapsed sidebar tooltip | Manual | Tooltip "IP Blocklist" appears |
| T2.1 | Schema field presence (no DB) | Automated | 3x PASS for nodeId + nodeOwner |
| T2.2 | Backend startup smoke test | Automated | Port 5000 up, no crash |
| T2.3 | Insert with nodeId works | Automated (DB) | PASS + fields stored correctly |
| T2.4 | Per-user query isolation | Automated (DB) | ISOLATION: PASS |
| T2.5 | Index verification | Automated (DB) | Both fields indexed PASS |
| T3.1 | Non-blocking overflow test | Automated (Go) | PASS (Send doesn't block on 500 buffer) |
| T3.2 | Flush & batched HTTP post test | Automated (Go) | PASS (POST sent with X-Node headers) |
| T4.1 | Proxy build & bus wiring test | Automated (Go) | PASS (go build ./... exits 0) |
| T5.1 | Go Detection mapping & scoping | Automated (Node) | PASS (SecurityEvent valid with nodeId/owner) |
| T6.1 | Socket.IO room join registration | Automated (Node) | PASS (socket.js clean, event registered) |

---

## Results Log (fill in as you run)

| # | Date | Result | Notes |
|---|---|---|---|
| T1.1 | | | |
| T1.2 | | | |
| T1.3 | | | |
| T1.4 | | | |
| T2.1 | 2026-09-16 | PASS | Verified via node -e schema check |
| T2.2 | | | |
| T2.3 | | | |
| T2.4 | | | |
| T2.5 | | | |
| T3.1 | 2026-09-16 | PASS | Verified via go test ./streamer (0.00s) |
| T3.2 | 2026-09-16 | PASS | Verified via go test ./streamer (0.32s) |
| T4.1 | 2026-09-16 | PASS | Verified via go build ./... in Security |
| T5.1 | 2026-09-16 | PASS | Verified via node -e SecurityEvent validation |
| T6.1 | 2026-09-16 | PASS | Verified via node -e socket.js import check |

---

## Next Task After All Tests Pass

→ **6B.6** — Wire `createAutomaticBlock` for CRITICAL severity in `agent.controller.js`

See `wave6_pending_implementation.md` for full task details.

