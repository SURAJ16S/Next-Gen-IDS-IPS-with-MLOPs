// tui.go — Interactive TUI dashboard for NGFW Monitor
// Implements a Bubble Tea tea.Model with three tabs:
//   [1] eBPF Telemetry      — live eBPF packet feed (deduped for loopback)
//   [2] L7 Detections       — ML / proxy detection events (INFO filtered by default)
//   [3] Protocol Utilisation — per-protocol traffic volume, detection breakdown, top talkers
//
// Hotkeys:
//   1 / 2 / 3           switch tabs
//   ↑ / ↓ / pgup / pgdn  scroll active pane
//   p                   pause / resume live scroll
//   f                   toggle: hide/show INFO events in L7 Detections tab
//   q / ctrl+c          graceful shutdown

package main

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/charmbracelet/bubbles/table"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"ngfw-monitor/detect"
	"ngfw-monitor/proxy"
)

// ── ring-buffer sizes ──────────────────────────────────────────────────────────

const (
	maxTUIPackets    = 200
	maxTUIDetections = 500
)

// ── message types sent into the TUI event loop ────────────────────────────────

type packetMsg packetRecord

// detectionMsg is sent by the detection bus to the UI.
type detectionMsg detect.Detection

// killResultMsg is sent after attempting to kill a connection.
type killResultMsg struct {
	ip     string
	killed bool
} // from DetectionBus subscriber
type tickMsg time.Time             // periodic metrics refresh

// ── TUI severity colour palette ───────────────────────────────────────────────

var (
	tuiCrit   = lipgloss.NewStyle().Foreground(lipgloss.Color("#FF1744")).Bold(true)
	tuiHigh   = lipgloss.NewStyle().Foreground(lipgloss.Color("#FF6D00")).Bold(true)
	tuiMed    = lipgloss.NewStyle().Foreground(lipgloss.Color("#FFEA00")).Bold(true)
	tuiLow    = lipgloss.NewStyle().Foreground(lipgloss.Color("#00B0FF"))
	tuiInfo   = lipgloss.NewStyle().Foreground(lipgloss.Color("#616161"))
	tuiGreen  = lipgloss.NewStyle().Foreground(lipgloss.Color("#00E676")).Bold(true)
	tuiCyan   = lipgloss.NewStyle().Foreground(lipgloss.Color("#00E5FF")).Bold(true)
	tuiWhite  = lipgloss.NewStyle().Foreground(lipgloss.Color("#ECEFF1")).Bold(true)
	tuiDim    = lipgloss.NewStyle().Foreground(lipgloss.Color("#546E7A"))
	tuiOrange = lipgloss.NewStyle().Foreground(lipgloss.Color("#FF6D00")).Bold(true)

	tuiTabActive = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#00E5FF")).
			Bold(true).
			Underline(true).
			Padding(0, 2)
	tuiTabInactive = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#546E7A")).
			Padding(0, 2)
	tuiPausedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FFEA00")).
			Bold(true).
			Background(lipgloss.Color("#1A1A00")).
			Padding(0, 1)
	tuiAlertBadge = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FF1744")).
			Bold(true)
)

// ── severity-specific styling helper ─────────────────────────────────────────

func tuiSevStyle(s detect.Severity) lipgloss.Style {
	switch s {
	case detect.SevCritical:
		return tuiCrit
	case detect.SevHigh:
		return tuiHigh
	case detect.SevMedium:
		return tuiMed
	case detect.SevLow:
		return tuiLow
	default:
		return tuiInfo
	}
}

// tuiActorStyle highlights the connecting IP address — the actor that triggered
// a detection. Bright yellow makes it immediately distinguishable from other
// fields in a busy log feed.
var tuiActor = lipgloss.NewStyle().Foreground(lipgloss.Color("#FFD600")).Bold(true)

func tuiProtoBadge(proto string) string {
	if proto == "" {
		return tuiDim.Render("[—  ]")
	}
	// Pad to 6 chars so badge widths are consistent in the table
	padded := proto
	if len(padded) < 6 {
		padded = padded + spaces(6-len(padded))
	}
	switch detect.Protocol(proto) {
	case detect.ProtocolHTTP:
		return tuiCyan.Render("[" + padded + "]")
	case detect.ProtocolTLS:
		return lipgloss.NewStyle().Foreground(lipgloss.Color("#E040FB")).Bold(true).Render("[" + padded + "]")
	case detect.ProtocolSSH:
		return tuiGreen.Render("[" + padded + "]")
	case detect.ProtocolFTP, detect.ProtocolFTPS:
		return tuiOrange.Render("[" + padded + "]")
	case detect.ProtocolDNS:
		return lipgloss.NewStyle().Foreground(lipgloss.Color("#FF6D00")).Bold(true).Render("[" + padded + "]")
	case detect.ProtocolSMTP:
		return tuiLow.Render("[" + padded + "]")
	case detect.ProtocolTelnet:
		return tuiCrit.Render("[" + padded + "]")
	default:
		return tuiDim.Render("[" + padded + "]")
	}
}

// spaces returns n space characters (helper for fixed-width badge padding).
func spaces(n int) string { return strings.Repeat(" ", n) }

// ── tuiStats — heap-allocated so atomic fields survive model copies ────────────
// IMPORTANT: atomic.Int64 must NOT be copied after first use.
// By keeping tuiStats on the heap (pointer), the tuiModel value type can be
// safely returned from Update() without invalidating any atomics.

type tuiStats struct {
	totalPkts   atomic.Int64
	ingressPkts atomic.Int64
	egressPkts  atomic.Int64
	totalBytes  atomic.Int64
	// sevCounts[0]=Info [1]=Low [2]=Medium [3]=High [4]=Critical
	sevCounts [5]atomic.Int64
}

func (ts *tuiStats) addPacket(rec packetRecord) {
	ts.totalPkts.Add(1)
	ts.totalBytes.Add(int64(rec.Size))
	if rec.Direction == "INCOMING" {
		ts.ingressPkts.Add(1)
	} else {
		ts.egressPkts.Add(1)
	}
}

func (ts *tuiStats) addAlert(sev detect.Severity) {
	if int(sev) < len(ts.sevCounts) {
		ts.sevCounts[sev].Add(1)
	}
}

// sevTotal returns the sum across all severity buckets (excluding Info if desired).
func (ts *tuiStats) sevTotal() int64 {
	var n int64
	for i := range ts.sevCounts {
		n += ts.sevCounts[i].Load()
	}
	return n
}

// highPlusCrit returns CRITICAL + HIGH count for tab badge.
func (ts *tuiStats) highPlusCrit() int64 {
	return ts.sevCounts[detect.SevHigh].Load() + ts.sevCounts[detect.SevCritical].Load()
}

// ── TUISubscriber — feeds DetectionBus events into the TUI program ────────────

// TUISubscriber implements detect.DetectionSubscriber and forwards events to
// a running Bubble Tea program via p.Send(). Thread-safe: program pointer is
// injected after the bus is already running.
type TUISubscriber struct {
	mu      sync.Mutex
	program *tea.Program
}

func (t *TUISubscriber) SetProgram(p *tea.Program) {
	t.mu.Lock()
	t.program = p
	t.mu.Unlock()
}

func (t *TUISubscriber) OnDetection(d detect.Detection) {
	t.mu.Lock()
	p := t.program
	t.mu.Unlock()
	if p != nil {
		p.Send(detectionMsg(d))
	}
}

func (t *TUISubscriber) OnConnectionClose(_ detect.ConnectionRecord) {}

// ── tuiModel — the Bubble Tea model ──────────────────────────────────────────

type tuiModel struct {
	// navigation
	activeTab  int  // 0=Packets, 1=Alerts, 2=Metrics
	paused     bool // freeze live scroll
	filterInfo bool // hide INFO-severity events in Alerts tab

	// data rings
	mu         sync.Mutex
	packets    []packetRecord
	detections []detect.Detection

	// sub-components
	pktsTable    table.Model
	detectionsVP viewport.Model
	metricsVP    viewport.Model

	// stats — pointer so atomic fields survive value copies in Bubble Tea
	stats      *tuiStats
	proxyStats *detect.StatsCollector
	startTime  time.Time

	// context
	port    uint16
	iface   string
	svcInfo ServiceInfo

	// terminal size
	width  int
	height int

	// file logger (shared with eBPF goroutine)
	flog *fileLogger

	// connections tab state
	engine          *proxy.ProxyEngine
	conns           []proxy.ConnSnapshot
	connSelected    int
	connKillPending bool
	connKillID      string
	connStatusMsg   string

	// deduplication and redis isolation
	dedupWindow     time.Duration
	dedupSeen       map[string]time.Time
	redisDetections []detect.Detection
	redisVP         viewport.Model
}

// newTuiModel constructs the model for Integrated or eBPF-only modes.
func newTuiModel(port uint16, iface string, svc ServiceInfo, pStats *detect.StatsCollector, flog *fileLogger, engine *proxy.ProxyEngine) tuiModel {
	// Packets table columns
	cols := []table.Column{
		{Title: "Dir", Width: 9},
		{Title: "Source", Width: 21},
		{Title: "Destination", Width: 21},
		{Title: "Proto", Width: 5},
		{Title: "Flags", Width: 13},
		{Title: "Size", Width: 8},
		{Title: "Time", Width: 12},
	}
	t := table.New(
		table.WithColumns(cols),
		table.WithFocused(false),
		table.WithHeight(20),
	)
	ts := table.DefaultStyles()
	ts.Header = ts.Header.
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(lipgloss.Color("#30363D")).
		BorderBottom(true).
		Bold(true).
		Foreground(lipgloss.Color("#ECEFF1"))
	ts.Selected = ts.Selected.
		Foreground(lipgloss.Color("#00E5FF")).
		Background(lipgloss.Color("#1A237E")).
		Bold(false)
	t.SetStyles(ts)

	return tuiModel{
		activeTab:    1,    // default to Alerts tab — most useful at a glance
		filterInfo:   true, // filter INFO noise by default; press f to toggle
		packets:      make([]packetRecord, 0, maxTUIPackets),
		detections:   make([]detect.Detection, 0, maxTUIDetections),
		pktsTable:    t,
		detectionsVP: viewport.New(80, 20),
		metricsVP:    viewport.New(80, 20),
		stats:        &tuiStats{}, // heap-allocated — safe across model copies
		proxyStats:   pStats,
		startTime:    time.Now(),
		port:         port,
		iface:        iface,
		svcInfo:      svc,
		flog:         flog,
		width:           120,
		height:          40,
		engine:          engine,
		conns:           make([]proxy.ConnSnapshot, 0),
		dedupWindow:     60 * time.Second,
		dedupSeen:       make(map[string]time.Time),
		redisDetections: make([]detect.Detection, 0, maxTUIDetections),
		redisVP:         viewport.New(80, 20),
	}
}

// ── Bubble Tea interface ──────────────────────────────────────────────────────

func (m tuiModel) Init() tea.Cmd {
	return tea.Batch(
		tea.EnterAltScreen,
		tickEvery(2*time.Second),
	)
}

func tickEvery(d time.Duration) tea.Cmd {
	return tea.Tick(d, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m tuiModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	// ── terminal resize ──
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		// The UI outside of the data areas uses about 10 lines of vertical space
		// (headers, tabs, separators, borders, footers).
		tableHeight := m.height - 10
		if tableHeight < 2 {
			tableHeight = 2
		}
		m.pktsTable.SetHeight(tableHeight)

		vpHeight := m.height - 8
		if vpHeight < 2 {
			vpHeight = 2
		}
		m.detectionsVP.Width = m.width - 4
		m.detectionsVP.Height = vpHeight
		m.metricsVP.Width = m.width - 4
		m.metricsVP.Height = vpHeight
		m.redisVP.Width = m.width - 4
		m.redisVP.Height = vpHeight
		return m, nil

	// ── keyboard ──
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "1":
			m.activeTab = 0
		case "2":
			m.activeTab = 1
		case "3":
			m.activeTab = 2
		case "4":
			m.activeTab = 3
		case "5":
			if m.engine != nil {
				m.activeTab = 4
			}
		case "p":
			m.paused = !m.paused
		case "f":
			m.filterInfo = !m.filterInfo
			m.rebuildDetectionsVP()
		case "up", "k":
			if m.activeTab == 4 && len(m.conns) > 0 {
				m.connSelected--
				if m.connSelected < 0 {
					m.connSelected = 0
				}
				m.connKillPending = false
				m.connStatusMsg = ""
			}
		case "down", "j":
			if m.activeTab == 4 && len(m.conns) > 0 {
				m.connSelected++
				if m.connSelected >= len(m.conns) {
					m.connSelected = len(m.conns) - 1
				}
				m.connKillPending = false
				m.connStatusMsg = ""
			}
		case "x":
			if m.activeTab == 4 && m.engine != nil && len(m.conns) > 0 && m.connSelected < len(m.conns) {
				selectedID := m.conns[m.connSelected].ConnID
				if m.connKillPending && m.connKillID == selectedID {
					// Confirm kill — do this async so we don't block the UI thread,
					// which causes a deadlock if EmitDetection tries to send back to the UI.
					ip := m.conns[m.connSelected].ClientIP
					m.connKillPending = false
					m.connKillID = ""
					m.connStatusMsg = fmt.Sprintf("Killing connection %s...", ip)
					engine := m.engine // capture for goroutine
					return m, func() tea.Msg {
						killed := engine.KillConnection(selectedID)
						return killResultMsg{ip: ip, killed: killed}
					}
				} else {
					// First press
					m.connKillPending = true
					m.connKillID = selectedID
					m.connStatusMsg = "Press x again to confirm kill"
				}
			}
		}

		// Delegate scroll / cursor keys to the active pane
		var cmd tea.Cmd
		switch m.activeTab {
		case 0:
			m.pktsTable, cmd = m.pktsTable.Update(msg)
		case 1:
			m.detectionsVP, cmd = m.detectionsVP.Update(msg)
		case 2:
			m.metricsVP, cmd = m.metricsVP.Update(msg)
		case 3:
			m.redisVP, cmd = m.redisVP.Update(msg)
		}
		return m, cmd

	// ── new eBPF packet ──
	case packetMsg:
		rec := packetRecord(msg)
		m.stats.addPacket(rec) // safe: pointer receiver, atomic ops
		if m.flog != nil {
			m.flog.logPacket(m.stats.totalPkts.Load(), rec)
		}
		if !m.paused {
			m.mu.Lock()
			m.packets = append(m.packets, rec)
			if len(m.packets) > maxTUIPackets {
				m.packets = m.packets[len(m.packets)-maxTUIPackets:]
			}
			m.mu.Unlock()
			m.rebuildPacketTable()
		}

	// ── new ML detection alert ──
	case detectionMsg:
		d := detect.Detection(msg)
		m.stats.addAlert(d.Severity) // safe: pointer receiver, atomic ops
		if !m.paused {
			m.mu.Lock()
			
			// 1. Redis Isolation
			if strings.EqualFold(d.Protocol, "redis") {
				m.redisDetections = append(m.redisDetections, d)
				if len(m.redisDetections) > maxTUIDetections {
					m.redisDetections = m.redisDetections[len(m.redisDetections)-maxTUIDetections:]
				}
				m.mu.Unlock()
				m.rebuildRedisVP()
				if m.activeTab == 3 {
					m.redisVP.GotoBottom()
				}
				return m, nil
			}

			// 2. View-layer Deduplication (LOW / INFO only)
			if d.Severity <= detect.SevLow {
				key := fmt.Sprintf("%s:%s:%d", d.ID, d.SourceIP, d.DestPort)
				now := time.Now()
				if lastSeen, ok := m.dedupSeen[key]; ok {
					if now.Sub(lastSeen) <= m.dedupWindow {
						m.mu.Unlock()
						return m, nil // Skip adding to display ring
					}
				}
				m.dedupSeen[key] = now
			}

			// 3. Append to main detections ring
			m.detections = append(m.detections, d)
			if len(m.detections) > maxTUIDetections {
				m.detections = m.detections[len(m.detections)-maxTUIDetections:]
			}
			m.mu.Unlock()
			m.rebuildDetectionsVP()
			if m.activeTab == 1 {
				m.detectionsVP.GotoBottom()
			}
		}

	// ── connection kill result ──
	case killResultMsg:
		if msg.killed {
			m.connStatusMsg = fmt.Sprintf("Killed connection %s", msg.ip)
		} else {
			m.connStatusMsg = "[already closed]"
		}
		return m, nil

	// ── periodic metrics refresh ──
	case tickMsg:
		m.mu.Lock()
		now := time.Now()
		for key, lastSeen := range m.dedupSeen {
			if now.Sub(lastSeen) > m.dedupWindow {
				delete(m.dedupSeen, key)
			}
		}
		m.mu.Unlock()

		m.rebuildMetricsVP()
		if m.engine != nil {
			m.conns = m.engine.GetActiveConnections()
			if len(m.conns) == 0 {
				m.connSelected = 0
			} else if m.connSelected >= len(m.conns) {
				m.connSelected = len(m.conns) - 1
			}
			// Clear status message after a few ticks (rudimentary timeout)
			if m.connStatusMsg == "[already closed]" || strings.HasPrefix(m.connStatusMsg, "Killed") {
				m.connStatusMsg = ""
			}
		}
		return m, tickEvery(2 * time.Second)
	}

	return m, nil
}

func (m tuiModel) View() string {
	if m.width == 0 {
		return "Loading…"
	}
	var sb strings.Builder
	sb.WriteString(m.renderHeader())
	sb.WriteString(m.renderTabBar())
	sb.WriteString("\n")

	switch m.activeTab {
	case 0:
		sb.WriteString(m.renderPacketsTab())
	case 1:
		sb.WriteString(m.renderDetectionsTab())
	case 2:
		sb.WriteString(m.renderMetricsTab())
	case 3:
		sb.WriteString(m.renderRedisTab())
	case 4:
		if m.engine != nil {
			sb.WriteString(m.renderConnectionsTab())
		}
	}

	sb.WriteString("\n")
	sb.WriteString(m.renderFooter())
	return sb.String()
}

// ── Header ────────────────────────────────────────────────────────────────────

func (m tuiModel) renderHeader() string {
	uptime := time.Since(m.startTime).Round(time.Second)

	portLabel := fmt.Sprintf(":%d", m.port)
	if m.port == 0 {
		portLabel = ":proxy"
	}
	svcName := m.svcInfo.DisplayName()
	if svcName == "" || svcName == "unknown" {
		svcName = "service"
	}
	ifaceLabel := m.iface
	if ifaceLabel == "" {
		ifaceLabel = "—"
	}

	left := tuiCyan.Render("NGFW") + tuiDim.Render(" │ ") +
		tuiWhite.Render(portLabel) + tuiDim.Render(" ("+svcName+")") +
		tuiDim.Render("  iface: ") + tuiWhite.Render(ifaceLabel)

	totalPkts := m.stats.totalPkts.Load()
	totalBytes := m.stats.totalBytes.Load()
	totalAlerts := m.stats.sevTotal()
	highCrit := m.stats.highPlusCrit()

	alertStr := fmt.Sprintf("%d", totalAlerts)
	if highCrit > 0 {
		alertStr = tuiAlertBadge.Render(fmt.Sprintf("⚠ %d", totalAlerts))
	} else {
		alertStr = tuiGreen.Render(alertStr)
	}

	right := tuiDim.Render("pkts: ") + tuiWhite.Render(fmt.Sprintf("%d", totalPkts)) +
		tuiDim.Render("  bytes: ") + tuiWhite.Render(formatBytes(totalBytes)) +
		tuiDim.Render("  alerts: ") + alertStr +
		tuiDim.Render("  up: ") + tuiWhite.Render(uptime.String())

	gap := m.width - lipgloss.Width(left) - lipgloss.Width(right) - 4
	if gap < 1 {
		gap = 1
	}
	line := "  " + left + strings.Repeat(" ", gap) + right
	return tuiGreen.Render("● MONITORING") + tuiDim.Render("  ") + line + "\n"
}

// ── Tab Bar with live severity badge ─────────────────────────────────────────

func (m tuiModel) renderTabBar() string {
	// Build alert badge for Alerts tab label
	highCrit := m.stats.highPlusCrit()
	alertsLabel := "[2] L7 Detections"
	if highCrit > 0 {
		alertsLabel = fmt.Sprintf("[2] L7 Detections %s", tuiAlertBadge.Render(fmt.Sprintf("(%d!)", highCrit)))
	}

	tabs := []string{"[1] eBPF Telemetry", alertsLabel, "[3] Protocol Utilisation"}
	m.mu.Lock()
	redisCount := len(m.redisDetections)
	m.mu.Unlock()
	
	redisLabel := "[4] Redis Logs"
	if redisCount > 0 {
		redisLabel = fmt.Sprintf("[4] Redis Logs (%d)", redisCount)
	}
	tabs = append(tabs, redisLabel)

	if m.engine != nil {
		tabs = append(tabs, "[5] Connections")
	}
	var parts []string
	for i, label := range tabs {
		if i == m.activeTab {
			parts = append(parts, tuiTabActive.Render(label))
		} else {
			parts = append(parts, tuiTabInactive.Render(label))
		}
	}
	bar := strings.Join(parts, tuiDim.Render("│"))

	// Status indicators
	indicators := ""
	if m.paused {
		indicators += "  " + tuiPausedStyle.Render("⏸ PAUSED")
	}
	if m.filterInfo {
		indicators += "  " + tuiDim.Render("[INFO filtered]")
	}

	return tuiDim.Render("  ") + bar + indicators + "\n" +
		tuiDim.Render("  "+strings.Repeat("─", m.width-4))
}

// ── Footer ────────────────────────────────────────────────────────────────────

func (m tuiModel) renderFooter() string {
	tabsLegend := "  1/2/3/4"
	if m.engine != nil {
		tabsLegend = "  1/2/3/4/5"
	}
	hotkeys := tuiDim.Render(tabsLegend) + tuiWhite.Render(" tabs") +
		tuiDim.Render("  ↑/↓") + tuiWhite.Render(" scroll")

	if m.activeTab == 4 {
		hotkeys += tuiDim.Render("  x") + tuiWhite.Render(" kill")
	}

	hotkeys += tuiDim.Render("  p") + tuiWhite.Render(" pause") +
		tuiDim.Render("  f") + tuiWhite.Render(" toggle INFO") +
		tuiDim.Render("  q") + tuiWhite.Render(" quit") +
		tuiDim.Render("  │  log → output.txt  │  detections → logs/detections.jsonl")
	return tuiDim.Render("  "+strings.Repeat("─", m.width-4)) + "\n" + hotkeys
}

// ── Packets Tab ───────────────────────────────────────────────────────────────

func (m *tuiModel) rebuildPacketTable() {
	m.mu.Lock()
	snap := make([]packetRecord, len(m.packets))
	copy(snap, m.packets)
	m.mu.Unlock()

	rows := make([]table.Row, 0, len(snap))
	// Show newest at top
	for i := len(snap) - 1; i >= 0; i-- {
		rec := snap[i]
		dir := "⬇ IN"
		if rec.Direction == "OUTGOING" {
			dir = "⬆ OUT"
		}
		src := fmt.Sprintf("%s:%d", rec.SrcIP, rec.SrcPort)
		dst := fmt.Sprintf("%s:%d", rec.DstIP, rec.DstPort)
		rows = append(rows, table.Row{
			dir,
			src,
			dst,
			rec.Protocol,
			rec.TCPFlags,
			formatBytes(int64(rec.Size)),
			rec.Timestamp.Format("15:04:05.000"),
		})
	}
	m.pktsTable.SetRows(rows)
}

func (m tuiModel) renderPacketsTab() string {
	totalPkts := m.stats.totalPkts.Load()
	if totalPkts == 0 {
		return "\n" + tuiDim.Render(fmt.Sprintf("  Waiting for packets on port %d…", m.port)) +
			"\n" + tuiDim.Render("  Tip: generate traffic to see live eBPF captures here.")
	}
	// Status line above table
	ingress := m.stats.ingressPkts.Load()
	egress := m.stats.egressPkts.Load()
	statusLine := fmt.Sprintf("  Total: %s   ⬇ IN: %s   ⬆ OUT: %s   Bytes: %s",
		tuiWhite.Render(fmt.Sprintf("%d", totalPkts)),
		tuiGreen.Render(fmt.Sprintf("%d", ingress)),
		tuiOrange.Render(fmt.Sprintf("%d", egress)),
		tuiWhite.Render(formatBytes(m.stats.totalBytes.Load())),
	)
	return statusLine + "\n" + m.pktsTable.View()
}

// ── Alerts Tab ────────────────────────────────────────────────────────────────

func (m *tuiModel) rebuildDetectionsVP() {
	m.mu.Lock()
	snap := make([]detect.Detection, len(m.detections))
	copy(snap, m.detections)
	m.mu.Unlock()

	var sb strings.Builder

	// Severity summary bar at the top of the alerts pane
	crit := m.stats.sevCounts[detect.SevCritical].Load()
	high := m.stats.sevCounts[detect.SevHigh].Load()
	med := m.stats.sevCounts[detect.SevMedium].Load()
	low := m.stats.sevCounts[detect.SevLow].Load()
	info := m.stats.sevCounts[detect.SevInfo].Load()
	sb.WriteString(fmt.Sprintf("  %s %s  %s %s  %s %s  %s %s  %s %s\n",
		tuiCrit.Render("🔴 CRIT:"), tuiCrit.Render(fmt.Sprintf("%d", crit)),
		tuiHigh.Render("🟠 HIGH:"), tuiHigh.Render(fmt.Sprintf("%d", high)),
		tuiMed.Render("🟡 MED:"), tuiMed.Render(fmt.Sprintf("%d", med)),
		tuiLow.Render("🔵 LOW:"), tuiLow.Render(fmt.Sprintf("%d", low)),
		tuiDim.Render("ℹ INFO:"), tuiDim.Render(fmt.Sprintf("%d", info)),
	))
	sb.WriteString(tuiDim.Render("  "+strings.Repeat("─", 80)) + "\n")

	// Event rows — fixed-width columns so arrows align in a scan-friendly column
	written := 0
	for _, d := range snap {
		if m.filterInfo && d.Severity == detect.SevInfo {
			continue // Skip rendering INFO events if filter is active
		}

		sevStyle := tuiSevStyle(d.Severity)
		ts := d.Timestamp.Format("15:04:05")

		// ── Actor: source IP and port ──────────────────────────────────
		actorIP := d.SourceIP
		if actorIP == "" {
			actorIP = "—"
		}
		actorPort := ""
		if d.SourcePort > 0 {
			actorPort = fmt.Sprintf(":%d", d.SourcePort)
		}
		// Pad actor field to 22 chars so the → arrow column stays aligned
		actorRaw := actorIP + actorPort
		if len(actorRaw) > 22 {
			actorRaw = actorRaw[:22]
		}
		actorPadded := actorRaw + spaces(22-len(actorRaw))

		line := fmt.Sprintf("  %s %s  %s  %-22s  %s  %s → :%d  %s\n",
			sevStyle.Render(d.Severity.Emoji()+" "+fmt.Sprintf("%-8s", d.Severity.String())),
			tuiDim.Render(ts),
			tuiProtoBadge(d.Protocol),
			tuiCyan.Render(fmt.Sprintf("%-22s", d.ID)),
			tuiActor.Render(actorPadded),
			tuiDim.Render("→"),
			d.DestPort,
			d.Summary,
		)
		sb.WriteString(line)
		written++
	}

	if written == 0 {
		filterNote := ""
		if m.filterInfo {
			filterNote = " (press f to show INFO events)"
		}
		sb.WriteString("\n" + tuiDim.Render("  No detection events yet"+filterNote+"."))
		sb.WriteString("\n" + tuiDim.Render(fmt.Sprintf("  Run traffic through port %d to see alerts.", m.port)))
	}

	m.detectionsVP.SetContent(sb.String())
}

func (m tuiModel) renderDetectionsTab() string {
	return m.detectionsVP.View()
}

// ── Redis Tab ─────────────────────────────────────────────────────────────────

func (m *tuiModel) rebuildRedisVP() {
	m.mu.Lock()
	snap := make([]detect.Detection, len(m.redisDetections))
	copy(snap, m.redisDetections)
	m.mu.Unlock()

	var sb strings.Builder

	sb.WriteString(tuiCyan.Render("  ● REDIS LOGS  (internal traffic — isolated from main alert feed)\n"))
	sb.WriteString(tuiDim.Render("  "+strings.Repeat("─", 80)) + "\n")

	written := 0
	for _, d := range snap {
		sevStyle := tuiSevStyle(d.Severity)
		ts := d.Timestamp.Format("15:04:05")

		actorIP := d.SourceIP
		if actorIP == "" {
			actorIP = "—"
		}
		actorPort := ""
		if d.SourcePort > 0 {
			actorPort = fmt.Sprintf(":%d", d.SourcePort)
		}
		actorRaw := actorIP + actorPort
		if len(actorRaw) > 22 {
			actorRaw = actorRaw[:22]
		}
		actorPadded := actorRaw + spaces(22-len(actorRaw))

		line := fmt.Sprintf("  %s %s  %s  %-22s  %s  %s → :%d  %s\n",
			sevStyle.Render(d.Severity.Emoji()+" "+fmt.Sprintf("%-8s", d.Severity.String())),
			tuiDim.Render(ts),
			tuiProtoBadge(d.Protocol),
			tuiCyan.Render(fmt.Sprintf("%-22s", d.ID)),
			tuiActor.Render(actorPadded),
			tuiDim.Render("→"),
			d.DestPort,
			d.Summary,
		)
		sb.WriteString(line)
		written++
	}

	if written == 0 {
		sb.WriteString("\n" + tuiDim.Render("  No Redis detection events yet."))
		sb.WriteString("\n" + tuiDim.Render(fmt.Sprintf("  Run traffic through port %d to see alerts.", m.port)))
	}

	m.redisVP.SetContent(sb.String())
}

func (m tuiModel) renderRedisTab() string {
	return m.redisVP.View()
}

// ── Metrics Tab ───────────────────────────────────────────────────────────────

func (m *tuiModel) rebuildMetricsVP() {
	uptime := time.Since(m.startTime).Round(time.Second)
	elapsed := time.Since(m.startTime).Seconds()

	totalPkts := m.stats.totalPkts.Load()
	ingress := m.stats.ingressPkts.Load()
	egress := m.stats.egressPkts.Load()
	totalBytes := m.stats.totalBytes.Load()

	pps := 0.0
	if elapsed > 0 {
		pps = float64(totalPkts) / elapsed
	}

	var sb strings.Builder
	sb.WriteString("\n")

	if m.proxyStats != nil {
		// ── Protocol Traffic Volume (proxy connections) ──
		sb.WriteString(tuiCyan.Render("  ── Protocol Traffic Volume (proxy connections) ──") + "\n\n")
		sb.WriteString(fmt.Sprintf("  %-10s  %-12s  %-10s  %-10s\n",
			tuiDim.Render("PROTOCOL"),
			tuiDim.Render("CONNECTIONS"),
			tuiDim.Render("BYTES IN"),
			tuiDim.Render("BYTES OUT"),
		))

		connStats := m.proxyStats.ProtocolConnStats()
		hasRows := false
		for _, proto := range []string{"HTTP", "TLS", "SSH", "FTP", "DNS", "SMTP", "TELNET", "REDIS", "MYSQL", "POSTGRES", "UNKNOWN"} {
			if stats, ok := connStats[proto]; ok && stats.Connections > 0 {
				sb.WriteString(fmt.Sprintf("  %-10s  %-12s  %-10s  %-10s\n",
					tuiWhite.Render(proto),
					tuiWhite.Render(fmt.Sprintf("%d", stats.Connections)),
					tuiGreen.Render(formatBytes(stats.BytesIn)),
					tuiOrange.Render(formatBytes(stats.BytesOut)),
				))
				hasRows = true
			}
		}
		if !hasRows {
			sb.WriteString(tuiDim.Render("  No proxy connections yet.\n"))
		}
		sb.WriteString("\n")

		// ── L7 Detection Breakdown by Protocol ──
		sb.WriteString(tuiCyan.Render("  ── L7 Detection Breakdown by Protocol ──") + "\n\n")
		sb.WriteString(fmt.Sprintf("  %-10s  %-8s\n",
			tuiDim.Render("PROTOCOL"),
			tuiDim.Render("TOTAL"),
		))
		detCounts := m.proxyStats.ProtocolCounts()
		hasDetRows := false
		for _, proto := range []string{"HTTP", "TLS", "SSH", "FTP", "DNS", "SMTP", "TELNET", "REDIS", "MYSQL", "POSTGRES", "UNKNOWN"} {
			if count, ok := detCounts[proto]; ok && count > 0 {
				sb.WriteString(fmt.Sprintf("  %-10s  %-8s\n",
					tuiWhite.Render(proto),
					tuiCrit.Render(fmt.Sprintf("%d", count)),
				))
				hasDetRows = true
			}
		}
		if !hasDetRows {
			sb.WriteString(tuiDim.Render("  No detections yet.\n"))
		}
		sb.WriteString("\n")

		// ── Top Talkers (IPs with most detections) ──
		sb.WriteString(tuiCyan.Render("  ── Top Talkers (by detection count) ──") + "\n\n")
		sb.WriteString(fmt.Sprintf("  %-22s  %-8s\n",
			tuiDim.Render("SOURCE IP"),
			tuiDim.Render("DETECTIONS"),
		))
		talkers := m.proxyStats.TopTalkers(5)
		if len(talkers) == 0 {
			sb.WriteString(tuiDim.Render("  No active actors yet.\n"))
		} else {
			for i, t := range talkers {
				ip := t.IP
				if ip == "" {
					continue
				}
				// First entry is the highest-count actor — highlight in yellow
				ipStyle := tuiWhite
				if i == 0 {
					ipStyle = tuiActor
				}
				sb.WriteString(fmt.Sprintf("  %-22s  %-8s\n",
					ipStyle.Render(fmt.Sprintf("%-22s", ip)),
					tuiCrit.Render(fmt.Sprintf("%d", t.Detections)),
				))
			}
		}
		sb.WriteString("\n")
	}

	// ── eBPF Layer (kernel-level) ──
	sb.WriteString(tuiCyan.Render("  ── eBPF Layer (kernel-level) ──") + "\n\n")
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Uptime:"), tuiWhite.Render(uptime.String())))
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Total Packets:"), tuiWhite.Render(fmt.Sprintf("%d", totalPkts))))
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("  ⬇ Incoming:"), tuiGreen.Render(fmt.Sprintf("%d", ingress))))
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("  ⬆ Outgoing:"), tuiOrange.Render(fmt.Sprintf("%d", egress))))
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Total Bytes:"), tuiWhite.Render(formatBytes(totalBytes))))
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Packet Rate:"), tuiCyan.Render(fmt.Sprintf("%.1f pkt/s", pps))))
	sb.WriteString("\n")

	m.metricsVP.SetContent(sb.String())
}

func (m tuiModel) renderMetricsTab() string {
	return m.metricsVP.View()
}

// ── Connections Tab ───────────────────────────────────────────────────────────

func (m tuiModel) renderConnectionsTab() string {
	var sb strings.Builder
	
	header := fmt.Sprintf("  Active Connections  (%d live)\n", len(m.conns))
	sb.WriteString(tuiWhite.Render(header))
	sb.WriteString(tuiDim.Render("  " + strings.Repeat("─", 80) + "\n"))

	if len(m.conns) == 0 {
		sb.WriteString(tuiDim.Render("\n  No active connections.\n"))
		sb.WriteString(tuiDim.Render(fmt.Sprintf("  Run traffic through port %d to see connections.", m.port)))
	} else {
		for i, c := range m.conns {
			cursor := "  "
			if i == m.connSelected {
				cursor = tuiCyan.Render("[>]")
			}
			
			ipStr := fmt.Sprintf("%s:%d", c.ClientIP, c.ClientPort)
			if len(ipStr) > 22 {
				ipStr = ipStr[:22]
			}
			
			uptime := time.Since(c.StartTime).Round(time.Second)
			upStr := uptime.String()
			
			sevStr := ""
			if c.MaxSev > detect.SevInfo {
				sevStyle := tuiSevStyle(c.MaxSev)
				sevStr = sevStyle.Render(c.MaxSev.Emoji() + " " + c.MaxSev.String())
			} else {
				sevStr = tuiDim.Render(detect.SevInfo.Emoji() + " INFO")
			}

			line := fmt.Sprintf("  %s %-22s   %-8s   %-10s   ↓ %-8s  ↑ %-8s   %s\n",
				cursor,
				tuiWhite.Render(ipStr),
				tuiProtoBadge(c.Protocol),
				tuiDim.Render(upStr),
				formatBytes(c.BytesIn),
				formatBytes(c.BytesOut),
				sevStr,
			)
			sb.WriteString(line)
		}
	}
	
	sb.WriteString(tuiDim.Render("  " + strings.Repeat("─", 80) + "\n"))
	if m.connStatusMsg != "" {
		msgColor := tuiMed
		if strings.HasPrefix(m.connStatusMsg, "Killed") {
			msgColor = tuiCrit
		}
		sb.WriteString(fmt.Sprintf("  %s\n", msgColor.Render(m.connStatusMsg)))
	} else {
		sb.WriteString("  \n")
	}

	return sb.String()
}
