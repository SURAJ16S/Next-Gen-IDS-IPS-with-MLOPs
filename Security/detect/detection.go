// SPDX-License-Identifier: GPL-2.0
// detect/detection.go — Core detection types, severity classification, and event bus.
// Every analyzer in the system produces Detection objects that flow through the
// DetectionBus to subscribers (logger, dashboard, future WebSocket API).

package detect

import (
	"fmt"
	"sync"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// Severity Levels
// ──────────────────────────────────────────────────────────────────────────────

// Severity classifies how critical a detection is.
type Severity int

const (
	SevInfo     Severity = iota // Normal activity logged for audit trail
	SevLow                      // Slightly unusual, worth noting
	SevMedium                   // Suspicious activity requiring attention
	SevHigh                     // Likely attack or policy violation
	SevCritical                 // Active exploitation attempt
)

// String returns a human-readable severity label.
func (s Severity) String() string {
	switch s {
	case SevInfo:
		return "INFO"
	case SevLow:
		return "LOW"
	case SevMedium:
		return "MEDIUM"
	case SevHigh:
		return "HIGH"
	case SevCritical:
		return "CRITICAL"
	default:
		return "UNKNOWN"
	}
}

// Emoji returns a colored emoji for terminal display.
func (s Severity) Emoji() string {
	switch s {
	case SevInfo:
		return "ℹ️"
	case SevLow:
		return "🔵"
	case SevMedium:
		return "🟡"
	case SevHigh:
		return "🟠"
	case SevCritical:
		return "🔴"
	default:
		return "⚪"
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Detection Categories
// ──────────────────────────────────────────────────────────────────────────────

const (
	CatSQLi             = "sqli"
	CatXSS              = "xss"
	CatPathTraversal    = "path-traversal"
	CatCommandInjection = "command-injection"
	CatSSRF             = "ssrf"
	CatXXE              = "xxe"
	CatLog4Shell        = "log4shell"
	CatHTTPSmuggling    = "http-smuggling"
	CatCRLFInjection    = "crlf-injection"
	CatOpenRedirect     = "open-redirect"
	CatFileUpload       = "file-upload"
	CatBotScanner       = "bot-scanner"
	CatDirBruteForce    = "dir-bruteforce"
	CatCredentialLeak   = "credential-leak"
	CatMissingHeaders   = "missing-headers"
	CatInfoLeakage      = "info-leakage"
	CatLDAPInjection    = "ldap-injection"

	CatBruteForce    = "brute-force"
	CatPortScan      = "port-scan"
	CatDDoS          = "ddos"
	CatSlowloris     = "slowloris"
	CatDataExfil     = "data-exfiltration"
	CatBeaconing     = "beaconing"
	CatTunneling     = "tunneling"
	CatC2            = "c2"
	CatLateralMove   = "lateral-movement"
	CatProtoMismatch = "protocol-mismatch"
	CatTimeAnomaly   = "time-anomaly"

	CatTLSWeakCipher  = "tls-weak-cipher"
	CatTLSDowngrade   = "tls-downgrade"
	CatTLSSNIMismatch = "tls-sni-mismatch"
	CatTLSExpired     = "tls-expired-cert"
	CatTLSSelfSigned  = "tls-self-signed"

	CatDNSTunnel     = "dns-tunnel"
	CatDGA           = "dga"
	CatDNSRebind     = "dns-rebinding"
	CatZoneTransfer  = "zone-transfer"
	CatNXDomainFlood = "nxdomain-flood"

	CatSSHWeakAlgo = "ssh-weak-algo"
	CatSSHTunnel   = "ssh-tunnel"

	CatOpenRelay = "open-relay"
	CatSpam      = "spam"
	CatPhishing  = "phishing"

	CatFTPBounce = "ftp-bounce"
	CatAnonLogin = "anonymous-login"

	CatDangerousCmd = "dangerous-command"
	CatUnauthAccess = "unauthenticated-access"

	CatProtocolDetect = "protocol-detect"
	CatConnLifecycle  = "connection-lifecycle"
)

// ──────────────────────────────────────────────────────────────────────────────
// Detection — the core event produced by every analyzer
// ──────────────────────────────────────────────────────────────────────────────

// Detection represents a single security finding or audit event.
type Detection struct {
	ID          string         `json:"id"` // e.g. "HTTP-SQLI-001"
	Timestamp   time.Time      `json:"timestamp"`
	Severity    Severity       `json:"severity"`
	SeverityStr string         `json:"severity_str"` // Populated on emit
	Category    string         `json:"category"`
	Protocol    string         `json:"protocol"` // "HTTP", "SSH", "DNS", etc.
	SourceIP    string         `json:"source_ip"`
	SourcePort  uint16         `json:"source_port"`
	DestPort    uint16         `json:"dest_port"`
	Summary     string         `json:"summary"`
	Details     map[string]any `json:"details,omitempty"`
	RawEvidence string         `json:"raw_evidence,omitempty"` // Truncated offending bytes
	ConnID      string         `json:"conn_id"`                // Link to connection context
}

// String returns a human-readable one-line summary.
func (d Detection) String() string {
	return fmt.Sprintf("[%s] %s %s | %s:%d → :%d | %s",
		d.SeverityStr, d.Severity.Emoji(), d.Category,
		d.SourceIP, d.SourcePort, d.DestPort, d.Summary)
}

// ──────────────────────────────────────────────────────────────────────────────
// ConnectionRecord — logged when a connection closes
// ──────────────────────────────────────────────────────────────────────────────

// ConnectionRecord captures the full lifecycle of a proxied connection.
type ConnectionRecord struct {
	ConnID           string    `json:"conn_id"`
	ClientIP         string    `json:"client_ip"`
	ClientPort       uint16    `json:"client_port"`
	ListenPort       uint16    `json:"listen_port"`
	BackendAddr      string    `json:"backend_addr"`
	DetectedProtocol string    `json:"detected_protocol"`
	ExpectedService  string    `json:"expected_service"`
	ProtoMismatch    bool      `json:"proto_mismatch"`
	StartTime        time.Time `json:"start_time"`
	EndTime          time.Time `json:"end_time"`
	DurationMs       int64     `json:"duration_ms"`
	BytesFromClient  int64     `json:"bytes_from_client"`
	BytesToClient    int64     `json:"bytes_to_client"`
	DetectionCount   int       `json:"detection_count"`
	MaxSeverity      Severity  `json:"max_severity"`
	MaxSeverityStr   string    `json:"max_severity_str"`
	CloseReason      string    `json:"close_reason"` // "normal", "reset", "timeout", "error"
}

// ──────────────────────────────────────────────────────────────────────────────
// DetectionBus — fan-out event distribution
// ──────────────────────────────────────────────────────────────────────────────

// DetectionSubscriber receives detection events.
type DetectionSubscriber interface {
	OnDetection(d Detection)
	OnConnectionClose(c ConnectionRecord)
}

// DetectionBus distributes detection events to all registered subscribers.
type DetectionBus struct {
	mu          sync.RWMutex
	subscribers []DetectionSubscriber
}

// NewDetectionBus creates a new event bus.
func NewDetectionBus() *DetectionBus {
	return &DetectionBus{}
}

// Subscribe registers a subscriber to receive events.
func (b *DetectionBus) Subscribe(s DetectionSubscriber) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.subscribers = append(b.subscribers, s)
}

// EmitDetection sends a detection to all subscribers. It auto-populates
// the SeverityStr field before distribution.
func (b *DetectionBus) EmitDetection(d Detection) {
	d.SeverityStr = d.Severity.String()
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, s := range b.subscribers {
		s.OnDetection(d)
	}
}

// EmitConnectionClose sends a connection record to all subscribers.
func (b *DetectionBus) EmitConnectionClose(c ConnectionRecord) {
	c.MaxSeverityStr = c.MaxSeverity.String()
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, s := range b.subscribers {
		s.OnConnectionClose(c)
	}
}
