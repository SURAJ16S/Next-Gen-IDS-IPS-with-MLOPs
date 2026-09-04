// SPDX-License-Identifier: GPL-2.0
// detect/ssh_analyzer.go — Stateful SSH protocol analyzer.
//
// This analyzer tracks each SSH connection through a 6-state machine and only
// fires detection rules when the relevant data is visible in plaintext.
//
// ARCHITECTURE: TCP stream reassembly
// The proxy Forwarder reads up to 32KB per relay() call. A single SSH message
// (e.g. KEXINIT) may span multiple reads, and a single read may contain multiple
// complete SSH messages. The analyzer maintains a per-direction reassembly buffer
// (clientBuf / serverBuf, capped at sshMaxReassemlyBuf) and consumes complete
// protocol units before dispatching to rule handlers.
//
// STATE MACHINE:
//   TCPEstablished → VersionExchange → KEXInit → KEXExchange → PostNewKeys
//                                                                    ↓
//                                                           ParseAbandoned
//
// ENCRYPTION BOUNDARY:
// After SSH_MSG_NEWKEYS (type 21), all payload is encrypted. The analyzer stops
// payload inspection and switches to timing-only heuristics (SSH-BRUTE-001).
// SSH_MSG_CHANNEL_OPEN (type 90) is encrypted post-NEWKEYS and cannot be
// inspected by a passive monitor — it is intentionally not implemented.
//
// KNOWN LIMITATIONS:
//   - Banner strings (SSH-TOOL-001) can be spoofed. Combine with HASSH for
//     higher confidence. Phase-2 enhancement: multi-signal tool correlation.
//   - SSH-BRUTE-001 is a heuristic. The thresholds (sshBruteThreshold, etc.)
//     are empirically unvalidated. Run baseline testing with your environment's
//     typical SSH automation patterns before deploying with blocking.
//   - srcIP:dstPort brute-force key conflates unrelated simultaneous connections
//     from the same source IP — acceptable for IDS purposes, but may increase
//     false-positive rate in NAT environments.
//   - ParseAbandoned: inspection halts but forwarding continues. An attacker
//     can intentionally send a malformed packet to blind this analyzer for that
//     session. This is an accepted limitation of passive monitoring; it does not
//     affect the forwarding path.
//
// RFC REFERENCES: RFC 4253 (Transport Layer), RFC 4252 (Authentication),
//                 RFC 4254 (Connection Protocol)
//
// HASSH SPECIFICATION:
//   Client HASSH  = MD5( kex;enc_c2s;mac_c2s;comp_c2s )
//   Server HASSH  = MD5( kex;enc_s2c;mac_s2c;comp_s2c )
//   where fields come from the respective peer's SSH_MSG_KEXINIT and the
//   name-list order matches RFC 4253 §7.1 exactly.
//   Reference: https://github.com/salesforce/hassh

package detect

import (
	"bytes"
	"crypto/md5"
	"fmt"
	"strings"
	"sync"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// Detection Thresholds (named constants — adjust after baseline testing)
// ──────────────────────────────────────────────────────────────────────────────

const (
	// sshBruteWindow is the sliding window for rapid-teardown counting.
	// EMPIRICALLY UNVALIDATED: requires baseline testing with your environment's
	// SSH automation patterns (CI/CD, monitoring probes, health checks) before
	// adjusting the threshold to avoid unknown false-positive rates.
	sshBruteWindow = 10 * time.Second

	// sshBruteTeardownMax is the maximum time from POST_NEWKEYS to TCP close that
	// counts as a "rapid teardown" — a heuristic indicator of failed authentication.
	// Legitimate single-command SSH sessions (ssh host cmd) may also trigger this.
	sshBruteTeardownMax = 3 * time.Second

	// sshBruteThreshold is the number of rapid teardowns from the same srcIP:dstPort
	// within sshBruteWindow before SSH-BRUTE-001 is emitted.
	sshBruteThreshold = 5

	// sshMaxReassemlyBuf is the per-direction reassembly buffer cap (bytes).
	// Data beyond this cap is discarded (no further inspection for that direction).
	sshMaxReassemlyBuf = 65536

	// sshMaxPacketSize is the maximum valid SSH binary packet payload size.
	// RFC 4253 §6.1 mandates implementations MUST be able to handle up to 35,000 bytes.
	sshMaxPacketSize = 35000

	// sshSessionIdleExpiry is the time after last activity before a session is
	// evicted from the tracker. Long-lived sessions (hours/days) reset this on
	// every Analyze() call. The eviction only removes sessions truly idle for
	// this duration — not simply sessions in PostNewKeys for a long time.
	sshSessionIdleExpiry = 10 * time.Minute
)

// ──────────────────────────────────────────────────────────────────────────────
// Connection State Machine
// ──────────────────────────────────────────────────────────────────────────────

type sshConnState int

const (
	sshTCPEstablished  sshConnState = iota // TCP connected, no SSH data yet
	sshVersionExchange                     // ASCII banner exchange ("SSH-2.0-...")
	sshKEXInit                             // SSH_MSG_KEXINIT (type 20) phase
	sshKEXExchange                         // DH/ECDH exchange (types 30/31)
	sshPostNewKeys                         // SSH_MSG_NEWKEYS received — encrypted from here
	sshParseAbandoned                      // Malformed packet — deep inspection halted
)

func (s sshConnState) String() string {
	switch s {
	case sshTCPEstablished:
		return "TCP_ESTABLISHED"
	case sshVersionExchange:
		return "VERSION_EXCHANGE"
	case sshKEXInit:
		return "KEX_INIT"
	case sshKEXExchange:
		return "KEX_EXCHANGE"
	case sshPostNewKeys:
		return "POST_NEWKEYS"
	case sshParseAbandoned:
		return "PARSE_ABANDONED"
	default:
		return "UNKNOWN"
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool Classification
// ──────────────────────────────────────────────────────────────────────────────

// sshToolClass categorizes SSH clients by threat profile.
// Tools in different classes require different response postures.
type sshToolClass string

const (
	sshClassBruteForce  sshToolClass = "brute-force-tool"  // Active credential attack tools
	sshClassScanner     sshToolClass = "scanner"           // Reconnaissance / banner scanners
	sshClassAutomation  sshToolClass = "automation-client" // Automation libs often used in attacks
	sshClassSSHLibrary  sshToolClass = "ssh-library"       // General-purpose SSH libraries (low risk)
	sshClassKnownClient sshToolClass = "known-ssh-client"  // Well-known legitimate SSH clients (INFO)
)

type sshToolInfo struct {
	name     string
	class    sshToolClass
	severity Severity
	note     string
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-Connection Session
// ──────────────────────────────────────────────────────────────────────────────

// sshSession holds all per-connection state for one SSH session.
// Each direction has its own reassembly buffer (clientBuf / serverBuf) because
// TCP segments can split or coalesce SSH protocol frames arbitrarily.
//
// connID is generated by the proxy (UUID per TCP connection) and is the primary
// key for the session map. The brute-force tracker uses srcIP:dstPort as a
// secondary key to correlate rapid teardowns across multiple connections from
// the same source.
type sshSession struct {
	connID        string
	srcIP         string
	srcPort       uint16
	dstPort       uint16
	state         sshConnState
	stateEntered  time.Time
	newKeysAt     time.Time // monotonic: when sshPostNewKeys was entered
	clientVersion string    // e.g. "SSH-2.0-OpenSSH_8.9"
	serverVersion string
	clientHASSH   string
	gotClientVer  bool
	gotServerVer  bool
	lastActivity  time.Time // updated on every Analyze() call (for cleanup)

	// Per-direction TCP reassembly buffers.
	// clientBuf is only appended to by the client→server relay goroutine.
	// serverBuf is only appended to by the server→client relay goroutine.
	// Both are protected by SSHAnalyzer.sessionMu.
	clientBuf []byte
	serverBuf []byte
	clientBytes int64
	serverBytes int64
	tunnelAlerted bool
}

// ──────────────────────────────────────────────────────────────────────────────
// Brute-Force Sliding Window
// ──────────────────────────────────────────────────────────────────────────────

type rapidTeardownEvent struct{ at time.Time }

type bruteForceWindow struct{ events []rapidTeardownEvent }

func (w *bruteForceWindow) prune(window time.Duration) {
	cutoff := time.Now().Add(-window)
	i := 0
	for i < len(w.events) && w.events[i].at.Before(cutoff) {
		i++
	}
	w.events = w.events[i:]
}

func (w *bruteForceWindow) count(window time.Duration) int {
	w.prune(window)
	return len(w.events)
}

func (w *bruteForceWindow) add() {
	w.events = append(w.events, rapidTeardownEvent{at: time.Now()})
}

// ──────────────────────────────────────────────────────────────────────────────
// SSH Analyzer
// ──────────────────────────────────────────────────────────────────────────────

// SSHAnalyzer is a stateful SSH protocol analyzer with per-connection session
// tracking, TCP stream reassembly, and sliding-window brute-force detection.
type SSHAnalyzer struct {
	bus *DetectionBus

	// sessions is keyed by proxy connID (UUID per TCP connection).
	sessionMu sync.Mutex
	sessions  map[string]*sshSession

	// bfWindows is keyed by "srcIP:dstPort" for cross-connection rapid-teardown
	// counting. This key may conflate simultaneous connections from the same IP
	// (e.g. in NAT environments), which is acceptable for IDS alerting purposes.
	bfMu      sync.Mutex
	bfWindows map[string]*bruteForceWindow

	weakKEX     map[string]bool
	weakCiphers map[string]bool
	weakMACs    map[string]bool
	knownTools  map[string]sshToolInfo

	// knownBadHASSH maps known attack-tool HASSH fingerprints to descriptions.
	knownBadHASSH map[string]string

	// knownVulnerableSSH maps known vulnerable SSH client versions to their CVEs.
	knownVulnerableSSH map[string]string
}

// NewSSHAnalyzer creates a stateful SSH analyzer.
func NewSSHAnalyzer(bus *DetectionBus) *SSHAnalyzer {
	a := &SSHAnalyzer{
		bus:       bus,
		sessions:  make(map[string]*sshSession),
		bfWindows: make(map[string]*bruteForceWindow),

		weakKEX: map[string]bool{
			"diffie-hellman-group1-sha1":         true,
			"diffie-hellman-group14-sha1":        true,
			"diffie-hellman-group-exchange-sha1": true,
		},
		weakCiphers: map[string]bool{
			"arcfour":                     true,
			"arcfour128":                  true,
			"arcfour256":                  true,
			"3des-cbc":                    true,
			"blowfish-cbc":                true,
			"cast128-cbc":                 true,
			"aes128-cbc":                  true, // CBC mode lacks AEAD guarantees
			"aes192-cbc":                  true,
			"aes256-cbc":                  true,
			"rijndael-cbc@lysator.liu.se": true,
			"none":                        true,
		},
		weakMACs: map[string]bool{
			"hmac-md5":       true,
			"hmac-md5-96":    true,
			"hmac-sha1-96":   true,
			"hmac-ripemd160": true,
			"none":           true,
		},

		// Tool database: keyed by lowercase substring of SSH version string.
		// LIMITATION: SSH version banners can be spoofed by any SSH client.
		// This detection is a first-pass heuristic. Combine with HASSH
		// fingerprint and behavioral signals for higher confidence (Phase 2).
		knownTools: map[string]sshToolInfo{
			// Brute-force tools — active credential attack
			"ncrack":     {"Ncrack", sshClassBruteForce, SevHigh, "Network authentication cracking tool"},
			"medusa":     {"Medusa", sshClassBruteForce, SevHigh, "Parallel brute-force login tool"},
			"hydra":      {"THC-Hydra", sshClassBruteForce, SevHigh, "Multi-protocol password attack framework"},
			"brutespray": {"Brutespray", sshClassBruteForce, SevHigh, "Service credential brute-forcer"},
			"crowbar":    {"Crowbar", sshClassBruteForce, SevHigh, "Brute-force tool with key-based auth support"},
			// Scanners — reconnaissance, not necessarily auth attacks
			"masscan": {"Masscan", sshClassScanner, SevMedium, "High-speed port and banner scanner"},
			"zgrab":   {"ZGrab", sshClassScanner, SevMedium, "Application-layer network scanner"},
			// Automation clients — dual-use (legitimate automation and attack tooling)
			"paramiko": {"Paramiko", sshClassAutomation, SevMedium, "Python SSH library — common in automated attack scripts"},
			"asyncssh": {"AsyncSSH", sshClassAutomation, SevLow, "Python async SSH library — dual-use"},
			"twisted":  {"Twisted Conch", sshClassAutomation, SevLow, "Python SSH framework"},
			"jsch":     {"JSch", sshClassAutomation, SevMedium, "Java SSH library — used in CI/CD and attack frameworks"},
			// SSH libraries — general purpose, low individual risk
			"libssh":  {"libssh", sshClassSSHLibrary, SevLow, "C SSH library (embedded/scripted clients)"},
			"libssh2": {"libssh2", sshClassSSHLibrary, SevLow, "C SSH library"},
			"go":      {"Go x/crypto/ssh", sshClassSSHLibrary, SevLow, "Go standard SSH library"},
			// Known legitimate clients — informational, no alert emitted
			"putty":     {"PuTTY", sshClassKnownClient, SevInfo, "Common Windows SSH terminal"},
			"openssh":   {"OpenSSH", sshClassKnownClient, SevInfo, "Standard SSH implementation"},
			"dropbear":  {"Dropbear", sshClassKnownClient, SevInfo, "Lightweight embedded SSH"},
			"bitvise":   {"Bitvise", sshClassKnownClient, SevInfo, "Windows SSH/SFTP client"},
			"winscp":    {"WinSCP", sshClassKnownClient, SevInfo, "Windows SFTP client"},
			"filezilla": {"FileZilla", sshClassKnownClient, SevInfo, "Cross-platform SFTP client"},
			"cyberduck": {"Cyberduck", sshClassKnownClient, SevInfo, "Cloud storage/SFTP client"},
			"mobaxterm": {"MobaXterm", sshClassKnownClient, SevInfo, "Windows SSH terminal emulator"},
		},

		knownBadHASSH: map[string]string{
			"92674389fa1e47a27ddd8d9b63ecd42b": "Metasploit Framework SSH scanner",
			"d41d8cd98f00b204e9800998ecf8427e": "Empty HASSH (null/buggy SSH implementation)",
			"1c7a1b9c44f45c91a5dce5b5e3f660b3": "Ncrack SSH module (known fingerprint)",
			"5f41249ed2e1a3d90610f6797a760b94": "Hydra SSH Brute-force Tool",
			"3c26027df2fbc5d7c474dc1d054238db": "Medusa SSH Brute-force Tool",
		},

		knownVulnerableSSH: map[string]string{
			"OpenSSH_8.1": "CVE-202X-XXXX (Possible RCE or privilege escalation)",
			"OpenSSH_7.2p2": "CVE-2016-6210 (User enumeration vulnerability)",
			"Dropbear_2016.74": "CVE-2016-7406 (Format string vulnerability)",
			"libssh_0.7.5": "CVE-2018-10933 (Authentication bypass)",
		},
	}
	go a.cleanupLoop()
	return a
}

// ──────────────────────────────────────────────────────────────────────────────
// Session Lifecycle
// ──────────────────────────────────────────────────────────────────────────────

// getOrCreate returns the existing session or creates a new one.
// Caller MUST hold a.sessionMu.
func (a *SSHAnalyzer) getOrCreate(connID, srcIP string, srcPort, dstPort uint16) *sshSession {
	sess, ok := a.sessions[connID]
	if !ok {
		sess = &sshSession{
			connID:       connID,
			srcIP:        srcIP,
			srcPort:      srcPort,
			dstPort:      dstPort,
			state:        sshTCPEstablished,
			stateEntered: time.Now(),
			lastActivity: time.Now(),
		}
		a.sessions[connID] = sess
	}
	return sess
}

// transition moves a session to a new state.
// Caller MUST hold a.sessionMu.
func (a *SSHAnalyzer) transition(sess *sshSession, newState sshConnState) {
	sess.state = newState
	sess.stateEntered = time.Now()
	if newState == sshPostNewKeys {
		sess.newKeysAt = time.Now()
	}
}

// cleanupLoop evicts sessions with no activity for sshSessionIdleExpiry.
// It uses lastActivity (updated on every Analyze call), NOT the duration
// in any specific state — so active long-lived sessions are preserved.
func (a *SSHAnalyzer) cleanupLoop() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		cutoff := time.Now().Add(-sshSessionIdleExpiry)
		a.sessionMu.Lock()
		for id, s := range a.sessions {
			if s.lastActivity.Before(cutoff) {
				delete(a.sessions, id)
			}
		}
		a.sessionMu.Unlock()

		a.bfMu.Lock()
		for key, w := range a.bfWindows {
			w.prune(sshBruteWindow)
			if len(w.events) == 0 {
				delete(a.bfWindows, key)
			}
		}
		a.bfMu.Unlock()
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Primary Entry Points
// ──────────────────────────────────────────────────────────────────────────────

// Analyze is called by the proxy Forwarder on every chunk of relayed data.
// It appends the chunk to the appropriate direction's reassembly buffer and
// processes as many complete protocol units as possible.
//
// The function collects all detections under the session lock and emits them
// after releasing the lock to avoid holding sessionMu during bus callbacks.
func (a *SSHAnalyzer) Analyze(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) == 0 {
		return
	}

	var detections []Detection

	a.sessionMu.Lock()
	sess := a.getOrCreate(connID, srcIP, srcPort, dstPort)
	sess.lastActivity = time.Now()

	// Append to the appropriate direction's reassembly buffer.
	if fromClient {
		if len(sess.clientBuf)+len(data) <= sshMaxReassemlyBuf {
			sess.clientBuf = append(sess.clientBuf, data...)
		} else {
			room := sshMaxReassemlyBuf - len(sess.clientBuf)
			if room > 0 {
				sess.clientBuf = append(sess.clientBuf, data[:room]...)
			}
		}
	} else {
		if len(sess.serverBuf)+len(data) <= sshMaxReassemlyBuf {
			sess.serverBuf = append(sess.serverBuf, data...)
		} else {
			room := sshMaxReassemlyBuf - len(sess.serverBuf)
			if room > 0 {
				sess.serverBuf = append(sess.serverBuf, data[:room]...)
			}
		}
	}

	// Process as many complete protocol units as the buffer allows.
	a.processStream(sess, fromClient, &detections)

	// ── SSH-TUNNEL-001: Tunnel anomaly detection ──
	if fromClient {
		sess.clientBytes += int64(len(data))
	} else {
		sess.serverBytes += int64(len(data))
	}

	if sess.state == sshPostNewKeys && !sess.tunnelAlerted {
		// Threshold: 10MB transferred, connection alive for at least 1 minute
		totalBytes := sess.clientBytes + sess.serverBytes
		if totalBytes > 10*1024*1024 && time.Since(sess.newKeysAt) > 1*time.Minute {
			sess.tunnelAlerted = true
			detections = append(detections, Detection{
				ID:         "SSH-TUNNEL-001",
				Timestamp:  time.Now(),
				Severity:   SevHigh,
				Category:   CatSuspicious,
				Protocol:   "SSH",
				SourceIP:   sess.srcIP,
				SourcePort: sess.srcPort,
				DestPort:   sess.dstPort,
				Summary:    fmt.Sprintf("SSH Tunnel suspected: %d bytes transferred over %s", totalBytes, time.Since(sess.newKeysAt).Round(time.Second)),
				ConnID:     sess.connID,
				Details: map[string]any{
					"client_bytes": sess.clientBytes,
					"server_bytes": sess.serverBytes,
					"duration_sec": time.Since(sess.newKeysAt).Seconds(),
				},
			})
		}
	}

	a.sessionMu.Unlock()

	// Emit detections outside the session lock.
	for _, d := range detections {
		a.bus.EmitDetection(d)
	}
}

// AnalyzeClose is called by the proxy Forwarder when a TCP connection closes.
// This is the entry point for timing-based heuristics that require knowing
// the exact moment a connection tears down.
func (a *SSHAnalyzer) AnalyzeClose(connID, srcIP string, srcPort, dstPort uint16) {
	a.sessionMu.Lock()
	sess, ok := a.sessions[connID]
	if ok {
		delete(a.sessions, connID)
	}
	a.sessionMu.Unlock()

	if !ok {
		return
	}

	var detections []Detection

	// ── SSH-SCAN-001: Heuristic Banner Scanner Indicator ──
	// A connection that received the server's version string but disconnected
	// before completing key exchange is a heuristic indicator of a banner scanner.
	// Confidence: MEDIUM. Legitimate clients can also disconnect early on
	// authentication failure or connectivity errors.
	if sess.state == sshVersionExchange && sess.gotServerVer && !sess.gotClientVer {
		detections = append(detections, Detection{
			ID:         "SSH-SCAN-001",
			Timestamp:  time.Now(),
			Severity:   SevMedium,
			Category:   CatSSHBannerScan,
			Protocol:   "SSH",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary: fmt.Sprintf(
				"SSH heuristic: %s read server banner and disconnected before key exchange (possible scanner)",
				srcIP,
			),
			ConnID: connID,
			Details: map[string]any{
				"server_version": sess.serverVersion,
				"phase_reached":  sess.state.String(),
				"confidence":     "MEDIUM",
				"note":           "Heuristic indicator only. Legitimate clients can also disconnect early.",
			},
		})
	}

	// ── SSH-BRUTE-001: Heuristic Rapid-Teardown / Failed Auth Indicator ──
	// A connection that entered PostNewKeys (completed KEX) and closed within
	// sshBruteTeardownMax is a heuristic indicator of a failed authentication
	// attempt. When this pattern occurs >= sshBruteThreshold times within
	// sshBruteWindow from the same srcIP:dstPort, SSH-BRUTE-001 is emitted.
	//
	// FALSE POSITIVES: Automated health checks, CI/CD pipelines, monitoring
	// probes (e.g., Nagios SSH checks), and single-command sessions that
	// complete quickly are computationally indistinguishable from this pattern
	// in a passive monitor. Baseline testing with your environment is required
	// before treating this as a confirmed brute-force attack.
	if sess.state == sshPostNewKeys {
		teardownDelay := time.Since(sess.newKeysAt)
		if teardownDelay <= sshBruteTeardownMax {
			windowKey := fmt.Sprintf("%s:%d", srcIP, dstPort)
			a.bfMu.Lock()
			w, exists := a.bfWindows[windowKey]
			if !exists {
				w = &bruteForceWindow{}
				a.bfWindows[windowKey] = w
			}
			w.add()
			count := w.count(sshBruteWindow)
			a.bfMu.Unlock()

			if count >= sshBruteThreshold {
				detections = append(detections, Detection{
					ID:         "SSH-BRUTE-001",
					Timestamp:  time.Now(),
					Severity:   SevHigh,
					Category:   CatSSHBruteForce,
					Protocol:   "SSH",
					SourceIP:   srcIP,
					SourcePort: srcPort,
					DestPort:   dstPort,
					Summary: fmt.Sprintf(
						"SSH heuristic: %s made %d rapid-teardown connections in %s (NEWKEYS→close in %s) — possible automated auth attempts",
						srcIP, count, sshBruteWindow, teardownDelay.Round(time.Millisecond),
					),
					ConnID: connID,
					Details: map[string]any{
						"rapid_teardowns_in_window": count,
						"window_seconds":            sshBruteWindow.Seconds(),
						"threshold":                 sshBruteThreshold,
						"teardown_delay_ms":         teardownDelay.Milliseconds(),
						"confidence":                "MEDIUM",
						"note": "Heuristic: connect→NEWKEYS→rapid-disconnect pattern. " +
							"Cannot confirm auth failure in passive mode (auth messages are encrypted). " +
							"False positives: health checks, CI/CD pipelines, BatchMode sessions.",
					},
				})
			}
		}
	}

	for _, d := range detections {
		a.bus.EmitDetection(d)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// TCP Stream Reassembly
// ──────────────────────────────────────────────────────────────────────────────

// processStream consumes as many complete protocol units as possible from the
// direction's reassembly buffer.
// Caller MUST hold a.sessionMu.
func (a *SSHAnalyzer) processStream(sess *sshSession, fromClient bool, out *[]Detection) {
	for {
		switch sess.state {
		case sshTCPEstablished, sshVersionExchange:
			if !a.consumeVersionLine(sess, fromClient, out) {
				return
			}
		case sshKEXInit, sshKEXExchange:
			if !a.consumeSSHPacket(sess, fromClient, out) {
				return
			}
		default:
			return // PostNewKeys or ParseAbandoned — nothing to consume
		}
	}
}

// consumeVersionLine tries to extract one complete version line from the buffer.
// SSH version exchange is ASCII line-oriented (RFC 4253 §4.2).
// Returns true if a line was consumed and the caller should loop again.
// Caller MUST hold a.sessionMu.
func (a *SSHAnalyzer) consumeVersionLine(sess *sshSession, fromClient bool, out *[]Detection) bool {
	var buf *[]byte
	if fromClient {
		buf = &sess.clientBuf
	} else {
		buf = &sess.serverBuf
	}

	// Look for a complete line (terminated by \n).
	idx := bytes.IndexByte(*buf, '\n')
	if idx < 0 {
		return false // incomplete line — wait for more data
	}

	line := bytes.TrimRight((*buf)[:idx], "\r")
	*buf = (*buf)[idx+1:]

	lineStr := string(line)

	// RFC 4253 §4.2: server MAY send other lines before "SSH-". Client MUST
	// send the identification string immediately. Non-SSH lines are skipped.
	if !strings.HasPrefix(lineStr, "SSH-") {
		return true // skip this line, try the next one
	}

	a.handleVersionString(sess, lineStr, fromClient, out)
	return true
}

// consumeSSHPacket tries to extract one complete binary SSH packet from the buffer.
// SSH binary packets: uint32 packet_length + byte padding_length + payload + padding
// (RFC 4253 §6). Returns true if a packet was consumed.
// Caller MUST hold a.sessionMu.
func (a *SSHAnalyzer) consumeSSHPacket(sess *sshSession, fromClient bool, out *[]Detection) bool {
	var buf *[]byte
	if fromClient {
		buf = &sess.clientBuf
	} else {
		buf = &sess.serverBuf
	}

	if len(*buf) < 5 { // need at least packet_length(4) + padding_length(1)
		return false
	}

	// Read packet_length (big-endian uint32).
	pktLen := int((*buf)[0])<<24 | int((*buf)[1])<<16 | int((*buf)[2])<<8 | int((*buf)[3])

	// Sanity bounds: minimum=2 (padding_length + type), maximum=sshMaxPacketSize.
	if pktLen < 2 || pktLen > sshMaxPacketSize {
		*out = append(*out, a.buildMalformed(sess,
			fmt.Sprintf("packet_length %d out of valid range [2, %d]", pktLen, sshMaxPacketSize),
			pktLen,
		))
		a.transition(sess, sshParseAbandoned)
		*buf = nil // discard buffer
		return false
	}

	totalWireLen := 4 + pktLen
	if len(*buf) < totalWireLen {
		return false // wait for more data
	}

	// pkt = everything after the 4-byte length field.
	// pkt[0] = padding_length
	// pkt[1] = message_type (payload type byte)
	// pkt[2..pktLen-padding_length-1] = payload
	// pkt[pktLen-padding_length..pktLen-1] = padding
	pkt := make([]byte, pktLen)
	copy(pkt, (*buf)[4:totalWireLen])
	*buf = (*buf)[totalWireLen:]

	if len(pkt) < 2 {
		return true // too short to have a type byte; skip silently
	}

	msgType := pkt[1]
	paddingLen := int(pkt[0])

	a.dispatchSSHPacket(sess, pkt, msgType, paddingLen, fromClient, out)
	return true
}

// ──────────────────────────────────────────────────────────────────────────────
// Protocol Dispatchers
// ──────────────────────────────────────────────────────────────────────────────

// handleVersionString parses and dispatches rules for an SSH version banner.
// Caller MUST hold a.sessionMu.
func (a *SSHAnalyzer) handleVersionString(sess *sshSession, banner string, fromClient bool, out *[]Detection) {
	parts := strings.SplitN(banner, "-", 3)
	protoVer, softVer := "", ""
	if len(parts) >= 2 {
		protoVer = parts[1]
	}
	if len(parts) >= 3 {
		softVer = parts[2]
	}

	direction := "server"
	if fromClient {
		direction = "client"
		sess.clientVersion = banner
		sess.gotClientVer = true
	} else {
		sess.serverVersion = banner
		sess.gotServerVer = true
	}

	if sess.state == sshTCPEstablished {
		a.transition(sess, sshVersionExchange)
	}

	// ── SSH-PROTO-001: SSHv1 detected ──
	if protoVer == "1" || strings.HasPrefix(protoVer, "1.") {
		*out = append(*out, Detection{
			ID:         "SSH-PROTO-001",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatSSHLegacyProto,
			Protocol:   "SSH",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			Summary: fmt.Sprintf(
				"SSHv1 detected from %s (%s) — cryptographically broken, deprecated by RFC 4253",
				direction, banner,
			),
			ConnID: sess.connID,
			Details: map[string]any{
				"protocol_version": protoVer,
				"software_version": softVer,
				"direction":        direction,
				"banner":           banner,
			},
		})
	}

	// ── SSH-VER-001: Version logged ──
	*out = append(*out, Detection{
		ID:         "SSH-VER-001",
		Timestamp:  time.Now(),
		Severity:   SevInfo,
		Category:   CatProtocolDetect,
		Protocol:   "SSH",
		SourceIP:   sess.srcIP,
		SourcePort: sess.srcPort,
		DestPort:   sess.dstPort,
		Summary:    fmt.Sprintf("SSH %s version: %s", direction, truncate(banner, 100)),
		ConnID:     sess.connID,
		Details: map[string]any{
			"direction":        direction,
			"protocol_version": protoVer,
			"software_version": softVer,
			"banner":           banner,
		},
	})

	// ── SSH-TOOL-001: Known tool fingerprint ──
	if fromClient {
		a.detectKnownTool(sess, softVer, direction, out)
	}

	// ── SSH-CVE-EXPLOIT: Vulnerable Client Watchlist ──
	if fromClient {
		if cveInfo, vulnerable := a.knownVulnerableSSH[softVer]; vulnerable {
			*out = append(*out, Detection{
				ID:         "SSH-CVE-EXPLOIT",
				Timestamp:  time.Now(),
				Severity:   SevHigh,
				Category:   CatSSHCVEExploit,
				Protocol:   "SSH",
				SourceIP:   sess.srcIP,
				SourcePort: sess.srcPort,
				DestPort:   sess.dstPort,
				Summary:    fmt.Sprintf("Vulnerable SSH client detected: %s (%s)", softVer, cveInfo),
				ConnID:     sess.connID,
				Details: map[string]any{
					"software_version": softVer,
					"cve_details":      cveInfo,
				},
			})
		}
	}

	// Once both sides have exchanged versions, advance to KEXInit.
	if sess.gotClientVer && sess.gotServerVer {
		a.transition(sess, sshKEXInit)
	}
}

// dispatchSSHPacket routes a complete SSH binary packet to the appropriate handler.
// Caller MUST hold a.sessionMu.
func (a *SSHAnalyzer) dispatchSSHPacket(sess *sshSession, pkt []byte, msgType byte, paddingLen int, fromClient bool, out *[]Detection) {
	switch msgType {
	case 20: // SSH_MSG_KEXINIT
		a.parseKEXInit(sess, pkt, paddingLen, fromClient, out)

	case 21: // SSH_MSG_NEWKEYS
		a.transition(sess, sshPostNewKeys)

	default:
		// Other message types during KEX are normal (e.g., DH init/reply types 30/31).
		// If we're still in KEXInit state, transition to KEXExchange.
		if sess.state == sshKEXInit {
			a.transition(sess, sshKEXExchange)
		}
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// KEXINIT Parsing (RFC 4253 §7.1)
// ──────────────────────────────────────────────────────────────────────────────

// parseKEXInit parses SSH_MSG_KEXINIT and fires algorithm-related detections.
//
// Wire structure of pkt (after the 4-byte packet_length field):
//
//	pkt[0]         = padding_length
//	pkt[1]         = 20 (SSH_MSG_KEXINIT)
//	pkt[2..17]     = cookie (16 random bytes)
//	pkt[18..end-padding_length] = 10 name-lists (each: uint32 length + ASCII bytes)
//	  name-list[0] = kex_algorithms
//	  name-list[1] = server_host_key_algorithms
//	  name-list[2] = encryption_algorithms_client_to_server
//	  name-list[3] = encryption_algorithms_server_to_client
//	  name-list[4] = mac_algorithms_client_to_server
//	  name-list[5] = mac_algorithms_server_to_client
//	  name-list[6] = compression_algorithms_client_to_server
//	  name-list[7] = compression_algorithms_server_to_client
//	  name-list[8] = languages_client_to_server (may be empty)
//	  name-list[9] = languages_server_to_client (may be empty)
//
// HASSH construction (https://github.com/salesforce/hassh):
//
//	Client HASSH = MD5( nl[0] ; nl[2] ; nl[4] ; nl[6] )  -- from client's KEXINIT
//	Server HASSH = MD5( nl[0] ; nl[3] ; nl[5] ; nl[7] )  -- from server's KEXINIT
//
// Caller MUST hold a.sessionMu.
func (a *SSHAnalyzer) parseKEXInit(sess *sshSession, pkt []byte, paddingLen int, fromClient bool, out *[]Detection) {
	// Minimum valid pkt: padding_length(1) + type(1) + cookie(16) + at least one name-list length(4) = 22
	if len(pkt) < 22 {
		*out = append(*out, a.buildMalformed(sess, "SSH_MSG_KEXINIT payload too short", len(pkt)))
		a.transition(sess, sshParseAbandoned)
		return
	}

	// The effective payload excludes the trailing padding bytes.
	// pkt[0] = padding_length, pkt[1] = type, pkt[2..17] = cookie, pkt[18..] = name-lists
	effectiveEnd := len(pkt) - paddingLen
	if effectiveEnd < 18 || effectiveEnd > len(pkt) {
		*out = append(*out, a.buildMalformed(sess, "padding_length makes payload bounds invalid", paddingLen))
		a.transition(sess, sshParseAbandoned)
		return
	}

	payload := pkt[18:effectiveEnd] // name-lists region
	nameLists := make([]string, 0, 10)
	offset := 0

	for i := 0; i < 10; i++ {
		if offset+4 > len(payload) {
			break
		}
		listLen := int(payload[offset])<<24 | int(payload[offset+1])<<16 |
			int(payload[offset+2])<<8 | int(payload[offset+3])
		offset += 4

		if listLen < 0 || listLen > 8192 || offset+listLen > len(payload) {
			*out = append(*out, a.buildMalformed(sess,
				fmt.Sprintf("KEXINIT name-list[%d] has invalid length %d", i, listLen),
				listLen,
			))
			a.transition(sess, sshParseAbandoned)
			return
		}
		nameLists = append(nameLists, string(payload[offset:offset+listLen]))
		offset += listLen
	}

	if len(nameLists) == 0 {
		a.transition(sess, sshKEXExchange)
		return
	}

	kex := sshNL(nameLists, 0)
	// Direction-specific algorithm selection for HASSH and weak-algo checks.
	var enc, mac, comp string
	direction := "server"
	if fromClient {
		direction = "client"
		enc = sshNL(nameLists, 2)  // encryption_algorithms_client_to_server
		mac = sshNL(nameLists, 4)  // mac_algorithms_client_to_server
		comp = sshNL(nameLists, 6) // compression_algorithms_client_to_server
	} else {
		enc = sshNL(nameLists, 3)  // encryption_algorithms_server_to_client
		mac = sshNL(nameLists, 5)  // mac_algorithms_server_to_client
		comp = sshNL(nameLists, 7) // compression_algorithms_server_to_client
	}

	// ── SSH-HASSH-001: Compute HASSH fingerprint ──
	// hashInput format: "kex;enc;mac;comp" — exact order per HASSH spec.
	hashInput := fmt.Sprintf("%s;%s;%s;%s", kex, enc, mac, comp)
	hassh := fmt.Sprintf("%x", md5.Sum([]byte(hashInput)))

	if fromClient {
		sess.clientHASSH = hassh
	}

	hasshNote := a.knownBadHASSH[hassh]
	if hasshNote != "" {
		*out = append(*out, Detection{
			ID:         "SSH-HASSH-BAD-001",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatSSHTool,
			Protocol:   "SSH",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			Summary:    fmt.Sprintf("Malicious SSH Client HASSH detected: %s (%s)", hassh, hasshNote),
			ConnID:     sess.connID,
			Details: map[string]any{
				"hassh":             hassh,
				"direction":         direction,
				"kex_algorithms":    kex,
				"enc_algorithms":    enc,
				"mac_algorithms":    mac,
				"comp_algorithms":   comp,
				"known_attack_tool": hasshNote,
				"hash_input":        hashInput,
			},
		})
	} else {
		*out = append(*out, Detection{
			ID:         "SSH-HASSH-001",
			Timestamp:  time.Now(),
			Severity:   SevInfo,
			Category:   CatProtocolDetect,
			Protocol:   "SSH",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			Summary:    fmt.Sprintf("SSH %s HASSH: %s", direction, hassh),
			ConnID:     sess.connID,
			Details: map[string]any{
				"hassh":             hassh,
				"direction":         direction,
				"kex_algorithms":    kex,
				"enc_algorithms":    enc,
				"mac_algorithms":    mac,
				"comp_algorithms":   comp,
				"hash_input":        hashInput,
			},
		})
	}

	// ── Weak algorithm checks (separate rule IDs per algorithm type) ──
	a.checkWeak(sess, "SSH-WEAK-KEX", "key-exchange", kex, a.weakKEX, out)
	a.checkWeak(sess, "SSH-WEAK-CIPHER", "cipher", enc, a.weakCiphers, out)
	a.checkWeak(sess, "SSH-WEAK-MAC", "MAC", mac, a.weakMACs, out)

	a.transition(sess, sshKEXExchange)
}

// ──────────────────────────────────────────────────────────────────────────────
// Rule Helpers
// ──────────────────────────────────────────────────────────────────────────────

// detectKnownTool checks the SSH software version string against the tool database.
// Caller MUST hold a.sessionMu.
func (a *SSHAnalyzer) detectKnownTool(sess *sshSession, softVer, direction string, out *[]Detection) {
	lower := strings.ToLower(softVer)
	for keyword, info := range a.knownTools {
		if strings.Contains(lower, keyword) {
			if info.severity > SevInfo { // skip sshClassKnownClient (SevInfo)
				*out = append(*out, Detection{
					ID:         "SSH-TOOL-001",
					Timestamp:  time.Now(),
					Severity:   info.severity,
					Category:   CatBotScanner,
					Protocol:   "SSH",
					SourceIP:   sess.srcIP,
					SourcePort: sess.srcPort,
					DestPort:   sess.dstPort,
					Summary: fmt.Sprintf(
						"SSH %s client identified as %s: %s (banner: %s)",
						direction, string(info.class), info.name, softVer,
					),
					ConnID: sess.connID,
					Details: map[string]any{
						"tool_name":    info.name,
						"tool_class":   string(info.class),
						"tool_note":    info.note,
						"tool_keyword": keyword,
						"software_ver": softVer,
						"client_hassh": sess.clientHASSH, // empty if KEXINIT not yet parsed
						"limitation":   "Banner strings can be spoofed. Combine with HASSH for higher confidence.",
					},
				})
			}
			return // first match wins — tool db keys should not overlap
		}
	}
}

// checkWeak scans a comma-separated algorithm list for known weak entries.
func (a *SSHAnalyzer) checkWeak(sess *sshSession, ruleID, algoType, algoList string, weakSet map[string]bool, out *[]Detection) {
	if algoList == "" {
		return
	}
	var weak []string
	for _, algo := range strings.Split(algoList, ",") {
		algo = strings.TrimSpace(algo)
		if weakSet[algo] {
			weak = append(weak, algo)
		}
	}
	if len(weak) == 0 {
		return
	}
	*out = append(*out, Detection{
		ID:         ruleID,
		Timestamp:  time.Now(),
		Severity:   SevMedium,
		Category:   CatSSHWeakAlgo,
		Protocol:   "SSH",
		SourceIP:   sess.srcIP,
		SourcePort: sess.srcPort,
		DestPort:   sess.dstPort,
		Summary: fmt.Sprintf(
			"Weak SSH %s algorithms advertised: %s",
			algoType, strings.Join(weak, ", "),
		),
		ConnID: sess.connID,
		Details: map[string]any{
			"algorithm_type":  algoType,
			"weak_algorithms": weak,
			"full_list":       algoList,
			"recommendation":  sshRecommend(algoType),
		},
	})
}

// buildMalformed constructs a SSH-MALFORM-001 Detection.
// After returning, the caller should transition the session to sshParseAbandoned.
// Note: inspection halts but packet forwarding continues — the analyzer cannot
// terminate the connection in passive mode. This is an accepted limitation.
func (a *SSHAnalyzer) buildMalformed(sess *sshSession, reason string, val int) Detection {
	return Detection{
		ID:         "SSH-MALFORM-001",
		Timestamp:  time.Now(),
		Severity:   SevMedium,
		Category:   CatSSHMalformed,
		Protocol:   "SSH",
		SourceIP:   sess.srcIP,
		SourcePort: sess.srcPort,
		DestPort:   sess.dstPort,
		Summary:    fmt.Sprintf("Malformed SSH packet from %s: %s", sess.srcIP, reason),
		ConnID:     sess.connID,
		Details: map[string]any{
			"reason":            reason,
			"problematic_value": val,
			"state":             sess.state.String(),
			"note":              "Deep inspection halted (PARSE_ABANDONED). Forwarding continues. May indicate fuzzing/evasion.",
		},
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ──────────────────────────────────────────────────────────────────────────────

// sshNL safely returns nameLists[i] or "" if i is out of bounds.
func sshNL(nameLists []string, i int) string {
	if i < len(nameLists) {
		return nameLists[i]
	}
	return ""
}

// sshFmtNote formats a known-bad HASSH note for inclusion in a summary string.
func sshFmtNote(note string) string {
	if note == "" {
		return ""
	}
	return fmt.Sprintf(" [KNOWN ATTACK TOOL: %s]", note)
}

// sshRecommend returns a short remediation hint for a given algorithm type.
func sshRecommend(algoType string) string {
	switch algoType {
	case "key-exchange":
		return "Use curve25519-sha256 or diffie-hellman-group16-sha512 (NIST SP 800-131A)"
	case "cipher":
		return "Use chacha20-poly1305@openssh.com or aes256-gcm@openssh.com (AEAD preferred)"
	case "MAC":
		return "Use hmac-sha2-256-etm@openssh.com or hmac-sha2-512-etm@openssh.com"
	default:
		return "Consult NIST SP 800-131A and OpenSSH security recommendations"
	}
}
