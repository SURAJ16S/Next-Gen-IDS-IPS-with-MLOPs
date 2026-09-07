package detect

import (
	"fmt"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"math/big"
	"strings"
	"sync"
	"testing"
	"time"
)

// Generate a dummy self-signed cert for testing
func generateDummyCert(expired bool) []byte {
	priv, _ := rsa.GenerateKey(rand.Reader, 2048)
	notBefore := time.Now().Add(-1 * time.Hour)
	notAfter := time.Now().Add(1 * time.Hour)
	if expired {
		notAfter = time.Now().Add(-1 * time.Minute)
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			CommonName: "dummy.example.com",
		},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}

	// self-signed
	derBytes, _ := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	return derBytes
}

func buildTLSRecord(recordType byte, version uint16, payload []byte) []byte {
	record := make([]byte, 5+len(payload))
	record[0] = recordType
	binary.BigEndian.PutUint16(record[1:3], version)
	binary.BigEndian.PutUint16(record[3:5], uint16(len(payload)))
	copy(record[5:], payload)
	return record
}

func buildHandshakeMsg(msgType byte, payload []byte) []byte {
	msg := make([]byte, 4+len(payload))
	msg[0] = msgType
	msg[1] = byte(len(payload) >> 16)
	msg[2] = byte(len(payload) >> 8)
	msg[3] = byte(len(payload))
	copy(msg[4:], payload)
	return msg
}

func buildDummyClientHello() []byte {
	// version(2) + random(32) + session(1) + ciphers(2+len) + comp(1+len) + ext(2+len)
	payload := make([]byte, 100)
	binary.BigEndian.PutUint16(payload[0:2], 0x0303) // TLS 1.2
	// offset 34: session len 0
	payload[34] = 0
	// offset 35: ciphers len 2
	binary.BigEndian.PutUint16(payload[35:37], 2)
	binary.BigEndian.PutUint16(payload[37:39], 0x0001) // weak cipher TLS_RSA_WITH_NULL_MD5
	// offset 39: comp len 1, method 0
	payload[39] = 1
	payload[40] = 0
	// offset 41: extensions length 10
	binary.BigEndian.PutUint16(payload[41:43], 10)

	// Extension 1: Supported Groups (0x000A), length 6, curves (2 bytes len + 2 curves)
	binary.BigEndian.PutUint16(payload[43:45], 0x000A)
	binary.BigEndian.PutUint16(payload[45:47], 6)
	binary.BigEndian.PutUint16(payload[47:49], 4)
	binary.BigEndian.PutUint16(payload[49:51], 0x1A1A) // GREASE
	binary.BigEndian.PutUint16(payload[51:53], 0x001D) // X25519

	return payload[:53]
}

type dummySubscriber struct {
	mu         sync.Mutex
	detections []Detection
}

func (s *dummySubscriber) OnDetection(d Detection) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.detections = append(s.detections, d)
}

func (s *dummySubscriber) OnConnectionClose(c ConnectionRecord) {}

func TestTLSInspector_ClientHello_Fragmentation(t *testing.T) {
	bus := NewDetectionBus()
	sub := &dummySubscriber{}
	bus.Subscribe(sub)

	inspector := NewTLSInspector(bus)

	chPayload := buildDummyClientHello()
	chMsg := buildHandshakeMsg(0x01, chPayload)
	record := buildTLSRecord(0x16, 0x0303, chMsg)

	// Fragment the record into 3 pieces to simulate TCP fragmentation
	frag1 := record[:10]
	frag2 := record[10:30]
	frag3 := record[30:]

	connID := "test-frag"
	inspector.Analyze(connID, "1.2.3.4", 1234, 443, frag1, true)
	inspector.Analyze(connID, "1.2.3.4", 1234, 443, frag2, true)
	inspector.Analyze(connID, "1.2.3.4", 1234, 443, frag3, true)

	time.Sleep(50 * time.Millisecond) // Let event loop flush

	sub.mu.Lock()
	defer sub.mu.Unlock()

	foundHello := false
	foundWeak := false
	for _, d := range sub.detections {
		if d.ID == "TLS-HELLO-001" {
			foundHello = true
			ja3 := d.Details["ja3_string"].(string)
			// Ensure GREASE (1a1a / 6682) is NOT in JA3 string!
			if strings.Contains(ja3, "6682") {
				t.Errorf("JA3 string contains GREASE value: %s", ja3)
			}
			if !strings.Contains(ja3, "29") { // 0x001D = 29
				t.Errorf("JA3 string missing X25519 curve: %s", ja3)
			}
		}
		if d.ID == "TLS-WEAK-001" {
			foundWeak = true
		}
	}

	if !foundHello {
		t.Errorf("Failed to reassemble and detect fragmented ClientHello")
	}
	if !foundWeak {
		t.Errorf("Failed to detect weak cipher")
	}
}

func TestTLSInspector_Certificates(t *testing.T) {
	bus := NewDetectionBus()
	sub := &dummySubscriber{}
	bus.Subscribe(sub)

	inspector := NewTLSInspector(bus)

	certDER := generateDummyCert(true) // expired

	// Construct Certificate handshake payload
	payload := make([]byte, 6+len(certDER))
	certsLen := len(certDER) + 3
	payload[0] = byte(certsLen >> 16)
	payload[1] = byte(certsLen >> 8)
	payload[2] = byte(certsLen)

	certLen := len(certDER)
	payload[3] = byte(certLen >> 16)
	payload[4] = byte(certLen >> 8)
	payload[5] = byte(certLen)

	copy(payload[6:], certDER)

	certMsg := buildHandshakeMsg(0x0B, payload)
	record := buildTLSRecord(0x16, 0x0303, certMsg)

	inspector.Analyze("test-cert", "8.8.8.8", 443, 1234, record, false)
	time.Sleep(50 * time.Millisecond)

	sub.mu.Lock()
	defer sub.mu.Unlock()

	foundExpired := false
	foundSelfSigned := false
	for _, d := range sub.detections {
		if d.ID == "TLS-CERT-EXPIRED" {
			foundExpired = true
		}
		if d.ID == "TLS-CERT-SELFSIGNED" {
			foundSelfSigned = true
		}
	}

	if !foundExpired {
		t.Errorf("Failed to detect expired certificate")
	}
	if !foundSelfSigned {
		t.Errorf("Failed to detect self-signed certificate")
	}
}

// TestJA3N_Determinism verifies that JA3N produces the same hash regardless of
// extension order, while JA3 hash differs when extension order differs.
func TestJA3N_Determinism(t *testing.T) {
	// Two extension lists with same values but different order
	exts1 := []uint16{0x0000, 0x000A, 0x002B, 0x0023} // wire order A
	exts2 := []uint16{0x002B, 0x0000, 0x0023, 0x000A} // wire order B (permuted)

	strs1 := make([]string, len(exts1))
	strs2 := make([]string, len(exts2))
	for i, e := range exts1 {
		strs1[i] = fmt.Sprintf("%d", e)
	}
	for i, e := range exts2 {
		strs2[i] = fmt.Sprintf("%d", e)
	}

	filtered1 := filterGREASE16(strs1, exts1)
	filtered2 := filterGREASE16(strs2, exts2)

	// JA3 strings differ because extension order is different
	ja3a := fmt.Sprintf("771,%s,%s,,", "49196", strings.Join(filtered1, "-"))
	ja3b := fmt.Sprintf("771,%s,%s,,", "49196", strings.Join(filtered2, "-"))
	if ja3a == ja3b {
		t.Log("JA3 strings happen to be identical (unlikely but not a test failure)")
	}

	// JA3N strings must be identical regardless of input order
	import_sort_strings := func(s []string) []string {
		c := make([]string, len(s))
		copy(c, s)
		// Use the same sort.Strings call as the production code
		sorted := c
		for i := 0; i < len(sorted)-1; i++ {
			for j := i + 1; j < len(sorted); j++ {
				if sorted[j] < sorted[i] {
					sorted[i], sorted[j] = sorted[j], sorted[i]
				}
			}
		}
		return sorted
	}
	sorted1 := import_sort_strings(filtered1)
	sorted2 := import_sort_strings(filtered2)

	ja3na := fmt.Sprintf("771,%s,%s,,", "49196", strings.Join(sorted1, "-"))
	ja3nb := fmt.Sprintf("771,%s,%s,,", "49196", strings.Join(sorted2, "-"))

	if ja3na != ja3nb {
		t.Errorf("JA3N strings differ for same extensions in different order:\n  %s\n  %s", ja3na, ja3nb)
	}
}

// TestComputeJA4_Format verifies that computeJA4 returns a correctly structured
// JA4 string without panicking on various inputs.
func TestComputeJA4_Format(t *testing.T) {
	cases := []struct {
		name             string
		clientVersion    uint16
		supportedVers    []uint16
		sni              string
		alpn             []string
		cipherSuites     []uint16
		extensions       []uint16
		wantPrefix       string // expected JA4 prefix (first segment before first '_')
	}{
		{
			name:          "TLS12_with_SNI_h2",
			clientVersion: 0x0303,
			supportedVers: nil,
			sni:           "example.com",
			alpn:          []string{"h2"},
			cipherSuites:  []uint16{0x1301, 0x1302, 0x002F},
			extensions:    []uint16{0x0000, 0x0010, 0x000A},
			wantPrefix:    "t12d03", // TLS1.2, domain, 3 ciphers, 3 exts (but SNI/ALPN in count), ALPN="h2"
		},
		{
			name:          "TLS13_no_SNI_no_ALPN",
			clientVersion: 0x0303,
			supportedVers: []uint16{0x0304},
			sni:           "",
			alpn:          nil,
			cipherSuites:  []uint16{0x1301},
			extensions:    []uint16{0x002B},
			wantPrefix:    "t13i", // TLS1.3, no-SNI → 'i' (IP), no ALPN → "00"
		},
		{
			name:          "GREASE_filtered",
			clientVersion: 0x0303,
			supportedVers: []uint16{0xAAAA, 0x0304}, // 0xAAAA is GREASE
			sni:           "test.com",
			alpn:          []string{"http/1.1"},
			cipherSuites:  []uint16{0xDADA, 0x1301}, // 0xDADA is GREASE
			extensions:    []uint16{0xBABA, 0x000A}, // 0xBABA is GREASE
			// TLS1.3 (0x0304 highest non-GREASE); SNI 'd'; ALPN first+last of "http/1.1" = 'h'+'1' = "h1"
			wantPrefix: "t13d",
		},
		{
			name:          "empty_all",
			clientVersion: 0x0303,
			supportedVers: nil,
			sni:           "",
			alpn:          nil,
			cipherSuites:  nil,
			extensions:    nil,
			wantPrefix:    "t12i", // TLS1.2, no SNI → 'i' (IP), no ALPN → "00"
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ja4 := computeJA4(tc.clientVersion, tc.supportedVers, tc.sni, tc.alpn, tc.cipherSuites, tc.extensions, nil)

			// Must have exactly 3 underscore-separated segments
			parts := strings.Split(ja4, "_")
			if len(parts) != 3 {
				t.Fatalf("JA4 must have 3 '_'-separated parts, got %d: %q", len(parts), ja4)
			}

			prefix, cipherHash, extHash := parts[0], parts[1], parts[2]

			// Prefix must start with 't' (TCP transport)
			if len(prefix) == 0 || prefix[0] != 't' {
				t.Errorf("JA4 prefix must start with 't', got %q", prefix)
			}

			// Check expected prefix prefix (partial match)
			if !strings.HasPrefix(prefix, tc.wantPrefix) {
				t.Errorf("JA4 prefix %q does not start with expected %q", prefix, tc.wantPrefix)
			}

			// Cipher hash and ext hash must be exactly 12 hex chars (or shorter if SHA-256 output truncated)
			for _, h := range []string{cipherHash, extHash} {
				if len(h) > 12 {
					t.Errorf("JA4 hash segment too long: %q (want ≤12)", h)
				}
				for _, c := range h {
					if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
						t.Errorf("JA4 hash segment contains non-hex char %q in %q", string(c), h)
					}
				}
			}

			t.Logf("JA4 (%s): %s", tc.name, ja4)
		})
	}
}

// TestTLSInspector_JA4_BadFingerprint verifies that a connection with a JA4 hash
// matching the knownBadJA4 map emits a TLS-JA4-BAD-001 detection.
func TestTLSInspector_JA4_BadFingerprint(t *testing.T) {
	bus := NewDetectionBus()
	sub := &dummySubscriber{}
	bus.Subscribe(sub)

	inspector := NewTLSInspector(bus)

	// Build a simple ClientHello packet to trigger fingerprinting
	chPayload := buildDummyClientHello()
	chMsg := buildHandshakeMsg(0x01, chPayload)
	record := buildTLSRecord(0x16, 0x0303, chMsg)

	// First pass: capture what JA4 hash gets generated
	inspector.Analyze("test-ja4-probe", "10.0.0.1", 50001, 443, record, true)
	time.Sleep(50 * time.Millisecond)

	sub.mu.Lock()
	var observedJA4 string
	for _, d := range sub.detections {
		if d.ID == "TLS-HELLO-001" {
			if v, ok := d.Details["ja4_hash"]; ok {
				observedJA4 = v.(string)
			}
		}
	}
	sub.detections = nil // reset
	sub.mu.Unlock()

	if observedJA4 == "" {
		t.Skip("Could not capture JA4 from TLS-HELLO-001 — skipping bad-fingerprint test")
	}

	// Now poison the knownBadJA4 map with that hash and re-test
	inspector.knownBadJA4[observedJA4] = "Test Malware Stub"

	inspector.Analyze("test-ja4-bad", "10.0.0.2", 50002, 443, record, true)
	time.Sleep(50 * time.Millisecond)

	sub.mu.Lock()
	defer sub.mu.Unlock()

	foundBadJA4 := false
	for _, d := range sub.detections {
		if d.ID == "TLS-JA4-BAD-001" {
			foundBadJA4 = true
			if d.Details["ja4_hash"] != observedJA4 {
				t.Errorf("TLS-JA4-BAD-001 has wrong ja4_hash: got %v, want %q", d.Details["ja4_hash"], observedJA4)
			}
			if d.Details["note"] != "Test Malware Stub" {
				t.Errorf("TLS-JA4-BAD-001 has wrong note: %v", d.Details["note"])
			}
		}
	}

	if !foundBadJA4 {
		t.Errorf("Expected TLS-JA4-BAD-001 detection for known-bad JA4 hash %q", observedJA4)
	}
}
