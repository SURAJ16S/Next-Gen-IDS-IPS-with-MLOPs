# Sandbox OOM & Health Check Fix

**Date:** 2026-08-18  
**Affected Component:** `Web/backend/src/services/process-manager.service.js`  
**Affected Deployment Type:** MERN monorepo sandboxes (e.g. BOTAM-APPARELS)

---

## Problem Statement

When restarting a sandbox for a successfully-built MERN monorepo deployment, two failures occurred simultaneously:

### Failure 1 — JavaScript Heap Out of Memory

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
[49:0x7fbe28a28650] Mark-Compact (reduce) 252.2 (258.7) -> 251.3 MB ...
Aborted (core dumped)
```

The preview container crashed within ~60 seconds of startup with a Node.js OOM error.

### Failure 2 — Health Check Never Passed

```
[HEALTH] ⏳ Waiting for app on port 3002… (21s elapsed, attempt #8)
[HEALTH] ⏳ Waiting for app on port 3002… (81s elapsed, attempt #28)
```

Even after the server successfully started on port `5001`, the health check kept polling port `3002` indefinitely and the deployment was never marked **Ready**.

---

## Root Cause Analysis

### OOM Root Cause

The Docker preview container for MERN monorepos was configured with:

```javascript
// process-manager.service.js (BEFORE)
Memory: 536870912,    // 512 MB only
NanoCPUs: 1000000000, // 1 vCPU
PidsLimit: 100
```

A MERN monorepo sandbox runs **three stages sequentially inside the same container**:

| Stage | Tool | Memory Usage |
|---|---|---|
| 1. `npm install` (client deps) | npm | ~150–200 MB |
| 2. `npm run build` (Vite/CRA) | Vite/Webpack | ~200–300 MB peak |
| 3. Node.js backend server | node | ~100–150 MB resident |

Peak memory during stage 2 (React compilation) easily exceeds 512 MB with a large codebase like BOTAM-APPARELS. Node.js's default V8 heap is ~256 MB on 64-bit systems — at that threshold, the GC enters "Mark-Compact (reduce)" cycles and eventually aborts.

Additionally, **no `--max-old-space-size` flag** was set, meaning Node.js used its conservative default instead of the available container headroom.

### Health Check Root Cause

The MERN monorepo startup command was structured as:

```sh
cd /project/client && npm install && npm run build \
  && cd /project && PORT=3002 node devops-proxy.js & \
  cd /project/server && PORT=5001 node server.js
```

The proxy (which listens on port `3002`) only starts **after** `npm install + npm run build` completes. This takes **60–120+ seconds** on a first run. The health check polls `http://localhost:3002/` starting immediately from container launch — so every attempt during the build phase returns `ECONNREFUSED`.

---

## Fix Applied

### Fix 1 — Increased Container Memory & CPU

```javascript
// process-manager.service.js (AFTER)
const isMernMonorepo = (absClientPath !== null && (framework === 'mern' || framework === 'express'));
const containerMemoryBytes = isMernMonorepo ? 1610612736 : 1073741824; // 1.5 GB / 1 GB

HostConfig: {
  NanoCPUs: 2000000000,      // 2 vCPUs (was 1) — faster React builds
  Memory: containerMemoryBytes,
  PidsLimit: 200             // was 100, MERN spawns more processes
}
```

| Resource | Before | After (MERN) | After (other) |
|---|---|---|---|
| RAM | 512 MB | **1.5 GB** | 1 GB |
| vCPUs | 1 | **2** | 2 |
| PID limit | 100 | **200** | 200 |

### Fix 2 — Node.js Heap Flag Injection

```javascript
const nodeMemFlag = '--max-old-space-size=768';
const serverStartCmdPatched = serverStartCmd.replace(/\bnode\b/, `node ${nodeMemFlag}`);

containerCmd = [
  'sh', '-c',
  `cd ${absClientPath} && npm install ... && npm run build \
   && cd /project && PORT=${port} node ${nodeMemFlag} devops-proxy.js & \
   cd ${absServerPath} && PORT=5001 SERVER_PORT=5001 ${serverStartCmdPatched}`
];
```

Injects `--max-old-space-size=768` into both the proxy and the backend server invocations, giving Node.js **768 MB of managed heap** before GC is forced to trigger.

> **Why 768 MB?** Container has 1.5 GB. 768 MB is for Node.js heap; ~750 MB remains for OS, npm build tools, and native allocations.

### Fix 3 — Explicit Health Check Timeout per Mode

```javascript
const healthCheckMaxWait = isMernMonorepo ? 1_200_000 : 600_000; // 20 min / 10 min

await logPreview(deploymentId, jobId,
  `[HEALTH] Waiting for app on port ${port} (timeout: ${Math.round(healthCheckMaxWait / 60000)} min)…`
);
const health = await waitForHttpReady(port, deploymentId, jobId, { maxWaitMs: healthCheckMaxWait });
```

- **MERN monorepos** → 20-minute health check window (accounts for full React build time)
- **Other frameworks** → 10-minute window (shorter, faster failure feedback)
- Log line now shows the timeout being used

---

## Expected Log Output After Fix

```
[PREVIEW] Detected MERN monorepo. Will build React client at /project/client ... Node.js heap: 768MB.
[APP] npm install (client deps)...
[APP] npm run build → vite build ...
[APP] ✓ built in 35.4s
[APP] [DEVOPS PROXY] Listening on port 3002, proxying APIs to port 5001
[APP] 🚀 Server running on port 5001
[APP] ✅ MongoDB connected successfully
[HEALTH] Waiting for app on port 3002 (timeout: 20 min)…
[HEALTH] ⏳ Waiting for app on port 3002… (12s, attempt #4)   ← during build, expected
[HEALTH] ✅ App responded — HTTP 200 in 85000ms
```

---

## Files Changed

| File | Change |
|---|---|
| `Web/backend/src/services/process-manager.service.js` | Memory limits, CPU, PID limits, heap flag, per-mode health check timeout |
