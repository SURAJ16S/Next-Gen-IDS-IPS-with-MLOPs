// tui.go — Interactive TUI dashboard for NGFW Monitor
// Implements a Bubble Tea tea.Model with three tabs:
//   [1] Packets  — live eBPF packet feed (deduped for loopback)
//   [2] Alerts   — ML / proxy detection events (INFO filtered by default)
//   [3] Metrics  — uptime, rates, severity counts, ASCII bar chart
//
// Hotkeys:
//   1 / 2 / 3      switch tabs
//   ↑ / ↓ / pgup / pgdn  scroll active pane
//   p              pause / resume live scroll
//   f              toggle: hide/show INFO events in Alerts tab
//   q / ctrl+c     graceful shutdown

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
)

// ── ring-buffer sizes ──────────────────────────────────────────────────────────

const (
	maxTUIPackets = 200
	maxTUIAlerts  = 500
)

// ── message types sent into the TUI event loop ────────────────────────────────

type packetMsg packetRecord     // from eBPF ring-buffer goroutine
type alertMsg  detect.Detection // from DetectionBus subscriber
type tickMsg   time.Time        // periodic metrics refresh

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
		p.Send(alertMsg(d))
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
	mu      sync.Mutex
	packets []packetRecord
	alerts  []detect.Detection

	// sub-components
	pktsTable table.Model
	alertsVP  viewport.Model
	metricsVP viewport.Model

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
}

// newTuiModel constructs the model for Integrated or eBPF-only modes.
func newTuiModel(port uint16, iface string, svc ServiceInfo, pStats *detect.StatsCollector, flog *fileLogger) tuiModel {
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
		activeTab:  1,    // default to Alerts tab — most useful at a glance
		filterInfo: true, // filter INFO noise by default; press f to toggle
		packets:    make([]packetRecord, 0, maxTUIPackets),
		alerts:     make([]detect.Detection, 0, maxTUIAlerts),
		pktsTable:  t,
		alertsVP:   viewport.New(80, 20),
		metricsVP:  viewport.New(80, 20),
		stats:      &tuiStats{}, // heap-allocated — safe across model copies
		proxyStats: pStats,
		startTime:  time.Now(),
		port:       port,
		iface:      iface,
		svcInfo:    svc,
		flog:       flog,
		width:      120,
		height:     40,
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
		m.alertsVP.Width = m.width - 4
		m.alertsVP.Height = vpHeight
		m.metricsVP.Width = m.width - 4
		m.metricsVP.Height = vpHeight
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
		case "p":
			m.paused = !m.paused
		case "f":
			m.filterInfo = !m.filterInfo
			m.rebuildAlertsVP()
		}

		// Delegate scroll / cursor keys to the active pane
		var cmd tea.Cmd
		switch m.activeTab {
		case 0:
			m.pktsTable, cmd = m.pktsTable.Update(msg)
		case 1:
			m.alertsVP, cmd = m.alertsVP.Update(msg)
		case 2:
			m.metricsVP, cmd = m.metricsVP.Update(msg)
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
	case alertMsg:
		d := detect.Detection(msg)
		m.stats.addAlert(d.Severity) // safe: pointer receiver, atomic ops
		if !m.paused {
			// Skip INFO events when filter is on — don't even store them
			if !(m.filterInfo && d.Severity == detect.SevInfo) {
				m.mu.Lock()
				m.alerts = append(m.alerts, d)
				if len(m.alerts) > maxTUIAlerts {
					m.alerts = m.alerts[len(m.alerts)-maxTUIAlerts:]
				}
				m.mu.Unlock()
				m.rebuildAlertsVP()
				if m.activeTab == 1 {
					m.alertsVP.GotoBottom()
				}
			}
		}

	// ── periodic metrics refresh ──
	case tickMsg:
		m.rebuildMetricsVP()
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
		sb.WriteString(m.renderAlertsTab())
	case 2:
		sb.WriteString(m.renderMetricsTab())
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
	alertsLabel := "[2] Alerts"
	if highCrit > 0 {
		alertsLabel = fmt.Sprintf("[2] Alerts %s", tuiAlertBadge.Render(fmt.Sprintf("(%d!)", highCrit)))
	}

	tabs := []string{"[1] Packets", alertsLabel, "[3] Metrics"}
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
	hotkeys := tuiDim.Render("  1/2/3") + tuiWhite.Render(" tabs") +
		tuiDim.Render("  ↑/↓") + tuiWhite.Render(" scroll") +
		tuiDim.Render("  p") + tuiWhite.Render(" pause") +
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

func (m *tuiModel) rebuildAlertsVP() {
	m.mu.Lock()
	snap := make([]detect.Detection, len(m.alerts))
	copy(snap, m.alerts)
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

	// Event rows
	written := 0
	for _, d := range snap {
		sevStyle := tuiSevStyle(d.Severity)
		ts := d.Timestamp.Format("15:04:05")
		srcPort := ""
		if d.SourcePort > 0 {
			srcPort = fmt.Sprintf(":%d", d.SourcePort)
		}
		line := fmt.Sprintf("  %s %s  %s  %s%s → :%d  %s\n",
			sevStyle.Render(d.Severity.Emoji()+" "+fmt.Sprintf("%-8s", d.Severity.String())),
			tuiDim.Render(ts),
			tuiCyan.Render(fmt.Sprintf("%-22s", d.ID)),
			tuiWhite.Render(d.SourceIP),
			tuiDim.Render(srcPort),
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

	m.alertsVP.SetContent(sb.String())
}

func (m tuiModel) renderAlertsTab() string {
	return m.alertsVP.View()
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

	// ── eBPF Traffic section ──
	sb.WriteString(tuiCyan.Render("  ── eBPF Traffic Metrics ──") + "\n\n")
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Uptime:"), tuiWhite.Render(uptime.String())))
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Total Packets:"), tuiWhite.Render(fmt.Sprintf("%d", totalPkts))))
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("  ⬇ Incoming:"), tuiGreen.Render(fmt.Sprintf("%d", ingress))))
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("  ⬆ Outgoing:"), tuiOrange.Render(fmt.Sprintf("%d", egress))))
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Total Bytes:"), tuiWhite.Render(formatBytes(totalBytes))))
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Packet Rate:"), tuiCyan.Render(fmt.Sprintf("%.1f pkt/s", pps))))
	sb.WriteString("\n")

	// ── Proxy / Detection section ──
	if m.proxyStats != nil {
		active := m.proxyStats.ActiveConnections()
		total := m.proxyStats.TotalConnections()
		dets := m.proxyStats.TotalDetections()
		sevs := m.proxyStats.SeverityCounts()

		sb.WriteString(tuiCyan.Render("  ── Proxy / Detection Metrics ──") + "\n\n")
		sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Active Conns:"), tuiWhite.Render(fmt.Sprintf("%d", active))))
		sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Total Conns:"), tuiWhite.Render(fmt.Sprintf("%d", total))))
		sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Total Detections:"), tuiWhite.Render(fmt.Sprintf("%d", dets))))
		sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("  🔴 Critical:"), tuiCrit.Render(fmt.Sprintf("%d", sevs["CRITICAL"]))))
		sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("  🟠 High:"), tuiHigh.Render(fmt.Sprintf("%d", sevs["HIGH"]))))
		sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("  🟡 Medium:"), tuiMed.Render(fmt.Sprintf("%d", sevs["MEDIUM"]))))
		sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("  🔵 Low:"), tuiLow.Render(fmt.Sprintf("%d", sevs["LOW"]))))
		sb.WriteString("\n")
	}

	// ── Traffic Direction bar chart ──
	if totalPkts > 0 {
		sb.WriteString(tuiCyan.Render("  ── Traffic Direction ──") + "\n\n")
		barWidth := 36
		ingressRatio := float64(ingress) / float64(totalPkts)
		ingressBars := int(ingressRatio * float64(barWidth))
		if ingressBars > barWidth {
			ingressBars = barWidth
		}
		egressBars := barWidth - ingressBars

		sb.WriteString(fmt.Sprintf("  ⬇ IN  %s%s  %.0f%%\n",
			tuiGreen.Render(strings.Repeat("█", ingressBars)),
			tuiDim.Render(strings.Repeat("░", egressBars)),
			ingressRatio*100,
		))
		sb.WriteString(fmt.Sprintf("  ⬆ OUT %s%s  %.0f%%\n",
			tuiOrange.Render(strings.Repeat("█", egressBars)),
			tuiDim.Render(strings.Repeat("░", ingressBars)),
			(1-ingressRatio)*100,
		))
		sb.WriteString("\n")
	}

	// ── Log file status ──
	sb.WriteString(tuiCyan.Render("  ── Log Files ──") + "\n\n")
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Packet log:"), tuiWhite.Render("output.txt")))
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Detections:"), tuiWhite.Render("logs/detections.jsonl")))
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Flows:"), tuiWhite.Render("logs/flow_stats.jsonl")))
	sb.WriteString(fmt.Sprintf("  %-18s  %s\n", tuiDim.Render("Protocol logs:"), tuiWhite.Render("logs/protocols/")))

	m.metricsVP.SetContent(sb.String())
}

func (m tuiModel) renderMetricsTab() string {
	return m.metricsVP.View()
}
