// SPDX-License-Identifier: GPL-2.0
// proxy/proxy.go — Core reverse proxy engine.
// Manages multiple TCP/UDP listeners, routes connections through the
// detection pipeline, and forwards traffic to backend services.

package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"sync"
	"time"

	"ngfw-monitor/detect"
)

// ──────────────────────────────────────────────────────────────────────────────
// Connection Context — carries metadata through the entire pipeline
// ──────────────────────────────────────────────────────────────────────────────

// ConnContext carries all metadata for a single proxied connection.
type ConnContext struct {
	ConnID          string
	ClientIP        net.IP
	ClientPort      uint16
	ServerIP        net.IP
	ServerPort      uint16
	ListenPort      uint16
	BackendAddr     string
	ExpectedService string
	Transport       string // "tcp", "udp", "tcp+tls"

	StartTime time.Time

	// Populated by protocol detection
	DetectedProtocol string
	ProtoConfidence  float64
	ProtoMismatch    bool

	// Accumulated detections for this connection
	mu         sync.Mutex
	detections []detect.Detection
	maxSev     detect.Severity

	// Byte counters
	BytesFromClient int64
	BytesToClient   int64

	// Close reason
	CloseReason string
}

// AddDetection appends a detection finding to this connection's context.
func (c *ConnContext) AddDetection(d detect.Detection) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.detections = append(c.detections, d)
	if d.Severity > c.maxSev {
		c.maxSev = d.Severity
	}
}

// DetectionCount returns the number of detections for this connection.
func (c *ConnContext) DetectionCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.detections)
}

// MaxSeverity returns the highest severity detection for this connection.
func (c *ConnContext) MaxSeverity() detect.Severity {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.maxSev
}

// ToConnectionRecord produces a ConnectionRecord for logging when the
// connection closes.
func (c *ConnContext) ToConnectionRecord() detect.ConnectionRecord {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	return detect.ConnectionRecord{
		ConnID:           c.ConnID,
		ClientIP:         c.ClientIP.String(),
		ClientPort:       c.ClientPort,
		ListenPort:       c.ListenPort,
		BackendAddr:      c.BackendAddr,
		DetectedProtocol: c.DetectedProtocol,
		ExpectedService:  c.ExpectedService,
		ProtoMismatch:    c.ProtoMismatch,
		StartTime:        c.StartTime,
		EndTime:          now,
		DurationMs:       now.Sub(c.StartTime).Milliseconds(),
		BytesFromClient:  c.BytesFromClient,
		BytesToClient:    c.BytesToClient,
		DetectionCount:   len(c.detections),
		MaxSeverity:      c.maxSev,
		CloseReason:      c.CloseReason,
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// ProxyEngine — orchestrates all listeners and the detection pipeline
// ──────────────────────────────────────────────────────────────────────────────

// ProxyEngine manages the full reverse proxy lifecycle.
type ProxyEngine struct {
	config *ProxyConfig
	bus    *detect.DetectionBus
	stats  *detect.StatsCollector

	// Active listeners
	tcpListeners []*TCPListener
	udpListeners []*UDPListener

	// Detection pipeline
	protoDetector *detect.ProtocolDetector
	analyzers     *AnalyzerRouter

	// Lifecycle
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// Raw packet dump
	DumpFile *os.File
	dumpMu   sync.Mutex
}

// RawDump represents a single raw traffic dump record
type RawDump struct {
	Timestamp string `json:"timestamp"`
	ConnID    string `json:"conn_id"`
	Direction string `json:"direction"`
	Protocol  string `json:"protocol"`
	ClientIP  string `json:"client_ip"`
	Port      uint16 `json:"port"`
	DataStr   string `json:"data_string"`
}

// LogRawTraffic writes raw request bytes to the dump file
func (p *ProxyEngine) LogRawTraffic(ctx *ConnContext, data []byte, fromClient bool) {
	if p.DumpFile == nil {
		return
	}

	dir := "client_to_backend"
	if !fromClient {
		dir = "backend_to_client"
	}

	dump := RawDump{
		Timestamp: time.Now().Format(time.RFC3339Nano),
		ConnID:    ctx.ConnID,
		Direction: dir,
		Protocol:  ctx.DetectedProtocol,
		ClientIP:  ctx.ClientIP.String(),
		Port:      ctx.ListenPort,
		DataStr:   string(data), // Simple string representation for JSON visibility
	}

	b, err := json.Marshal(dump)
	if err == nil {
		b = append(b, '\n')
		p.dumpMu.Lock()
		p.DumpFile.Write(b)
		p.dumpMu.Unlock()
	}
}

// AnalyzerRouter dispatches connections to protocol-specific analyzers.
type AnalyzerRouter struct {
	engine          *ProxyEngine
	bus             *detect.DetectionBus
	httpAnalyzer    *detect.HTTPAnalyzer
	sshAnalyzer     *detect.SSHAnalyzer
	dnsAnalyzer     *detect.DNSAnalyzer
	smtpAnalyzer    *detect.SMTPAnalyzer
	ftpAnalyzer     *detect.FTPAnalyzer
	dbAnalyzer      *detect.DBAnalyzer
	genericAnalyzer *detect.GenericAnalyzer
	tlsInspector    *detect.TLSInspector
	behavioral      *detect.BehavioralEngine
}

// NewAnalyzerRouter creates the full analysis pipeline.
func NewAnalyzerRouter(engine *ProxyEngine, bus *detect.DetectionBus, cfg *ProxyConfig) *AnalyzerRouter {
	return &AnalyzerRouter{
		engine:          engine,
		bus:             bus,
		httpAnalyzer:    detect.NewHTTPAnalyzer(engine.ctx, bus),
		sshAnalyzer:     detect.NewSSHAnalyzer(bus),
		dnsAnalyzer:     detect.NewDNSAnalyzer(bus),
		smtpAnalyzer:    detect.NewSMTPAnalyzer(bus),
		ftpAnalyzer:     detect.NewFTPAnalyzer(bus),
		dbAnalyzer:      detect.NewDBAnalyzer(bus),
		genericAnalyzer: detect.NewGenericAnalyzer(bus),
		tlsInspector:    detect.NewTLSInspector(bus),
		behavioral: detect.NewBehavioralEngine(bus, cfg.Detection.RateLimit.ConnectionsPerMinute,
			cfg.Detection.RateLimit.PortScanThreshold, cfg.Detection.RateLimit.BruteForceThreshold),
	}
}

// AnalyzeStream dispatches data to the appropriate analyzer based on detected protocol.
// A deferred recover() ensures that a panic in any analyzer cannot bring down the
// forwarding path — the proxy must remain operational even if inspection fails.
func (ar *AnalyzerRouter) AnalyzeStream(ctx *ConnContext, data []byte, fromClient bool) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[proxy] ⚠ analyzer panic recovered (conn %s, proto %s): %v",
				ctx.ConnID, ctx.ExpectedService, r)
		}
	}()

	// Log the raw traffic to proxy-output.json
	if ar.engine != nil {
		ar.engine.LogRawTraffic(ctx, data, fromClient)
	}

	// Behavioral tracking for every connection
	if fromClient {
		ar.behavioral.TrackConnection(ctx.ClientIP.String(), ctx.ListenPort)
	}

	protocol := ctx.DetectedProtocol
	if protocol == "" {
		protocol = ctx.ExpectedService
	}

	switch protocol {
	case "http", "HTTP", "HTTP/1.0", "HTTP/1.1", "HTTP/2":
		ar.httpAnalyzer.Analyze(ctx.ConnID, ctx.ClientIP.String(), ctx.ClientPort,
			ctx.ListenPort, data, fromClient)
	case "ssh", "SSH", "SSH-2.0":
		ar.sshAnalyzer.Analyze(ctx.ConnID, ctx.ClientIP.String(), ctx.ClientPort,
			ctx.ListenPort, data, fromClient)
	case "dns", "DNS":
		ar.dnsAnalyzer.Analyze(ctx.ConnID, ctx.ClientIP.String(), ctx.ClientPort,
			ctx.ListenPort, data, fromClient)
	case "smtp", "SMTP", "smtps":
		ar.smtpAnalyzer.Analyze(ctx.ConnID, ctx.ClientIP.String(), ctx.ClientPort,
			ctx.ListenPort, data, fromClient)
	case "ftp", "FTP":
		ar.ftpAnalyzer.Analyze(ctx.ConnID, ctx.ClientIP.String(), ctx.ClientPort,
			ctx.ListenPort, data, fromClient)
	case "mysql", "MySQL", "postgresql", "PostgreSQL", "redis", "Redis", "mongodb", "MongoDB":
		ar.dbAnalyzer.Analyze(ctx.ConnID, ctx.ClientIP.String(), ctx.ClientPort,
			ctx.ListenPort, protocol, data, fromClient)
	case "https", "TLS", "tls":
		ar.tlsInspector.Analyze(ctx.ConnID, ctx.ClientIP.String(), ctx.ClientPort,
			ctx.ListenPort, data, fromClient)
	default:
		ar.genericAnalyzer.Analyze(ctx.ConnID, ctx.ClientIP.String(), ctx.ClientPort,
			ctx.ListenPort, protocol, data, fromClient)
	}
}

// AnalyzeClose notifies protocol analyzers when a connection is torn down.
// This is essential for timing-based heuristics (e.g., SSH brute-force detection)
// that need to know the exact moment a connection closes.
func (ar *AnalyzerRouter) AnalyzeClose(ctx *ConnContext) {
	protocol := ctx.DetectedProtocol
	if protocol == "" {
		protocol = ctx.ExpectedService
	}
	switch protocol {
	case "ssh", "SSH", "SSH-2.0":
		ar.sshAnalyzer.AnalyzeClose(
			ctx.ConnID, ctx.ClientIP.String(),
			ctx.ClientPort, ctx.ListenPort,
		)
	}
}

// NewProxyEngine creates and initializes the proxy engine.
func NewProxyEngine(config *ProxyConfig, bus *detect.DetectionBus, stats *detect.StatsCollector) *ProxyEngine {
	ctx, cancel := context.WithCancel(context.Background())

	engine := &ProxyEngine{
		config:        config,
		bus:           bus,
		stats:         stats,
		protoDetector: detect.NewProtocolDetector(bus),
		ctx:           ctx,
		cancel:        cancel,
	}
	engine.analyzers = NewAnalyzerRouter(engine, bus, config)

	// Create or overwrite the raw traffic dump file
	dumpFile, err := os.OpenFile("proxy-output.json", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err == nil {
		engine.DumpFile = dumpFile
	} else {
		log.Printf("[proxy] ⚠ Failed to open proxy-output.json for raw dumps: %v", err)
	}

	return engine
}

// Start launches all configured listeners.
func (p *ProxyEngine) Start() error {
	listeners := p.config.EnabledListeners()
	if len(listeners) == 0 {
		return fmt.Errorf("no enabled listeners in configuration")
	}

	log.Printf("[proxy] Starting %d listeners...", len(listeners))

	for _, lcfg := range listeners {
		switch lcfg.Transport {
		case "tcp", "tcp+tls":
			tl, err := NewTCPListener(lcfg, p)
			if err != nil {
				log.Printf("[proxy] ⚠ Failed to start TCP listener on :%d (%s): %v",
					lcfg.ListenPort, lcfg.Service, err)
				continue
			}
			p.tcpListeners = append(p.tcpListeners, tl)
			p.wg.Add(1)
			go func(listener *TCPListener) {
				defer p.wg.Done()
				listener.Serve(p.ctx)
			}(tl)
			log.Printf("[proxy] ✓ TCP :%d → %s [%s]",
				lcfg.ListenPort, lcfg.BackendAddr, lcfg.Service)

		case "udp":
			ul, err := NewUDPListener(lcfg, p)
			if err != nil {
				log.Printf("[proxy] ⚠ Failed to start UDP listener on :%d (%s): %v",
					lcfg.ListenPort, lcfg.Service, err)
				continue
			}
			p.udpListeners = append(p.udpListeners, ul)
			p.wg.Add(1)
			go func(listener *UDPListener) {
				defer p.wg.Done()
				listener.Serve(p.ctx)
			}(ul)
			log.Printf("[proxy] ✓ UDP :%d → %s [%s]",
				lcfg.ListenPort, lcfg.BackendAddr, lcfg.Service)

		default:
			log.Printf("[proxy] ⚠ Unknown transport %q for port %d", lcfg.Transport, lcfg.ListenPort)
		}
	}

	activeTCP := len(p.tcpListeners)
	activeUDP := len(p.udpListeners)
	if activeTCP+activeUDP == 0 {
		return fmt.Errorf("failed to start any listeners")
	}

	log.Printf("[proxy] ✓ Proxy engine running: %d TCP + %d UDP listeners active", activeTCP, activeUDP)
	return nil
}

// Stop gracefully shuts down all listeners and waits for connections to drain.
func (p *ProxyEngine) Stop() {
	log.Println("[proxy] Shutting down proxy engine...")
	p.cancel()

	// Close all TCP listeners
	for _, tl := range p.tcpListeners {
		tl.Close()
	}
	// Close all UDP listeners
	for _, ul := range p.udpListeners {
		ul.Close()
	}

	p.wg.Wait()

	if p.DumpFile != nil {
		p.DumpFile.Close()
	}

	log.Println("[proxy] All listeners stopped.")
}

// Stats returns the stats collector.
func (p *ProxyEngine) Stats() *detect.StatsCollector {
	return p.stats
}

// Bus returns the detection bus.
func (p *ProxyEngine) Bus() *detect.DetectionBus {
	return p.bus
}
