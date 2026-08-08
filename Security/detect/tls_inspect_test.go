package detect

import (
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
