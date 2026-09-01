package detect

import (
	"encoding/binary"
	"strings"
	"sync"
	"testing"
)

// mockSubscriber captures detections emitted by the DetectionBus
type mockSubscriber struct {
	mu         sync.Mutex
	detections []Detection
}

func (m *mockSubscriber) OnDetection(d Detection) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.detections = append(m.detections, d)
}

func (m *mockSubscriber) OnConnectionClose(c ConnectionRecord) {}

func setupTestAnalyzer() (*SSHAnalyzer, *mockSubscriber) {
	sub := &mockSubscriber{}
	bus := NewDetectionBus()
	bus.Subscribe(sub)
	analyzer := NewSSHAnalyzer(bus)
	return analyzer, sub
}

func buildSSHPacket(payload []byte) []byte {
	// Length (4), Padding Length (1), Payload, Padding
	padLen := 8 - ((len(payload) + 5) % 8)
	if padLen < 4 {
		padLen += 8
	}
	pktLen := 1 + len(payload) + padLen
	out := make([]byte, 4)
	binary.BigEndian.PutUint32(out, uint32(pktLen))
	out = append(out, byte(padLen))
	out = append(out, payload...)
	for i := 0; i < padLen; i++ {
		out = append(out, 0)
	}
	return out
}

func buildKexInit(kex, hostKey, encCS, encSC, macCS, macSC, compCS, compSC string) []byte {
	payload := []byte{20} // SSH_MSG_KEXINIT
	// 16 bytes cookie
	payload = append(payload, make([]byte, 16)...)

	// 8 name lists
	lists := []string{kex, hostKey, encCS, encSC, macCS, macSC, compCS, compSC}
	for _, l := range lists {
		buf := make([]byte, 4)
		binary.BigEndian.PutUint32(buf, uint32(len(l)))
		payload = append(payload, buf...)
		payload = append(payload, []byte(l)...)
	}

	// languages (2x empty)
	payload = append(payload, []byte{0, 0, 0, 0, 0, 0, 0, 0}...)
	// first_kex_packet_follows (1)
	payload = append(payload, 0)
	// reserved (4)
	payload = append(payload, []byte{0, 0, 0, 0}...)

	return buildSSHPacket(payload)
}

func TestSSHAnalyzer_VersionExchange(t *testing.T) {
	a, sub := setupTestAnalyzer()
	connID := "test-1"

	// Client sends valid OpenSSH banner
	a.Analyze(connID, "10.0.0.1", 12345, 22, []byte("SSH-2.0-OpenSSH_8.9\r\n"), true)
	// Server sends valid banner
	a.Analyze(connID, "10.0.0.1", 12345, 22, []byte("SSH-2.0-OpenSSH_8.9\r\n"), false)

	sub.mu.Lock()
	defer sub.mu.Unlock()

	foundClientVer := false
	for _, d := range sub.detections {
		if d.ID == "SSH-VER-001" {
			foundClientVer = true
		}
	}
	if !foundClientVer {
		t.Errorf("Expected SSH-VER-001 detection")
	}
}

func TestSSHAnalyzer_Protocol1(t *testing.T) {
	a, sub := setupTestAnalyzer()
	connID := "test-2"

	a.Analyze(connID, "10.0.0.1", 12345, 22, []byte("SSH-1.5-Client\r\n"), true)

	sub.mu.Lock()
	defer sub.mu.Unlock()

	found := false
	for _, d := range sub.detections {
		if d.ID == "SSH-PROTO-001" {
			found = true
		}
	}
	if !found {
		t.Errorf("Expected SSH-PROTO-001 detection")
	}
}

func TestSSHAnalyzer_ToolNcrack(t *testing.T) {
	a, sub := setupTestAnalyzer()
	connID := "test-tool"

	a.Analyze(connID, "10.0.0.1", 12345, 22, []byte("SSH-2.0-Ncrack_0.7\r\n"), true)

	sub.mu.Lock()
	defer sub.mu.Unlock()

	found := false
	for _, d := range sub.detections {
		if d.ID == "SSH-TOOL-001" && strings.Contains(d.Summary, "Ncrack") {
			found = true
		}
	}
	if !found {
		t.Errorf("Expected SSH-TOOL-001 for Ncrack")
	}
}

func TestSSHAnalyzer_HASSH_And_WeakAlgos(t *testing.T) {
	a, sub := setupTestAnalyzer()
	connID := "test-hassh"

	// Version exchange first
	a.Analyze(connID, "10.0.0.1", 12345, 22, []byte("SSH-2.0-Client\r\n"), true)
	a.Analyze(connID, "10.0.0.1", 12345, 22, []byte("SSH-2.0-Server\r\n"), false)

	// Send weak KEX packet
	kexPacket := buildKexInit(
		"diffie-hellman-group1-sha1", // weak KEX
		"ssh-rsa",
		"aes128-cbc", // weak cipher
		"aes128-cbc",
		"hmac-md5", // weak MAC
		"hmac-md5",
		"none", "none",
	)

	a.Analyze(connID, "10.0.0.1", 12345, 22, kexPacket, true)

	sub.mu.Lock()
	defer sub.mu.Unlock()

	foundHASSH := false
	foundWeakKEX := false
	foundWeakCipher := false

	for _, d := range sub.detections {
		if d.ID == "SSH-HASSH-001" {
			foundHASSH = true
		}
		if d.ID == "SSH-WEAK-KEX" {
			foundWeakKEX = true
		}
		if d.ID == "SSH-WEAK-CIPHER" {
			foundWeakCipher = true
		}
	}

	if !foundHASSH {
		t.Errorf("Expected SSH-HASSH-001")
	}
	if !foundWeakKEX {
		t.Errorf("Expected SSH-WEAK-KEX")
	}
	if !foundWeakCipher {
		t.Errorf("Expected SSH-WEAK-CIPHER")
	}
}

func TestSSHAnalyzer_Scanner(t *testing.T) {
	a, sub := setupTestAnalyzer()
	connID := "test-scan"

	// Client sends nothing or just banner, Server sends banner
	a.Analyze(connID, "10.0.0.1", 12345, 22, []byte("SSH-2.0-Server\r\n"), false)
	// Connection closes prematurely
	a.AnalyzeClose(connID, "10.0.0.1", 12345, 22)

	sub.mu.Lock()
	defer sub.mu.Unlock()

	found := false
	for _, d := range sub.detections {
		if d.ID == "SSH-SCAN-001" {
			found = true
		}
	}
	if !found {
		t.Errorf("Expected SSH-SCAN-001 detection on premature close")
	}
}

func TestSSHAnalyzer_BruteForce(t *testing.T) {
	a, sub := setupTestAnalyzer()

	// Simulate 6 rapid connections from the same IP
	for i := 0; i < 6; i++ {
		connID := "test-bf-" + string(rune(i))

		a.Analyze(connID, "10.0.0.1", uint16(1000+i), 22, []byte("SSH-2.0-Client\r\n"), true)
		a.Analyze(connID, "10.0.0.1", uint16(1000+i), 22, []byte("SSH-2.0-Server\r\n"), false)

		// Send NEWKEYS (type 21)
		nk := buildSSHPacket([]byte{21})
		a.Analyze(connID, "10.0.0.1", uint16(1000+i), 22, nk, true)
		a.Analyze(connID, "10.0.0.1", uint16(1000+i), 22, nk, false)

		// Close connection immediately
		a.AnalyzeClose(connID, "10.0.0.1", uint16(1000+i), 22)
	}

	sub.mu.Lock()
	defer sub.mu.Unlock()

	found := false
	for _, d := range sub.detections {
		if d.ID == "SSH-BRUTE-001" {
			found = true
		}
	}
	if !found {
		t.Errorf("Expected SSH-BRUTE-001 detection after 5 rapid teardowns")
	}
}

func TestSSHAnalyzer_MalformedPacket(t *testing.T) {
	a, sub := setupTestAnalyzer()
	connID := "test-malform"

	a.Analyze(connID, "10.0.0.1", 12345, 22, []byte("SSH-2.0-Client\r\n"), true)
	a.Analyze(connID, "10.0.0.1", 12345, 22, []byte("SSH-2.0-Server\r\n"), false)

	// Send a malformed packet (invalid length)
	badPacket := []byte{0x7F, 0xFF, 0xFF, 0xFF, 0x00, 0x00}
	a.Analyze(connID, "10.0.0.1", 12345, 22, badPacket, true)

	sub.mu.Lock()
	defer sub.mu.Unlock()

	found := false
	for _, d := range sub.detections {
		if d.ID == "SSH-MALFORM-001" {
			found = true
		}
	}
	if !found {
		t.Errorf("Expected SSH-MALFORM-001 detection for invalid packet length")
	}
}

func TestSSHAnalyzer_Fragmentation(t *testing.T) {
	a, sub := setupTestAnalyzer()
	connID := "test-frag"

	a.Analyze(connID, "10.0.0.1", 12345, 22, []byte("SSH-2.0-Client\r\n"), true)
	a.Analyze(connID, "10.0.0.1", 12345, 22, []byte("SSH-2.0-Server\r\n"), false)

	kexPacket := buildKexInit(
		"curve25519-sha256", "ssh-rsa", "aes256-gcm@openssh.com", "aes256-gcm@openssh.com",
		"none", "none", "none", "none",
	)

	// Send in 1-byte chunks
	for i := 0; i < len(kexPacket); i++ {
		a.Analyze(connID, "10.0.0.1", 12345, 22, kexPacket[i:i+1], true)
	}

	sub.mu.Lock()
	defer sub.mu.Unlock()

	foundHASSH := false
	for _, d := range sub.detections {
		if d.ID == "SSH-HASSH-001" {
			foundHASSH = true
		}
	}
	if !foundHASSH {
		t.Errorf("Expected SSH-HASSH-001 after fragmented delivery")
	}
}

func TestSSHAnalyzer_RaceCondition(t *testing.T) {
	a, _ := setupTestAnalyzer()
	var wg sync.WaitGroup

	// Run 100 concurrent connections
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			connID := "race-" + string(rune(id))
			a.Analyze(connID, "10.0.0.1", uint16(1000+id), 22, []byte("SSH-2.0-Client\r\n"), true)
			a.Analyze(connID, "10.0.0.1", uint16(1000+id), 22, []byte("SSH-2.0-Server\r\n"), false)
			kexPacket := buildKexInit("curve25519-sha256", "ssh-rsa", "aes256-gcm@openssh.com", "aes256-gcm@openssh.com", "none", "none", "none", "none")
			a.Analyze(connID, "10.0.0.1", uint16(1000+id), 22, kexPacket, true)

			nk := buildSSHPacket([]byte{21})
			a.Analyze(connID, "10.0.0.1", uint16(1000+id), 22, nk, true)
			a.AnalyzeClose(connID, "10.0.0.1", uint16(1000+id), 22)
		}(i)
	}
	wg.Wait()
}
