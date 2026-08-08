// SPDX-License-Identifier: GPL-2.0
// detect/telnet_analyzer.go — Stateful Telnet protocol analyzer.
//
// ARCHITECTURE:
//   Two levels of state are maintained:
//
//   Level 1 — Per-connection (TelnetSession, keyed by ConnID):
//     Bounded TCP reassembly buffers (client/server, 64 KB max each).
//     NVT/IAC parser state including partial-sequence buffer.
//     Authentication state machine.
//     TTL-based last-activity tracking.
//
//   Level 2 — Per-source-IP (TelnetSourceState, keyed by srcIP):
//     Cross-connection brute-force sliding window.
//     Password-spray tracking (same passFingerprint → multiple usernames).
//     Credential-stuffing tracking (unique user/pass pairs).
//     Scan detection (short connections without authentication).
//
// AUTHENTICATION STATE MACHINE:
//   INITIAL → BANNER_RECEIVED → AWAITING_USERNAME → GOT_USERNAME →
//   AWAITING_PASSWORD → GOT_PASSWORD → AUTHENTICATED / AUTH_FAILED
//
//   UNKNOWN is the initial state when inspection starts mid-session.
//
// NVT IAC PARSER:
//   Correctly handles: WILL/WONT/DO/DONT/SB/SE/escaped-IAC/partial sequences.
//   Malformed sequences stop deep inspection (TELNET-NVT-MALFORM-001) but
//   do NOT terminate the proxy connection.
//
// SECURITY:
//   Plaintext passwords are never stored or emitted. Only username,
//   password_present (bool), and a truncated SHA-256 credential fingerprint
//   are tracked. DetectionEvent.Details never include password values.
//
// TRACK 2 PLACEHOLDER:
//   Command/behavioral detection (TELNET-CMD-001 et al.) is not implemented
//   here. The command line buffer is maintained for NOLOGIN/SCAN heuristics only.
//
// RFC REFERENCES: RFC 854 (Telnet Protocol), RFC 855 (Telnet Option Spec)

package detect

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"sync"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Constants and configuration
// ─────────────────────────────────────────────────────────────────────────────

const (
	// Telnet NVT command bytes (RFC 854)
	telnetIAC  = 0xFF // Interpret As Command
	telnetDONT = 0xFE // You must stop using option
	telnetDO   = 0xFD // Please use option
	telnetWONT = 0xFC // I will stop using option
	telnetWILL = 0xFB // I will use option
	telnetSB   = 0xFA // Subnegotiation Begin
	telnetGA   = 0xF9 // Go Ahead
	telnetEL   = 0xF8 // Erase Line
	telnetEC   = 0xF7 // Erase Character
	telnetAYT  = 0xF6 // Are You There
	telnetAO   = 0xF5 // Abort Output
	telnetIP   = 0xF4 // Interrupt Process
	telnetBRK  = 0xF3 // Break
	telnetDM   = 0xF2 // Data Mark
	telnetNOP  = 0xF1 // No Operation
	telnetSE   = 0xF0 // Subnegotiation End

	// Reassembly buffer limits
	telnetMaxBufPerDir = 64 * 1024 // 64 KB per direction

	// SB payload limit — oversized triggers NVT-ANOMALY-001
	telnetMaxSBPayload = 1024

	// Excessive IAC negotiation threshold — triggers NVT-ANOMALY-001
	telnetMaxIACPerSession = 50

	// Session TTL for cleanup
	telnetSessionTTL = 5 * time.Minute

	// Brute-force detection defaults
	telnetBruteWindow    = 60 * time.Second
	telnetBruteThreshold = 5

	// Password-spray detection: same passFingerprint, N distinct usernames
	telnetSprayWindow    = 60 * time.Second
	telnetSprayThreshold = 3

	// Credential stuffing: N unique (user, passHash) pairs from same srcIP
	telnetCredStuffWindow    = 60 * time.Second
	telnetCredStuffThreshold = 5

	// Scan detection: short connection = ≤3s; N in window
	telnetScanShortDuration = 3 * time.Second
	telnetScanWindow        = 60 * time.Second
	telnetScanThreshold     = 3
)

// ─────────────────────────────────────────────────────────────────────────────
// Authentication state machine
// ─────────────────────────────────────────────────────────────────────────────

type telnetAuthState int

const (
	telnetAuthUnknown          telnetAuthState = iota // mid-session start
	telnetAuthInitial                                 // connection established, no banner yet
	telnetAuthBannerReceived                          // server sent banner/NVT opts
	telnetAuthAwaitingUsername                        // server sent "login:" prompt
	telnetAuthGotUsername                             // client sent username line
	telnetAuthAwaitingPassword                        // server sent "Password:" prompt
	telnetAuthGotPassword                             // client sent password line
	telnetAuthAuthenticated                           // shell prompt received
	telnetAuthFailed                                  // failure indicator received
)

// ─────────────────────────────────────────────────────────────────────────────
// NVT IAC parser state
// ─────────────────────────────────────────────────────────────────────────────

type nvtParseState int

const (
	nvtStateData    nvtParseState = iota // normal data
	nvtStateIAC                         // saw 0xFF, awaiting command byte
	nvtStateOption                      // saw WILL/WONT/DO/DONT, awaiting option byte
	nvtStateSB                          // inside subnegotiation
	nvtStateSBIAC                       // inside SB, saw 0xFF (check for SE)
)

// ─────────────────────────────────────────────────────────────────────────────
// Per-connection session state (Level 1)
// ─────────────────────────────────────────────────────────────────────────────

type TelnetSession struct {
	connID   string
	srcIP    string
	srcPort  uint16
	dstPort  uint16
	startTime time.Time
	lastActivity time.Time

	// TCP reassembly buffers (client→server, server→client)
	clientBuf []byte
	serverBuf []byte

	// NVT parser state (shared; direction tracked by which buffer we process)
	nvtState   nvtParseState
	nvtOptByte byte    // pending option byte for WILL/WONT/DO/DONT
	sbPayload  []byte  // accumulating SB payload
	iacCount   int     // total IAC sequences seen (for anomaly detection)
	malformed  bool    // if true, deep inspection is stopped

	// Auth state machine
	authState     telnetAuthState
	username      string
	passPresent   bool
	passFingerprint string // SHA-256[:16] of "username:password"
	passOnlyFP      string // SHA-256[:16] of "password"
	authResult    string   // "success", "failed", ""
	serverLineBuf string   // accumulates server text for prompt matching

	// Shell/command line buffer (bounded; Track 2 uses for cmd detection)
	cmdBuf    string
	cmdBufLen int

	// TELNET-NOLOGIN-001: did we see shell without auth exchange?
	shellBeforeAuth bool

	// TELNET-PLAINTEXT-001 emitted flag (emit once per connection)
	plaintextEmitted bool
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-source-IP cross-connection state (Level 2)
// ─────────────────────────────────────────────────────────────────────────────

type credPairKey struct {
	username     string
	passFingerprint string
}

type TelnetSourceState struct {
	// Brute-force: timestamp of each failed login
	failedLogins []time.Time

	// Password spray: passFingerprint → set of distinct usernames seen
	sprayPassFP    string
	sprayUsernames map[string]struct{}
	sprayTimes     []time.Time

	// Credential stuffing: set of unique (user, passHash) pairs
	credPairs      map[credPairKey]struct{}
	credPairTimes  []time.Time

	// Whether a success has been recorded after prior failures
	hadPriorFailures bool
	bruteSuccessEmitted bool

	// Scan: list of connection start times where conn was "short"
	shortConns []time.Time

	lastActivity time.Time
}

// ─────────────────────────────────────────────────────────────────────────────
// TelnetAnalyzer
// ─────────────────────────────────────────────────────────────────────────────

// TelnetAnalyzer inspects Telnet connections for security-relevant patterns.
type TelnetAnalyzer struct {
	bus *DetectionBus

	mu       sync.Mutex
	sessions map[string]*TelnetSession      // keyed by ConnID
	sources  map[string]*TelnetSourceState  // keyed by srcIP
}

// NewTelnetAnalyzer creates and starts the Telnet analyzer.
func NewTelnetAnalyzer(bus *DetectionBus) *TelnetAnalyzer {
	a := &TelnetAnalyzer{
		bus:      bus,
		sessions: make(map[string]*TelnetSession),
		sources:  make(map[string]*TelnetSourceState),
	}
	go a.cleanupRoutine()
	return a
}

func (a *TelnetAnalyzer) cleanupRoutine() {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		a.cleanup()
	}
}

func (a *TelnetAnalyzer) cleanup() {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()

	for id, sess := range a.sessions {
		if now.Sub(sess.lastActivity) > telnetSessionTTL {
			delete(a.sessions, id)
		}
	}
	for ip, src := range a.sources {
		if now.Sub(src.lastActivity) > telnetSessionTTL {
			delete(a.sources, ip)
		}
	}
}

// OnClose is called when a TCP connection terminates.
func (a *TelnetAnalyzer) OnClose(connID string) {
	a.mu.Lock()
	sess, ok := a.sessions[connID]
	if ok {
		delete(a.sessions, connID)
	}
	a.mu.Unlock()

	if !ok || sess == nil {
		return
	}

	// Contribute to scan detection: was this a short connection with no auth?
	connDuration := time.Since(sess.startTime)
	if connDuration <= telnetScanShortDuration && sess.authState != telnetAuthAuthenticated {
		a.mu.Lock()
		src := a.getOrCreateSource(sess.srcIP)
		now := time.Now()
		src.shortConns = trimTimes(src.shortConns, now, telnetScanWindow)
		src.shortConns = append(src.shortConns, now)
		count := len(src.shortConns)
		src.lastActivity = now
		a.mu.Unlock()

		if count >= telnetScanThreshold {
			a.bus.EmitDetection(Detection{
				ID:         "TELNET-SCAN-001",
				Timestamp:  time.Now(),
				Severity:   SevMedium,
				Category:   CatTelnetScan,
				Protocol:   "Telnet",
				SourceIP:   sess.srcIP,
				SourcePort: sess.srcPort,
				DestPort:   sess.dstPort,
				ConnID:     connID,
				Summary: fmt.Sprintf("Telnet scan detected: %d short connections without auth from %s in %s",
					count, sess.srcIP, telnetScanWindow),
				Details: map[string]any{
					"short_conn_count": count,
					"window":           telnetScanWindow.String(),
					"threshold_secs":   telnetScanShortDuration.Seconds(),
				},
			})
			a.mu.Lock()
			src.shortConns = nil // reset after alert
			a.mu.Unlock()
		}
	}
}

// getOrCreateSource returns or creates the per-srcIP state. Caller must hold mu.
func (a *TelnetAnalyzer) getOrCreateSource(srcIP string) *TelnetSourceState {
	src, ok := a.sources[srcIP]
	if !ok {
		src = &TelnetSourceState{
			sprayUsernames: make(map[string]struct{}),
			credPairs:      make(map[credPairKey]struct{}),
		}
		a.sources[srcIP] = src
	}
	return src
}

// getOrCreateSession returns or creates the per-ConnID state. Caller must hold mu.
func (a *TelnetAnalyzer) getOrCreateSession(connID, srcIP string, srcPort, dstPort uint16) *TelnetSession {
	sess, ok := a.sessions[connID]
	if !ok {
		sess = &TelnetSession{
			connID:    connID,
			srcIP:     srcIP,
			srcPort:   srcPort,
			dstPort:   dstPort,
			startTime: time.Now(),
			authState: telnetAuthInitial,
		}
		a.sessions[connID] = sess
	}
	sess.lastActivity = time.Now()
	return sess
}

// ─────────────────────────────────────────────────────────────────────────────
// Analyze — main entry point
// ─────────────────────────────────────────────────────────────────────────────

// Analyze processes a chunk of Telnet stream data.
func (a *TelnetAnalyzer) Analyze(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) == 0 {
		return
	}

	a.mu.Lock()
	sess := a.getOrCreateSession(connID, srcIP, srcPort, dstPort)

	// Enforce per-direction buffer limits
	if fromClient {
		if len(sess.clientBuf)+len(data) > telnetMaxBufPerDir {
			sess.clientBuf = nil // reset on overflow
		}
		sess.clientBuf = append(sess.clientBuf, data...)
	} else {
		if len(sess.serverBuf)+len(data) > telnetMaxBufPerDir {
			sess.serverBuf = nil
		}
		sess.serverBuf = append(sess.serverBuf, data...)
	}

	// Emit TELNET-PLAINTEXT-001 once per connection
	if !sess.plaintextEmitted {
		sess.plaintextEmitted = true
		a.mu.Unlock()
		a.bus.EmitDetection(Detection{
			ID:         "TELNET-PLAINTEXT-001",
			Timestamp:  time.Now(),
			Severity:   SevMedium,
			Category:   CatCredentialLeak,
			Protocol:   "Telnet",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			ConnID:     connID,
			Summary:    fmt.Sprintf("Telnet connection from %s — all traffic transmitted in plaintext", srcIP),
			Details: map[string]any{
				"note": "Telnet provides no encryption. Use SSH instead.",
			},
		})
		a.mu.Lock()
	}

	// If malformed NVT stopped deep inspection, skip further parsing
	if sess.malformed {
		a.mu.Unlock()
		return
	}

	// Strip NVT IAC sequences and extract plaintext payload
	plaintext := a.stripNVT(sess, data, fromClient)

	// Run auth state machine on the plaintext
	a.processAuthState(sess, plaintext, fromClient)

	a.mu.Unlock()
}

// ─────────────────────────────────────────────────────────────────────────────
// NVT / IAC parser
// ─────────────────────────────────────────────────────────────────────────────

// stripNVT processes raw bytes through the NVT state machine, returning
// plaintext with IAC sequences removed. Partial IAC sequences are buffered
// in sess.nvtState across calls. Caller must hold mu.
func (a *TelnetAnalyzer) stripNVT(sess *TelnetSession, data []byte, fromClient bool) []byte {
	out := make([]byte, 0, len(data))
	connID := sess.connID
	srcIP := sess.srcIP

	for i := 0; i < len(data); i++ {
		b := data[i]

		switch sess.nvtState {
		case nvtStateData:
			if b == telnetIAC {
				sess.nvtState = nvtStateIAC
			} else {
				out = append(out, b)
			}

		case nvtStateIAC:
			switch b {
			case telnetIAC:
				// Escaped IAC — literal 0xFF in data
				out = append(out, 0xFF)
				sess.nvtState = nvtStateData
			case telnetWILL, telnetWONT, telnetDO, telnetDONT:
				sess.nvtOptByte = b
				sess.nvtState = nvtStateOption
				sess.iacCount++
				a.checkIACAnomaly(sess, connID, srcIP)
			case telnetSB:
				sess.sbPayload = sess.sbPayload[:0]
				sess.nvtState = nvtStateSB
				sess.iacCount++
				a.checkIACAnomaly(sess, connID, srcIP)
			case telnetSE:
				// SE without SB — malformed
				if !sess.malformed {
					sess.malformed = true
					a.mu.Unlock()
					a.emitNVTMalform(connID, srcIP, sess.srcPort, sess.dstPort, "SE without preceding SB")
					a.mu.Lock()
				}
				sess.nvtState = nvtStateData
			case telnetGA, telnetEL, telnetEC, telnetAYT, telnetAO,
				telnetIP, telnetBRK, telnetDM, telnetNOP:
				// Single-byte commands — consume and continue
				sess.iacCount++
				a.checkIACAnomaly(sess, connID, srcIP)
				sess.nvtState = nvtStateData
			default:
				// Unknown command byte — malformed
				if !sess.malformed {
					sess.malformed = true
					a.mu.Unlock()
					a.emitNVTMalform(connID, srcIP, sess.srcPort, sess.dstPort,
						fmt.Sprintf("unknown IAC command byte: 0x%02X", b))
					a.mu.Lock()
				}
				sess.nvtState = nvtStateData
			}

		case nvtStateOption:
			// Option byte for WILL/WONT/DO/DONT — consume and return to data
			_ = b // option byte; could log for audit
			sess.nvtState = nvtStateData

		case nvtStateSB:
			if b == telnetIAC {
				sess.nvtState = nvtStateSBIAC
			} else {
				if len(sess.sbPayload) < telnetMaxSBPayload {
					sess.sbPayload = append(sess.sbPayload, b)
				} else {
					// Oversized subnegotiation
					if !sess.malformed {
						a.mu.Unlock()
						a.emitNVTAnomaly(connID, srcIP, sess.srcPort, sess.dstPort,
							fmt.Sprintf("SB payload exceeds %d bytes", telnetMaxSBPayload))
						a.mu.Lock()
					}
					// Drain until SE
				}
			}

		case nvtStateSBIAC:
			if b == telnetSE {
				// SB complete — discard payload (used for option negotiation, not attack content)
				sess.sbPayload = sess.sbPayload[:0]
				sess.nvtState = nvtStateData
			} else if b == telnetIAC {
				// Escaped IAC inside SB
				sess.sbPayload = append(sess.sbPayload, 0xFF)
				sess.nvtState = nvtStateSB
			} else {
				// Invalid: IAC not followed by SE inside SB — malformed
				if !sess.malformed {
					sess.malformed = true
					a.mu.Unlock()
					a.emitNVTMalform(connID, srcIP, sess.srcPort, sess.dstPort,
						"invalid byte after IAC inside SB")
					a.mu.Lock()
				}
				sess.nvtState = nvtStateData
			}
		}
	}

	return out
}

func (a *TelnetAnalyzer) checkIACAnomaly(sess *TelnetSession, connID, srcIP string) {
	if sess.iacCount == telnetMaxIACPerSession {
		a.mu.Unlock()
		a.emitNVTAnomaly(connID, srcIP, sess.srcPort, sess.dstPort,
			fmt.Sprintf("excessive IAC negotiation: %d sequences", sess.iacCount))
		a.mu.Lock()
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication state machine
// ─────────────────────────────────────────────────────────────────────────────

// loginPromptPatterns are server-side patterns indicating "enter username".
var loginPromptPatterns = []string{
	"login:", "Login:", "LOGIN:",
	"Username:", "username:", "USER:",
	"user:", "User name:", "User Name:",
}

// passwordPromptPatterns are server-side patterns indicating "enter password".
var passwordPromptPatterns = []string{
	"Password:", "password:", "PASSWORD:",
	"Pass:", "Passwd:", "passwd:",
}

// authFailureIndicators is a controlled set of server-side failure messages.
var authFailureIndicators = []string{
	"Login incorrect",
	"Login failed",
	"Authentication failed",
	"Invalid password",
	"Access denied",
	"Permission denied",
	"Bad password",
	"Incorrect password",
	"authentication failure",
	"Login invalid",
	"password failure",
}

// shellPromptPatterns are contextual shell-prompt patterns (not just $/#/>).
// These require some surrounding context: username/hostname prefix.
var shellPromptPatterns = []string{
	"@", // hostname context: "root@host:~#" or "admin@router>"
	"$ ", "# ", "> ",      // with trailing space (less ambiguous)
	"~# ", "~$ ",          // bash-style
	":~#", ":~$",          // with colon prefix
	"/ # ", "/ $ ",        // root shell path
	"# \r", "$ \r", "> \r", // with CR (common in Telnet)
}

// processAuthState advances the authentication state machine.
// Caller must hold mu.
func (a *TelnetAnalyzer) processAuthState(sess *TelnetSession, text []byte, fromClient bool) {
	if len(text) == 0 || sess.malformed {
		return
	}

	s := string(text)
	connID := sess.connID

	if !fromClient {
		// ── Server → Client ────────────────────────────────────────────────
		sess.serverLineBuf += s
		if len(sess.serverLineBuf) > 1024 {
			sess.serverLineBuf = sess.serverLineBuf[len(sess.serverLineBuf)-1024:]
		}
		s = sess.serverLineBuf

		switch sess.authState {
		case telnetAuthInitial, telnetAuthUnknown:
			// Any server data indicates a banner
			sess.authState = telnetAuthBannerReceived
			fallthrough
		case telnetAuthBannerReceived, telnetAuthAuthenticated:
			// Check for login prompt
			if containsAny(s, loginPromptPatterns) {
				sess.authState = telnetAuthAwaitingUsername
				sess.serverLineBuf = ""
			}
			// Check for auth failure (could arrive after GOT_PASSWORD)
			if containsAny(s, authFailureIndicators) && sess.authState == telnetAuthAuthenticated {
				sess.authState = telnetAuthFailed
				sess.authResult = "failed"
				sess.serverLineBuf = ""
			}
		case telnetAuthGotUsername:
			if containsAny(s, passwordPromptPatterns) {
				sess.authState = telnetAuthAwaitingPassword
				sess.serverLineBuf = ""
			} else if containsAny(s, loginPromptPatterns) {
				// Re-prompt — treat as failure (no password step)
				sess.authState = telnetAuthFailed
				sess.authResult = "failed"
				sess.serverLineBuf = ""
				a.mu.Unlock()
				a.handleAuthFailure(sess, connID)
				a.mu.Lock()
			}
		case telnetAuthGotPassword:
			if containsAny(s, authFailureIndicators) {
				sess.authState = telnetAuthFailed
				sess.authResult = "failed"
				sess.serverLineBuf = ""
				a.mu.Unlock()
				a.handleAuthFailure(sess, connID)
				a.mu.Lock()
			} else if isShellPrompt(s) {
				sess.authState = telnetAuthAuthenticated
				sess.authResult = "success"
				sess.serverLineBuf = ""
				a.mu.Unlock()
				a.handleAuthSuccess(sess, connID)
				a.mu.Lock()
			}
		}

		// Shell prompt check for all states — NOLOGIN detection
		if isShellPrompt(s) &&
			sess.authState != telnetAuthAuthenticated &&
			sess.authState != telnetAuthAwaitingUsername &&
			sess.authState != telnetAuthGotUsername &&
			sess.authState != telnetAuthAwaitingPassword &&
			sess.authState != telnetAuthGotPassword {
			sess.shellBeforeAuth = true
			sess.authState = telnetAuthAuthenticated
			sess.serverLineBuf = ""
			a.mu.Unlock()
			a.bus.EmitDetection(Detection{
				ID:         "TELNET-NOLOGIN-001",
				Timestamp:  time.Now(),
				Severity:   SevMedium,
				Category:   CatUnauthAccess,
				Protocol:   "Telnet",
				SourceIP:   sess.srcIP,
				SourcePort: sess.srcPort,
				DestPort:   sess.dstPort,
				ConnID:     connID,
				Summary: fmt.Sprintf("Telnet shell prompt observed without authentication exchange from %s",
					sess.srcIP),
			})
			a.mu.Lock()
		}

	} else {
		// ── Client → Server ────────────────────────────────────────────────
		line := strings.TrimRight(s, "\r\n")

		switch sess.authState {
		case telnetAuthAwaitingUsername:
			if line != "" {
				sess.username = line
				sess.authState = telnetAuthGotUsername
			}
		case telnetAuthAwaitingPassword:
			// Never store the password
			sess.passPresent = line != ""
			if sess.username != "" {
				sess.passFingerprint = credFingerprint(sess.username, line)
			}
			sess.passOnlyFP = passOnlyFingerprint(line)
			sess.authState = telnetAuthGotPassword
		}
	}
}

// handleAuthSuccess runs checks when a successful login is observed.
func (a *TelnetAnalyzer) handleAuthSuccess(sess *TelnetSession, connID string) {
	// TELNET-AUTH-001: emit cred summary (no password)
	details := map[string]any{
		"username":          sess.username,
		"password_present":  sess.passPresent,
		"cred_fingerprint":  sess.passFingerprint,
	}
	a.bus.EmitDetection(Detection{
		ID:         "TELNET-AUTH-001",
		Timestamp:  time.Now(),
		Severity:   SevHigh,
		Category:   CatCredentialLeak,
		Protocol:   "Telnet",
		SourceIP:   sess.srcIP,
		SourcePort: sess.srcPort,
		DestPort:   sess.dstPort,
		ConnID:     connID,
		Summary: fmt.Sprintf("Telnet credentials observed in plaintext: user=%q from %s",
			sess.username, sess.srcIP),
		Details: details,
	})

	// TELNET-ANON-001: empty username or empty password
	if sess.username == "" || !sess.passPresent ||
		strings.EqualFold(sess.username, "anonymous") {
		a.bus.EmitDetection(Detection{
			ID:         "TELNET-ANON-001",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatAnonLogin,
			Protocol:   "Telnet",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			ConnID:     connID,
			Summary: fmt.Sprintf("Telnet anonymous/empty-credential login from %s (user=%q)",
				sess.srcIP, sess.username),
		})
	}

	// Default credential matching
	a.checkDefaultCreds(sess, connID)

	// TELNET-BRUTE-SUCCESS-001: success after prior failures from this srcIP
	a.mu.Lock()
	src := a.getOrCreateSource(sess.srcIP)
	if src.hadPriorFailures && !src.bruteSuccessEmitted {
		src.bruteSuccessEmitted = true
		a.mu.Unlock()
		a.bus.EmitDetection(Detection{
			ID:         "TELNET-BRUTE-SUCCESS-001",
			Timestamp:  time.Now(),
			Severity:   SevCritical,
			Category:   CatBruteForce,
			Protocol:   "Telnet",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			ConnID:     connID,
			Summary: fmt.Sprintf("Telnet brute-force success: authentication succeeded after prior failures from %s (user=%q)",
				sess.srcIP, sess.username),
			Details: map[string]any{
				"username":         sess.username,
				"password_present": sess.passPresent,
				"cred_fingerprint": sess.passFingerprint,
			},
		})
	} else {
		a.mu.Unlock()
	}

	// Track for credential stuffing
	a.mu.Lock()
	src = a.getOrCreateSource(sess.srcIP)
	a.recordCredPair(src, sess.username, sess.passFingerprint)
	src.lastActivity = time.Now()
	a.mu.Unlock()
}

// handleAuthFailure runs checks when a failed login is observed.
func (a *TelnetAnalyzer) handleAuthFailure(sess *TelnetSession, connID string) {
	now := time.Now()

	a.mu.Lock()
	src := a.getOrCreateSource(sess.srcIP)

	// Trim stale failures inline
	src.failedLogins = trimTimes(src.failedLogins, now, telnetBruteWindow)
	src.failedLogins = append(src.failedLogins, now)
	failCount := len(src.failedLogins)
	src.hadPriorFailures = true
	src.lastActivity = now

	// Password spray: track passOnlyFP → usernames
	if sess.passPresent && sess.passOnlyFP != "" {
		if src.sprayPassFP == "" || src.sprayPassFP == sess.passOnlyFP {
			src.sprayPassFP = sess.passOnlyFP
			src.sprayTimes = trimTimes(src.sprayTimes, now, telnetSprayWindow)
			src.sprayTimes = append(src.sprayTimes, now)
			src.sprayUsernames[sess.username] = struct{}{}
		} else {
			// Different password fingerprint — reset spray tracking
			src.sprayPassFP = sess.passOnlyFP
			src.sprayUsernames = map[string]struct{}{sess.username: {}}
			src.sprayTimes = []time.Time{now}
		}
	}
	sprayCount := len(src.sprayUsernames)

	// Credential stuffing
	a.recordCredPair(src, sess.username, sess.passFingerprint)
	src.credPairTimes = trimTimes(src.credPairTimes, now, telnetCredStuffWindow)
	credPairCount := len(src.credPairs)

	a.mu.Unlock()

	// TELNET-BRUTE-001
	if failCount >= telnetBruteThreshold {
		a.bus.EmitDetection(Detection{
			ID:         "TELNET-BRUTE-001",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatBruteForce,
			Protocol:   "Telnet",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			ConnID:     connID,
			Summary: fmt.Sprintf("Telnet brute-force: %d failed logins in %s from %s",
				failCount, telnetBruteWindow, sess.srcIP),
			Details: map[string]any{
				"failure_count": failCount,
				"window":        telnetBruteWindow.String(),
				"username":      sess.username,
			},
		})
		a.mu.Lock()
		src = a.getOrCreateSource(sess.srcIP)
		src.failedLogins = nil // reset after alert
		a.mu.Unlock()
	}

	// TELNET-SPRAY-001
	if sprayCount >= telnetSprayThreshold {
		a.bus.EmitDetection(Detection{
			ID:         "TELNET-SPRAY-001",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatPwdSpray,
			Protocol:   "Telnet",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			ConnID:     connID,
			Summary: fmt.Sprintf("Telnet password spray: same credential fingerprint used against %d usernames from %s",
				sprayCount, sess.srcIP),
			Details: map[string]any{
				"distinct_usernames": sprayCount,
				"cred_fingerprint":   sess.passFingerprint,
				"window":             telnetSprayWindow.String(),
			},
		})
		a.mu.Lock()
		src = a.getOrCreateSource(sess.srcIP)
		src.sprayUsernames = make(map[string]struct{})
		src.sprayTimes = nil
		a.mu.Unlock()
	}

	// TELNET-CREDSTUFF-001
	if credPairCount >= telnetCredStuffThreshold {
		a.bus.EmitDetection(Detection{
			ID:         "TELNET-CREDSTUFF-001",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatCredStuff,
			Protocol:   "Telnet",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			ConnID:     connID,
			Summary: fmt.Sprintf("Telnet credential stuffing: %d unique credential pairs from %s in %s",
				credPairCount, sess.srcIP, telnetCredStuffWindow),
			Details: map[string]any{
				"unique_pairs": credPairCount,
				"window":       telnetCredStuffWindow.String(),
			},
		})
		a.mu.Lock()
		src = a.getOrCreateSource(sess.srcIP)
		src.credPairs = make(map[credPairKey]struct{})
		src.credPairTimes = nil
		a.mu.Unlock()
	}
}

// checkDefaultCreds matches captured credentials against the defaults database.
func (a *TelnetAnalyzer) checkDefaultCreds(sess *TelnetSession, connID string) {
	if sess.username == "" || !sess.passPresent {
		return
	}
	fp := sess.passFingerprint

	for _, entry := range TelnetDefaultCredDB {
		if strings.EqualFold(entry.Username, sess.username) && entry.PassHash == fp {
			// Default credential match
			a.bus.EmitDetection(Detection{
				ID:         "TELNET-DEFAULT-CRED-001",
				Timestamp:  time.Now(),
				Severity:   SevHigh,
				Category:   CatCredentialLeak,
				Protocol:   "Telnet",
				SourceIP:   sess.srcIP,
				SourcePort: sess.srcPort,
				DestPort:   sess.dstPort,
				ConnID:     connID,
				Summary: fmt.Sprintf("Telnet default credential used: user=%q vendor=%s device=%s from %s",
					sess.username, entry.Vendor, entry.DeviceType, sess.srcIP),
				Details: map[string]any{
					"username":         sess.username,
					"password_present": true,
					"cred_fingerprint": fp,
					"vendor":           entry.Vendor,
					"device_type":      entry.DeviceType,
					"db_version":       telnetDefaultsVersion,
				},
			})

			// IoT botnet match (Mirai, etc.)
			if telnetMiraiTags[entry.BotnetTag] {
				a.bus.EmitDetection(Detection{
					ID:         "TELNET-IOT-001",
					Timestamp:  time.Now(),
					Severity:   SevCritical,
					Category:   CatTelnetIoT,
					Protocol:   "Telnet",
					SourceIP:   sess.srcIP,
					SourcePort: sess.srcPort,
					DestPort:   sess.dstPort,
					ConnID:     connID,
					Summary: fmt.Sprintf("Telnet IoT botnet credential (tag=%q) used: user=%q from %s",
						entry.BotnetTag, sess.username, sess.srcIP),
					Details: map[string]any{
						"username":         sess.username,
						"password_present": true,
						"cred_fingerprint": fp,
						"botnet_tag":       entry.BotnetTag,
						"vendor":           entry.Vendor,
						"device_type":      entry.DeviceType,
					},
				})
			}
			return // match found, no need to continue
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// NVT anomaly/malform emitters
// ─────────────────────────────────────────────────────────────────────────────

func (a *TelnetAnalyzer) emitNVTMalform(connID, srcIP string, srcPort, dstPort uint16, msg string) {
	a.bus.EmitDetection(Detection{
		ID:         "TELNET-NVT-MALFORM-001",
		Timestamp:  time.Now(),
		Severity:   SevHigh,
		Category:   CatMalformed,
		Protocol:   "Telnet",
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		ConnID:     connID,
		Summary:    fmt.Sprintf("Malformed Telnet NVT sequence: %s", msg),
		Details:    map[string]any{"detail": msg},
	})
}

func (a *TelnetAnalyzer) emitNVTAnomaly(connID, srcIP string, srcPort, dstPort uint16, msg string) {
	a.bus.EmitDetection(Detection{
		ID:         "TELNET-NVT-ANOMALY-001",
		Timestamp:  time.Now(),
		Severity:   SevMedium,
		Category:   CatProtoMismatch,
		Protocol:   "Telnet",
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		ConnID:     connID,
		Summary:    fmt.Sprintf("Telnet NVT anomaly: %s", msg),
		Details:    map[string]any{"detail": msg},
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// credFingerprint returns a truncated SHA-256 hash of "username:password".
// The password is never stored or emitted.
func credFingerprint(username, password string) string {
	h := sha256.Sum256([]byte(username + ":" + password))
	const hex = "0123456789abcdef"
	out := make([]byte, 16)
	for i := 0; i < 8; i++ {
		out[2*i] = hex[h[i]>>4]
		out[2*i+1] = hex[h[i]&0xF]
	}
	return string(out)
}

// passOnlyFingerprint returns a truncated SHA-256 hash of the password alone.
// Used for password spray detection where the username varies.
func passOnlyFingerprint(password string) string {
	h := sha256.Sum256([]byte(password))
	const hex = "0123456789abcdef"
	out := make([]byte, 16)
	for i := 0; i < 8; i++ {
		out[2*i] = hex[h[i]>>4]
		out[2*i+1] = hex[h[i]&0xF]
	}
	return string(out)
}

// containsAny returns true if s contains any of the patterns.
func containsAny(s string, patterns []string) bool {
	for _, p := range patterns {
		if strings.Contains(s, p) {
			return true
		}
	}
	return false
}

// isShellPrompt returns true if s contains a contextual shell-prompt pattern.
// Requires some surrounding context; bare $ / # / > are insufficient.
func isShellPrompt(s string) bool {
	return containsAny(s, shellPromptPatterns)
}

// trimTimes removes entries older than window from a sorted timestamp slice.
func trimTimes(times []time.Time, now time.Time, window time.Duration) []time.Time {
	cutoff := now.Add(-window)
	for len(times) > 0 && times[0].Before(cutoff) {
		times = times[1:]
	}
	return times
}

// recordCredPair adds a unique (username, passFingerprint) pair to the source set.
// Caller must hold mu.
func (a *TelnetAnalyzer) recordCredPair(src *TelnetSourceState, username, fp string) {
	if username == "" || fp == "" {
		return
	}
	key := credPairKey{username: username, passFingerprint: fp}
	src.credPairs[key] = struct{}{}
}
