# AegisProxy — Implementation & Enhancement Report

**Branch:** `AegisProxy`
**Date:** 2026-09-01
**Module:** `Security/` (Go — `ngfw-monitor`)

---

## Overview

This document records every implementation, bug fix, and enhancement made to the **NGFW Monitor** system during the AegisProxy development session. The work covers four primary areas:

1. **Source IP Attribution** — ensuring every detection event carries the real client IP and port.
2. **TUI Filter Fix** — correcting broken INFO severity filtering in the Alerts tab.
3. **Active Connection Management** — new Connections tab with live kill capability.
4. **Async Kill Fix** — resolving a BubbleTea UI deadlock during connection termination.

---

## 1. Source IP Attribution

### Problem
Detection events emitted by protocol analyzers (SSH, HTTP, DNS, etc.) were not consistently carrying `SourceIP` and `SourcePort`. This made it impossible to identify which client IP was responsible for a threat event.

### Files Modified
- `Security/detect/protocol_detect.go`
- `Security/proxy/listener.go`

### What Changed

#### `detect/protocol_detect.go`
- Updated `Detect()` to accept `clientIP string` and `clientPort uint16` as parameters.
- All detection events returned by the protocol detector now set `SourceIP` and `SourcePort` fields from the live connection context.

#### `proxy/listener.go`
- `handleConnection` now passes `connCtx.ClientIP.String()` and `connCtx.ClientPort` down to `tl.engine.protoDetector.Detect(...)`.
- All emitted events including `CONN-BACKEND-ERR` now include `SourceIP` and `SourcePort`.

---

## 2. TUI INFO Filter Fix

### Problem
The `[f]` key toggle (hide/show INFO events in the L7 Detections tab) was applying the filter at **ingestion time**, meaning previously seen INFO events could not be toggled back into view without restarting. Historical INFO events were permanently discarded once the filter was active.

### Files Modified
- `Security/tui.go`

### What Changed
- All incoming `detectionMsg` events are now stored unconditionally in the `m.detections` slice (no filter at ingestion).
- The filter (`m.filterInfo`) is applied only at **render time** inside `rebuildDetectionsVP()`.
- Pressing `f` now rebuilds the viewport from the full in-memory log, retroactively showing or hiding INFO events.

---

## 3. Active Connection Management (Connections Tab)

### Problem
The TUI had no visibility into currently live proxied connections. There was no mechanism to see which clients were connected or to terminate a session manually (IPS-style manual intervention).

### Architecture

```
Client TCP Conn
      │
 listener.go (handleConnection)
      │
 context.WithCancel(parentCtx) ← per-connection context
      │
 ActiveConn { ConnID, ClientConn, Cancel, CloseOnce, Ctx }
      │
 engine.RegisterConn(ac)  ←  sync.Map keyed by ConnID (UUID)
      │
 forwarder.Forward(connCanCtx, ...) ← uses per-connection ctx
      │
 defer engine.UnregisterConn(connID)  ← always on exit
```

### New Types Added

#### `proxy/proxy.go`

```go
// ActiveConn tracks a single live proxied connection.
type ActiveConn struct {
    ConnID     string
    ClientConn net.Conn
    Cancel     context.CancelFunc
    CloseOnce  sync.Once
    Ctx        *ConnContext
}

// ConnSnapshot is a safe, immutable copy for TUI rendering.
type ConnSnapshot struct {
    ConnID     string
    ClientIP   string
    ClientPort uint16
    Protocol   string
    StartTime  time.Time
    BytesIn    int64
    BytesOut   int64
    MaxSev     detect.Severity
}
```

### New Methods on `ProxyEngine`

| Method | Purpose |
|---|---|
| `RegisterConn(ac *ActiveConn)` | Adds connection to `sync.Map` |
| `UnregisterConn(connID string)` | Removes connection from `sync.Map` (deferred) |
| `KillConnection(connID string) bool` | Cancels context AND closes socket, emits audit event |
| `GetActiveConnections() []ConnSnapshot` | Returns a safe value-copy slice for the TUI |

### Safety Properties

| Concern | Solution |
|---|---|
| **cancelFunc ≠ close** | `KillConnection` calls both `ac.Cancel()` and `ac.ClientConn.Close()` to immediately unblock blocking reads |
| **Connection identity** | Uses the existing `ConnID` which is a `uuid.New()` string — immune to ephemeral port reuse |
| **Double-close race** | `sync.Once` in `ActiveConn.CloseOnce` ensures close + audit event fire exactly once regardless of which path (natural or operator kill) wins |
| **Stale selection** | `KillConnection` does `sync.Map.Load()` first; returns `false` gracefully if already gone |
| **TUI pointer safety** | `GetActiveConnections()` returns `[]ConnSnapshot` (value slice copy) — TUI never holds live pointers into the map |

### Audit Trail
When `KillConnection` fires, it emits a `CONN-KILL-001` detection event (Severity: **HIGH**) through the existing `DetectionBus`:

```
ID:       CONN-KILL-001
Severity: HIGH
Category: connection-lifecycle
Summary:  "Connection manually terminated by operator: <IP>:<Port>"
ConnID:   <uuid>
```

This event appears in:
- **[2] L7 Detections** tab of the TUI
- `logs/detections.jsonl` for audit purposes

### Files Modified
- `Security/proxy/proxy.go` — new types and methods
- `Security/proxy/listener.go` — per-connection context + register/unregister lifecycle
- `Security/main.go` — pass `*proxy.ProxyEngine` to `runEBPFMonitor` and `newTuiModel`
- `Security/tui.go` — new tab, state fields, keybindings, render function

---

## 4. TUI Connections Tab UI

### New Tab: `[4] Connections`
Only visible in **Integrated Mode** (when `engine != nil`). Hidden in eBPF-only or Proxy-only modes.

### Connection Table Columns
```
[>] 192.168.58.1:57413   SSH       00:02:14   ↓ 12.3 KB  ↑ 4.1 KB   🟠 HIGH
    10.0.0.5:44812        HTTP      00:00:07   ↓  1.1 KB  ↑ 0.4 KB   ℹ INFO
```
| Column | Source |
|---|---|
| IP:Port | `ConnSnapshot.ClientIP:ClientPort` |
| Protocol | `ConnSnapshot.Protocol` (detected, not assumed) |
| Uptime | `time.Since(ConnSnapshot.StartTime)` |
| Bytes ↓/↑ | `ConnSnapshot.BytesIn / BytesOut` |
| Max Severity | `ConnSnapshot.MaxSev` (from `ConnContext.MaxSeverity()`) |

### Keybindings (active only on Connections tab)

| Key | Action |
|---|---|
| `↑` / `k` | Move selection up |
| `↓` / `j` | Move selection down |
| `x` (first press) | Prime kill — shows "Press x again to confirm kill" |
| `x` (second press) | Confirm and execute kill |

### Keybinding Audit (no collisions)
| Key | Existing use | New use | Conflict? |
|---|---|---|---|
| `4` | (unused) | Switch to Connections tab | ✅ None |
| `↑` / `↓` | Scroll viewport in other tabs | Row selection in Connections tab | ✅ Context-isolated |
| `x` | (unused) | Kill connection with confirm | ✅ None |
| `k` | (unused globally) | Up-navigation in Connections tab only | ✅ Context-isolated |

### Refresh
On every **2-second tick** (reusing the existing `tickEvery(2 * time.Second)` timer), the TUI fetches a fresh `[]ConnSnapshot` from `engine.GetActiveConnections()`. The selected index is clamped to avoid out-of-bounds after a connection closes naturally.

---

## 5. Async Kill Fix (BubbleTea Deadlock)

### Problem
When the user pressed `x` to confirm a kill, the TUI froze completely. The root cause was a **deadlock**:

```
UI goroutine blocked on KillConnection()
        ↓
KillConnection() calls EmitDetection(CONN-KILL-001)
        ↓
EmitDetection() tries to send to TUI channel
        ↓
TUI channel blocked because UI goroutine is waiting for KillConnection()
        → DEADLOCK
```

### Fix
Moved the kill execution into a `tea.Cmd` (a background goroutine managed by BubbleTea). The UI immediately shows `"Killing connection [IP]..."` and returns, freeing the event loop. When the kill completes, it returns a `killResultMsg` which updates the status line.

```go
// New message type
type killResultMsg struct {
    ip     string
    killed bool
}

// Returned as tea.Cmd on x-confirm:
return m, func() tea.Msg {
    killed := engine.KillConnection(selectedID)
    return killResultMsg{ip: ip, killed: killed}
}
```

### Files Modified
- `Security/tui.go`

---

## 6. Testing & Validation

### Build Verification
```bash
cd Security && make build   # → go build -o ngfw-monitor ✅
```

### Manual Test Procedure
1. Start **OWASP Juice Shop** (`docker run -p 3000:3000 bkimminich/juice-shop`)
2. Launch monitor in **Integrated Mode** (Option 3), proxy port `8080`, backend port `3000`
3. Browse to `http://192.168.58.128:8080` from Windows
4. Inject test payloads (e.g. `<script>alert(1)</script>` in search bar)
5. Verify **[2] L7 Detections** shows `XSS` events with correct Windows source IP
6. Verify **[4] Connections** tab lists the live browser connection
7. Select connection and press `x` twice → connection drops → `CONN-KILL-001` appears in Alerts tab

### SSH Kill Test
1. From Windows: `ssh kali@192.168.58.128 -p <proxy_port>`
2. TUI **[4] Connections** shows the SSH session
3. Press `x` twice on it → Windows SSH terminal shows `Connection closed by foreign host`

---

## 7. Summary of All Modified Files

| File | Change |
|---|---|
| `Security/proxy/proxy.go` | Added `ActiveConn`, `ConnSnapshot`, `activeConns sync.Map`, `RegisterConn`, `UnregisterConn`, `KillConnection`, `GetActiveConnections` |
| `Security/proxy/listener.go` | Per-connection cancellable context, `RegisterConn`/`UnregisterConn` lifecycle, pass `connCanCtx` to forwarder |
| `Security/detect/protocol_detect.go` | `Detect()` accepts and propagates `clientIP` and `clientPort` |
| `Security/main.go` | `runEBPFMonitor` and `newTuiModel` accept `*proxy.ProxyEngine`; all call sites updated |
| `Security/tui.go` | New `engine`, `conns`, `connSelected`, `connKillPending`, `connKillID`, `connStatusMsg` fields; Connections tab render; async kill via `tea.Cmd`; INFO filter at render time |
