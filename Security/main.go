// SPDX-License-Identifier: GPL-2.0
// main.go — NGFW eBPF Traffic Monitor
// A desktop CLI application that uses eBPF TC hooks to monitor incoming and
// outgoing TCP/UDP traffic on a user-specified port in real time.
// Logs complete packet details to output.txt (overwritten on each restart).

package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"flag"
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	ebpflib "github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"

	"ngfw-monitor/detect"
	"ngfw-monitor/proxy"
)

var (
	globalStreamer       *TelemetryStreamer
	globalStreamInterval time.Duration
)

// ──────────────────────────────────────────────────────────────────────────────
// Constants & Styles
// ──────────────────────────────────────────────────────────────────────────────

const maxEvents = 15 // Number of events to keep in the scrolling dashboard

// Color palette
var (
	colorCyan    = lipgloss.Color("#00E5FF")
	colorGreen   = lipgloss.Color("#00E676")
	colorRed     = lipgloss.Color("#FF1744")
	colorYellow  = lipgloss.Color("#FFEA00")
	colorMagenta = lipgloss.Color("#E040FB")
	colorDim     = lipgloss.Color("#616161")
	colorWhite   = lipgloss.Color("#ECEFF1")
	colorBg      = lipgloss.Color("#0D1117")
	colorBorder  = lipgloss.Color("#30363D")
)

// Styles
var (
	bannerStyle = lipgloss.NewStyle().
			Foreground(colorCyan).
			Bold(true)

	headerStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(colorWhite).
			Background(lipgloss.Color("#1A237E")).
			Padding(0, 1)

	ingressStyle = lipgloss.NewStyle().
			Foreground(colorGreen).
			Bold(true)

	egressStyle = lipgloss.NewStyle().
			Foreground(colorRed).
			Bold(true)

	tcpStyle = lipgloss.NewStyle().
			Foreground(colorCyan)

	udpStyle = lipgloss.NewStyle().
			Foreground(colorMagenta)

	flagStyle = lipgloss.NewStyle().
			Foreground(colorYellow)

	statLabelStyle = lipgloss.NewStyle().
			Foreground(colorDim)

	statValueStyle = lipgloss.NewStyle().
			Foreground(colorWhite).
			Bold(true)

	dimStyle = lipgloss.NewStyle().
			Foreground(colorDim)

	borderStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorBorder).
			Padding(0, 1)
)

// ──────────────────────────────────────────────────────────────────────────────
// Data types
// ──────────────────────────────────────────────────────────────────────────────

type packetRecord struct {
	// Metadata
	Direction string // "INCOMING" or "OUTGOING"
	Timestamp time.Time

	// IP Layer
	SrcIP      string
	DstIP      string
	Protocol   string // "TCP" or "UDP"
	Size       uint16 // Total IP packet size
	TTL        uint8
	TOS        uint8
	IPID       uint16
	IPHdrLen   uint8
	FragOffset uint16
	MoreFrag   bool

	// L4 Layer
	SrcPort uint16
	DstPort uint16

	// TCP-specific
	TCPFlags  string // Human-readable flags like "[SYN,ACK]"
	FlagsRaw  uint8  // Raw bitmask
	SeqNum    uint32
	AckNum    uint32
	Window    uint16
	TCPHdrLen uint8
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

// intToIP converts a 32-bit network-order IP to dotted notation
func intToIP(nn uint32) string {
	ip := make(net.IP, 4)
	ip[0] = byte(nn)
	ip[1] = byte(nn >> 8)
	ip[2] = byte(nn >> 16)
	ip[3] = byte(nn >> 24)
	return ip.String()
}

// tcpFlagsToString converts a TCP flags bitmask to a human-readable string
func tcpFlagsToString(flags uint8) string {
	if flags == 0 {
		return ""
	}
	var parts []string
	if flags&0x02 != 0 {
		parts = append(parts, "SYN")
	}
	if flags&0x10 != 0 {
		parts = append(parts, "ACK")
	}
	if flags&0x01 != 0 {
		parts = append(parts, "FIN")
	}
	if flags&0x04 != 0 {
		parts = append(parts, "RST")
	}
	if flags&0x08 != 0 {
		parts = append(parts, "PSH")
	}
	if flags&0x20 != 0 {
		parts = append(parts, "URG")
	}
	if len(parts) == 0 {
		return ""
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func clearScreen() {
	fmt.Print("\033[2J\033[H")
}

func moveCursor(row, col int) {
	fmt.Printf("\033[%d;%dH", row, col)
}

func formatBytes(b int64) string {
	switch {
	case b >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(b)/float64(1<<20))
	case b >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(b)/float64(1<<10))
	default:
		return fmt.Sprintf("%d B", b)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Interactive CLI Helpers
// ──────────────────────────────────────────────────────────────────────────────

// globalScanner is a shared bufio.Scanner that reads from stdin line-by-line.
// Using a single scanner avoids buffering conflicts between multiple reads.
var globalScanner = bufio.NewScanner(os.Stdin)

// readLine reads a single trimmed line from stdin via the global scanner.
func readLine() string {
	if globalScanner.Scan() {
		return strings.TrimSpace(globalScanner.Text())
	}
	return ""
}

// promptMenuChoice displays the main menu and returns a valid choice (1–4).
// It re-prompts indefinitely until the user enters a valid option.
func promptMenuChoice() int {
	errorStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#FF1744")).Bold(true)
	optionStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00E5FF")).Bold(true)
	highlightStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00E676")).Bold(true)

	for {
		clearScreen()
		fmt.Println(bannerStyle.Render(`
  ╔══════════════════════════════════════════════════════════════════╗
  ║      ███╗   ██╗ ██████╗ ███████╗██╗    ██╗                     ║
  ║      ████╗  ██║██╔════╝ ██╔════╝██║    ██║                     ║
  ║      ██╔██╗ ██║██║  ███╗█████╗  ██║ █╗ ██║                     ║
  ║      ██║╚██╗██║██║   ██║██╔══╝  ██║███╗██║                     ║
  ║      ██║ ╚████║╚██████╔╝██║     ╚███╔███╔╝                     ║
  ║      ╚═╝  ╚═══╝ ╚═════╝ ╚═╝      ╚══╝╚══╝                     ║
  ║ Intelligent multi protocol intrusion detection and prevention system using the ML Ops ║
  ╚═════════════════════════════════════════════════════════════════════════════════════╝`))
		fmt.Println()
		fmt.Println(statLabelStyle.Render("  Select an operating mode:"))
		fmt.Println()
		fmt.Println("  " + optionStyle.Render("[1]") + "  " + statValueStyle.Render("eBPF Traffic Monitor") +
			" — kernel-level packet inspection via TC hooks")
		fmt.Println("  " + optionStyle.Render("[2]") + "  " + statValueStyle.Render("Reverse Proxy") +
			"          — application-layer DPI detection engine")
		fmt.Println("  " + optionStyle.Render("[3]") + "  " + statValueStyle.Render("Integrated Mode") +
			"        — eBPF monitor + proxy detection combined")
		fmt.Println("  " + optionStyle.Render("[4]") + "  " + statValueStyle.Render("Port Management") +
			"        — check if a port is in use and free it")
		fmt.Println("  " + optionStyle.Render("[5]") + "  " + statValueStyle.Render("Agent Setup Wizard") +
			"     — pair this node with the central dashboard")
		fmt.Println("  " + highlightStyle.Render("[6]") + "  " + statValueStyle.Render("Exit"))
		fmt.Println()
		fmt.Print(statLabelStyle.Render("  Enter choice [1-6]: "))

		input := readLine()
		choice, err := strconv.Atoi(input)
		if err != nil || choice < 1 || choice > 6 {
			fmt.Println()
			fmt.Println(errorStyle.Render("  ✗ Invalid choice '" + input + "'. Please enter a number between 1 and 6."))
			fmt.Println(statLabelStyle.Render("  Press Enter to try again..."))
			readLine()
			continue
		}
		return choice
	}
}

// promptInterface lists available network interfaces and asks the user to
// select one by name or by list index. Re-prompts on invalid input.
func promptInterface() string {
	errorStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#FF1744")).Bold(true)
	indexStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#E040FB")).Bold(true)

	for {
		fmt.Println()
		fmt.Println(statLabelStyle.Render("  Available network interfaces:"))
		fmt.Println()

		ifaces, err := net.Interfaces()
		if err != nil {
			log.Fatalf("❌  Failed to list network interfaces: %v", err)
		}

		// Build a list of valid interface names for index-based lookup
		validIfaces := make([]string, 0, len(ifaces))
		for _, ifc := range ifaces {
			addrs, _ := ifc.Addrs()
			addrStrs := make([]string, 0, len(addrs))
			for _, a := range addrs {
				addrStrs = append(addrStrs, a.String())
			}
			addrInfo := ""
			if len(addrStrs) > 0 {
				addrInfo = " (" + strings.Join(addrStrs, ", ") + ")"
			}
			idx := len(validIfaces) + 1
			if ifc.Flags&net.FlagUp != 0 {
				fmt.Printf("    %s %s %s%s\n",
					indexStyle.Render(fmt.Sprintf("[%d]", idx)),
					ingressStyle.Render("●"),
					statValueStyle.Render(ifc.Name),
					dimStyle.Render(addrInfo))
			} else {
				fmt.Printf("    %s %s %s%s\n",
					indexStyle.Render(fmt.Sprintf("[%d]", idx)),
					dimStyle.Render("○"),
					dimStyle.Render(ifc.Name),
					dimStyle.Render(addrInfo+" [DOWN]"))
			}
			validIfaces = append(validIfaces, ifc.Name)
		}

		fmt.Println()
		fmt.Print(statLabelStyle.Render("  Enter interface name or number: "))
		input := readLine()

		if input == "" {
			fmt.Println(errorStyle.Render("  ✗ Input cannot be empty. Please try again."))
			continue
		}

		// Check if user entered a number (index)
		if idx, err := strconv.Atoi(input); err == nil {
			if idx >= 1 && idx <= len(validIfaces) {
				selected := validIfaces[idx-1]
				fmt.Println(ingressStyle.Render("  ✓ Selected interface: ") + statValueStyle.Render(selected))
				return selected
			}
			fmt.Println(errorStyle.Render(fmt.Sprintf("  ✗ Index %d is out of range (1–%d). Please try again.", idx, len(validIfaces))))
			continue
		}

		// Check if user entered a valid interface name
		if _, err := net.InterfaceByName(input); err == nil {
			fmt.Println(ingressStyle.Render("  ✓ Selected interface: ") + statValueStyle.Render(input))
			return input
		}

		fmt.Println(errorStyle.Render("  ✗ Interface '" + input + "' not found. Please enter a valid name or number."))
	}
}

// promptPort prompts the user to enter a port number (1–65535) and
// re-prompts until a valid value is given.
func promptPort(label string) uint16 {
	errorStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#FF1744")).Bold(true)

	for {
		fmt.Println()
		fmt.Print(statLabelStyle.Render("  " + label + " [1-65535]: "))
		input := readLine()

		if input == "" {
			fmt.Println(errorStyle.Render("  ✗ Input cannot be empty. Please try again."))
			continue
		}

		port, err := strconv.Atoi(input)
		if err != nil {
			fmt.Println(errorStyle.Render("  ✗ '" + input + "' is not a valid number. Please enter an integer."))
			continue
		}
		if port < 1 || port > 65535 {
			fmt.Println(errorStyle.Render(fmt.Sprintf("  ✗ Port %d is out of range. Must be between 1 and 65535.", port)))
			continue
		}

		fmt.Println(ingressStyle.Render(fmt.Sprintf("  ✓ Port set to: %d", port)))
		return uint16(port)
	}
}

// findFreePort finds a free port starting from base, incrementing until one is
// available. This is used to auto-select a proxy listen port so it never
// conflicts with the user's real service.
func findFreePort(base uint16) uint16 {
	for port := base; port <= 65534; port++ {
		// Browsers block port 10080 (Amanda) to prevent NAT slipstreaming,
		// and most ports under 1024. Skip them so we don't break web access.
		if port == 10080 || (port < 1024 && port != 80 && port != 443) {
			continue
		}
		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
		if err == nil {
			ln.Close()
			return port
		}
	}
	// Fallback: try from 49152 (IANA dynamic range)
	for port := uint16(49152); port <= 65534; port++ {
		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
		if err == nil {
			ln.Close()
			return port
		}
	}
	return 0
}

// promptAppPort asks the user for their backend service port.
// Auto-calculates a free proxy listen port (backend + 10000) and returns both.
func promptAppPort() (backendPort, proxyPort uint16) {
	infoStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00E5FF"))
	tipStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#FFEA00"))

	fmt.Println()
	fmt.Println(infoStyle.Render("  \u250c\u2500 What port is your app/service running on?"))
	fmt.Println(infoStyle.Render("  \u2502  This is the port YOU started your server on."))
	fmt.Println(tipStyle.Render("  \u2502  Examples:"))
	fmt.Println(tipStyle.Render("  \u2502    python3 -m http.server 8080  \u2192  enter 8080"))
	fmt.Println(tipStyle.Render("  \u2502    node server.js (port 5000)   \u2192  enter 5000"))
	fmt.Println(tipStyle.Render("  \u2502    npm run dev  (port 3000)     \u2192  enter 3000"))
	fmt.Println(infoStyle.Render("  \u2514\u2500 The monitor will NOT touch that port."))

	backendPort = promptPort("Your app's port")

	// Auto-calculate a free proxy listen port
	candidate := backendPort + 10000
	if candidate > 65534 {
		candidate = backendPort - 1000
	}
	proxyPort = findFreePort(candidate)

	if proxyPort != 0 {
		fmt.Println()
		fmt.Println(infoStyle.Render(fmt.Sprintf(
			"  \u2713 Proxy will be assigned port :%d (auto-selected, won't conflict with your app)",
			proxyPort)))
	}

	return backendPort, proxyPort
}

// managePort prompts for a port, checks if it's in use, and offers to kill it.
func managePort() {
	clearScreen()
	fmt.Println(bannerStyle.Render("\n  ── Port Management ──\n"))

	port := promptPort("Enter port to check/manage")
	fmt.Println()

	// Try to listen on the port to see if it's free
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err == nil {
		ln.Close()
		successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00E676")).Bold(true)
		fmt.Println(successStyle.Render(fmt.Sprintf("  ✓ Port %d is currently FREE (not in use).", port)))
		return
	}

	// Port is in use
	errorStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#FF1744")).Bold(true)
	fmt.Println(errorStyle.Render(fmt.Sprintf("  ✗ Port %d is IN USE.", port)))

	// Show what is using it if possible using ss
	cmd := exec.Command("ss", "-lptn", fmt.Sprintf("sport = :%d", port))
	out, _ := cmd.CombinedOutput()
	if len(out) > 0 {
		fmt.Println(lipgloss.NewStyle().Foreground(lipgloss.Color("#757575")).Render("\n" + string(out)))
	}

	fmt.Print(statLabelStyle.Render("  Do you want to FORCE CLOSE the port by killing the process? (y/N): "))
	ans := readLine()
	if strings.ToLower(ans) == "y" || strings.ToLower(ans) == "yes" {
		killCmd := exec.Command("fuser", "-k", fmt.Sprintf("%d/tcp", port))
		if killErr := killCmd.Run(); killErr != nil {
			fmt.Println(errorStyle.Render("  ✗ Failed to kill process. Are you running as root (sudo)?"))
		} else {
			successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00E676")).Bold(true)
			fmt.Println(successStyle.Render(fmt.Sprintf("  ✓ Process killed. Port %d should now be free.", port)))
		}
	} else {
		fmt.Println(statLabelStyle.Render("  Skipped."))
	}
}

// initProxyEngineWithPort loads (or creates) the proxy config, injects the
// user-specified listen/backend port pair into it, saves the updated config
// back to disk, then initialises and starts the proxy engine.
// tuiSub may be nil; when non-nil, detection events are also forwarded to the TUI.
func initProxyEngineWithPort(configPath string, listenPort, backendPort uint16, service string, tuiSub *TUISubscriber) (*proxy.ProxyEngine, *detect.StatsCollector, error) {
	// Load existing config, or fall back to the built-in default
	cfg, err := proxy.LoadConfig(configPath)
	if err != nil {
		if strings.Contains(err.Error(), "no such file or directory") {
			cfg = proxy.DefaultConfig()

		} else {
			return nil, nil, fmt.Errorf("failed to load configuration: %w", err)
		}
	}

	// Inject the user-supplied listener (add or update in place)
	cfg.AddOrUpdateListener(listenPort, backendPort, service)

	// Persist the updated config so it survives restarts
	if saveErr := proxy.SaveConfig(cfg, configPath); saveErr != nil {
		// Non-fatal: warn but continue — the engine will still start with the
		// in-memory config even if the file write fails.
		fmt.Printf("  %s Warning: could not save updated config to %s: %v\n",
			lipgloss.NewStyle().Foreground(lipgloss.Color("#FFEA00")).Bold(true).Render("⚠"),
			configPath, saveErr)
	} else {
		fmt.Printf("  %s Config saved: :%d → 127.0.0.1:%d [%s] added to %s\n",
			ingressStyle.Render("✓"),
			listenPort, backendPort, service, configPath)
	}

	stats := detect.NewStatsCollector()
	bus := detect.NewDetectionBus()

	jsonLogger, err := detect.NewJSONLLogger(cfg.Logging.Dir, cfg.Logging.MaxFileSizeMB)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to initialize JSONL logger: %w", err)
	}
	bus.Subscribe(jsonLogger)
	bus.Subscribe(stats)
	detect.NewGraphEngine(bus)
	detect.NewThresholdCalibrator(bus)
	detect.NewDeceptionMesh(bus, []int{3306, 5432, 23}).Start()
	
	// Forward detections to TUI if one is attached
	if tuiSub != nil {
		bus.Subscribe(tuiSub)
	}

	nodeCfg, _ := LoadNodeConfig()
	if nodeCfg != nil && globalStreamInterval > 0 {
		globalStreamer = NewTelemetryStreamer(nodeCfg, stats, globalStreamInterval)
		bus.Subscribe(globalStreamer)
		globalStreamer.Start()
	}

	engine := proxy.NewProxyEngine(cfg, bus, stats)
	if err := engine.Start(); err != nil {
		return nil, nil, fmt.Errorf("failed to start proxy engine: %w", err)
	}

	return engine, stats, nil
}

// ──────────────────────────────────────────────────────────────────────────────
// Interactive Menu Orchestrator
// ──────────────────────────────────────────────────────────────────────────────

// runInteractiveMenu drives the top-level menu loop and dispatches to the
// appropriate mode based on user selection.
func runInteractiveMenu() {
	errorStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#FF1744")).Bold(true)
	successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00E676")).Bold(true)
	highlightStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#00E5FF")).Bold(true)

	for {
		choice := promptMenuChoice()

		switch choice {

		case 1: // eBPF Monitor only
			clearScreen()
			fmt.Println(bannerStyle.Render("\n  ── eBPF Traffic Monitor Setup ──\n"))
			ifaceName := promptInterface()
			backendPort := promptPort("Your backend service port")
			fmt.Println()
			fmt.Println(successStyle.Render(fmt.Sprintf("  ✓ Attaching eBPF hooks to %s on port %d...", ifaceName, backendPort)))
			fmt.Println(dimStyle.Render(fmt.Sprintf("  ● Your app is still accessible at http://localhost:%d", backendPort)))
			fmt.Println()
			runEBPFMonitor(backendPort, ifaceName, nil, nil, nil)

		case 2: // Proxy only
			clearScreen()
			fmt.Println(bannerStyle.Render("\n  ── Reverse Proxy Setup ──\n"))
			backendPort, proxyPort := promptAppPort()
			if proxyPort == 0 {
				fmt.Println(errorStyle.Render("  ✗ Could not find a free port. Please free up some ports."))
				fmt.Println(statLabelStyle.Render("  Press Enter to return to menu..."))
				readLine()
				continue
			}
			svcInfo := detectService(backendPort)
			service := svcInfo.DisplayName()
			if service == "" || service == "unknown" {
				service = "http"
			}
			fmt.Println()
			fmt.Println(successStyle.Render(fmt.Sprintf("  ✓ Auto-selected proxy port: %d", proxyPort)))
			fmt.Println(highlightStyle.Render(fmt.Sprintf("  ● Open in browser: http://localhost:%d", proxyPort)))
			fmt.Println(dimStyle.Render(fmt.Sprintf("  ● Flow: browser → :%d (proxy) → :%d (your app)", proxyPort, backendPort)))
			fmt.Println()
			_, stats, err := initProxyEngineWithPort("proxy_config.yaml", proxyPort, backendPort, service, nil)
			if err != nil {
				fmt.Println(errorStyle.Render("  ✗ Proxy initialization failed: " + err.Error()))
				fmt.Println(statLabelStyle.Render("  Press Enter to return to menu..."))
				readLine()
				continue
			}
			runStandaloneProxy(stats)

		case 3: // Integrated — eBPF + Proxy, both on same proxy listen port
			clearScreen()
			fmt.Println(bannerStyle.Render("\n  ── Integrated Mode Setup (eBPF + Proxy) ──\n"))
			ifaceName := promptInterface()
			backendPort, proxyPort := promptAppPort()
			if proxyPort == 0 {
				fmt.Println(errorStyle.Render("  ✗ Could not find a free port. Please free up some ports."))
				fmt.Println(statLabelStyle.Render("  Press Enter to return to menu..."))
				readLine()
				continue
			}
			svcInfo := detectService(backendPort)
			service := svcInfo.DisplayName()
			if service == "" || service == "unknown" {
				service = "http"
			}
			fmt.Println()
			fmt.Println(successStyle.Render(fmt.Sprintf("  ✓ eBPF hooks on %s — watching proxy port :%d", ifaceName, proxyPort)))
			fmt.Println(successStyle.Render(fmt.Sprintf("  ✓ Proxy :%d → your app on :%d", proxyPort, backendPort)))
			fmt.Println(highlightStyle.Render(fmt.Sprintf("  ● Open in browser: http://localhost:%d", proxyPort)))
			fmt.Println(dimStyle.Render(fmt.Sprintf("  ● Flow: browser → :%d (eBPF+Proxy) → :%d (your app)", proxyPort, backendPort)))
			fmt.Println()
			// Create a TUI subscriber placeholder; the TUI program pointer is
			// injected by runEBPFMonitor after the program starts.
			tuiAlertSub := &TUISubscriber{}
			engine, proxyStats, err := initProxyEngineWithPort("proxy_config.yaml", proxyPort, backendPort, service, tuiAlertSub)
			if err != nil {
				fmt.Println(errorStyle.Render("  ✗ Proxy initialization failed: " + err.Error()))
				fmt.Println(statLabelStyle.Render("  Press Enter to return to menu..."))
				readLine()
				continue
			}
			// eBPF monitors the proxy listen port — same port clients connect to
			runEBPFMonitor(proxyPort, ifaceName, proxyStats, tuiAlertSub, engine)

		case 4: // Port Management
			managePort()

		case 5: // Agent Setup Wizard
			clearScreen()
			RunSetupWizard()

		case 6: // Exit
			fmt.Println()
			fmt.Println(ingressStyle.Render("  ✓ Exiting NGFW Monitor. Goodbye!"))
			fmt.Println()
			os.Exit(0)
		}

		// After a run completes, return to the main menu
		fmt.Println()
		fmt.Println(statLabelStyle.Render("  Session ended. Press Enter to return to the menu..."))
		readLine()
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// File Logger — writes complete packet details to output.txt
// ──────────────────────────────────────────────────────────────────────────────

type fileLogger struct {
	file *os.File
	mu   sync.Mutex
}

func newFileLogger(path string) (*fileLogger, error) {
	// O_TRUNC overwrites the file on each restart
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return nil, err
	}

	fl := &fileLogger{file: f}
	fl.writeHeader()
	return fl, nil
}

func (fl *fileLogger) writeHeader() {
	fl.mu.Lock()
	defer fl.mu.Unlock()

	header := fmt.Sprintf(
		"================================================================================\n"+
			"  NGFW eBPF Traffic Monitor — Packet Log\n"+
			"  Started: %s\n"+
			"================================================================================\n\n"+
			"%-5s  %-9s  %-22s  %-22s  %-5s  %-15s  %-8s  %-4s  %-4s  %-7s  %-12s  %-12s  %-7s  %-5s\n"+
			"%s\n",
		time.Now().Format("2006-01-02 15:04:05 MST"),
		"#", "DIRECTION", "SOURCE", "DESTINATION", "PROTO", "FLAGS",
		"SIZE", "TTL", "TOS", "IP-ID", "SEQ", "ACK", "WINDOW", "IPHL",
		strings.Repeat("─", 160),
	)
	fmt.Fprint(fl.file, header)
}

func (fl *fileLogger) logPacket(index int64, rec packetRecord) {
	fl.mu.Lock()
	defer fl.mu.Unlock()

	src := fmt.Sprintf("%s:%d", rec.SrcIP, rec.SrcPort)
	dst := fmt.Sprintf("%s:%d", rec.DstIP, rec.DstPort)

	// Compact line in the table
	line := fmt.Sprintf(
		"%-5d  %-9s  %-22s  %-22s  %-5s  %-15s  %-8s  %-4d  %-4d  %-7d  %-12d  %-12d  %-7d  %-5d\n",
		index, rec.Direction, src, dst, rec.Protocol, rec.TCPFlags,
		formatBytes(int64(rec.Size)), rec.TTL, rec.TOS, rec.IPID,
		rec.SeqNum, rec.AckNum, rec.Window, rec.IPHdrLen,
	)

	// Detailed block underneath
	detail := fmt.Sprintf(
		"  │ Time: %s  │  FragOffset: %d  │  MF: %t  │  TCP-HdrLen: %d B  │  IP-HdrLen: %d B  │  Payload: ~%d B\n",
		rec.Timestamp.Format("2006-01-02 15:04:05.000"),
		rec.FragOffset,
		rec.MoreFrag,
		rec.TCPHdrLen,
		rec.IPHdrLen,
		payloadSize(rec),
	)

	fmt.Fprint(fl.file, line)
	fmt.Fprint(fl.file, detail)
}

func (fl *fileLogger) writeSummary(total, ingress, egress, totalBytesVal int64, uptime time.Duration) {
	fl.mu.Lock()
	defer fl.mu.Unlock()

	summary := fmt.Sprintf(
		"\n%s\n"+
			"  Session Summary\n"+
			"  Duration:      %s\n"+
			"  Total Packets: %d\n"+
			"  Incoming:      %d\n"+
			"  Outgoing:      %d\n"+
			"  Total Bytes:   %s\n"+
			"%s\n",
		strings.Repeat("═", 80),
		uptime.String(), total, ingress, egress, formatBytes(totalBytesVal),
		strings.Repeat("═", 80),
	)
	fmt.Fprint(fl.file, summary)
}

func (fl *fileLogger) close() {
	fl.file.Close()
}

// payloadSize estimates the application-layer payload size
func payloadSize(rec packetRecord) uint16 {
	headerSize := uint16(rec.IPHdrLen)
	if rec.Protocol == "TCP" {
		headerSize += uint16(rec.TCPHdrLen)
	} else {
		headerSize += 8 // UDP header is 8 bytes
	}
	if rec.Size > headerSize {
		return rec.Size - headerSize
	}
	return 0
}

// ──────────────────────────────────────────────────────────────────────────────
// Dashboard placeholder — kept for unused-import safety; real UI is in tui.go
// ──────────────────────────────────────────────────────────────────────────────

// sync and sync/atomic are used in tui.go and the file logger.

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

// runEBPFMonitor starts the eBPF traffic monitoring session on the given port
// and interface, optionally integrated with a running proxy detection engine.
func runEBPFMonitor(targetPort uint16, ifaceName string, proxyStats *detect.StatsCollector, tuiAlertSub *TUISubscriber, engine *proxy.ProxyEngine) {
	// ── Detect service running on the target port ──
	fmt.Printf("\n  %s Detecting service on port %d...\n", statLabelStyle.Render("🔍"), targetPort)
	svcInfo := detectService(targetPort)
	fmt.Printf("  %s Service detected: %s %s\n\n",
		statLabelStyle.Render("ℹ"),
		svcInfo.StatusBadge(),
		statValueStyle.Render(svcInfo.DisplayName()),
	)
	if svcInfo.ProcessName != "" && svcInfo.PID > 0 {
		fmt.Printf("  %s Process: %s   User: %s   Protocol: %s\n",
			statLabelStyle.Render(" "),
			statValueStyle.Render(svcInfo.ProcessName),
			statValueStyle.Render(svcInfo.User),
			statValueStyle.Render(svcInfo.Proto),
		)
		if svcInfo.Command != "" {
			cmd := svcInfo.Command
			if len(cmd) > 90 {
				cmd = cmd[:90] + "…"
			}
			fmt.Printf("  %s CMD: %s\n", statLabelStyle.Render(" "), dimStyle.Render(cmd))
		}
		fmt.Println()
	}

	// ── Validate interface ──
	iface, err := net.InterfaceByName(ifaceName)
	if err != nil {
		log.Fatalf("❌  Network interface %q not found: %v\n   Available interfaces can be listed with: ip link show", ifaceName, err)
	}

	// ── Open output.txt for logging (overwrite on restart) ──
	flog, err := newFileLogger("output.txt")
	if err != nil {
		log.Fatalf("❌  Failed to create output.txt: %v", err)
	}
	defer flog.close()

	// ── Load eBPF objects into the kernel ──
	fmt.Printf("  %s Loading eBPF programs into the kernel...\n", statLabelStyle.Render("⏳"))

	objs := bpfObjects{}
	if err := loadBpfObjects(&objs, nil); err != nil {
		log.Fatalf("❌  Failed to load eBPF objects: %v\n   Make sure you are running as root (sudo).", err)
	}
	defer objs.Close()

	// ── Write target port to the config map ──
	key := uint32(0)
	if err := objs.PortConfig.Put(&key, &targetPort); err != nil {
		log.Fatalf("❌  Failed to set target port in eBPF config map: %v", err)
	}

	// ── Attach eBPF programs to TC hooks ──
	fmt.Printf("  %s Attaching to TC ingress hook on %s...\n", statLabelStyle.Render("⏳"), ifaceName)
	ingressLink, err := link.AttachTCX(link.TCXOptions{
		Interface: iface.Index,
		Program:   objs.HandleIngress,
		Attach:    ebpflib.AttachTCXIngress,
	})
	if err != nil {
		log.Fatalf("❌  Failed to attach TC ingress: %v\n   Ensure your kernel supports TCX (Linux 6.6+).", err)
	}
	defer ingressLink.Close()

	fmt.Printf("  %s Attaching to TC egress hook on %s...\n", statLabelStyle.Render("⏳"), ifaceName)
	egressLink, err := link.AttachTCX(link.TCXOptions{
		Interface: iface.Index,
		Program:   objs.HandleEgress,
		Attach:    ebpflib.AttachTCXEgress,
	})
	if err != nil {
		log.Fatalf("❌  Failed to attach TC egress: %v\n   Ensure your kernel supports TCX (Linux 6.6+).", err)
	}
	defer egressLink.Close()

	fmt.Printf("  %s eBPF programs attached successfully!\n", ingressStyle.Render("✓"))
	fmt.Printf("  %s Logging packets to output.txt\n\n", statLabelStyle.Render("📄"))

	// ── Open ring buffer reader ──
	rd, err := ringbuf.NewReader(objs.PacketEvents)
	if err != nil {
		log.Fatalf("❌  Failed to open ring buffer reader: %v", err)
	}
	defer rd.Close()

	// ── Initialize flow tracker and logger ──
	flowTracker := detect.NewFlowTracker(10000, 120*time.Second)
	// Create a dummy bus for now since eBPF monitor doesn't have a shared one
	flowLoggerBus := detect.NewDetectionBus()
	if tuiAlertSub != nil {
		flowLoggerBus.Subscribe(tuiAlertSub)
	}
	flowLogger, err := detect.NewFlowLogger("logs", 100, flowLoggerBus)
	if err != nil {
		log.Fatalf("❌  Failed to create flow logger: %v", err)
	}
	defer flowLogger.Close()

	// ── Initialize flow correlator ──
	sshCorrelator := detect.NewFlowCorrelator()

	// ── Initialize SSH Feature Logger ──
	sshFeatureFile, err := os.OpenFile("logs/ssh_features.jsonl", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		log.Fatalf("❌  Failed to open ssh_features.jsonl: %v", err)
	}
	defer sshFeatureFile.Close()
	sshFeatureEncoder := json.NewEncoder(sshFeatureFile)

	// Drain completed flows to JSONL logger and Correlator
	go func() {
		for rec := range flowTracker.CompletedFlows() {
			flowLogger.LogFlow(rec)
			sshCorrelator.AddFlowRecord(rec)
		}
	}()

	// Drain SSH sessions to Correlator
	go func() {
		for sshRec := range detect.SSHSessionChan {
			sshCorrelator.AddSSHSessionRecord(sshRec)
		}
	}()

	// Drain completed correlated vectors to ML Client and JSONL Logger
	go func() {
		for vec := range sshCorrelator.OutCh {
			// Write to JSONL for training (Data Collection Step 7)
			sshFeatureEncoder.Encode(vec)

			// Call ML Service; fail-open
			score, _ := detect.ScoreSSH(context.Background(), vec)
			if score != nil && score.RiskScore > 70 && score.ModelVersion != "unavailable" {
				sev := detect.SevMedium
				if score.RiskScore > 85 {
					sev = detect.SevHigh
				}

				details := map[string]any{
					"risk_score":         score.RiskScore,
					"predicted_category": score.PredictedCategory,
					"confidence":         score.Confidence,
					"model_version":      score.ModelVersion,
				}
				for k, v := range score.ContributingFeatures {
					details["feature_"+k] = v
				}

				flowLoggerBus.EmitDetection(detect.Detection{
					ID:         fmt.Sprintf("ML-SSH-%s", score.PredictedCategory),
					Timestamp:  time.Now(),
					Severity:   sev,
					Category:   "ml-anomaly",
					Protocol:   "TCP", // SSH is over TCP
					SourceIP:   vec.SrcIP,
					SourcePort: 0, // not readily available in vec, 0 is fine
					DestPort:   22,
					Summary: fmt.Sprintf("ML SSH anomaly score %.1f — predicted: %s (model: %s)",
						score.RiskScore, score.PredictedCategory, score.ModelVersion),
					ConnID:  vec.ConnID,
					Details: details,
				})
			}
		}
	}()

	// Periodic sweep of idle flows
	go func() {
		sweepTicker := time.NewTicker(30 * time.Second)
		defer sweepTicker.Stop()
		for range sweepTicker.C {
			flowTracker.Sweep()
		}
	}()

	fmt.Printf("  %s Flow aggregation active → logs/flow_stats.jsonl\n", ingressStyle.Render("✓"))

	// ── Build TUI model and program ──
	tuiM := newTuiModel(targetPort, ifaceName, svcInfo, proxyStats, flog, engine)
	p := tea.NewProgram(tuiM, tea.WithAltScreen())
	// Wire the program pointer into the alert subscriber so proxy detections
	// flow into the TUI immediately (non-nil only in Integrated Mode)
	if tuiAlertSub != nil {
		tuiAlertSub.SetProgram(p)
	}

	// ── Signal handler for graceful shutdown ──
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		flowTracker.FlushAll()
		if globalStreamer != nil {
			globalStreamer.Stop()
		}
		p.Quit()
	}()

	// ── Ring buffer → TUI event pipeline ──
	go func() {
		for {
			record, err := rd.Read()
			if err != nil {
				return // reader closed on shutdown
			}

			var event bpfPacketEvent
			if err := binary.Read(bytes.NewBuffer(record.RawSample), binary.LittleEndian, &event); err != nil {
				continue
			}

			dir := "INCOMING"
			if event.Direction == 1 {
				dir = "OUTGOING"
			}
			proto := "TCP"
			if event.Protocol == 17 {
				proto = "UDP"
			}

			rec := packetRecord{
				Direction:  dir,
				Timestamp:  time.Now(),
				SrcIP:      intToIP(event.SrcIp),
				DstIP:      intToIP(event.DestIp),
				Protocol:   proto,
				Size:       event.PktSize,
				TTL:        event.Ttl,
				TOS:        event.Tos,
				IPID:       event.IpId,
				IPHdrLen:   event.IpHdrLen,
				FragOffset: event.IpFragOffset,
				MoreFrag:   event.IpMf != 0,
				SrcPort:    event.SrcPort,
				DstPort:    event.DestPort,
				TCPFlags:   tcpFlagsToString(event.TcpFlags),
				FlagsRaw:   event.TcpFlags,
				SeqNum:     event.TcpSeq,
				AckNum:     event.TcpAck,
				Window:     event.TcpWindow,
				TCPHdrLen:  event.TcpHdrLen,
			}

			// Deduplicate loopback echoing at the source so stats, flows, and output.txt are accurate
			if rec.SrcIP == "127.0.0.1" && rec.DstIP == "127.0.0.1" && rec.Direction == "OUTGOING" {
				continue
			}

			// Align the logical direction with the perspective of the protected application
			if targetPort > 0 {
				if rec.DstPort == targetPort {
					rec.Direction = "INCOMING"
				} else if rec.SrcPort == targetPort {
					rec.Direction = "OUTGOING"
				}
			}

			// Feed flow tracker
			flowTracker.TrackPacket(detect.PacketEvent{
				Timestamp: rec.Timestamp,
				SrcIP:     rec.SrcIP,
				DstIP:     rec.DstIP,
				SrcPort:   rec.SrcPort,
				DstPort:   rec.DstPort,
				Protocol:  rec.Protocol,
				Size:      rec.Size,
				TCPFlags:  rec.FlagsRaw,
				Direction: rec.Direction,
			})

			// Send to TUI (file logging happens inside tuiModel.Update)
			p.Send(packetMsg(rec))
		}
	}()

	// ── Run TUI (blocks until quit) ──
	if _, err := p.Run(); err != nil {
		log.Printf("TUI error: %v", err)
	}

	// Write a minimal session summary to output.txt after TUI exits
	if flog != nil {
		flog.writeSummary(0, 0, 0, 0, time.Since(time.Now()))
	}

	fmt.Println()
	fmt.Println(ingressStyle.Render("  ✓ eBPF programs detached. Goodbye!"))
	fmt.Println()
}

// ──────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ──────────────────────────────────────────────────────────────────────────────

func main() {
	// Redirect all standard log output to a file so it doesn't corrupt the TUI
	logFile, err := os.OpenFile("ngfw-app.log", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
	if err == nil {
		log.SetOutput(logFile)
	} else {
		// If we can't open a log file, discard logs to save the TUI
		log.SetOutput(io.Discard)
	}

	// ── Parse CLI flags for non-interactive (scripted/automated) usage ──
	portFlag := flag.Int("port", 0, "Port number to monitor (required in monitor mode)")
	ifaceFlag := flag.String("iface", "", "Network interface to attach eBPF programs to")
	proxyFlag := flag.Bool("proxy", false, "Run in reverse proxy mode with detection engine")
	configFlag := flag.String("config", "proxy_config.yaml", "Path to proxy configuration file")
	setupFlag := flag.Bool("setup", false, "Run the node pairing setup wizard")
	streamIntervalFlag := flag.Duration("stream-interval", 5*time.Second, "Telemetry batch interval for dashboard streaming")
	flag.Parse()

	globalStreamInterval = *streamIntervalFlag

	if *setupFlag {
		RunSetupWizard()
		return
	}

	RunCommander()

	// Detect if any meaningful flags were provided; if not, use the interactive menu.
	flagsProvided := *portFlag > 0 || *proxyFlag || *ifaceFlag != ""

	if !flagsProvided {
		// No flags → launch full interactive menu
		runInteractiveMenu()
		return
	}

	// ── Non-interactive (flag-driven) mode ──
	var proxyStats *detect.StatsCollector

	if *proxyFlag {
		_, stats, err := initProxyEngine(*configFlag)
		if err != nil {
			log.Fatalf("❌ Proxy Initialization Error: %v", err)
		}
		proxyStats = stats
	}

	if *portFlag > 0 && *portFlag <= 65535 {
		// eBPF monitor (with optional proxy if --proxy flag was set)
		ifaceName := *ifaceFlag
		if ifaceName == "" {
			ifaceName = "eth0" // sensible default when using flags
		}
		runEBPFMonitor(uint16(*portFlag), ifaceName, proxyStats, nil, nil)
	} else if *proxyFlag {
		// Proxy-only (no port flag)
		runStandaloneProxy(proxyStats)
	} else {
		log.Fatalf("❌  No valid mode selected. Use --port to monitor a port, --proxy for proxy mode, or run without flags for the interactive menu.")
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Proxy Mode Entry Point
// ──────────────────────────────────────────────────────────────────────────────

func initProxyEngine(configPath string) (*proxy.ProxyEngine, *detect.StatsCollector, error) {
	cfg, err := proxy.LoadConfig(configPath)
	if err != nil {
		if strings.Contains(err.Error(), "no such file or directory") {
			cfg = proxy.DefaultConfig()
			if err := proxy.SaveConfig(cfg, configPath); err != nil {
				return nil, nil, fmt.Errorf("failed to create default config: %w", err)
			}
		} else {
			return nil, nil, fmt.Errorf("failed to load configuration: %w", err)
		}
	}

	stats := detect.NewStatsCollector()
	bus := detect.NewDetectionBus()

	jsonLogger, err := detect.NewJSONLLogger(cfg.Logging.Dir, cfg.Logging.MaxFileSizeMB)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to initialize JSONL logger: %w", err)
	}
	bus.Subscribe(jsonLogger)
	bus.Subscribe(stats)
	bus.Subscribe(&ConsoleLogger{})
	detect.NewGraphEngine(bus)
	detect.NewThresholdCalibrator(bus)
	detect.NewDeceptionMesh(bus, []int{3306, 5432, 23}).Start()
	
	go startDNSDrainLoop(bus, cfg)

	nodeCfg, _ := LoadNodeConfig()
	if nodeCfg != nil && globalStreamInterval > 0 {
		globalStreamer = NewTelemetryStreamer(nodeCfg, stats, globalStreamInterval)
		bus.Subscribe(globalStreamer)
		globalStreamer.Start()
	}

	engine := proxy.NewProxyEngine(cfg, bus, stats)
	if err := engine.Start(); err != nil {
		return nil, nil, fmt.Errorf("failed to start proxy engine: %w", err)
	}

	return engine, stats, nil
}

// ConsoleLogger prints real-time detections to the terminal.
type ConsoleLogger struct{}

func (c *ConsoleLogger) OnDetection(d detect.Detection) {
	// Clear the current line (which contains the ticker) before printing
	fmt.Printf("\r\033[K")

	emoji := d.Severity.Emoji()
	fmt.Printf("  %s [%s] %s | %s:%d -> %d | %s\n",
		emoji,
		d.Timestamp.Format("15:04:05"),
		d.Severity.String(),
		d.SourceIP,
		d.SourcePort,
		d.DestPort,
		d.Summary,
	)
}

func (c *ConsoleLogger) OnConnectionClose(conn detect.ConnectionRecord) {}

func runStandaloneProxy(stats *detect.StatsCollector) {
	// Proxy-only mode: launch TUI with no eBPF port / iface info.
	// Alerts and Metrics tabs are active; Packets tab shows empty state.
	tuiM := newTuiModel(0, "", ServiceInfo{}, stats, nil, nil)
	tuiM.activeTab = 1 // default to Alerts
	p := tea.NewProgram(tuiM, tea.WithAltScreen())

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		if globalStreamer != nil {
			globalStreamer.Stop()
		}
		p.Quit()
	}()

	if _, err := p.Run(); err != nil {
		log.Printf("TUI error: %v", err)
	}
	fmt.Println("\n  " + ingressStyle.Render("✓") + " Shutting down reverse proxy gracefully...")
}

func startDNSDrainLoop(bus *detect.DetectionBus, cfg *proxy.ProxyConfig) {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	
	batch := make([]detect.DNSFeatureVector, 0, 100)
	
	logPath := "dns_features.jsonl"
	if cfg.Logging.Dir != "" {
		logPath = filepath.Join(cfg.Logging.Dir, "dns_features.jsonl")
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
	if err != nil {
		log.Printf("Failed to open %s: %v", logPath, err)
	}
	if logFile != nil {
		defer logFile.Close()
	}
	
	var lastNXDomainFlood = make(map[string]time.Time)
	var lastZoneTransfer = make(map[string]time.Time)
	var mu sync.Mutex
	
	// Subscribe to rule alerts to update suppression windows
	bus.Subscribe(&dnsRuleSubscriber{
		lastNXDomainFlood: lastNXDomainFlood,
		lastZoneTransfer:  lastZoneTransfer,
		mu:                &mu,
	})

	flush := func() {
		if len(batch) == 0 {
			return
		}
		
		if logFile != nil {
			for _, vec := range batch {
				b, _ := json.Marshal(vec)
				logFile.Write(b)
				logFile.WriteString("\n")
			}
		}

		resps, err := detect.ScoreDNSBatch(context.Background(), batch)
		if err == nil {
			mu.Lock()
			for i, resp := range resps {
				if resp == nil {
					continue
				}
				vec := batch[i]
				
				nxFlood := time.Since(lastNXDomainFlood[vec.SrcIP]) < 5*time.Second
				zoneTx := time.Since(lastZoneTransfer[vec.SrcIP]) < 5*time.Second

				if resp.PredictedCategory == "dga" && resp.RiskScore > cfg.Detection.DNSDGAMinScore {
					if !nxFlood { // Suppress if NXDOMAIN flood fired
						bus.EmitDetection(detect.Detection{
							ID: "ML-DNS-DGA", Timestamp: time.Now(), Severity: detect.SevHigh, Category: detect.CatDGA, Protocol: "DNS",
							SourceIP: vec.SrcIP, ConnID: vec.ConnID,
							Summary: fmt.Sprintf("ML detected DGA behavior (Score: %.1f)", resp.RiskScore),
							Details: map[string]any{"features": resp.ContributingFeatures},
						})
					}
				} else if resp.PredictedCategory == "tunnel" && resp.RiskScore > cfg.Detection.DNSTunnelMinScore {
					if !zoneTx { // Suppress if Zone Transfer fired
						bus.EmitDetection(detect.Detection{
							ID: "ML-DNS-TUNNEL", Timestamp: time.Now(), Severity: detect.SevHigh, Category: detect.CatDNSTunnel, Protocol: "DNS",
							SourceIP: vec.SrcIP, ConnID: vec.ConnID,
							Summary: fmt.Sprintf("ML detected DNS Tunneling (Score: %.1f)", resp.RiskScore),
							Details: map[string]any{"features": resp.ContributingFeatures},
						})
					}
				}
			}
			mu.Unlock()
		}
		batch = batch[:0]
	}

	for {
		select {
		case vec := <-detect.DNSFeatureChan:
			batch = append(batch, vec)
			if len(batch) >= 100 {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

type dnsRuleSubscriber struct {
	lastNXDomainFlood map[string]time.Time
	lastZoneTransfer  map[string]time.Time
	mu                *sync.Mutex
}

func (s *dnsRuleSubscriber) OnDetection(d detect.Detection) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d.Category == detect.CatNXDomainFlood {
		s.lastNXDomainFlood[d.SourceIP] = time.Now()
	} else if d.Category == detect.CatZoneTransfer {
		s.lastZoneTransfer[d.SourceIP] = time.Now()
	}
}

func (s *dnsRuleSubscriber) OnConnectionClose(conn detect.ConnectionRecord) {}
