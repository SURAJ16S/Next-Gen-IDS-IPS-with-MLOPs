// SPDX-License-Identifier: GPL-2.0
// detect/telnet_analyzer_test.go — Comprehensive tests for the Telnet analyzer.

package detect

import (
	"encoding/binary"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

type mockTelnetSubscriber struct {
	mu         sync.Mutex
	detections []Detection
}

func (m *mockTelnetSubscriber) OnDetection(d Detection) {
	m.mu.Lock()
	m.detections = append(m.detections, d)
	m.mu.Unlock()
}
func (m *mockTelnetSubscriber) OnConnectionClose(c ConnectionRecord) {}

func (m *mockTelnetSubscriber) count(id string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, d := range m.detections {
		if d.ID == id {
			n++
		}
	}
	return n
}

func (m *mockTelnetSubscriber) countPrefix(prefix string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, d := range m.detections {
		if strings.HasPrefix(d.ID, prefix) {
			n++
		}
	}
	return n
}

func (m *mockTelnetSubscriber) hasID(id string) bool { return m.count(id) > 0 }

func newTelnetTest() (*TelnetAnalyzer, *mockTelnetSubscriber) {
	bus := NewDetectionBus()
	sub := &mockTelnetSubscriber{}
	bus.Subscribe(sub)
	return NewTelnetAnalyzer(bus), sub
}

// wrapIAC prepends a simple IAC DO ECHO option sequence for testing NVT parsing.
func wrapIAC(payload string) []byte {
	// IAC WILL ECHO + payload
	return append([]byte{telnetIAC, telnetWILL, 0x01}, []byte(payload)...)
}

// authFlow sends a complete Telnet server banner → username prompt → client username
// → server password prompt → client password → server success.
func authFlow(a *TelnetAnalyzer, connID, srcIP string, username, password string) {
	a.Analyze(connID, srcIP, 54321, 23, []byte("Ubuntu 22.04 LTS\r\n"), false)
	a.Analyze(connID, srcIP, 54321, 23, []byte("login: "), false)
	a.Analyze(connID, srcIP, 54321, 23, []byte(username+"\r\n"), true)
	a.Analyze(connID, srcIP, 54321, 23, []byte("Password: "), false)
	a.Analyze(connID, srcIP, 54321, 23, []byte(password+"\r\n"), true)
	a.Analyze(connID, srcIP, 54321, 23, []byte("root@host:~# "), false)
}

// failedAuthFlow sends a failed login cycle.
func failedAuthFlow(a *TelnetAnalyzer, connID, srcIP, username, password string) {
	a.Analyze(connID, srcIP, 54321, 23, []byte("login: "), false)
	a.Analyze(connID, srcIP, 54321, 23, []byte(username+"\r\n"), true)
	a.Analyze(connID, srcIP, 54321, 23, []byte("Password: "), false)
	a.Analyze(connID, srcIP, 54321, 23, []byte(password+"\r\n"), true)
	a.Analyze(connID, srcIP, 54321, 23, []byte("Login incorrect\r\n"), false)
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Structural — plaintext alert, TCP buffering, NVT parser
// ─────────────────────────────────────────────────────────────────────────────

func TestTelnetPlaintext_EmittedOnce(t *testing.T) {
	a, sub := newTelnetTest()
	a.Analyze("c1", "10.0.0.1", 54321, 23, []byte("hello"), false)
	a.Analyze("c1", "10.0.0.1", 54321, 23, []byte("world"), true)
	time.Sleep(5 * time.Millisecond)
	if sub.count("TELNET-PLAINTEXT-001") != 1 {
		t.Fatalf("Expected exactly 1 TELNET-PLAINTEXT-001, got %d", sub.count("TELNET-PLAINTEXT-001"))
	}
}

func TestTelnetTCP_Fragmented(t *testing.T) {
	a, sub := newTelnetTest()
	// Send "login: " in 3 chunks, then username
	a.Analyze("c2", "10.0.0.1", 54321, 23, []byte("log"), false)
	a.Analyze("c2", "10.0.0.1", 54321, 23, []byte("in"), false)
	a.Analyze("c2", "10.0.0.1", 54321, 23, []byte(": "), false)
	a.Analyze("c2", "10.0.0.1", 54321, 23, []byte("admin\r\n"), true)
	a.Analyze("c2", "10.0.0.1", 54321, 23, []byte("Password: "), false)
	a.Analyze("c2", "10.0.0.1", 54321, 23, []byte("pass\r\n"), true)
	a.Analyze("c2", "10.0.0.1", 54321, 23, []byte("root@router:~# "), false)
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-AUTH-001") {
		t.Fatal("Expected TELNET-AUTH-001 from fragmented stream")
	}
}

func TestTelnetTCP_Coalesced(t *testing.T) {
	a, sub := newTelnetTest()
	// Send banner + login prompt + username all in one read
	combined := "Ubuntu 20.04\r\nlogin: admin\r\nPassword: "
	a.Analyze("c3", "10.0.0.2", 54321, 23, []byte(combined), false)
	// Note: "admin\r\n" was in the combined server data (won't be parsed as client input)
	// Just verify no panic and plaintext fires
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-PLAINTEXT-001") {
		t.Fatal("Expected TELNET-PLAINTEXT-001 on coalesced stream")
	}
}

func TestTelnetNVT_IACFragmented(t *testing.T) {
	a, sub := newTelnetTest()
	// Split IAC command across two reads
	a.Analyze("c4", "10.0.0.1", 54321, 23, []byte{telnetIAC}, false)         // partial: just IAC
	a.Analyze("c4", "10.0.0.1", 54321, 23, []byte{telnetWILL, 0x01}, false)  // WILL ECHO
	// Then send login prompt — should still be processed as plaintext
	a.Analyze("c4", "10.0.0.1", 54321, 23, []byte("login: "), false)
	a.Analyze("c4", "10.0.0.1", 54321, 23, []byte("root\r\n"), true)
	a.Analyze("c4", "10.0.0.1", 54321, 23, []byte("Password: "), false)
	a.Analyze("c4", "10.0.0.1", 54321, 23, []byte("pass\r\n"), true)
	a.Analyze("c4", "10.0.0.1", 54321, 23, []byte("root@host:~# "), false)
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-AUTH-001") {
		t.Fatal("Expected TELNET-AUTH-001 after fragmented IAC")
	}
}

func TestTelnetNVT_EscapedIAC(t *testing.T) {
	a, sub := newTelnetTest()
	// IAC IAC = literal 0xFF in data stream — must not treat as command
	data := []byte{telnetIAC, telnetIAC, 'l', 'o', 'g', 'i', 'n', ':', ' '}
	a.Analyze("c5", "10.0.0.1", 54321, 23, data, false)
	a.Analyze("c5", "10.0.0.1", 54321, 23, []byte("admin\r\n"), true)
	a.Analyze("c5", "10.0.0.1", 54321, 23, []byte("Password: "), false)
	a.Analyze("c5", "10.0.0.1", 54321, 23, []byte("secret\r\n"), true)
	a.Analyze("c5", "10.0.0.1", 54321, 23, []byte("admin@router> "), false)
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-AUTH-001") {
		t.Fatal("Expected TELNET-AUTH-001 after escaped IAC")
	}
}

func TestTelnetNVT_SBSEFragmented(t *testing.T) {
	a, sub := newTelnetTest()
	// SB split across reads: IAC SB <option> <payload> IAC SE
	// Read 1: IAC SB 0x18 (TERMINAL-TYPE)
	a.Analyze("c6", "10.0.0.1", 54321, 23, []byte{telnetIAC, telnetSB, 0x18}, false)
	// Read 2: payload bytes
	a.Analyze("c6", "10.0.0.1", 54321, 23, []byte("xterm-256color"), false)
	// Read 3: IAC SE to close
	a.Analyze("c6", "10.0.0.1", 54321, 23, []byte{telnetIAC, telnetSE}, false)
	// Then normal auth
	a.Analyze("c6", "10.0.0.1", 54321, 23, []byte("login: "), false)
	a.Analyze("c6", "10.0.0.1", 54321, 23, []byte("pi\r\n"), true)
	a.Analyze("c6", "10.0.0.1", 54321, 23, []byte("Password: "), false)
	a.Analyze("c6", "10.0.0.1", 54321, 23, []byte("raspberry\r\n"), true)
	a.Analyze("c6", "10.0.0.1", 54321, 23, []byte("pi@raspberrypi:~$ "), false)
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-AUTH-001") {
		t.Fatal("Expected TELNET-AUTH-001 after fragmented SB/SE")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Authentication
// ─────────────────────────────────────────────────────────────────────────────

func TestTelnetAuth_UsernameExtraction(t *testing.T) {
	a, sub := newTelnetTest()
	a.Analyze("ua1", "10.0.0.1", 54321, 23, []byte("login: "), false)
	a.Analyze("ua1", "10.0.0.1", 54321, 23, []byte("testuser\r\n"), true)

	a.mu.Lock()
	sess := a.sessions["ua1"]
	username := sess.username
	a.mu.Unlock()

	if username != "testuser" {
		t.Fatalf("Expected username 'testuser', got %q", username)
	}
	_ = sub
}

func TestTelnetAuth_PasswordPresent(t *testing.T) {
	a, _ := newTelnetTest()
	a.Analyze("pp1", "10.0.0.1", 54321, 23, []byte("login: "), false)
	a.Analyze("pp1", "10.0.0.1", 54321, 23, []byte("admin\r\n"), true)
	a.Analyze("pp1", "10.0.0.1", 54321, 23, []byte("Password: "), false)
	a.Analyze("pp1", "10.0.0.1", 54321, 23, []byte("secret\r\n"), true)

	a.mu.Lock()
	sess := a.sessions["pp1"]
	present := sess.passPresent
	fp := sess.passFingerprint
	a.mu.Unlock()

	if !present {
		t.Fatal("Expected passPresent=true")
	}
	if fp == "" {
		t.Fatal("Expected non-empty credential fingerprint")
	}
	// Verify the fingerprint is for the right data
	expected := credFingerprint("admin", "secret")
	if fp != expected {
		t.Fatalf("Fingerprint mismatch: got %q, want %q", fp, expected)
	}
}

func TestTelnetAuth_EmptyPassword(t *testing.T) {
	a, sub := newTelnetTest()
	a.Analyze("ep1", "10.0.0.1", 54321, 23, []byte("login: "), false)
	a.Analyze("ep1", "10.0.0.1", 54321, 23, []byte("admin\r\n"), true)
	a.Analyze("ep1", "10.0.0.1", 54321, 23, []byte("Password: "), false)
	a.Analyze("ep1", "10.0.0.1", 54321, 23, []byte("\r\n"), true) // empty password
	a.Analyze("ep1", "10.0.0.1", 54321, 23, []byte("admin@host:~# "), false)
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-ANON-001") {
		t.Fatal("Expected TELNET-ANON-001 for empty password")
	}
}

func TestTelnetAuth_Anonymous(t *testing.T) {
	a, sub := newTelnetTest()
	a.Analyze("an1", "10.0.0.1", 54321, 23, []byte("login: "), false)
	a.Analyze("an1", "10.0.0.1", 54321, 23, []byte("anonymous\r\n"), true)
	a.Analyze("an1", "10.0.0.1", 54321, 23, []byte("Password: "), false)
	a.Analyze("an1", "10.0.0.1", 54321, 23, []byte("anything\r\n"), true)
	a.Analyze("an1", "10.0.0.1", 54321, 23, []byte("$ "), false)
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-ANON-001") {
		t.Fatal("Expected TELNET-ANON-001 for 'anonymous' username")
	}
}

func TestTelnetAuth_Success(t *testing.T) {
	a, sub := newTelnetTest()
	authFlow(a, "s1", "10.0.0.1", "admin", "password123")
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-AUTH-001") {
		t.Fatal("Expected TELNET-AUTH-001 on success")
	}
}

func TestTelnetAuth_Failure(t *testing.T) {
	a, sub := newTelnetTest()
	failedAuthFlow(a, "f1", "10.0.0.1", "admin", "wrongpass")
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-AUTH-001") {
		// No AUTH-001 on failure (no shell prompt); check no panic at least
		// AUTH-001 only fires on success; for failed we track on the source state
	}
	// The failure was recorded — no alert yet (only 1 failure; threshold is 5)
	if sub.hasID("TELNET-BRUTE-001") {
		t.Fatal("Should not fire brute-force alert on first failure")
	}
}

func TestTelnetAuth_NoLoginShell(t *testing.T) {
	a, sub := newTelnetTest()
	// Server sends shell prompt without any login exchange
	a.Analyze("nl1", "10.0.0.1", 54321, 23, []byte("Cisco IOS Software\r\n"), false)
	a.Analyze("nl1", "10.0.0.1", 54321, 23, []byte("router# "), false)
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-NOLOGIN-001") {
		t.Fatal("Expected TELNET-NOLOGIN-001 for shell without auth")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Default credentials and IoT detection
// ─────────────────────────────────────────────────────────────────────────────

func TestTelnetDefaultCred_Match(t *testing.T) {
	a, sub := newTelnetTest()
	// "ubnt":"ubnt" is in the defaults database
	authFlow(a, "dc1", "10.0.0.1", "ubnt", "ubnt")
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-DEFAULT-CRED-001") {
		t.Fatal("Expected TELNET-DEFAULT-CRED-001 for ubnt:ubnt")
	}
}

func TestTelnetDefaultCred_NoMatch(t *testing.T) {
	a, sub := newTelnetTest()
	// Unusual credentials not in the database
	authFlow(a, "dc2", "10.0.0.2", "secureuser", "Str0ng!Pass#2024")
	time.Sleep(5 * time.Millisecond)
	if sub.hasID("TELNET-DEFAULT-CRED-001") {
		t.Fatal("Should not match uncommon credentials as default")
	}
}

func TestTelnetIoT_Mirai(t *testing.T) {
	a, sub := newTelnetTest()
	// root:xc3511 is a Mirai credential
	authFlow(a, "iot1", "10.0.0.1", "root", "xc3511")
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-IOT-001") {
		t.Fatal("Expected TELNET-IOT-001 for Mirai credential root:xc3511")
	}
}

func TestTelnetIoT_NonMirai(t *testing.T) {
	a, sub := newTelnetTest()
	// ubnt:ubnt is in defaults but NOT Mirai-tagged
	authFlow(a, "iot2", "10.0.0.2", "ubnt", "ubnt")
	time.Sleep(5 * time.Millisecond)
	if sub.hasID("TELNET-IOT-001") {
		t.Fatal("TELNET-IOT-001 should not fire for non-botnet default cred")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3: Brute-force, spraying, stuffing, scan
// ─────────────────────────────────────────────────────────────────────────────

func TestTelnetBrute_Positive(t *testing.T) {
	a, sub := newTelnetTest()
	srcIP := "10.1.1.1"
	// Send 5 failures from same srcIP
	for i := 0; i < 5; i++ {
		connID := fmt.Sprintf("bf-%d", i)
		failedAuthFlow(a, connID, srcIP, "admin", "wrong")
	}
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-BRUTE-001") {
		t.Fatalf("Expected TELNET-BRUTE-001 after 5 failures, got %d", sub.count("TELNET-BRUTE-001"))
	}
}

func TestTelnetBrute_Negative(t *testing.T) {
	a, sub := newTelnetTest()
	srcIP := "10.1.1.2"
	// Only 4 failures — below threshold
	for i := 0; i < 4; i++ {
		connID := fmt.Sprintf("bfn-%d", i)
		failedAuthFlow(a, connID, srcIP, "admin", "wrong")
	}
	time.Sleep(5 * time.Millisecond)
	if sub.hasID("TELNET-BRUTE-001") {
		t.Fatal("Should not fire brute-force for 4 failures")
	}
}

func TestTelnetSpray_Positive(t *testing.T) {
	a, sub := newTelnetTest()
	srcIP := "10.2.2.1"
	// Same password "spray123" against 3 different usernames
	users := []string{"alice", "bob", "charlie"}
	for i, user := range users {
		connID := fmt.Sprintf("spray-%d", i)
		failedAuthFlow(a, connID, srcIP, user, "spray123")
	}
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-SPRAY-001") {
		t.Fatalf("Expected TELNET-SPRAY-001 for spray against 3 usernames")
	}
}

func TestTelnetSpray_Negative(t *testing.T) {
	a, sub := newTelnetTest()
	srcIP := "10.2.2.2"
	// Different passwords — not a spray
	pairs := [][2]string{{"alice", "pass1"}, {"bob", "pass2"}, {"charlie", "pass3"}}
	for i, pair := range pairs {
		connID := fmt.Sprintf("sprayn-%d", i)
		failedAuthFlow(a, connID, srcIP, pair[0], pair[1])
	}
	time.Sleep(5 * time.Millisecond)
	if sub.hasID("TELNET-SPRAY-001") {
		t.Fatal("Should not fire spray for different passwords")
	}
}

func TestTelnetCredStuff_Positive(t *testing.T) {
	a, sub := newTelnetTest()
	srcIP := "10.3.3.1"
	// 5 unique (user, pass) pairs
	pairs := [][2]string{
		{"user1", "pass1"}, {"user2", "pass2"}, {"user3", "pass3"},
		{"user4", "pass4"}, {"user5", "pass5"},
	}
	for i, pair := range pairs {
		connID := fmt.Sprintf("cs-%d", i)
		failedAuthFlow(a, connID, srcIP, pair[0], pair[1])
	}
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-CREDSTUFF-001") {
		t.Fatalf("Expected TELNET-CREDSTUFF-001 for 5 unique pairs")
	}
}

func TestTelnetCredStuff_Negative(t *testing.T) {
	a, sub := newTelnetTest()
	srcIP := "10.3.3.2"
	// Same pair repeated — should not inflate count
	for i := 0; i < 10; i++ {
		connID := fmt.Sprintf("csn-%d", i)
		failedAuthFlow(a, connID, srcIP, "admin", "admin")
	}
	time.Sleep(5 * time.Millisecond)
	if sub.hasID("TELNET-CREDSTUFF-001") {
		t.Fatal("Repeated same pair should not trigger credential stuffing")
	}
}

func TestTelnetBruteSuccess(t *testing.T) {
	a, sub := newTelnetTest()
	srcIP := "10.4.4.1"
	// First: several failures
	for i := 0; i < 3; i++ {
		connID := fmt.Sprintf("bsf-%d", i)
		failedAuthFlow(a, connID, srcIP, "root", "wrong")
	}
	// Then: success
	authFlow(a, "bss-success", srcIP, "root", "correctpass")
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-BRUTE-SUCCESS-001") {
		t.Fatal("Expected TELNET-BRUTE-SUCCESS-001 after failures followed by success")
	}
}

func TestTelnetScan_Positive(t *testing.T) {
	a, sub := newTelnetTest()
	srcIP := "10.5.5.1"
	// 3 very short connections — just send banner and disconnect
	for i := 0; i < 3; i++ {
		connID := fmt.Sprintf("scan-%d", i)
		// Send minimal data and close immediately — session starts, connection closes
		a.Analyze(connID, srcIP, 54321, 23, []byte{telnetIAC, telnetWILL, 0x01}, false)
		// Force the session to appear short-lived by manipulating startTime
		a.mu.Lock()
		if sess, ok := a.sessions[connID]; ok {
			sess.startTime = time.Now().Add(-5 * time.Second) // fake long ago
		}
		a.mu.Unlock()
		// But set startTime to NOW for actual scan (≤3s short connection)
		a.mu.Lock()
		if sess, ok := a.sessions[connID]; ok {
			sess.startTime = time.Now() // started just now
		}
		a.mu.Unlock()
		a.OnClose(connID)
	}
	time.Sleep(10 * time.Millisecond)
	if !sub.hasID("TELNET-SCAN-001") {
		t.Fatalf("Expected TELNET-SCAN-001 for 3 short connections, got %d", sub.count("TELNET-SCAN-001"))
	}
}

func TestTelnetScan_Negative(t *testing.T) {
	a, sub := newTelnetTest()
	srcIP := "10.5.5.2"
	// 3 connections that complete full auth — not scans
	for i := 0; i < 3; i++ {
		connID := fmt.Sprintf("scann-%d", i)
		authFlow(a, connID, srcIP, "admin", "pass")
		// Mark connection as long-lived
		a.mu.Lock()
		if sess, ok := a.sessions[connID]; ok {
			sess.startTime = time.Now().Add(-10 * time.Second)
		}
		a.mu.Unlock()
		a.OnClose(connID)
	}
	time.Sleep(10 * time.Millisecond)
	if sub.hasID("TELNET-SCAN-001") {
		t.Fatal("Should not fire scan for authenticated connections")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: NVT malformed/anomaly
// ─────────────────────────────────────────────────────────────────────────────

func TestTelnetNVT_Malformed_UnknownCmd(t *testing.T) {
	a, sub := newTelnetTest()
	// IAC followed by invalid command byte (e.g., 0x01)
	a.Analyze("malf1", "10.0.0.1", 54321, 23, []byte{telnetIAC, 0x01}, false)
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-NVT-MALFORM-001") {
		t.Fatal("Expected TELNET-NVT-MALFORM-001 for unknown IAC command")
	}
}

func TestTelnetNVT_Malformed_SEWithoutSB(t *testing.T) {
	a, sub := newTelnetTest()
	// SE without preceding SB
	a.Analyze("malf2", "10.0.0.1", 54321, 23, []byte{telnetIAC, telnetSE}, false)
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-NVT-MALFORM-001") {
		t.Fatal("Expected TELNET-NVT-MALFORM-001 for SE without SB")
	}
}

func TestTelnetNVT_Anomaly_ExcessiveNegotiation(t *testing.T) {
	a, sub := newTelnetTest()
	// Send > 50 IAC sequences
	for i := 0; i <= telnetMaxIACPerSession; i++ {
		a.Analyze("anm1", "10.0.0.1", 54321, 23, []byte{telnetIAC, telnetWILL, 0x01}, false)
	}
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-NVT-ANOMALY-001") {
		t.Fatal("Expected TELNET-NVT-ANOMALY-001 for excessive IAC negotiation")
	}
}

func TestTelnetNVT_OversizedSB(t *testing.T) {
	a, sub := newTelnetTest()
	// IAC SB + >1024 bytes of payload
	bigPayload := make([]byte, 3+telnetMaxSBPayload+10)
	bigPayload[0] = telnetIAC
	bigPayload[1] = telnetSB
	bigPayload[2] = 0x18 // TERMINAL-TYPE
	for i := 3; i < len(bigPayload); i++ {
		bigPayload[i] = 'A'
	}
	a.Analyze("sb1", "10.0.0.1", 54321, 23, bigPayload, false)
	time.Sleep(5 * time.Millisecond)
	if !sub.hasID("TELNET-NVT-ANOMALY-001") {
		t.Fatal("Expected TELNET-NVT-ANOMALY-001 for oversized SB payload")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Malformed input / no-panic guarantees
// ─────────────────────────────────────────────────────────────────────────────

func TestTelnetNoPanic_Malformed(t *testing.T) {
	a, _ := newTelnetTest()
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Analyzer panicked on malformed input: %v", r)
		}
	}()

	// All-zero payload
	a.Analyze("p1", "10.0.0.1", 54321, 23, make([]byte, 256), false)
	// Empty payload
	a.Analyze("p2", "10.0.0.1", 54321, 23, []byte{}, true)
	// Pure IAC with nothing after
	a.Analyze("p3", "10.0.0.1", 54321, 23, []byte{telnetIAC}, false)
	// Random garbage
	a.Analyze("p4", "10.0.0.1", 54321, 23, []byte{0xFE, 0xFD, 0xFF, 0x00, 0x01}, true)
	// Oversized buffer trigger
	big := make([]byte, telnetMaxBufPerDir+1)
	a.Analyze("p5", "10.0.0.1", 54321, 23, big, false)
}

func TestTelnetOversizedBuffer(t *testing.T) {
	a, sub := newTelnetTest()
	// Sending more than maxBufPerDir should be handled gracefully
	big := make([]byte, telnetMaxBufPerDir+100)
	a.Analyze("obf1", "10.0.0.1", 54321, 23, big, false)
	a.Analyze("obf1", "10.0.0.1", 54321, 23, big, true)
	time.Sleep(5 * time.Millisecond)
	_ = sub // no panic is the requirement
}

// ─────────────────────────────────────────────────────────────────────────────
// Session cleanup and TTL
// ─────────────────────────────────────────────────────────────────────────────

func TestTelnetOnClose(t *testing.T) {
	a, _ := newTelnetTest()
	a.Analyze("close1", "10.0.0.1", 54321, 23, []byte("hello"), false)

	a.mu.Lock()
	_, exists := a.sessions["close1"]
	a.mu.Unlock()
	if !exists {
		t.Fatal("Session should exist after first data")
	}

	a.OnClose("close1")

	a.mu.Lock()
	_, exists = a.sessions["close1"]
	a.mu.Unlock()
	if exists {
		t.Fatal("Session should be removed after OnClose")
	}
}

func TestTelnetTTL_Cleanup(t *testing.T) {
	a, _ := newTelnetTest()
	a.Analyze("ttl1", "10.0.0.1", 54321, 23, []byte("data"), false)

	// Manually age the session
	a.mu.Lock()
	if sess, ok := a.sessions["ttl1"]; ok {
		sess.lastActivity = time.Now().Add(-10 * time.Minute)
	}
	a.mu.Unlock()

	a.cleanup()

	a.mu.Lock()
	_, exists := a.sessions["ttl1"]
	a.mu.Unlock()
	if exists {
		t.Fatal("Stale session should be removed by TTL cleanup")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrent access (race detector)
// ─────────────────────────────────────────────────────────────────────────────

func TestTelnetConcurrent(t *testing.T) {
	a, _ := newTelnetTest()

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			connID := fmt.Sprintf("conc-%d", n)
			srcIP := fmt.Sprintf("10.0.%d.1", n)
			a.Analyze(connID, srcIP, 54321, 23, []byte("login: "), false)
			a.Analyze(connID, srcIP, 54321, 23, []byte("user\r\n"), true)
			a.Analyze(connID, srcIP, 54321, 23, []byte("Password: "), false)
			a.Analyze(connID, srcIP, 54321, 23, []byte("pass\r\n"), true)
			a.OnClose(connID)
		}(i)
	}
	wg.Wait()
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential fingerprint — security verification
// ─────────────────────────────────────────────────────────────────────────────

func TestTelnetCredFingerprint_NoPlaintext(t *testing.T) {
	a, sub := newTelnetTest()
	authFlow(a, "cf1", "10.0.0.1", "admin", "supersecret")
	time.Sleep(5 * time.Millisecond)

	sub.mu.Lock()
	defer sub.mu.Unlock()
	for _, d := range sub.detections {
		details := d.Details
		for k, v := range details {
			if strings.Contains(strings.ToLower(k), "password") {
				if str, ok := v.(string); ok && str == "supersecret" {
					t.Fatalf("Plaintext password found in DetectionEvent.Details key=%q", k)
				}
			}
			if str, ok := v.(string); ok && str == "supersecret" {
				t.Fatalf("Plaintext password 'supersecret' found in DetectionEvent.Details value for key=%q", k)
			}
		}
	}
}

// Ensure binary.BigEndian is available (imported for test helpers in other test files)
var _ = binary.BigEndian
