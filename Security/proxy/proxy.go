// SPDX-License-Identifier: GPL-2.0
// proxy/proxy.go — Core reverse proxy engine.
// Manages multiple TCP/UDP listeners, routes connections through the
// detection pipeline, and forwards traffic to backend services.

package proxy

import (
	"context"
	"fmt"
	"log"
	"net"
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
	config  *ProxyConfig
	bus     *detect.DetectionBus
	stats   *detect.StatsCollector

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
}

// AnalyzerRouter dispatches connections to protocol-specific analyzers.
type AnalyzerRouter struct {
	bus            *detect.DetectionBus
	httpAnalyzer   *detect.HTTPAnalyzer
	sshAnalyzer    *detect.SSHAnalyzer
	dnsAnalyzer    *detect.DNSAnalyzer
	smtpAnalyzer   *detect.SMTPAnalyzer
	ftpAnalyzer    *detect.FTPAnalyzer
	dbAnalyzer     *detect.DBAnalyzer
	genericAnalyzer *detect.GenericAnalyzer
	tlsInspector   *detect.TLSInspector
	behavioral     *detect.BehavioralEngine
}

// NewAnalyzerRouter creates the full analysis pipeline.
func NewAnalyzerRouter(bus *detect.DetectionBus, cfg *ProxyConfig) *AnalyzerRouter {
	return &AnalyzerRouter{
		bus:            bus,
		httpAnalyzer:   detect.NewHTTPAnalyzer(bus),
		sshAnalyzer:    detect.NewSSHAnalyzer(bus),
		dnsAnalyzer:    detect.NewDNSAnalyzer(bus),
		smtpAnalyzer:   detect.NewSMTPAnalyzer(bus),
		ftpAnalyzer:    detect.NewFTPAnalyzer(bus),
		dbAnalyzer:     detect.NewDBAnalyzer(bus),
		genericAnalyzer: detect.NewGenericAnalyzer(bus),
		tlsInspector:   detect.NewTLSInspector(bus),
		behavioral:     detect.NewBehavioralEngine(bus, cfg.Detection.RateLimit.ConnectionsPerMinute,
			cfg.Detection.RateLimit.PortScanThreshold, cfg.Detection.RateLimit.BruteForceThreshold),
	}
}

// AnalyzeStream dispatches data to the appropriate analyzer based on detected protocol.
func (ar *AnalyzerRouter) AnalyzeStream(ctx *ConnContext, data []byte, fromClient bool) {
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

// NewProxyEngine creates and initializes the proxy engine.
func NewProxyEngine(config *ProxyConfig, bus *detect.DetectionBus, stats *detect.StatsCollector) *ProxyEngine {
	ctx, cancel := context.WithCancel(context.Background())

	return &ProxyEngine{
		config:        config,
		bus:           bus,
		stats:         stats,
		protoDetector: detect.NewProtocolDetector(bus),
		analyzers:     NewAnalyzerRouter(bus, config),
		ctx:           ctx,
		cancel:        cancel,
	}
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
