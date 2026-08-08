// SPDX-License-Identifier: GPL-2.0
// detect/ftp_analyzer.go — FTP/FTPS traffic analysis with stateful session tracking.
// Implements a per-connection FTP state machine with bounded TCP stream reassembly
// for fragmented and coalesced FTP control messages.
//
// References:
//   RFC 959  — File Transfer Protocol
//   RFC 2228 — FTP Security Extensions (AUTH TLS/SSL)
//   RFC 2428 — FTP Extensions for IPv6 and NATs (EPSV/EPRT)
//   RFC 5797 — FTP Command and Extension Registry

package detect

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// Constants & Limits
// ──────────────────────────────────────────────────────────────────────────────

const (
	ftpMaxBuf          = 65536         // 64 KB max reassembly buffer per direction
	ftpMaxLineLen      = 4096          // Max single line — drop oversized partials
	ftpSessionTTL      = 5 * time.Minute
	ftpCleanupInterval = 2 * time.Minute
)

// Brute-force defaults — configurable via FTPBruteConfig.
const (
	ftpDefaultBruteWindow    = 60 * time.Second
	ftpDefaultBruteThreshold = 5
)

// Sensitive paths that should trigger FTP-SUSPICIOUS-PATH.
var ftpSensitivePaths = []string{
	"/etc/", "/proc/", "/var/", "/root/", "/home/",
	"shadow", "passwd", "sudoers", ".bash_history",
	".ssh/", "id_rsa", "id_ecdsa", "id_ed25519",
}

// ──────────────────────────────────────────────────────────────────────────────
// FTP State Machine
// ──────────────────────────────────────────────────────────────────────────────

type ftpState uint8

const (
	ftpStateInit              ftpState = iota // TCP connection established
	ftpStateGreeting                          // 220 received from server
	ftpStateAuthentication                    // USER sent, awaiting PASS / 230
	ftpStateAuthenticated                     // 230 received
	ftpStateCommandProcessing                 // Idle in command loop
	ftpStateDataNegotiation                   // PORT/PASV/EPSV sent or responded to
	ftpStateTransfer                          // 125/150 received — transfer active
	ftpStateTLS                               // AUTH TLS + 234 — encrypted
	ftpStateClosed
)

func (s ftpState) String() string {
	switch s {
	case ftpStateInit:
		return "TCP_ESTABLISHED"
	case ftpStateGreeting:
		return "FTP_GREETING"
	case ftpStateAuthentication:
		return "AUTHENTICATION"
	case ftpStateAuthenticated:
		return "AUTHENTICATED"
	case ftpStateCommandProcessing:
		return "COMMAND_PROCESSING"
	case ftpStateDataNegotiation:
		return "DATA_CHANNEL_NEGOTIATION"
	case ftpStateTransfer:
		return "TRANSFER"
	case ftpStateTLS:
		return "TLS_ENCRYPTED"
	default:
		return "CLOSED"
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-connection FTP Session
// ──────────────────────────────────────────────────────────────────────────────

type ftpSession struct {
	mu sync.Mutex

	connID  string
	srcIP   string
	srcPort uint16
	dstPort uint16

	state ftpState

	// Bounded TCP reassembly buffers
	clientBuf []byte
	serverBuf []byte

	// Client IP (set on first client→server data, may differ from srcIP in tests)
	clientIP string

	// Auth context
	currentUser   string
	authenticated bool
	anonymous     bool

	// FTPS explicit negotiation
	tlsRequested   bool // Client sent AUTH TLS/SSL
	tlsEstablished bool // Server confirmed with 234

	// Data channel metadata from PORT/PASV/EPSV
	dataIP   net.IP
	dataPort uint16

	// RFC 959 §4.2 multiline response state:
	//   "XYZ-text" starts multiline; "XYZ text" (space after code) terminates.
	serverMultiLine bool
	serverMultiCode string // Opening code, e.g. "220"

	// Last client command (for response correlation)
	lastCmd string

	lastActivity time.Time
}

// ──────────────────────────────────────────────────────────────────────────────
// Cross-connection Brute-force Tracker
// ──────────────────────────────────────────────────────────────────────────────

type bfKey struct {
	srcIP   string
	dstPort uint16
}

type bfEntry struct {
	failures int
	since    time.Time
}

type bruteTracker struct {
	mu      sync.Mutex
	entries map[bfKey]*bfEntry
}

func newBruteTracker() *bruteTracker {
	return &bruteTracker{entries: make(map[bfKey]*bfEntry)}
}

// record returns true when threshold is met or exceeded within the window.
func (bt *bruteTracker) record(srcIP string, dstPort uint16, window time.Duration, threshold int) bool {
	bt.mu.Lock()
	defer bt.mu.Unlock()
	k := bfKey{srcIP: srcIP, dstPort: dstPort}
	now := time.Now()
	e, ok := bt.entries[k]
	if !ok || now.Sub(e.since) > window {
		bt.entries[k] = &bfEntry{failures: 1, since: now}
		return false
	}
	e.failures++
	return e.failures >= threshold
}

// cleanup removes expired entries (called periodically).
func (bt *bruteTracker) cleanup(olderThan time.Duration) {
	bt.mu.Lock()
	defer bt.mu.Unlock()
	now := time.Now()
	for k, e := range bt.entries {
		if now.Sub(e.since) > olderThan {
			delete(bt.entries, k)
		}
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// FTPBruteConfig — configurable brute-force parameters
// ──────────────────────────────────────────────────────────────────────────────

// FTPBruteConfig holds configurable brute-force detection settings.
type FTPBruteConfig struct {
	Window    time.Duration // Time window for counting failures
	Threshold int           // Number of failures in Window to trigger FTP-BRUTE-001
}

// ──────────────────────────────────────────────────────────────────────────────
// FTP Analyzer
// ──────────────────────────────────────────────────────────────────────────────

// FTPAnalyzer inspects FTP/FTPS control channel traffic for security events.
// It maintains per-connection state, performs bounded TCP stream reassembly,
// and correctly parses RFC 959 multiline responses.
type FTPAnalyzer struct {
	bus       *DetectionBus
	brute     *bruteTracker
	bruteConf FTPBruteConfig

	sessionMu sync.Mutex
	sessions  map[string]*ftpSession

	stopCleanup chan struct{}
}

// NewFTPAnalyzer creates an FTP analyzer and registers it with the DetectionBus.
func NewFTPAnalyzer(bus *DetectionBus) *FTPAnalyzer {
	a := &FTPAnalyzer{
		bus:   bus,
		brute: newBruteTracker(),
		bruteConf: FTPBruteConfig{
			Window:    ftpDefaultBruteWindow,
			Threshold: ftpDefaultBruteThreshold,
		},
		sessions:    make(map[string]*ftpSession),
		stopCleanup: make(chan struct{}),
	}
	bus.Subscribe(a)
	go a.cleanupLoop()
	return a
}

// OnDetection satisfies the DetectionSubscriber interface (no-op for self-events).
func (a *FTPAnalyzer) OnDetection(_ Detection) {}

// OnConnectionClose removes the session on explicit proxy connection teardown.
func (a *FTPAnalyzer) OnConnectionClose(c ConnectionRecord) {
	a.sessionMu.Lock()
	delete(a.sessions, c.ConnID)
	a.sessionMu.Unlock()
}

func (a *FTPAnalyzer) cleanupLoop() {
	ticker := time.NewTicker(ftpCleanupInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			a.expireSessions()
			a.brute.cleanup(a.bruteConf.Window * 2)
		case <-a.stopCleanup:
			return
		}
	}
}

func (a *FTPAnalyzer) expireSessions() {
	a.sessionMu.Lock()
	defer a.sessionMu.Unlock()
	cutoff := time.Now().Add(-ftpSessionTTL)
	for id, s := range a.sessions {
		s.mu.Lock()
		last := s.lastActivity
		s.mu.Unlock()
		if last.Before(cutoff) {
			delete(a.sessions, id)
		}
	}
}

func (a *FTPAnalyzer) getOrCreate(connID, srcIP string, srcPort, dstPort uint16) *ftpSession {
	a.sessionMu.Lock()
	defer a.sessionMu.Unlock()
	s, ok := a.sessions[connID]
	if !ok {
		s = &ftpSession{
			connID:       connID,
			srcIP:        srcIP,
			srcPort:      srcPort,
			dstPort:      dstPort,
			state:        ftpStateInit,
			lastActivity: time.Now(),
		}
		a.sessions[connID] = s
	}
	return s
}

// Analyze inspects a chunk of FTP data and emits detections.
func (a *FTPAnalyzer) Analyze(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) == 0 {
		return
	}
	sess := a.getOrCreate(connID, srcIP, srcPort, dstPort)
	sess.mu.Lock()
	defer sess.mu.Unlock()

	// Once TLS is established the control channel is encrypted — stop parsing.
	if sess.tlsEstablished {
		return
	}

	sess.lastActivity = time.Now()

	if fromClient {
		// Capture the real client IP on first client→server segment
		if sess.clientIP == "" {
			sess.clientIP = srcIP
		}
		sess.clientBuf = appendCapped(sess.clientBuf, data, ftpMaxBuf)
		a.processClientLines(sess)
	} else {
		sess.serverBuf = appendCapped(sess.serverBuf, data, ftpMaxBuf)
		a.processServerLines(sess)
	}
}

// appendCapped appends src to dst, capping the result at maxLen by discarding
// the oldest bytes. This prevents unbounded memory growth on slow-drain connections.
func appendCapped(dst, src []byte, maxLen int) []byte {
	dst = append(dst, src...)
	if len(dst) > maxLen {
		dst = dst[len(dst)-maxLen:]
	}
	return dst
}

// extractLines extracts complete \r\n-terminated lines from buf.
// It guards against oversized partial lines by dropping data beyond ftpMaxLineLen.
func extractLines(buf []byte) (lines []string, remaining []byte) {
	for {
		idx := -1
		for i := 0; i < len(buf)-1; i++ {
			if buf[i] == '\r' && buf[i+1] == '\n' {
				idx = i
				break
			}
		}
		if idx < 0 {
			// No complete line yet — guard against partial-line exhaustion
			if len(buf) > ftpMaxLineLen {
				buf = buf[len(buf)-ftpMaxLineLen:]
			}
			break
		}
		lines = append(lines, string(buf[:idx]))
		buf = buf[idx+2:] // consume \r\n
	}
	return lines, buf
}

// ──────────────────────────────────────────────────────────────────────────────
// Client command parsing (Phase 1 — reassembly + state + all rules)
// ──────────────────────────────────────────────────────────────────────────────

func (a *FTPAnalyzer) processClientLines(sess *ftpSession) {
	lines, remaining := extractLines(sess.clientBuf)
	sess.clientBuf = remaining
	for _, line := range lines {
		if line == "" {
			continue
		}
		a.handleClientLine(sess, line)
	}
}

func (a *FTPAnalyzer) handleClientLine(sess *ftpSession, line string) {
	parts := strings.SplitN(line, " ", 2)
	cmd := strings.ToUpper(strings.TrimSpace(parts[0]))
	arg := ""
	if len(parts) > 1 {
		arg = strings.TrimSpace(parts[1])
	}
	sess.lastCmd = cmd

	switch cmd {
	case "USER":
		sess.currentUser = arg
		if strings.EqualFold(arg, "anonymous") || strings.EqualFold(arg, "ftp") {
			sess.anonymous = true
			a.emit(sess, "FTP-ANON-001", SevMedium, CatAnonLogin,
				fmt.Sprintf("FTP anonymous login attempt: USER %s", arg),
				map[string]any{"username": arg})
		} else {
			sess.anonymous = false
			a.emit(sess, "FTP-USER-001", SevInfo, CatConnLifecycle,
				fmt.Sprintf("FTP login: USER %s", truncate(arg, 50)),
				map[string]any{"username": arg})
		}
		sess.state = ftpStateAuthentication

	case "PASS":
		a.emit(sess, "FTP-PASS-001", SevInfo, CatConnLifecycle,
			fmt.Sprintf("FTP PASS command sent for user '%s' (credentials in plaintext transit)", sess.currentUser),
			nil)

	case "PORT":
		a.handlePORT(sess, arg)

	case "PASV", "EPSV":
		sess.state = ftpStateDataNegotiation

	case "AUTH":
		upperArg := strings.ToUpper(arg)
		if upperArg == "TLS" || upperArg == "SSL" {
			sess.tlsRequested = true
			a.emitProto(sess, "FTP-STARTTLS", SevInfo, "FTPS",
				fmt.Sprintf("FTPS negotiation started: AUTH %s", arg),
				map[string]any{"auth_type": arg})
		}

	case "RETR":
		a.emit(sess, "FTP-XFER-001", SevInfo, CatConnLifecycle,
			fmt.Sprintf("FTP download: RETR %s", truncate(arg, 100)),
			map[string]any{"direction": "download", "filename": arg})
		a.checkSensitivePath(sess, arg, "RETR")
		a.checkGlob(sess, arg, "RETR")

	case "STOR":
		a.emit(sess, "FTP-XFER-002", SevInfo, CatConnLifecycle,
			fmt.Sprintf("FTP upload: STOR %s", truncate(arg, 100)),
			map[string]any{"direction": "upload", "filename": arg})
		a.checkGlob(sess, arg, "STOR")

	case "STOU":
		a.emit(sess, "FTP-STOU-001", SevHigh, CatDangerousCmd,
			fmt.Sprintf("FTP STOU (store-unique): may drop files with unpredictable names: %s", truncate(arg, 80)),
			nil)

	case "APPE":
		a.emit(sess, "FTP-APPE-001", SevHigh, CatDangerousCmd,
			fmt.Sprintf("FTP APPE (append-to-file): %s", truncate(arg, 80)),
			map[string]any{"filename": arg})
		a.checkSensitivePath(sess, arg, "APPE")

	case "DELE":
		a.emit(sess, "FTP-DEL-001", SevMedium, CatDangerousCmd,
			fmt.Sprintf("FTP file deletion: DELE %s", truncate(arg, 100)),
			map[string]any{"filename": arg})

	case "RMD", "XRMD":
		a.emit(sess, "FTP-RMD-001", SevMedium, CatDangerousCmd,
			fmt.Sprintf("FTP directory removal: %s %s", cmd, truncate(arg, 100)),
			nil)

	case "MKD", "XMKD":
		a.emit(sess, "FTP-MKD-001", SevLow, CatConnLifecycle,
			fmt.Sprintf("FTP make directory: %s %s", cmd, truncate(arg, 100)),
			map[string]any{"directory": arg})

	case "SITE":
		a.handleSITE(sess, arg)

	case "LIST", "NLST":
		a.checkGlob(sess, arg, cmd)
	}

	// Global path traversal check
	if strings.Contains(strings.ToUpper(line), "..") {
		a.bus.EmitDetection(Detection{
			ID: "FTP-TRAV-001", Timestamp: time.Now(),
			Severity: SevHigh, Category: CatPathTraversal, Protocol: "FTP",
			SourceIP: sess.srcIP, SourcePort: sess.srcPort, DestPort: sess.dstPort,
			Summary:     fmt.Sprintf("Path traversal in FTP command: %s", truncate(line, 100)),
			ConnID:      sess.connID,
			RawEvidence: truncate(line, 150),
		})
	}
}

func (a *FTPAnalyzer) handlePORT(sess *ftpSession, arg string) {
	sess.state = ftpStateDataNegotiation
	parts := strings.Split(strings.TrimSpace(arg), ",")
	if len(parts) != 6 {
		return
	}
	portIP := fmt.Sprintf("%s.%s.%s.%s", parts[0], parts[1], parts[2], parts[3])
	p1, err1 := strconv.Atoi(parts[4])
	p2, err2 := strconv.Atoi(parts[5])
	if err1 != nil || err2 != nil {
		return
	}
	dataPort := uint16(p1*256 + p2)
	parsedIP := net.ParseIP(portIP)
	// Use tracked clientIP; fall back to srcIP for backward-compat
	rawClientIP := sess.clientIP
	if rawClientIP == "" {
		rawClientIP = sess.srcIP
	}
	clientIPParsed := net.ParseIP(rawClientIP)
	if parsedIP != nil {
		sess.dataIP = parsedIP
		sess.dataPort = dataPort
	}
	// FTP Bounce: PORT IP differs from the actual client's own IP
	if parsedIP != nil && clientIPParsed != nil && !parsedIP.Equal(clientIPParsed) {
		a.bus.EmitDetection(Detection{
			ID: "FTP-BOUNCE-001", Timestamp: time.Now(),
			Severity: SevHigh, Category: CatFTPBounce, Protocol: "FTP",
			SourceIP: sess.srcIP, SourcePort: sess.srcPort, DestPort: sess.dstPort,
			Summary: fmt.Sprintf("FTP bounce attack: PORT pointing to %s:%d (client is %s)",
				portIP, dataPort, sess.srcIP),
			ConnID: sess.connID,
			Details: map[string]any{
				"port_ip":   portIP,
				"port_port": dataPort,
				"client_ip": sess.srcIP,
			},
		})
	}
}

func (a *FTPAnalyzer) handleSITE(sess *ftpSession, arg string) {
	parts := strings.SplitN(strings.TrimSpace(arg), " ", 2)
	subCmd := strings.ToUpper(parts[0])
	subArg := ""
	if len(parts) > 1 {
		subArg = parts[1]
	}
	switch subCmd {
	case "EXEC":
		a.bus.EmitDetection(Detection{
			ID: "FTP-EXEC", Timestamp: time.Now(),
			Severity: SevCritical, Category: CatDangerousCmd, Protocol: "FTP",
			SourceIP: sess.srcIP, SourcePort: sess.srcPort, DestPort: sess.dstPort,
			Summary:     fmt.Sprintf("FTP SITE EXEC remote command execution: %s", truncate(subArg, 150)),
			ConnID:      sess.connID,
			RawEvidence: truncate(arg, 150),
		})
	case "CHMOD":
		sev := SevMedium
		if strings.HasPrefix(subArg, "7") || strings.Contains(subArg, "777") {
			sev = SevCritical
		}
		a.emit(sess, "FTP-CHMOD", sev, CatDangerousCmd,
			fmt.Sprintf("FTP SITE CHMOD: %s", truncate(subArg, 100)),
			map[string]any{"permissions": subArg})
	default:
		a.emit(sess, "FTP-SITE-001", SevMedium, CatDangerousCmd,
			fmt.Sprintf("FTP SITE command: %s", truncate(arg, 100)),
			nil)
	}
}

func (a *FTPAnalyzer) checkSensitivePath(sess *ftpSession, path, cmd string) {
	lower := strings.ToLower(path)
	for _, sp := range ftpSensitivePaths {
		if strings.Contains(lower, sp) {
			a.bus.EmitDetection(Detection{
				ID: "FTP-SUSPICIOUS-PATH", Timestamp: time.Now(),
				Severity: SevHigh, Category: CatPathTraversal, Protocol: "FTP",
				SourceIP: sess.srcIP, SourcePort: sess.srcPort, DestPort: sess.dstPort,
				Summary: fmt.Sprintf("FTP access to sensitive path via %s: %s", cmd, truncate(path, 100)),
				ConnID:  sess.connID,
				Details: map[string]any{"path": path, "command": cmd, "matched_pattern": sp},
			})
			return
		}
	}
}

func (a *FTPAnalyzer) checkGlob(sess *ftpSession, arg, cmd string) {
	if strings.ContainsAny(arg, "*?[") {
		a.emit(sess, "FTP-GLOB-001", SevMedium, CatDangerousCmd,
			fmt.Sprintf("FTP wildcard glob in %s: %s", cmd, truncate(arg, 100)),
			map[string]any{"pattern": arg, "command": cmd})
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Server response parsing
// ──────────────────────────────────────────────────────────────────────────────

func (a *FTPAnalyzer) processServerLines(sess *ftpSession) {
	lines, remaining := extractLines(sess.serverBuf)
	sess.serverBuf = remaining
	for _, line := range lines {
		if line == "" {
			continue
		}
		a.handleServerLine(sess, line)
	}
}

func (a *FTPAnalyzer) handleServerLine(sess *ftpSession, line string) {
	if len(line) < 3 {
		return
	}
	code := line[:3]

	// Validate that first 3 chars are digits
	for _, c := range code {
		if c < '0' || c > '9' {
			return
		}
	}

	// RFC 959 §4.2: "XYZ-text" starts/continues multiline; "XYZ text" terminates it.
	if len(line) > 3 {
		sep := line[3]
		if sep == '-' {
			if !sess.serverMultiLine {
				sess.serverMultiLine = true
				sess.serverMultiCode = code
			}
			return // Continuation — don't act until termination
		} else if sep == ' ' && sess.serverMultiLine {
			if code != sess.serverMultiCode {
				// Malformed: terminating code differs from opening code (RFC violation)
				a.bus.EmitDetection(Detection{
					ID: "FTP-MALFORM-001", Timestamp: time.Now(),
					Severity: SevMedium, Category: CatMalformed, Protocol: "FTP",
					SourceIP: sess.srcIP, SourcePort: sess.srcPort, DestPort: sess.dstPort,
					Summary: fmt.Sprintf(
						"Malformed FTP multiline response: opened %s, terminated with %s",
						sess.serverMultiCode, code),
					ConnID: sess.connID,
				})
				// Safe reset — treat this line as an independent response
				sess.serverMultiLine = false
				sess.serverMultiCode = ""
				return
			}
			// Normal termination: fall through to process terminal code
			sess.serverMultiLine = false
			sess.serverMultiCode = ""
		}
	} else if sess.serverMultiLine {
		return // 3-char line mid-multiline is a continuation
	}

	a.processResponseCode(sess, code, line)
}

func (a *FTPAnalyzer) processResponseCode(sess *ftpSession, code, line string) {
	switch code {
	case "220":
		a.emit(sess, "FTP-GREET-001", SevInfo, CatProtocolDetect,
			fmt.Sprintf("FTP server greeting: %s", truncate(line, 120)),
			nil)
		sess.state = ftpStateGreeting

	case "230":
		a.emit(sess, "FTP-LOGIN-OK", SevInfo, CatConnLifecycle,
			fmt.Sprintf("FTP login successful: user '%s'", sess.currentUser),
			map[string]any{"username": sess.currentUser})
		sess.authenticated = true
		sess.state = ftpStateAuthenticated
		if sess.anonymous {
			// Anonymous login actually succeeded — escalate severity
			a.emit(sess, "FTP-ANON-LOGIN-OK", SevHigh, CatAnonLogin,
				"FTP anonymous login SUCCEEDED — server grants unauthenticated access",
				nil)
		}

	case "234":
		// Server accepted AUTH TLS/SSL (explicit FTPS)
		if sess.tlsRequested {
			a.emitProto(sess, "FTP-FTPS-001", SevInfo, "FTPS",
				"FTPS explicit negotiation complete (234): control channel is now TLS-encrypted",
				nil)
			sess.tlsEstablished = true
			sess.state = ftpStateTLS
		}

	case "227":
		// Passive mode: 227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)
		a.parsePASVResponse(sess, line)

	case "229":
		// Extended passive mode: 229 Entering Extended Passive Mode (|||port|)
		a.parseEPSVResponse(sess, line)

	case "530":
		// Authentication failure
		a.emit(sess, "FTP-AUTH-FAIL", SevMedium, CatBruteForce,
			fmt.Sprintf("FTP authentication failure for user '%s'", sess.currentUser),
			map[string]any{"username": sess.currentUser})
		if a.brute.record(sess.srcIP, sess.dstPort, a.bruteConf.Window, a.bruteConf.Threshold) {
			a.bus.EmitDetection(Detection{
				ID: "FTP-BRUTE-001", Timestamp: time.Now(),
				Severity: SevCritical, Category: CatBruteForce, Protocol: "FTP",
				SourceIP: sess.srcIP, SourcePort: sess.srcPort, DestPort: sess.dstPort,
				Summary: fmt.Sprintf("FTP brute-force: ≥%d authentication failures from %s in %s",
					a.bruteConf.Threshold, sess.srcIP, a.bruteConf.Window),
				ConnID: sess.connID,
				Details: map[string]any{
					"threshold": a.bruteConf.Threshold,
					"window":    a.bruteConf.Window.String(),
				},
			})
		}

	case "125", "150":
		sess.state = ftpStateTransfer

	case "226":
		// Transfer complete — clear data channel metadata, return to command loop
		sess.state = ftpStateCommandProcessing
		sess.dataIP = nil
		sess.dataPort = 0
	}
}

func (a *FTPAnalyzer) parsePASVResponse(sess *ftpSession, line string) {
	// 227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)
	start := strings.Index(line, "(")
	end := strings.LastIndex(line, ")")
	if start < 0 || end <= start {
		return
	}
	parts := strings.Split(line[start+1:end], ",")
	if len(parts) != 6 {
		return
	}
	ip := fmt.Sprintf("%s.%s.%s.%s", parts[0], parts[1], parts[2], parts[3])
	p1, err1 := strconv.Atoi(strings.TrimSpace(parts[4]))
	p2, err2 := strconv.Atoi(strings.TrimSpace(parts[5]))
	if err1 != nil || err2 != nil {
		return
	}
	port := uint16(p1*256 + p2)
	sess.dataIP = net.ParseIP(ip)
	sess.dataPort = port
	sess.state = ftpStateDataNegotiation
	a.emit(sess, "FTP-PASV-001", SevInfo, CatFTPData,
		fmt.Sprintf("FTP passive mode: data channel negotiated at %s:%d (PASV)", ip, port),
		map[string]any{"data_ip": ip, "data_port": port, "mode": "PASV"})
}

func (a *FTPAnalyzer) parseEPSVResponse(sess *ftpSession, line string) {
	// 229 Entering Extended Passive Mode (|||port|)
	start := strings.Index(line, "(")
	end := strings.LastIndex(line, ")")
	if start < 0 || end <= start {
		return
	}
	inner := line[start+1 : end]
	// EPSV format: |AF|IP|port|  or  |||port|
	parts := strings.Split(inner, "|")
	if len(parts) < 4 {
		return
	}
	port, err := strconv.Atoi(strings.TrimSpace(parts[len(parts)-2]))
	if err != nil {
		return
	}
	sess.dataPort = uint16(port)
	sess.state = ftpStateDataNegotiation
	a.emit(sess, "FTP-PASV-001", SevInfo, CatFTPData,
		fmt.Sprintf("FTP extended passive mode: data channel port %d (EPSV)", port),
		map[string]any{"data_port": port, "mode": "EPSV"})
}

// ──────────────────────────────────────────────────────────────────────────────
// Emit helpers
// ──────────────────────────────────────────────────────────────────────────────

func (a *FTPAnalyzer) emit(sess *ftpSession, id string, sev Severity, cat, summary string, details map[string]any) {
	a.bus.EmitDetection(Detection{
		ID: id, Timestamp: time.Now(),
		Severity: sev, Category: cat, Protocol: "FTP",
		SourceIP: sess.srcIP, SourcePort: sess.srcPort, DestPort: sess.dstPort,
		Summary: summary, ConnID: sess.connID, Details: details,
	})
}

// emitProto allows overriding the Protocol field (e.g. "FTPS").
func (a *FTPAnalyzer) emitProto(sess *ftpSession, id string, sev Severity, proto, summary string, details map[string]any) {
	a.bus.EmitDetection(Detection{
		ID: id, Timestamp: time.Now(),
		Severity: sev, Category: CatProtocolDetect, Protocol: proto,
		SourceIP: sess.srcIP, SourcePort: sess.srcPort, DestPort: sess.dstPort,
		Summary: summary, ConnID: sess.connID, Details: details,
	})
}
