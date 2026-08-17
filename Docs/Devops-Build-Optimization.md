# Sandbox Build Speed & Efficiency Guide

This document identifies the root causes of slow container builds in the DevOps Sandbox Platform and provides concrete, prioritized fixes. Each optimization is rated by **impact**, **effort**, and includes the exact code or configuration change required.

> **Context:** A MERN monorepo cold build was taking ~600 seconds (10 minutes). The target after all optimizations is **60–90 seconds** for a cold first build, and **15–25 seconds** for warm restarts and port-change rebuilds.

---

## Why Builds Are Slow — Root Cause Map

```
Container starts fresh
        │
        ▼
npm install (client) ──── 🔴 No cache → full network download every time (~4 min)
        │
        ▼
npm run build (client) ── 🟡 Recompiles even if source unchanged (~2–3 min)
        │
        ▼
npm install (server) ──── 🔴 Serial, waits for client to finish (~1–2 min)
        │
        ▼
Server starts ──────────── 🟡 Throttled by WSL2 memory ceiling (~30–60s extra)
```

Total cold build time: **~600 seconds**

---

## Fix #1 — Persistent npm Cache Volume *(Highest Impact)*

### Root Cause
Every container starts with an empty filesystem. `node_modules` and the npm package cache are discarded at container exit. Even with `--prefer-offline`, there is nothing to be offline about on the first run — npm re-downloads and re-extracts every dependency from the registry from scratch.

### Solution
Bind a **Docker named volume** to the npm global cache directory (`/root/.npm`) inside the container. This cache persists across every build. On subsequent runs, `--prefer-offline` resolves packages directly from the volume instead of hitting the network.

### Code Change
In `process-manager.service.js`, add the volume to the `Binds` array in `createContainer`:

```javascript
// BEFORE
HostConfig: {
  Binds: [containerBind],
  // ...
}

// AFTER
HostConfig: {
  Binds: [
    containerBind,
    'devops-npm-cache:/root/.npm'  // ← named volume persists across all builds
  ],
  // ...
}
```

### Expected Improvement
| Scenario | Before | After |
|---|---|---|
| First ever build (cache cold) | ~4 min | ~4 min (same, populates cache) |
| All subsequent builds | ~4 min | ~10–20 seconds |

> **Note:** The Docker named volume `devops-npm-cache` is created automatically by Docker on first use. No manual `docker volume create` is needed.

---

## Fix #2 — Parallel Client + Server `npm install` *(High Impact)*

### Root Cause
The current shell command chain is **entirely serial**:
```sh
cd client && npm install → npm run build → cd server && npm install → server start
```
The server `npm install` sits idle waiting for the client build to finish, wasting ~60–90 seconds of calendar time when both could install simultaneously.

### Solution
Run both `npm install` commands in the **background** using `&`, then `wait` for both to finish before running the build step:

```javascript
// BEFORE (serial — your current line 647)
containerCmd = [
  'sh', '-c',
  `cd ${absClientPath} && npm install --prefer-offline --no-audit --no-fund --ignore-scripts --include=dev --legacy-peer-deps && npm run build && cd /project && PORT=${port} node devops-proxy.js & cd ${absServerPath} && PORT=3002 SERVER_PORT=3002 ${serverStartCmd}`
];

// AFTER (parallel installs, then serial build)
containerCmd = [
  'sh', '-c',
  `cd ${absClientPath} && npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps & \
   cd ${absServerPath} && npm install --prefer-offline --no-audit --no-fund & \
   wait && \
   cd ${absClientPath} && npm run build && \
   cd /project && PORT=${port} node devops-proxy.js & \
   cd ${absServerPath} && PORT=3002 SERVER_PORT=3002 ${serverStartCmd}`
];
```

### Expected Improvement
- Saves the full server `npm install` time (~60–90 seconds) from the critical path.
- Both installs complete at roughly the same time, then the build proceeds immediately.

---

## Fix #3 — Skip Client Rebuild When `dist` Already Exists *(High Impact for Restarts)*

### Root Cause
When a user restarts a previously deployed project (e.g., after a port change or a `Start Preview` from history), the entire React bundle is recompiled from scratch — even if no source files have changed. Vite cold-compilation of a large MERN client takes 2–4 minutes.

### Solution
Before running `npm run build`, check whether a `dist/index.html` or `build/index.html` already exists on disk. If it does, skip the build step entirely.

```javascript
// Determine client build output path on HOST (before container starts)
const clientDistOnHost = path.join(
  hasClientSibling ? path.resolve(workDir, '..', 'client') : path.join(workDir, 'client'),
  'dist', 'index.html'
);
const clientBuildOnHost = path.join(
  hasClientSibling ? path.resolve(workDir, '..', 'client') : path.join(workDir, 'client'),
  'build', 'index.html'
);
const clientAlreadyBuilt = fs.existsSync(clientDistOnHost) || fs.existsSync(clientBuildOnHost);

// Inject into the shell command
const buildStep = clientAlreadyBuilt
  ? `echo "[SKIP] Client already built — skipping npm run build"`
  : `npm run build`;

containerCmd = [
  'sh', '-c',
  `cd ${absClientPath} && npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps & \
   cd ${absServerPath} && npm install --prefer-offline --no-audit --no-fund & \
   wait && \
   cd ${absClientPath} && ${buildStep} && \
   cd /project && PORT=${port} node devops-proxy.js & \
   cd ${absServerPath} && PORT=3002 SERVER_PORT=3002 ${serverStartCmd}`
];
```

### Expected Improvement
| Scenario | Before | After |
|---|---|---|
| Cold build (no dist/) | 2–4 min (Vite compile) | 2–4 min (unchanged) |
| Restart / port-change rebuild | 2–4 min (recompile) | ~0 seconds (skipped) |

---

## Fix #4 — Remove `--ignore-scripts` Flag *(Medium Impact, Correctness Fix)*

### Root Cause
The current command passes `--ignore-scripts` during client `npm install`. This silently skips postinstall lifecycle scripts that some packages depend on (e.g., `sharp` image processor native binaries, Vite plugin setup scripts, `husky` hooks). When these scripts are skipped, the installed package may behave incorrectly or fail to load at runtime, causing hard-to-diagnose container crashes.

### Solution
Remove `--ignore-scripts` from the client install command. It provides no measurable speed gain and causes reliability issues:

```sh
# BEFORE
npm install --prefer-offline --no-audit --no-fund --ignore-scripts --include=dev --legacy-peer-deps

# AFTER
npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps
```

> `--include=dev` is also removed — development dependencies are not needed in production builds.

---

## Fix #5 — Increase WSL2 Memory Allocation *(Medium Impact on Windows)*

### Root Cause
On Windows, Docker Desktop runs inside a WSL2 virtual machine. By default, WSL2 is allocated only **50% of total physical RAM**. On a machine with 16 GB RAM, the VM gets 8 GB — shared between all WSL2 processes, Docker's own overhead, and the container build. The Node.js compiler (`esbuild`, Vite, TypeScript) is heavily memory-bound. When constrained, it falls back to disk-based operations, causing significant slowdowns.

### Solution
Create or edit the file `%USERPROFILE%\.wslconfig` (i.e., `C:\Users\<YourName>\.wslconfig`) with the following content:

```ini
[wsl2]
memory=10GB
processors=4
swap=4GB
```

Then restart WSL2 from PowerShell:
```powershell
wsl --shutdown
```

Docker Desktop will automatically pick up the new limits on next start.

### Expected Improvement
- Reduces GC pressure on Vite and TypeScript compiler.
- Estimated 20–40% reduction in client bundle compile time.
- More reliable concurrent workloads (parallel installs, proxy + server).

---

## Fix #6 — Remove Container Resource Hard Limits During Build *(Low Effort)*

### Root Cause
If `Memory` or `NanoCpus` ceilings are set in `createContainer`, Docker enforces them via Linux cgroups. A `512 MB` memory limit will cause Node.js to OOM-kill itself mid-build on large projects.

### Solution
Set both to `0` (which Docker interprets as "no limit — use host defaults"):

```javascript
HostConfig: {
  Memory: 0,     // 0 = inherit WSL2 VM limit
  NanoCpus: 0,   // 0 = no CPU throttle
  Binds: [containerBind, 'devops-npm-cache:/root/.npm'],
  // ...
}
```

---

## Combined Impact Summary

| # | Fix | Time Saved | Difficulty |
|---|---|---|---|
| 1 | Persistent npm cache volume | **~4 min** on all warm builds | ⭐ Very Easy |
| 2 | Parallel `npm install` (client + server) | **~60–90s** | ⭐ Easy |
| 3 | Skip client rebuild if `dist` exists | **~2–4 min** on restarts | ⭐ Easy |
| 4 | Remove `--ignore-scripts` | Prevents crashes | ⭐ Trivial |
| 5 | Increase WSL2 memory | **~20–40%** compile speedup | ⭐ Easy |
| 6 | Remove container resource hard limits | Prevents OOM kills | ⭐ Trivial |

### Time Targets

| Scenario | Current | After All Fixes |
|---|---|---|
| Cold first build (no cache) | ~600s | ~120–150s |
| Warm rebuild (cache warm) | ~600s | ~20–35s |
| Restart / port-change only | ~600s | ~10–20s |

---

## Files to Modify

| File | Change |
|---|---|
| [`process-manager.service.js`](../Web/backend/src/services/process-manager.service.js) | Fixes #1, #2, #3, #4, #6 |
| `%USERPROFILE%\.wslconfig` | Fix #5 (Windows host config) |
