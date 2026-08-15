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
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/charmbracelet/lipgloss"
	ebpflib "github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"

	"ngfw-monitor/detect"
	"ngfw-monitor/proxy"
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
// This ensures that any custom port always works regardless of what was
// previously in proxy_config.yaml.
func initProxyEngineWithPort(configPath string, listenPort, backendPort uint16, service string) (*proxy.ProxyEngine, *detect.StatsCollector, error) {
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
			runEBPFMonitor(backendPort, ifaceName, nil)

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
			_, stats, err := initProxyEngineWithPort("proxy_config.yaml", proxyPort, backendPort, service)
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
			_, proxyStats, err := initProxyEngineWithPort("proxy_config.yaml", proxyPort, backendPort, service)
			if err != nil {
				fmt.Println(errorStyle.Render("  ✗ Proxy initialization failed: " + err.Error()))
				fmt.Println(statLabelStyle.Render("  Press Enter to return to menu..."))
				readLine()
				continue
			}
			// eBPF monitors the proxy listen port — same port clients connect to
			runEBPFMonitor(proxyPort, ifaceName, proxyStats)

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
// Dashboard Renderer
// ──────────────────────────────────────────────────────────────────────────────

type dashboard struct {
	port        uint16
	iface       string
	service     ServiceInfo
	startTime   time.Time
	events      []packetRecord
	mu          sync.Mutex
	totalPkts   atomic.Int64
	ingressPkts atomic.Int64
	egressPkts  atomic.Int64
	totalBytes  atomic.Int64
	proxyStats  *detect.StatsCollector
}

func newDashboard(port uint16, iface string, svc ServiceInfo, pStats *detect.StatsCollector) *dashboard {
	return &dashboard{
		port:       port,
		iface:      iface,
		service:    svc,
		startTime:  time.Now(),
		events:     make([]packetRecord, 0, maxEvents),
		proxyStats: pStats,
	}
}

func (d *dashboard) addEvent(rec packetRecord) {
	d.totalPkts.Add(1)
	d.totalBytes.Add(int64(rec.Size))
	if rec.Direction == "INCOMING" {
		d.ingressPkts.Add(1)
	} else {
		d.egressPkts.Add(1)
	}

	d.mu.Lock()
	d.events = append(d.events, rec)
	if len(d.events) > maxEvents {
		d.events = d.events[len(d.events)-maxEvents:]
	}
	d.mu.Unlock()
}

func (d *dashboard) render() {
	moveCursor(1, 1)

	// ── Banner ──
	banner := `
  ╔══════════════════════════════════════════════════════════════════╗
  ║      ███╗   ██╗ ██████╗ ███████╗██╗    ██╗                     ║
  ║      ████╗  ██║██╔════╝ ██╔════╝██║    ██║                     ║
  ║      ██╔██╗ ██║██║  ███╗█████╗  ██║ █╗ ██║                     ║
  ║      ██║╚██╗██║██║   ██║██╔══╝  ██║███╗██║                     ║
  ║      ██║ ╚████║╚██████╔╝██║     ╚███╔███╔╝                     ║
  ║      ╚═╝  ╚═══╝ ╚═════╝ ╚═╝      ╚══╝╚══╝                     ║
  ║              eBPF Traffic Monitor v1.1                         ║
  ╚══════════════════════════════════════════════════════════════════╝`

	fmt.Println(bannerStyle.Render(banner))
	fmt.Println()

	// ── Status Bar ──
	uptime := time.Since(d.startTime).Round(time.Second)
	total := d.totalPkts.Load()
	ingress := d.ingressPkts.Load()
	egress := d.egressPkts.Load()
	totalBytesVal := d.totalBytes.Load()

	pps := float64(0)
	elapsed := time.Since(d.startTime).Seconds()
	if elapsed > 0 {
		pps = float64(total) / elapsed
	}

	// Build the port + service string
	portLabel := fmt.Sprintf("%d", d.port)
	svcBadge := d.service.StatusBadge()
	svcDisplay := d.service.DisplayName()
	portDisplay := fmt.Sprintf("%s  %s %s", portLabel, svcBadge, svcDisplay)

	statusLine := fmt.Sprintf(
		"  %s %s   %s %s   %s %s   %s %s",
		statLabelStyle.Render("PORT:"),
		statValueStyle.Render(portDisplay),
		statLabelStyle.Render("IFACE:"),
		statValueStyle.Render(d.iface),
		statLabelStyle.Render("UPTIME:"),
		statValueStyle.Render(uptime.String()),
		statLabelStyle.Render("STATUS:"),
		ingressStyle.Render("● MONITORING"),
	)
	fmt.Println(statusLine)

	// ── Service Detail line (only if active listener was found) ──
	if d.service.ProcessName != "" {
		svcProto := d.service.Proto
		if svcProto == "" {
			svcProto = "TCP/UDP"
		}
		svcUser := d.service.User
		if svcUser == "" {
			svcUser = "unknown"
		}
		svcLine := fmt.Sprintf(
			"  %s %s  %s %s  %s %s",
			statLabelStyle.Render("Process:"),
			statValueStyle.Render(d.service.ProcessName),
			statLabelStyle.Render("User:"),
			statValueStyle.Render(svcUser),
			statLabelStyle.Render("Proto:"),
			statValueStyle.Render(svcProto),
		)
		fmt.Println(svcLine)
		// Show truncated command line if available
		if d.service.Command != "" {
			cmd := d.service.Command
			if len(cmd) > 80 {
				cmd = cmd[:80] + "…"
			}
			fmt.Println(dimStyle.Render("  CMD: ") + dimStyle.Render(cmd))
		}
	}
	fmt.Println()

	// ── Proxy Status ──
	if d.proxyStats != nil {
		active := d.proxyStats.ActiveConnections()
		totalConns := d.proxyStats.TotalConnections()
		dets := d.proxyStats.TotalDetections()
		sevs := d.proxyStats.SeverityCounts()
		crit := sevs["CRITICAL"]
		high := sevs["HIGH"]
		proxyContent := fmt.Sprintf(
			"  %s %s    %s %s    %s %s",
			statLabelStyle.Render("Proxy Conns:"),
			statValueStyle.Render(fmt.Sprintf("%d", active)),
			statLabelStyle.Render("Total Conns:"),
			statValueStyle.Render(fmt.Sprintf("%d", totalConns)),
			statLabelStyle.Render("Detections:"),
			egressStyle.Render(fmt.Sprintf("%d (Crit: %d, High: %d)", dets, crit, high)),
		)
		fmt.Println(borderStyle.Render(proxyContent))
		fmt.Println()
	}

	// ── Stats Panel ──
	statsContent := fmt.Sprintf(
		"  %s %s    %s %s    %s %s    %s %s    %s %s",
		statLabelStyle.Render("Total Packets:"),
		statValueStyle.Render(fmt.Sprintf("%d", total)),
		statLabelStyle.Render("Incoming:"),
		ingressStyle.Render(fmt.Sprintf("⬇ %d", ingress)),
		statLabelStyle.Render("Outgoing:"),
		egressStyle.Render(fmt.Sprintf("⬆ %d", egress)),
		statLabelStyle.Render("Bytes:"),
		statValueStyle.Render(formatBytes(totalBytesVal)),
		statLabelStyle.Render("Rate:"),
		statValueStyle.Render(fmt.Sprintf("%.1f pkt/s", pps)),
	)
	fmt.Println(borderStyle.Render(statsContent))
	fmt.Println()

	// ── Packet Table ──
	hdr := fmt.Sprintf(
		"  %-11s  %-6s  %-3s  %-22s  %-22s  %-5s  %-15s  %-8s  %-4s  %-12s",
		"DIRECTION", "FragOff", "MF", "SOURCE", "DESTINATION", "PROTO", "FLAGS", "SIZE", "TTL", "TIME",
	)
	fmt.Println(headerStyle.Render(hdr))
	fmt.Println(dimStyle.Render("  " + strings.Repeat("─", 110)))

	// Events
	d.mu.Lock()
	eventsSnapshot := make([]packetRecord, len(d.events))
	copy(eventsSnapshot, d.events)
	d.mu.Unlock()

	if len(eventsSnapshot) == 0 {
		fmt.Println()
		fmt.Println(dimStyle.Render("  Waiting for packets on port " + fmt.Sprintf("%d", d.port) + "..."))
		fmt.Println(dimStyle.Render("  Generate traffic with: curl http://localhost:" + fmt.Sprintf("%d", d.port)))
	} else {
		for i := len(eventsSnapshot) - 1; i >= 0; i-- {
			ev := eventsSnapshot[i]
			var dirStr string
			if ev.Direction == "INCOMING" {
				dirStr = ingressStyle.Render("  ⬇ INCOMING")
			} else {
				dirStr = egressStyle.Render("  ⬆ OUTGOING")
			}

			var protoStr string
			if ev.Protocol == "TCP" {
				protoStr = tcpStyle.Render("TCP")
			} else {
				protoStr = udpStyle.Render("UDP")
			}

			src := fmt.Sprintf("%s:%d", ev.SrcIP, ev.SrcPort)
			dst := fmt.Sprintf("%s:%d", ev.DstIP, ev.DstPort)
			sizeStr := formatBytes(int64(ev.Size))
			timeStr := ev.Timestamp.Format("15:04:05.000")
			flagsStr := flagStyle.Render(ev.TCPFlags)
			ttlStr := fmt.Sprintf("%d", ev.TTL)

			line := fmt.Sprintf(
				"%-11s  %-6d  %-3t  %-22s  %-22s  %-5s  %-15s  %-8s  %-4s  %s",
				dirStr, ev.FragOffset, ev.MoreFrag, src, dst, protoStr, flagsStr, sizeStr, ttlStr, dimStyle.Render(timeStr),
			)
			fmt.Println(line)
		}
	}

	// ── Footer ──
	fmt.Println()
	fmt.Println(dimStyle.Render("  Logging to: output.txt   |   Press Ctrl+C to stop"))
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

// runEBPFMonitor starts the eBPF traffic monitoring session on the given port
// and interface, optionally integrated with a running proxy detection engine.
func runEBPFMonitor(targetPort uint16, ifaceName string, proxyStats *detect.StatsCollector) {
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
	flowLogger, err := detect.NewFlowLogger("logs", 100)
	if err != nil {
		log.Fatalf("❌  Failed to create flow logger: %v", err)
	}
	defer flowLogger.Close()

	// Drain completed flows to JSONL logger
	go func() {
		for rec := range flowTracker.CompletedFlows() {
			flowLogger.LogFlow(rec)
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

	// ── Initialize dashboard ──
	dash := newDashboard(targetPort, ifaceName, svcInfo, proxyStats)

	// ── Signal handler for graceful shutdown ──
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	// ── Ring buffer event reader goroutine ──
	eventCh := make(chan packetRecord, 256)

	go func() {
		for {
			record, err := rd.Read()
			if err != nil {
				return // Reader closed
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
				// Metadata
				Direction: dir,
				Timestamp: time.Now(),

				// IP Layer
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

				// L4 Layer
				SrcPort: event.SrcPort,
				DstPort: event.DestPort,

				// TCP-specific
				TCPFlags:  tcpFlagsToString(event.TcpFlags),
				FlagsRaw:  event.TcpFlags,
				SeqNum:    event.TcpSeq,
				AckNum:    event.TcpAck,
				Window:    event.TcpWindow,
				TCPHdrLen: event.TcpHdrLen,
			}

			eventCh <- rec
		}
	}()

	// ── Dashboard refresh loop ──
	clearScreen()
	dash.render()

	refreshTicker := time.NewTicker(500 * time.Millisecond)
	defer refreshTicker.Stop()

	needsRefresh := false

	for {
		select {
		case rec := <-eventCh:
			dash.addEvent(rec)
			// Log every packet to output.txt
			flog.logPacket(dash.totalPkts.Load(), rec)

			// Feed into flow aggregator
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
			needsRefresh = true

		case <-refreshTicker.C:
			if needsRefresh || dash.totalPkts.Load() > 0 {
				clearScreen()
				dash.render()
				needsRefresh = false
			}

		case <-sig:
			// Flush all remaining flows before shutdown
			flowTracker.FlushAll()

			// Write session summary to output.txt
			total := dash.totalPkts.Load()
			ingress := dash.ingressPkts.Load()
			egress := dash.egressPkts.Load()
			totalBytesVal := dash.totalBytes.Load()
			uptime := time.Since(dash.startTime).Round(time.Second)

			flog.writeSummary(total, ingress, egress, totalBytesVal, uptime)

			clearScreen()
			fmt.Println()
			fmt.Println(bannerStyle.Render("  NGFW eBPF Traffic Monitor — Shutting Down"))
			fmt.Println()

			fmt.Printf("  %s %s\n", statLabelStyle.Render("Session Duration:"), statValueStyle.Render(uptime.String()))
			fmt.Printf("  %s %s\n", statLabelStyle.Render("Total Packets:"), statValueStyle.Render(fmt.Sprintf("%d", total)))
			fmt.Printf("  %s %s\n", statLabelStyle.Render("Incoming:"), ingressStyle.Render(fmt.Sprintf("⬇ %d", ingress)))
			fmt.Printf("  %s %s\n", statLabelStyle.Render("Outgoing:"), egressStyle.Render(fmt.Sprintf("⬆ %d", egress)))
			fmt.Printf("  %s %s\n", statLabelStyle.Render("Total Bytes:"), statValueStyle.Render(formatBytes(totalBytesVal)))
			fmt.Printf("  %s %s\n", statLabelStyle.Render("Log saved to:"), statValueStyle.Render("output.txt"))
			fmt.Println()
			fmt.Println(ingressStyle.Render("  ✓ eBPF programs detached. Goodbye!"))
			fmt.Println()
			return
		}
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ──────────────────────────────────────────────────────────────────────────────

func main() {
	// ── Parse CLI flags for non-interactive (scripted/automated) usage ──
	portFlag := flag.Int("port", 0, "Port number to monitor (required in monitor mode)")
	ifaceFlag := flag.String("iface", "", "Network interface to attach eBPF programs to")
	proxyFlag := flag.Bool("proxy", false, "Run in reverse proxy mode with detection engine")
	configFlag := flag.String("config", "proxy_config.yaml", "Path to proxy configuration file")
	setupFlag := flag.Bool("setup", false, "Run the node pairing setup wizard")
	flag.Parse()

	if *setupFlag {
		RunSetupWizard()
		return
	}

	RunStreamer()
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
		runEBPFMonitor(uint16(*portFlag), ifaceName, proxyStats)
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
	clearScreen()
	fmt.Println(bannerStyle.Render(`
  ╔══════════════════════════════════════════════════════════════════╗
  ║              NGFW — Detection Reverse Proxy                      ║
  ║              Deep Packet Inspection Engine                       ║
  ╚══════════════════════════════════════════════════════════════════╝`))
	fmt.Println()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-sig:
			fmt.Println("\n  " + ingressStyle.Render("✓") + " Shutting down reverse proxy gracefully...")
			return
		case <-ticker.C:
			active := stats.ActiveConnections()
			total := stats.TotalConnections()
			dets := stats.TotalDetections()
			sevs := stats.SeverityCounts()
			crit := sevs["CRITICAL"]
			high := sevs["HIGH"]
			fmt.Printf("  \r\033[K%s Active Conns: %d | Total Conns: %d | Detections: %d (Critical: %d, High: %d)",
				statLabelStyle.Render("⚡"), active, total, dets, crit, high)
		}
	}
}
