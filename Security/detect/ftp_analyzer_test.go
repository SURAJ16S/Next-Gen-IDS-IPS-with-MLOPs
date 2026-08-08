// SPDX-License-Identifier: GPL-2.0
// detect/ftp_analyzer_test.go — Comprehensive FTP/FTPS analyzer tests.
// Covers: fragmentation, coalesced messages, multiline responses, malformed
// multiline, buffer limits, auth/brute-force, PORT/PASV/EPSV, path traversal,
// dangerous commands, FTPS explicit negotiation, concurrency, TTL cleanup.

package detect

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────────────────────

// ftpSub is a simple DetectionSubscriber that collects events.
type ftpSub struct {
	mu         sync.Mutex
	detections []Detection
}

func (s *ftpSub) OnDetection(d Detection)          { s.mu.Lock(); s.detections = append(s.detections, d); s.mu.Unlock() }
func (s *ftpSub) OnConnectionClose(_ ConnectionRecord) {}

func (s *ftpSub) has(id string) bool {
	s.mu.Lock(); defer s.mu.Unlock()
	for _, d := range s.detections {
		if d.ID == id {
			return true
		}
	}
	return false
}

func (s *ftpSub) count(id string) int {
	s.mu.Lock(); defer s.mu.Unlock()
	n := 0
	for _, d := range s.detections {
		if d.ID == id {
			n++
		}
	}
	return n
}

func (s *ftpSub) reset() { s.mu.Lock(); s.detections = nil; s.mu.Unlock() }

// newFTPTest creates an analyzer with a collector subscriber.
func newFTPTest() (*FTPAnalyzer, *ftpSub) {
	bus := NewDetectionBus()
	sub := &ftpSub{}
	bus.Subscribe(sub)
	a := NewFTPAnalyzer(bus)
	return a, sub
}

// crlf appends \r\n to a FTP line.
func crlf(s string) []byte { return []byte(s + "\r\n") }

// fullHandshake sends the standard FTP greeting from server.
func serverGreet(a *FTPAnalyzer, cid string) {
	a.Analyze(cid, "10.0.0.1", "10.0.0.2", 21, 21, crlf("220 ProFTPd 1.3.6 Server ready"), false)
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 1 — TCP Reassembly
// ──────────────────────────────────────────────────────────────────────────────

func TestFTP_FragmentedCommand(t *testing.T) {
	a, sub := newFTPTest()
	cid := "frag-cmd"
	serverGreet(a, cid)

	// Split "USER admin\r\n" across 3 TCP reads
	full := []byte("USER admin\r\n")
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 12345, 21, full[:4], true)   // "USER"
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 12345, 21, full[4:9], true)  // " admi"
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 12345, 21, full[9:], true)   // "n\r\n"

	if !sub.has("FTP-USER-001") {
		t.Error("Fragmented USER command not detected")
	}
}

func TestFTP_CoalescedCommands(t *testing.T) {
	a, sub := newFTPTest()
	cid := "coalesced"
	serverGreet(a, cid)

	// Two commands coalesced in a single TCP read
	combined := []byte("USER alice\r\nPASS secret\r\n")
	a.Analyze(cid, "5.5.5.5", "10.0.0.2", 60000, 21, combined, true)

	if !sub.has("FTP-USER-001") {
		t.Error("USER not detected from coalesced read")
	}
	if !sub.has("FTP-PASS-001") {
		t.Error("PASS not detected from coalesced read")
	}
}

func TestFTP_FragmentedMultilineGreeting(t *testing.T) {
	a, sub := newFTPTest()
	cid := "ml-greet"

	// Multi-line greeting fragmented across reads
	part1 := []byte("220-Welcome to FTP server\r\n")
	part2 := []byte("220-Please read the rules\r\n")
	part3 := []byte("220 Ready.\r\n")

	a.Analyze(cid, "9.9.9.9", "10.0.0.2", 2121, 21, part1, false)
	a.Analyze(cid, "9.9.9.9", "10.0.0.2", 2121, 21, part2, false)
	a.Analyze(cid, "9.9.9.9", "10.0.0.2", 2121, 21, part3, false)

	if !sub.has("FTP-GREET-001") {
		t.Error("Multi-line greeting not detected after fragmentation")
	}
}

func TestFTP_BufferOverflowProtection(t *testing.T) {
	a, _ := newFTPTest()
	cid := "overflow"
	// Send data larger than ftpMaxBuf — must not panic or OOM
	giant := make([]byte, ftpMaxBuf*3)
	for i := range giant {
		giant[i] = 'A'
	}
	// Should not panic
	a.Analyze(cid, "1.1.1.1", "10.0.0.2", 1234, 21, giant, true)
	a.Analyze(cid, "1.1.1.1", "10.0.0.2", 1234, 21, giant, false)
}

func TestFTP_OversizedLineProtection(t *testing.T) {
	a, _ := newFTPTest()
	cid := "bigline"
	// A line that exceeds ftpMaxLineLen without \r\n
	bigline := []byte(strings.Repeat("X", ftpMaxLineLen*2))
	// Must not panic
	a.Analyze(cid, "2.2.2.2", "10.0.0.2", 2222, 21, bigline, true)
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 1 — Multiline Response Parsing
// ──────────────────────────────────────────────────────────────────────────────

func TestFTP_MultilineResponseValid(t *testing.T) {
	a, sub := newFTPTest()
	cid := "ml-valid"

	// RFC 959 valid multi-line: 220- ... 220<space>
	lines := "220-Hello\r\n220-More info\r\n220 Done.\r\n"
	a.Analyze(cid, "3.3.3.3", "10.0.0.2", 3333, 21, []byte(lines), false)

	if !sub.has("FTP-GREET-001") {
		t.Error("Expected FTP-GREET-001 from valid multiline response")
	}
	if sub.has("FTP-MALFORM-001") {
		t.Error("False-positive FTP-MALFORM-001 on valid multiline response")
	}
}

func TestFTP_MultilineResponseMalformed(t *testing.T) {
	a, sub := newFTPTest()
	cid := "ml-bad"

	// Opened with 220-, terminated with 530 (different code — RFC violation)
	lines := "220-Hello\r\n530 Login incorrect.\r\n"
	a.Analyze(cid, "4.4.4.4", "10.0.0.2", 4444, 21, []byte(lines), false)

	if !sub.has("FTP-MALFORM-001") {
		t.Error("Expected FTP-MALFORM-001 for malformed multiline response")
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Existing rules — regression tests
// ──────────────────────────────────────────────────────────────────────────────

func TestFTP_AnonymousLoginAttempt(t *testing.T) {
	a, sub := newFTPTest()
	cid := "anon-try"
	serverGreet(a, cid)
	a.Analyze(cid, "6.6.6.6", "10.0.0.2", 6666, 21, crlf("USER anonymous"), true)
	if !sub.has("FTP-ANON-001") {
		t.Error("FTP-ANON-001 not detected for USER anonymous")
	}
}

func TestFTP_AnonymousLoginNegative(t *testing.T) {
	a, sub := newFTPTest()
	cid := "anon-neg"
	serverGreet(a, cid)
	a.Analyze(cid, "7.7.7.7", "10.0.0.2", 7777, 21, crlf("USER bob"), true)
	if sub.has("FTP-ANON-001") {
		t.Error("False-positive FTP-ANON-001 for non-anonymous user")
	}
	if !sub.has("FTP-USER-001") {
		t.Error("FTP-USER-001 not emitted for USER bob")
	}
}

func TestFTP_AnonymousLoginSucceeded(t *testing.T) {
	a, sub := newFTPTest()
	cid := "anon-ok"
	serverGreet(a, cid)
	a.Analyze(cid, "8.8.8.8", "10.0.0.2", 8888, 21, crlf("USER anonymous"), true)
	a.Analyze(cid, "8.8.8.8", "10.0.0.2", 8888, 21, crlf("230 Login successful."), false)
	if !sub.has("FTP-ANON-LOGIN-OK") {
		t.Error("FTP-ANON-LOGIN-OK not emitted when anonymous login succeeds")
	}
}

func TestFTP_AuthFailure(t *testing.T) {
	a, sub := newFTPTest()
	cid := "auth-fail"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("USER root"), true)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("530 Login incorrect."), false)
	if !sub.has("FTP-AUTH-FAIL") {
		t.Error("FTP-AUTH-FAIL not emitted on 530 response")
	}
}

func TestFTP_PathTraversal(t *testing.T) {
	a, sub := newFTPTest()
	cid := "trav"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("RETR ../../etc/shadow"), true)
	if !sub.has("FTP-TRAV-001") {
		t.Error("FTP-TRAV-001 not detected for .. in path")
	}
}

func TestFTP_BounceAttack(t *testing.T) {
	a, sub := newFTPTest()
	cid := "bounce"
	serverGreet(a, cid)
	// Client is 1.2.3.4 but PORT points to 192.168.1.100
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("PORT 192,168,1,100,20,21"), true)
	if !sub.has("FTP-BOUNCE-001") {
		t.Error("FTP-BOUNCE-001 not detected for mismatched PORT IP")
	}
}

func TestFTP_BounceAttackNegative(t *testing.T) {
	a, sub := newFTPTest()
	cid := "no-bounce"
	serverGreet(a, cid)
	// Client IS 1.2.3.4 and PORT points to the same IP
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("PORT 1,2,3,4,20,21"), true)
	if sub.has("FTP-BOUNCE-001") {
		t.Error("False-positive FTP-BOUNCE-001 when PORT IP matches client IP")
	}
}

func TestFTP_FileDelete(t *testing.T) {
	a, sub := newFTPTest()
	cid := "del"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("DELE /var/www/index.php"), true)
	if !sub.has("FTP-DEL-001") {
		t.Error("FTP-DEL-001 not detected for DELE")
	}
}

func TestFTP_DirectoryRemoval(t *testing.T) {
	a, sub := newFTPTest()
	cid := "rmd"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("RMD /tmp/evil"), true)
	if !sub.has("FTP-RMD-001") {
		t.Error("FTP-RMD-001 not detected for RMD")
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 2 — New detection rules
// ──────────────────────────────────────────────────────────────────────────────

func TestFTP_BruteForce(t *testing.T) {
	a, sub := newFTPTest()
	// Use very tight window and threshold for test speed
	a.bruteConf = FTPBruteConfig{Window: 5 * time.Second, Threshold: 3}

	// Simulate 3+ auth failures from the same IP across separate connections
	for i := 0; i < 3; i++ {
		cid := fmt.Sprintf("brute-%d", i)
		serverGreet(a, cid)
		a.Analyze(cid, "10.10.10.10", "10.0.0.2", 10000+uint16(i), 21, crlf("USER admin"), true)
		a.Analyze(cid, "10.10.10.10", "10.0.0.2", 10000+uint16(i), 21, crlf("530 Login incorrect."), false)
	}

	if !sub.has("FTP-BRUTE-001") {
		t.Error("FTP-BRUTE-001 not emitted after threshold failures from same IP")
	}
}

func TestFTP_BruteForceWindowExpiry(t *testing.T) {
	a, sub := newFTPTest()
	a.bruteConf = FTPBruteConfig{Window: 100 * time.Millisecond, Threshold: 3}

	// 2 failures
	for i := 0; i < 2; i++ {
		cid := fmt.Sprintf("bf-exp-%d", i)
		a.Analyze(cid, "11.11.11.11", "10.0.0.2", 11000+uint16(i), 21, crlf("220 Ready"), false)
		a.Analyze(cid, "11.11.11.11", "10.0.0.2", 11000+uint16(i), 21, crlf("USER root"), true)
		a.Analyze(cid, "11.11.11.11", "10.0.0.2", 11000+uint16(i), 21, crlf("530 Login incorrect."), false)
	}

	// Wait for window to expire
	time.Sleep(200 * time.Millisecond)

	// 1 more failure — window reset, should NOT trigger brute-force
	sub.reset()
	cid := "bf-exp-2"
	a.Analyze(cid, "11.11.11.11", "10.0.0.2", 11002, 21, crlf("220 Ready"), false)
	a.Analyze(cid, "11.11.11.11", "10.0.0.2", 11002, 21, crlf("USER root"), true)
	a.Analyze(cid, "11.11.11.11", "10.0.0.2", 11002, 21, crlf("530 Login incorrect."), false)

	if sub.has("FTP-BRUTE-001") {
		t.Error("False-positive FTP-BRUTE-001 after window expiry reset")
	}
}

func TestFTP_PASV(t *testing.T) {
	a, sub := newFTPTest()
	cid := "pasv"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("PASV"), true)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("227 Entering Passive Mode (192,168,1,200,10,50)"), false)
	if !sub.has("FTP-PASV-001") {
		t.Error("FTP-PASV-001 not detected for PASV 227 response")
	}
}

func TestFTP_EPSV(t *testing.T) {
	a, sub := newFTPTest()
	cid := "epsv"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("EPSV"), true)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("229 Entering Extended Passive Mode (|||2048|)"), false)
	if !sub.has("FTP-PASV-001") {
		t.Error("FTP-PASV-001 not detected for EPSV 229 response")
	}
}

func TestFTP_SuspiciousPath(t *testing.T) {
	a, sub := newFTPTest()
	cid := "sens"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("RETR /etc/shadow"), true)
	if !sub.has("FTP-SUSPICIOUS-PATH") {
		t.Error("FTP-SUSPICIOUS-PATH not detected for /etc/shadow")
	}
}

func TestFTP_SuspiciousPathSTOR(t *testing.T) {
	a, sub := newFTPTest()
	cid := "sens-stor"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("STOR /etc/passwd"), true)
	if !sub.has("FTP-SUSPICIOUS-PATH") {
		t.Error("FTP-SUSPICIOUS-PATH not detected for STOR /etc/passwd")
	}
}

func TestFTP_SuspiciousPathNegative(t *testing.T) {
	a, sub := newFTPTest()
	cid := "safe-path"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("RETR /pub/file.zip"), true)
	if sub.has("FTP-SUSPICIOUS-PATH") {
		t.Error("False-positive FTP-SUSPICIOUS-PATH for innocuous path")
	}
}

func TestFTP_STOU(t *testing.T) {
	a, sub := newFTPTest()
	cid := "stou"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("STOU shell.php"), true)
	if !sub.has("FTP-STOU-001") {
		t.Error("FTP-STOU-001 not detected")
	}
}

func TestFTP_APPE(t *testing.T) {
	a, sub := newFTPTest()
	cid := "appe"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("APPE /var/www/index.php"), true)
	if !sub.has("FTP-APPE-001") {
		t.Error("FTP-APPE-001 not detected")
	}
}

func TestFTP_GlobInLIST(t *testing.T) {
	a, sub := newFTPTest()
	cid := "glob"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("LIST *.conf"), true)
	if !sub.has("FTP-GLOB-001") {
		t.Error("FTP-GLOB-001 not detected for glob in LIST")
	}
}

func TestFTP_GlobNegative(t *testing.T) {
	a, sub := newFTPTest()
	cid := "no-glob"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("LIST /pub/"), true)
	if sub.has("FTP-GLOB-001") {
		t.Error("False-positive FTP-GLOB-001 for non-glob LIST")
	}
}

func TestFTP_SiteExec(t *testing.T) {
	a, sub := newFTPTest()
	cid := "exec"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("SITE EXEC id"), true)
	if !sub.has("FTP-EXEC") {
		t.Error("FTP-EXEC not detected for SITE EXEC")
	}
}

func TestFTP_SiteChmodDangerous(t *testing.T) {
	a, sub := newFTPTest()
	cid := "chmod"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("SITE CHMOD 777 /var/www"), true)

	// Find the CHMOD detection and verify severity
	sub.mu.Lock()
	defer sub.mu.Unlock()
	for _, d := range sub.detections {
		if d.ID == "FTP-CHMOD" {
			if d.Severity != SevCritical {
				t.Errorf("FTP-CHMOD with 777 should be CRITICAL, got %s", d.Severity)
			}
			return
		}
	}
	t.Error("FTP-CHMOD not detected for SITE CHMOD 777")
}

func TestFTP_SiteChmodSafe(t *testing.T) {
	a, sub := newFTPTest()
	cid := "chmod-safe"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("SITE CHMOD 644 /pub/file"), true)

	sub.mu.Lock()
	defer sub.mu.Unlock()
	for _, d := range sub.detections {
		if d.ID == "FTP-CHMOD" && d.Severity == SevCritical {
			t.Error("SITE CHMOD 644 should not be CRITICAL")
		}
	}
}

func TestFTP_SiteChmod700(t *testing.T) {
	a, sub := newFTPTest()
	cid := "chmod-700"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("SITE CHMOD 700 /pub/file"), true)

	sub.mu.Lock()
	defer sub.mu.Unlock()
	for _, d := range sub.detections {
		if d.ID == "FTP-CHMOD" && d.Severity == SevCritical {
			t.Error("SITE CHMOD 700 should not be CRITICAL")
		}
	}
}

func TestFTP_SiteGeneric(t *testing.T) {
	a, sub := newFTPTest()
	cid := "site-gen"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("SITE HELP"), true)
	if !sub.has("FTP-SITE-001") {
		t.Error("FTP-SITE-001 not emitted for generic SITE command")
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// FTPS explicit negotiation
// ──────────────────────────────────────────────────────────────────────────────

func TestFTP_ExplicitFTPS_AuthTLS(t *testing.T) {
	a, sub := newFTPTest()
	cid := "ftps-tls"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("AUTH TLS"), true)
	if !sub.has("FTP-STARTTLS") {
		t.Error("FTP-STARTTLS not detected on AUTH TLS")
	}
}

func TestFTP_ExplicitFTPS_234Confirms(t *testing.T) {
	a, sub := newFTPTest()
	cid := "ftps-234"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("AUTH TLS"), true)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("234 Auth OK."), false)
	if !sub.has("FTP-FTPS-001") {
		t.Error("FTP-FTPS-001 not emitted on 234 response")
	}
}

func TestFTP_ExplicitFTPS_EncryptedAfterTLS(t *testing.T) {
	a, sub := newFTPTest()
	cid := "ftps-blind"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("AUTH TLS"), true)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("234 Auth OK."), false)

	// After 234, subsequent commands are encrypted — should not be parsed
	sub.reset()
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("USER admin"), true)
	if sub.has("FTP-USER-001") {
		t.Error("FTP-USER-001 should not fire after TLS established (command channel is encrypted)")
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Session cleanup
// ──────────────────────────────────────────────────────────────────────────────

func TestFTP_SessionCleanupOnClose(t *testing.T) {
	a, _ := newFTPTest()
	cid := "cleanup"
	serverGreet(a, cid)
	a.Analyze(cid, "1.2.3.4", "10.0.0.2", 1234, 21, crlf("USER admin"), true)

	// Verify session was created
	a.sessionMu.Lock()
	_, exists := a.sessions[cid]
	a.sessionMu.Unlock()
	if !exists {
		t.Fatal("Session not created")
	}

	// Simulate connection close via DetectionBus
	a.OnConnectionClose(ConnectionRecord{ConnID: cid})

	a.sessionMu.Lock()
	_, exists = a.sessions[cid]
	a.sessionMu.Unlock()
	if exists {
		t.Error("Session not cleaned up after OnConnectionClose")
	}
}

func TestFTP_TTLExpiry(t *testing.T) {
	// Temporarily override the TTL for testing
	a, _ := newFTPTest()
	cid := "ttl-exp"
	serverGreet(a, cid)

	a.sessionMu.Lock()
	if s, ok := a.sessions[cid]; ok {
		// Set lastActivity far in the past
		s.mu.Lock()
		s.lastActivity = time.Now().Add(-10 * time.Minute)
		s.mu.Unlock()
	}
	a.sessionMu.Unlock()

	// Force expiry
	a.expireSessions()

	a.sessionMu.Lock()
	_, exists := a.sessions[cid]
	a.sessionMu.Unlock()
	if exists {
		t.Error("Session not expired by TTL cleanup")
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Concurrency / race detection
// ──────────────────────────────────────────────────────────────────────────────

func TestFTP_Concurrency(t *testing.T) {
	a, _ := newFTPTest()

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			cid := fmt.Sprintf("race-%d", n)
			srcIP := fmt.Sprintf("10.0.0.%d", n%254+1)
			a.Analyze(cid, srcIP, "10.0.0.2", uint16(10000+n), 21, crlf("220 Ready"), false)
			a.Analyze(cid, srcIP, "10.0.0.2", uint16(10000+n), 21, crlf("USER admin"), true)
			a.Analyze(cid, srcIP, "10.0.0.2", uint16(10000+n), 21, crlf("530 Login failed."), false)
			a.OnConnectionClose(ConnectionRecord{ConnID: cid})
		}(i)
	}
	wg.Wait()
}
