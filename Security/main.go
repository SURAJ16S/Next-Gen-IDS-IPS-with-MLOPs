// SPDX-License-Identifier: GPL-2.0
// main.go — NGFW eBPF Traffic Monitor
// A desktop CLI application that uses eBPF TC hooks to monitor incoming and
// outgoing TCP/UDP traffic on a user-specified port in real time.
// Logs complete packet details to output.txt (overwritten on each restart).

package main

import (
	"bytes"
	"encoding/binary"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
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

const maxEvents = 50 // Number of events to keep in the scrolling dashboard

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
	SrcIP     string
	DstIP     string
	Protocol  string // "TCP" or "UDP"
	Size      uint16 // Total IP packet size
	TTL       uint8
	TOS       uint8
	IPID      uint16
	IPHdrLen  uint8
	FragOff   uint16

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
		"  │ Time: %s  │  Frag: 0x%04x  │  TCP-HdrLen: %d B  │  IP-HdrLen: %d B  │  Payload: ~%d B\n",
		rec.Timestamp.Format("2006-01-02 15:04:05.000"),
		rec.FragOff,
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
}

func newDashboard(port uint16, iface string, svc ServiceInfo) *dashboard {
	return &dashboard{
		port:      port,
		iface:     iface,
		service:   svc,
		startTime: time.Now(),
		events:    make([]packetRecord, 0, maxEvents),
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
		"  %-11s  %-22s  %-22s  %-5s  %-15s  %-8s  %-4s  %-12s",
		"DIRECTION", "SOURCE", "DESTINATION", "PROTO", "FLAGS", "SIZE", "TTL", "TIME",
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
				"%-11s  %-22s  %-22s  %-5s  %-15s  %-8s  %-4s  %s",
				dirStr, src, dst, protoStr, flagsStr, sizeStr, ttlStr, dimStyle.Render(timeStr),
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

func main() {
	// ── Parse CLI flags ──
	portFlag := flag.Int("port", 0, "Port number to monitor (required in monitor mode)")
	ifaceFlag := flag.String("iface", "eth0", "Network interface to attach eBPF programs to")
	proxyFlag := flag.Bool("proxy", false, "Run in reverse proxy mode with detection engine")
	configFlag := flag.String("config", "proxy_config.yaml", "Path to proxy configuration file")
	flag.Parse()

	if *proxyFlag {
		runProxyMode(*configFlag)
		return
	}

	var targetPort uint16

	if *portFlag > 0 && *portFlag <= 65535 {
		targetPort = uint16(*portFlag)
	} else {
		// Interactive prompt
		clearScreen()
		fmt.Println(bannerStyle.Render(`
  ╔══════════════════════════════════════════════════════════════════╗
  ║              NGFW — eBPF Traffic Monitor                       ║
  ║              Next-Generation Firewall Foundation               ║
  ╚══════════════════════════════════════════════════════════════════╝`))
		fmt.Println()

		// List interfaces
		ifaces, err := net.Interfaces()
		if err == nil {
			fmt.Println(statLabelStyle.Render("  Available network interfaces:"))
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
				if ifc.Flags&net.FlagUp != 0 {
					fmt.Printf("    %s %s%s\n",
						ingressStyle.Render("●"),
						statValueStyle.Render(ifc.Name),
						dimStyle.Render(addrInfo))
				} else {
					fmt.Printf("    %s %s%s\n",
						dimStyle.Render("○"),
						dimStyle.Render(ifc.Name),
						dimStyle.Render(addrInfo+" [DOWN]"))
				}
			}
			fmt.Println()
		}

		fmt.Print(statLabelStyle.Render("  Enter the port number to monitor: "))
		_, err = fmt.Scanf("%d", &targetPort)
		if err != nil || targetPort == 0 {
			log.Fatalf("❌  Invalid port number. Please provide a value between 1 and 65535.")
		}
		fmt.Println()
	}

	// ── Detect service running on the target port ──
	fmt.Printf("  %s Detecting service on port %d...\n", statLabelStyle.Render("🔍"), targetPort)
	svcInfo := detectService(targetPort)
	// Print detection result to console before the dashboard launches
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

	ifaceName := *ifaceFlag

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

	// ── Initialize dashboard ──
	dash := newDashboard(targetPort, ifaceName, svcInfo)

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
				SrcIP:    intToIP(event.SrcIp),
				DstIP:    intToIP(event.DestIp),
				Protocol: proto,
				Size:     event.PktSize,
				TTL:      event.Ttl,
				TOS:      event.Tos,
				IPID:     event.IpId,
				IPHdrLen: event.IpHdrLen,
				FragOff:  event.IpFragOff,

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
			needsRefresh = true

		case <-refreshTicker.C:
			if needsRefresh || dash.totalPkts.Load() > 0 {
				clearScreen()
				dash.render()
				needsRefresh = false
			}

		case <-sig:
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
// Proxy Mode Entry Point
// ──────────────────────────────────────────────────────────────────────────────

func runProxyMode(configPath string) {
	clearScreen()
	fmt.Println(bannerStyle.Render(`
  ╔══════════════════════════════════════════════════════════════════╗
  ║              NGFW — Detection Reverse Proxy                      ║
  ║              Deep Packet Inspection Engine                       ║
  ╚══════════════════════════════════════════════════════════════════╝`))
	fmt.Println()

	// 1. Load config
	fmt.Printf("  %s Loading configuration from %s...\n", statLabelStyle.Render("⚙"), configPath)
	cfg, err := proxy.LoadConfig(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Printf("  %s Config file not found, creating default at %s\n", statLabelStyle.Render("ℹ"), configPath)
			cfg = proxy.DefaultConfig()
			if err := proxy.SaveConfig(cfg, configPath); err != nil {
				log.Fatalf("❌ Failed to create default config: %v", err)
			}
		} else {
			log.Fatalf("❌ Failed to load configuration: %v", err)
		}
	}
	fmt.Printf("  %s Loaded %d enabled listeners\n\n", ingressStyle.Render("✓"), len(cfg.EnabledListeners()))

	// 2. Initialize telemetry & logging
	stats := detect.NewStatsCollector()
	
	// Create detection bus and attach JSON logger
	bus := detect.NewDetectionBus()
	jsonLogger, err := detect.NewJSONLLogger(cfg.Logging.Dir, cfg.Logging.MaxFileSizeMB)
	if err != nil {
		log.Fatalf("❌ Failed to initialize JSONL logger: %v", err)
	}
	defer jsonLogger.Close()
	bus.Subscribe(jsonLogger)

	// Attach stats collector to bus
	bus.Subscribe(stats)

	// 3. Initialize Proxy Engine
	engine := proxy.NewProxyEngine(cfg, bus, stats)

	// 4. Start Engine
	if err := engine.Start(); err != nil {
		log.Fatalf("❌ Failed to start proxy engine: %v", err)
	}
	defer engine.Stop()

	// 5. Signal handling & dashboard update
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
			// Print brief status update
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
