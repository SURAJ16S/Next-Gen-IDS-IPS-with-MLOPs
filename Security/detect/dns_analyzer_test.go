package detect

import (
	"encoding/binary"
	"strings"
	"sync"
	"testing"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

type mockDNSSubscriber struct {
	mu          sync.Mutex
	detections  []Detection
	onDetection func(d Detection)
}

func (m *mockDNSSubscriber) OnDetection(d Detection) {
	m.mu.Lock()
	m.detections = append(m.detections, d)
	m.mu.Unlock()
	if m.onDetection != nil {
		m.onDetection(d)
	}
}
func (m *mockDNSSubscriber) OnConnectionClose(c ConnectionRecord) {}

func (m *mockDNSSubscriber) countByID(id string) int {
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

func (m *mockDNSSubscriber) countByPrefix(prefix string) int {
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

// createDNSMessage builds a wire-format DNS message for testing.
func createDNSMessage(txID uint16, qname string, qtype uint16, isResponse bool, rcode uint16, answers [][]byte) []byte {
	buf := make([]byte, 12)
	binary.BigEndian.PutUint16(buf[0:2], txID)
	flags := uint16(0)
	if isResponse {
		flags |= 0x8000
	}
	flags |= (rcode & 0x000F)
	binary.BigEndian.PutUint16(buf[2:4], flags)
	binary.BigEndian.PutUint16(buf[4:6], 1)                    // QDCOUNT
	binary.BigEndian.PutUint16(buf[6:8], uint16(len(answers))) // ANCOUNT

	for _, p := range strings.Split(qname, ".") {
		if p != "" {
			buf = append(buf, byte(len(p)))
			buf = append(buf, []byte(p)...)
		}
	}
	buf = append(buf, 0)

	qtypeBuf := make([]byte, 4)
	binary.BigEndian.PutUint16(qtypeBuf[0:2], qtype)
	binary.BigEndian.PutUint16(qtypeBuf[2:4], 1) // IN class
	buf = append(buf, qtypeBuf...)

	for _, ans := range answers {
		buf = append(buf, ans...)
	}
	return buf
}

// encodeAnswerA encodes a DNS A record answer using a compression pointer.
func encodeAnswerA(nameOffset uint16, ip []byte) []byte {
	buf := make([]byte, 16)
	binary.BigEndian.PutUint16(buf[0:2], 0xC000|nameOffset)
	binary.BigEndian.PutUint16(buf[2:4], dnsTypeA)
	binary.BigEndian.PutUint16(buf[4:6], 1)    // IN class
	binary.BigEndian.PutUint32(buf[6:10], 300) // TTL
	binary.BigEndian.PutUint16(buf[10:12], uint16(len(ip)))
	copy(buf[12:], ip)
	return buf
}

// wrapTCP wraps a DNS message with a 2-byte TCP length prefix.
func wrapTCP(msg []byte) []byte {
	out := make([]byte, 2+len(msg))
	binary.BigEndian.PutUint16(out[0:2], uint16(len(msg)))
	copy(out[2:], msg)
	return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: UDP parsing
// ─────────────────────────────────────────────────────────────────────────────

func TestDNSUDP_BasicQueryResponse(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	query := createDNSMessage(0x1234, "example.com", dnsTypeA, false, 0, nil)
	analyzer.Analyze("c1", "10.0.0.1", "1.1.1.1", 12345, 53, query, true, true)

	resp := createDNSMessage(0x1234, "example.com", dnsTypeA, true, 0,
		[][]byte{encodeAnswerA(12, []byte{93, 184, 216, 34})})
	analyzer.Analyze("c1", "1.1.1.1", "10.0.0.1", 53, 12345, resp, false, true)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-QUERY-001") != 1 {
		t.Fatalf("Expected 1 DNS-QUERY-001, got %d", sub.countByID("DNS-QUERY-001"))
	}
	if sub.countByID("DNS-RESP-001") != 1 {
		t.Fatalf("Expected 1 DNS-RESP-001, got %d", sub.countByID("DNS-RESP-001"))
	}
	// Public IP must NOT trigger rebinding
	if sub.countByID("DNS-REBIND-001") != 0 {
		t.Fatalf("Public IP should not trigger rebinding, got %d", sub.countByID("DNS-REBIND-001"))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: TCP reassembly
// ─────────────────────────────────────────────────────────────────────────────

func TestDNSTCP_Reassembly_Fragmented(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	query := createDNSMessage(0x4321, "tcp.example.com", dnsTypeA, false, 0, nil)
	tcp := wrapTCP(query)

	// Send in two fragments - split in the middle of the length prefix itself
	analyzer.Analyze("c2", "10.0.0.1", "1.1.1.1", 12345, 53, tcp[:1], true, false)
	analyzer.Analyze("c2", "10.0.0.1", "1.1.1.1", 12345, 53, tcp[1:5], true, false)
	analyzer.Analyze("c2", "10.0.0.1", "1.1.1.1", 12345, 53, tcp[5:], true, false)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-QUERY-001") != 1 {
		t.Fatalf("Expected 1 query after fragmented reassembly, got %d", sub.countByID("DNS-QUERY-001"))
	}
}

func TestDNSTCP_MultipleMessagesInOneRead(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	q1 := wrapTCP(createDNSMessage(0x0001, "alpha.com", dnsTypeA, false, 0, nil))
	q2 := wrapTCP(createDNSMessage(0x0002, "beta.com", dnsTypeA, false, 0, nil))
	coalesced := append(q1, q2...)

	analyzer.Analyze("c3", "10.0.0.1", "1.1.1.1", 12345, 53, coalesced, true, false)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-QUERY-001") != 2 {
		t.Fatalf("Expected 2 queries from coalesced TCP read, got %d", sub.countByID("DNS-QUERY-001"))
	}
}

func TestDNSTCP_MultipleMessagesSplitAcrossReads(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	q1 := wrapTCP(createDNSMessage(0x0001, "split1.com", dnsTypeA, false, 0, nil))
	q2 := wrapTCP(createDNSMessage(0x0002, "split2.com", dnsTypeA, false, 0, nil))
	combined := append(q1, q2...)

	// Split at a point that cuts across the boundary of the two messages
	mid := len(q1) + 3
	analyzer.Analyze("c4", "10.0.0.1", "1.1.1.1", 12345, 53, combined[:mid], true, false)
	analyzer.Analyze("c4", "10.0.0.1", "1.1.1.1", 12345, 53, combined[mid:], true, false)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-QUERY-001") != 2 {
		t.Fatalf("Expected 2 queries from split-across-reads, got %d", sub.countByID("DNS-QUERY-001"))
	}
}

func TestDNSTCP_OversizedMessagePrefix(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	// A TCP frame claiming to be 65536 bytes (> maxDNSBufferSize)
	bad := make([]byte, 2)
	binary.BigEndian.PutUint16(bad, 0xFFFF) // 65535 OK, but > maxDNSBufferSize triggers malform
	bad[0] = 0xFF                           // force > maxDNSBufferSize
	bad[1] = 0xFF
	// Append a small payload that won't satisfy the claimed length
	bad = append(bad, make([]byte, 10)...)
	analyzer.Analyze("c5", "10.0.0.1", "1.1.1.1", 12345, 53, bad, true, false)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-MALFORM-001") < 1 {
		t.Fatalf("Expected malformed detection for oversized TCP prefix, got %d", sub.countByID("DNS-MALFORM-001"))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3: Query/response correlation
// ─────────────────────────────────────────────────────────────────────────────

func TestDNS_QueryResponseCorrelation(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	// Send query then response with same txID but reversed src/dst
	query := createDNSMessage(0xAAAA, "correlate.com", dnsTypeA, false, 0, nil)
	analyzer.Analyze("cx", "10.0.0.2", "8.8.8.8", 54321, 53, query, true, true)

	resp := createDNSMessage(0xAAAA, "correlate.com", dnsTypeA, true, 0, nil)
	analyzer.Analyze("cx", "8.8.8.8", "10.0.0.2", 53, 54321, resp, false, true)

	time.Sleep(10 * time.Millisecond)
	// Correlation means response summary should contain the original qname
	sub.mu.Lock()
	found := false
	for _, d := range sub.detections {
		if d.ID == "DNS-RESP-001" && strings.Contains(d.Summary, "correlate.com") {
			found = true
		}
	}
	sub.mu.Unlock()
	if !found {
		t.Fatal("Expected DNS-RESP-001 to contain correlated qname 'correlate.com'")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: NXDOMAIN flood detection
// ─────────────────────────────────────────────────────────────────────────────

func TestDNS_NXDOMAINFlood_Positive(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	// Send 20 NXDOMAIN responses directed at a single client
	for i := 0; i < 20; i++ {
		resp := createDNSMessage(uint16(i), "missing.com", dnsTypeA, true, 3, nil)
		// srcIP=DNS_SERVER, dstIP=CLIENT — flood keyed on dstIP (client)
		analyzer.Analyze("cf", "1.1.1.1", "10.0.0.5", 53, 12345, resp, false, true)
	}

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-NXDOMAIN-FLOOD") != 1 {
		t.Fatalf("Expected 1 NXDOMAIN flood detection, got %d", sub.countByID("DNS-NXDOMAIN-FLOOD"))
	}
}

func TestDNS_NXDOMAINFlood_Negative_BelowThreshold(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	// Only 19 — should not trigger
	for i := 0; i < 19; i++ {
		resp := createDNSMessage(uint16(i), "miss.com", dnsTypeA, true, 3, nil)
		analyzer.Analyze("cn", "1.1.1.1", "10.0.0.6", 53, 12345, resp, false, true)
	}

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-NXDOMAIN-FLOOD") != 0 {
		t.Fatalf("19 NXDOMAINs must not trigger flood, got %d", sub.countByID("DNS-NXDOMAIN-FLOOD"))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: DNS rebinding detection
// ─────────────────────────────────────────────────────────────────────────────

func TestDNS_Rebinding_PrivateIPv4(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	resp := createDNSMessage(0x5555, "evil.com", dnsTypeA, true, 0,
		[][]byte{encodeAnswerA(12, []byte{192, 168, 1, 100})})
	analyzer.Analyze("cr1", "1.1.1.1", "10.0.0.1", 53, 12345, resp, false, true)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-REBIND-001") != 1 {
		t.Fatalf("Expected rebinding detection for 192.168.x.x, got %d", sub.countByID("DNS-REBIND-001"))
	}
}

func TestDNS_Rebinding_Loopback(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	resp := createDNSMessage(0x5556, "evil2.com", dnsTypeA, true, 0,
		[][]byte{encodeAnswerA(12, []byte{127, 0, 0, 1})})
	analyzer.Analyze("cr2", "1.1.1.1", "10.0.0.1", 53, 12345, resp, false, true)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-REBIND-001") != 1 {
		t.Fatalf("Expected rebinding detection for 127.0.0.1, got %d", sub.countByID("DNS-REBIND-001"))
	}
}

func TestDNS_Rebinding_LinkLocal(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	resp := createDNSMessage(0x5557, "evil3.com", dnsTypeA, true, 0,
		[][]byte{encodeAnswerA(12, []byte{169, 254, 1, 1})})
	analyzer.Analyze("cr3", "1.1.1.1", "10.0.0.1", 53, 12345, resp, false, true)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-REBIND-001") != 1 {
		t.Fatalf("Expected rebinding detection for 169.254.x.x, got %d", sub.countByID("DNS-REBIND-001"))
	}
}

func TestDNS_Rebinding_Negative_PublicIP(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	// Public IP — must NOT trigger
	resp := createDNSMessage(0x5558, "legit.com", dnsTypeA, true, 0,
		[][]byte{encodeAnswerA(12, []byte{8, 8, 8, 8})})
	analyzer.Analyze("cr4", "1.1.1.1", "10.0.0.1", 53, 12345, resp, false, true)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-REBIND-001") != 0 {
		t.Fatalf("Public IP should not trigger rebinding, got %d", sub.countByID("DNS-REBIND-001"))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6: Tunneling detection
// ─────────────────────────────────────────────────────────────────────────────

func TestDNS_Tunneling_LongLabel(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	// Label >30 chars should trigger DNS-TUN-001
	query := createDNSMessage(0x6001, "thisisaverylongsubdomainnamethatwillbeflagged.example.com", dnsTypeA, false, 0, nil)
	analyzer.Analyze("ct1", "10.0.0.1", "1.1.1.1", 12345, 53, query, true, true)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-TUN-001") < 1 {
		t.Fatalf("Expected DNS-TUN-001 for long label, got %d", sub.countByID("DNS-TUN-001"))
	}
}

func TestDNS_Tunneling_LongTXT(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	// TXT query with qname > 60 chars triggers DNS-TUN-003
	query := createDNSMessage(0x6002, "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz.example.com", dnsTypeTXT, false, 0, nil)
	analyzer.Analyze("ct2", "10.0.0.1", "1.1.1.1", 12345, 53, query, true, true)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-TUN-003") < 1 {
		t.Fatalf("Expected DNS-TUN-003 for long TXT qname, got %d", sub.countByID("DNS-TUN-003"))
	}
}

func TestDNS_Tunneling_Negative(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	// Normal short domain — must not trigger tunneling
	query := createDNSMessage(0x6003, "google.com", dnsTypeA, false, 0, nil)
	analyzer.Analyze("ct3", "10.0.0.1", "1.1.1.1", 12345, 53, query, true, true)

	time.Sleep(10 * time.Millisecond)
	if sub.countByPrefix("DNS-TUN") != 0 {
		t.Fatalf("Short normal domain must not trigger tunneling, got %d", sub.countByPrefix("DNS-TUN"))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7: DGA detection
// ─────────────────────────────────────────────────────────────────────────────

func TestDNS_DGA_Positive(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	// High entropy, mixed digits+letters, no vowels, long SLD
	query := createDNSMessage(0x7001, "q1w2r4t5y6p7.com", dnsTypeA, false, 0, nil)
	analyzer.Analyze("cd1", "10.0.0.1", "1.1.1.1", 12345, 53, query, true, true)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-DGA-001") != 1 {
		t.Fatalf("Expected DGA detection, got %d", sub.countByID("DNS-DGA-001"))
	}
}

func TestDNS_DGA_Negative_LegitDomain(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	// Legitimate-looking domain: has vowels, reasonable entropy
	query := createDNSMessage(0x7002, "wikipedia.org", dnsTypeA, false, 0, nil)
	analyzer.Analyze("cd2", "10.0.0.1", "1.1.1.1", 12345, 53, query, true, true)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-DGA-001") != 0 {
		t.Fatalf("Legitimate domain must not trigger DGA, got %d", sub.countByID("DNS-DGA-001"))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8: Malformed DNS
// ─────────────────────────────────────────────────────────────────────────────

func TestDNS_Malformed_TooShort(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	analyzer.Analyze("cm1", "10.0.0.1", "1.1.1.1", 12345, 53, []byte{1, 2, 3}, true, true)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-MALFORM-001") != 1 {
		t.Fatalf("Expected malformed for too-short message, got %d", sub.countByID("DNS-MALFORM-001"))
	}
}

func TestDNS_Malformed_NoPanic(t *testing.T) {
	bus := NewDetectionBus()
	bus.Subscribe(&mockDNSSubscriber{})
	analyzer := NewDNSAnalyzer(bus)

	// Various malformed payloads must not panic
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Analyzer panicked on malformed input: %v", r)
		}
	}()

	analyzer.Analyze("cm2", "10.0.0.1", "1.1.1.1", 12345, 53, []byte{}, true, true)
	analyzer.Analyze("cm3", "10.0.0.1", "1.1.1.1", 12345, 53, make([]byte, 12), true, true) // all-zero header
	analyzer.Analyze("cm4", "10.0.0.1", "1.1.1.1", 12345, 53, make([]byte, 256), true, true)
	// Compression pointer loop
	loop := make([]byte, 14)
	binary.BigEndian.PutUint16(loop[4:6], 1) // 1 question
	loop[12] = 0xC0                          // pointer
	loop[13] = 0x0C                          // pointing to offset 12 = loop
	analyzer.Analyze("cm5", "10.0.0.1", "1.1.1.1", 12345, 53, loop, true, true)
}

func TestDNS_Malformed_ZeroLengthTCP(t *testing.T) {
	bus := NewDetectionBus()
	sub := &mockDNSSubscriber{}
	bus.Subscribe(sub)
	analyzer := NewDNSAnalyzer(bus)

	// Zero-length TCP prefix should not hang or panic
	zeroPfx := []byte{0, 0}
	realMsg := wrapTCP(createDNSMessage(0x9999, "after.com", dnsTypeA, false, 0, nil))
	combined := append(zeroPfx, realMsg...)
	analyzer.Analyze("cmz", "10.0.0.1", "1.1.1.1", 12345, 53, combined, true, false)

	time.Sleep(10 * time.Millisecond)
	if sub.countByID("DNS-QUERY-001") != 1 {
		t.Fatalf("Expected 1 query after zero-length prefix skip, got %d", sub.countByID("DNS-QUERY-001"))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9: Session cleanup and TTL
// ─────────────────────────────────────────────────────────────────────────────

func TestDNS_OnClose_CleansState(t *testing.T) {
	bus := NewDetectionBus()
	bus.Subscribe(&mockDNSSubscriber{})
	analyzer := NewDNSAnalyzer(bus)

	// Create TCP state
	q := wrapTCP(createDNSMessage(0x1111, "cleanup.com", dnsTypeA, false, 0, nil))
	analyzer.Analyze("cclose", "10.0.0.1", "1.1.1.1", 12345, 53, q[:3], true, false)

	analyzer.mu.Lock()
	_, exists := analyzer.tcpStates["cclose"]
	analyzer.mu.Unlock()
	if !exists {
		t.Fatal("TCP state should exist after partial read")
	}

	analyzer.OnClose("cclose")

	analyzer.mu.Lock()
	_, exists = analyzer.tcpStates["cclose"]
	analyzer.mu.Unlock()
	if exists {
		t.Fatal("TCP state should be cleaned up after OnClose")
	}
}

func TestDNS_TTL_CleanupExpired(t *testing.T) {
	bus := NewDetectionBus()
	bus.Subscribe(&mockDNSSubscriber{})
	analyzer := NewDNSAnalyzer(bus)

	// Manually insert stale TCP state
	analyzer.mu.Lock()
	analyzer.tcpStates["stale"] = &DNSTCPState{
		buffer:       []byte{1, 2, 3},
		lastActivity: time.Now().Add(-3 * time.Minute), // older than 2-min TTL
	}
	analyzer.mu.Unlock()

	analyzer.cleanup()

	analyzer.mu.Lock()
	_, exists := analyzer.tcpStates["stale"]
	analyzer.mu.Unlock()
	if exists {
		t.Fatal("Stale TCP state should be removed by TTL cleanup")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 10: Concurrent access / race detection
// ─────────────────────────────────────────────────────────────────────────────

func TestDNS_Concurrent(t *testing.T) {
	bus := NewDetectionBus()
	bus.Subscribe(&mockDNSSubscriber{})
	analyzer := NewDNSAnalyzer(bus)

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			q := createDNSMessage(uint16(n), "concurrent.com", dnsTypeA, false, 0, nil)
			analyzer.Analyze("cc", "10.0.0.1", "1.1.1.1", 12345, 53, q, true, true)
		}(i)
	}
	wg.Wait()
}
