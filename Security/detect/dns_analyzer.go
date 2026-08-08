package detect

import (
	"encoding/binary"
	"fmt"
	"math"
	"net"
	"strings"
	"sync"
	"time"
)

const (
	maxDNSBufferSize       = 65534 // Max DNS payload; 65535 prefix triggers malformed
	dnsStateTTL            = 2 * time.Minute
	nxdomainFloodThreshold = 20
	nxdomainFloodWindow    = 60 * time.Second
)

type DNSQueryContext struct {
	QName     string
	QType     uint16
	Timestamp time.Time
}

type DNSTCPState struct {
	buffer       []byte
	lastActivity time.Time
}

type DNSAnalyzer struct {
	bus        *DetectionBus
	mu         sync.Mutex
	tcpStates  map[string]*DNSTCPState
	udpQueries map[string]DNSQueryContext
	nxWindow   map[string][]time.Time
}

func NewDNSAnalyzer(bus *DetectionBus) *DNSAnalyzer {
	a := &DNSAnalyzer{
		bus:        bus,
		tcpStates:  make(map[string]*DNSTCPState),
		udpQueries: make(map[string]DNSQueryContext),
		nxWindow:   make(map[string][]time.Time),
	}
	go a.cleanupRoutine()
	return a
}

func (a *DNSAnalyzer) cleanupRoutine() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		a.cleanup()
	}
}

func (a *DNSAnalyzer) cleanup() {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()

	for connID, state := range a.tcpStates {
		if now.Sub(state.lastActivity) > dnsStateTTL {
			delete(a.tcpStates, connID)
		}
	}
	for key, ctx := range a.udpQueries {
		if now.Sub(ctx.Timestamp) > dnsStateTTL {
			delete(a.udpQueries, key)
		}
	}
	for ip, times := range a.nxWindow {
		var valid []time.Time
		for _, t := range times {
			if now.Sub(t) <= nxdomainFloodWindow {
				valid = append(valid, t)
			}
		}
		if len(valid) == 0 {
			delete(a.nxWindow, ip)
		} else {
			a.nxWindow[ip] = valid
		}
	}
}

func (a *DNSAnalyzer) OnClose(connID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.tcpStates, connID)
}

const (
	dnsTypeA     = 1
	dnsTypeNS    = 2
	dnsTypeCNAME = 5
	dnsTypeSOA   = 6
	dnsTypePTR   = 12
	dnsTypeMX    = 15
	dnsTypeTXT   = 16
	dnsTypeAAAA  = 28
	dnsTypeSRV   = 33
	dnsTypeANY   = 255
	dnsTypeAXFR  = 252
	dnsTypeIXFR  = 251
	dnsTypeNULL  = 10
)

func dnsTypeString(qtype uint16) string {
	switch qtype {
	case dnsTypeA:
		return "A"
	case dnsTypeNS:
		return "NS"
	case dnsTypeCNAME:
		return "CNAME"
	case dnsTypeSOA:
		return "SOA"
	case dnsTypePTR:
		return "PTR"
	case dnsTypeMX:
		return "MX"
	case dnsTypeTXT:
		return "TXT"
	case dnsTypeAAAA:
		return "AAAA"
	case dnsTypeSRV:
		return "SRV"
	case dnsTypeANY:
		return "ANY"
	case dnsTypeAXFR:
		return "AXFR"
	case dnsTypeIXFR:
		return "IXFR"
	case dnsTypeNULL:
		return "NULL"
	default:
		return fmt.Sprintf("TYPE%d", qtype)
	}
}

func dnsRcodeString(rcode uint16) string {
	switch rcode {
	case 0:
		return "NOERROR"
	case 1:
		return "FORMERR"
	case 2:
		return "SERVFAIL"
	case 3:
		return "NXDOMAIN"
	case 4:
		return "NOTIMP"
	case 5:
		return "REFUSED"
	default:
		return fmt.Sprintf("RCODE%d", rcode)
	}
}

func (a *DNSAnalyzer) Analyze(connID, srcIP, dstIP string, srcPort, dstPort uint16, data []byte, fromClient bool, isUDP bool) {
	if len(data) == 0 {
		return
	}

	if isUDP {
		a.processMessage(connID, srcIP, dstIP, srcPort, dstPort, data, fromClient, true)
		return
	}

	a.mu.Lock()
	state, exists := a.tcpStates[connID]
	if !exists {
		state = &DNSTCPState{}
		a.tcpStates[connID] = state
	}
	state.lastActivity = time.Now()

	if len(state.buffer)+len(data) > maxDNSBufferSize {
		a.bus.EmitDetection(Detection{
			ID: "DNS-MALFORM-001", Timestamp: time.Now(), Severity: SevHigh, Category: "protocol-violation", Protocol: "DNS",
			SourceIP: srcIP, SourcePort: srcPort, DestPort: dstPort, ConnID: connID,
			Summary: "TCP stream exceeds max DNS buffer limit",
		})
		state.buffer = nil
		a.mu.Unlock()
		return
	}
	state.buffer = append(state.buffer, data...)
	a.mu.Unlock()

	for {
		a.mu.Lock()
		if len(state.buffer) < 2 {
			a.mu.Unlock()
			break
		}
		msgLen := int(binary.BigEndian.Uint16(state.buffer[:2]))
		if msgLen == 0 {
			// Zero-length TCP DNS frame — skip the prefix and continue
			state.buffer = state.buffer[2:]
			a.mu.Unlock()
			continue
		}
		if msgLen > maxDNSBufferSize {
			a.bus.EmitDetection(Detection{
				ID: "DNS-MALFORM-001", Timestamp: time.Now(), Severity: SevHigh, Category: "protocol-violation", Protocol: "DNS",
				SourceIP: srcIP, SourcePort: srcPort, DestPort: dstPort, ConnID: connID,
				Summary: fmt.Sprintf("Oversized DNS message length prefix: %d bytes", msgLen),
			})
			state.buffer = nil
			a.mu.Unlock()
			return
		}
		if len(state.buffer) < 2+msgLen {
			a.mu.Unlock()
			break
		}
		msgData := make([]byte, msgLen)
		copy(msgData, state.buffer[2:2+msgLen])
		state.buffer = state.buffer[2+msgLen:]
		a.mu.Unlock()

		a.processMessage(connID, srcIP, dstIP, srcPort, dstPort, msgData, fromClient, false)
	}
}

func (a *DNSAnalyzer) processMessage(connID, srcIP, dstIP string, srcPort, dstPort uint16, data []byte, fromClient bool, isUDP bool) {
	if len(data) < 12 {
		a.emitMalformed(connID, srcIP, srcPort, dstPort, "DNS message too short (<12 bytes)")
		return
	}

	txID := binary.BigEndian.Uint16(data[0:2])
	flags := binary.BigEndian.Uint16(data[2:4])
	qdCount := binary.BigEndian.Uint16(data[4:6])
	anCount := binary.BigEndian.Uint16(data[6:8])

	isResponse := (flags & 0x8000) != 0
	opcode := (flags >> 11) & 0x0F
	rcode := flags & 0x000F

	queryOffset := 12
	var queries []struct {
		name  string
		qtype uint16
	}

	for i := 0; i < int(qdCount); i++ {
		name, newOffset, err := parseDNSNameSafe(data, queryOffset)
		if err != nil {
			a.emitMalformed(connID, srcIP, srcPort, dstPort, fmt.Sprintf("Invalid QNAME parsing: %v", err))
			return
		}
		if newOffset+4 > len(data) {
			a.emitMalformed(connID, srcIP, srcPort, dstPort, "Truncated query section")
			return
		}
		qtype := binary.BigEndian.Uint16(data[newOffset : newOffset+2])
		queryOffset = newOffset + 4
		queries = append(queries, struct {
			name  string
			qtype uint16
		}{name, qtype})
	}

	if len(queries) == 0 {
		return
	}

	qname := queries[0].name
	qtype := queries[0].qtype

	transKey := fmt.Sprintf("%v:%v-%v:%v-%v", srcIP, srcPort, dstIP, dstPort, txID)
	if !fromClient {
		transKey = fmt.Sprintf("%v:%v-%v:%v-%v", dstIP, dstPort, srcIP, srcPort, txID)
	}

	if !isResponse {
		a.mu.Lock()
		a.udpQueries[transKey] = DNSQueryContext{QName: qname, QType: qtype, Timestamp: time.Now()}
		a.mu.Unlock()

		a.bus.EmitDetection(Detection{
			ID: "DNS-QUERY-001", Timestamp: time.Now(), Severity: SevInfo, Category: CatConnLifecycle, Protocol: "DNS",
			SourceIP: srcIP, SourcePort: srcPort, DestPort: dstPort, ConnID: connID,
			Summary: fmt.Sprintf("DNS query: %s %s", dnsTypeString(qtype), qname),
			Details: map[string]any{"transaction_id": txID, "qname": qname, "qtype": dnsTypeString(qtype), "opcode": opcode},
		})

		if qtype == dnsTypeAXFR || qtype == dnsTypeIXFR {
			a.bus.EmitDetection(Detection{
				ID: "DNS-AXFR-001", Timestamp: time.Now(), Severity: SevHigh, Category: CatZoneTransfer, Protocol: "DNS",
				SourceIP: srcIP, SourcePort: srcPort, DestPort: dstPort, ConnID: connID,
				Summary: fmt.Sprintf("DNS zone transfer attempt (%s) for: %s", dnsTypeString(qtype), qname),
			})
		}
		if qtype == dnsTypeANY {
			a.bus.EmitDetection(Detection{
				ID: "DNS-AMP-001", Timestamp: time.Now(), Severity: SevMedium, Category: CatDDoS, Protocol: "DNS",
				SourceIP: srcIP, SourcePort: srcPort, DestPort: dstPort, ConnID: connID,
				Summary: fmt.Sprintf("DNS ANY query (amplification risk): %s", qname),
			})
		}
		if qtype == dnsTypeNULL {
			a.bus.EmitDetection(Detection{
				ID: "DNS-NULL-001", Timestamp: time.Now(), Severity: SevHigh, Category: CatDNSTunnel, Protocol: "DNS",
				SourceIP: srcIP, SourcePort: srcPort, DestPort: dstPort, ConnID: connID,
				Summary: fmt.Sprintf("DNS NULL record query (tunneling indicator): %s", qname),
			})
		}

		a.detectTunneling(connID, srcIP, srcPort, dstPort, qname, qtype)
		a.detectDGA(connID, srcIP, srcPort, dstPort, qname)
	} else {
		a.mu.Lock()
		qCtx, exists := a.udpQueries[transKey]
		if exists {
			delete(a.udpQueries, transKey)
			qname = qCtx.QName
			qtype = qCtx.QType
		}
		a.mu.Unlock()

		rcodeStr := dnsRcodeString(rcode)
		a.bus.EmitDetection(Detection{
			ID: "DNS-RESP-001", Timestamp: time.Now(), Severity: SevInfo, Category: CatConnLifecycle, Protocol: "DNS",
			SourceIP: srcIP, SourcePort: srcPort, DestPort: dstPort, ConnID: connID,
			Summary: fmt.Sprintf("DNS response: %s %s → %s (answers: %d)", dnsTypeString(qtype), qname, rcodeStr, anCount),
			Details: map[string]any{"transaction_id": txID, "qname": qname, "rcode": rcodeStr},
		})

		if rcode == 3 {
			// Key by the querying client IP. In a DNS response:
			// - srcIP is the DNS resolver (server)
			// - dstIP is the querying client
			clientIP := dstIP

			a.mu.Lock()
			// Trim entries outside the sliding window inline before counting
			now := time.Now()
			var fresh []time.Time
			for _, t := range a.nxWindow[clientIP] {
				if now.Sub(t) <= nxdomainFloodWindow {
					fresh = append(fresh, t)
				}
			}
			fresh = append(fresh, now)
			a.nxWindow[clientIP] = fresh
			count := len(fresh)
			a.mu.Unlock()

			if count >= nxdomainFloodThreshold {
				a.bus.EmitDetection(Detection{
					ID: "DNS-NXDOMAIN-FLOOD", Timestamp: time.Now(), Severity: SevMedium, Category: CatNXDomainFlood, Protocol: "DNS",
					SourceIP: clientIP, SourcePort: dstPort, DestPort: srcPort, ConnID: connID,
					Summary: fmt.Sprintf("NXDOMAIN flood: %d misses in %s window from %s", count, nxdomainFloodWindow, clientIP),
					Details: map[string]any{"client_ip": clientIP, "nxdomain_count": count, "window": nxdomainFloodWindow.String()},
				})
				a.mu.Lock()
				a.nxWindow[clientIP] = nil
				a.mu.Unlock()
			}
		}

		if anCount > 0 {
			a.checkDNSRebinding(connID, srcIP, srcPort, dstPort, data, queryOffset, anCount, qname)
		}
	}
}

func (a *DNSAnalyzer) emitMalformed(connID, srcIP string, srcPort, dstPort uint16, msg string) {
	a.bus.EmitDetection(Detection{
		ID: "DNS-MALFORM-001", Timestamp: time.Now(), Severity: SevHigh, Category: "protocol-violation", Protocol: "DNS",
		SourceIP: srcIP, SourcePort: srcPort, DestPort: dstPort, ConnID: connID,
		Summary: fmt.Sprintf("Malformed DNS message: %s", msg),
	})
}

func parseDNSNameSafe(data []byte, offset int) (string, int, error) {
	var parts []string
	visited := make(map[int]bool)
	originalOffset := offset
	jumped := false

	for {
		if offset >= len(data) {
			return "", -1, fmt.Errorf("out of bounds")
		}
		if visited[offset] {
			return "", -1, fmt.Errorf("pointer loop detected")
		}
		visited[offset] = true

		length := int(data[offset])
		if length == 0 {
			if !jumped {
				originalOffset = offset + 1
			}
			break
		}

		if length&0xC0 == 0xC0 {
			if offset+1 >= len(data) {
				return "", -1, fmt.Errorf("truncated pointer")
			}
			pointer := int(data[offset]&0x3F)<<8 | int(data[offset+1])
			if !jumped {
				originalOffset = offset + 2
			}
			offset = pointer
			jumped = true
			continue
		}

		if length&0xC0 != 0 {
			return "", -1, fmt.Errorf("invalid label length bits")
		}

		offset++
		if offset+length > len(data) {
			return "", -1, fmt.Errorf("label exceeds bounds")
		}
		parts = append(parts, string(data[offset:offset+length]))
		offset += length
	}

	return strings.Join(parts, "."), originalOffset, nil
}

func (a *DNSAnalyzer) checkDNSRebinding(connID, srcIP string, srcPort, dstPort uint16, data []byte, answerOffset int, anCount uint16, qname string) {
	offset := answerOffset

	for i := 0; i < int(anCount); i++ {
		if offset >= len(data) {
			break
		}

		_, newOffset, err := parseDNSNameSafe(data, offset)
		if err != nil || newOffset < 0 || newOffset+10 > len(data) {
			break
		}

		rtype := binary.BigEndian.Uint16(data[newOffset : newOffset+2])
		rdLength := binary.BigEndian.Uint16(data[newOffset+8 : newOffset+10])
		offset = newOffset + 10

		if rtype == dnsTypeA && rdLength == 4 && offset+4 <= len(data) {
			ip := net.IPv4(data[offset], data[offset+1], data[offset+2], data[offset+3])
			if ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				a.bus.EmitDetection(Detection{
					ID: "DNS-REBIND-001", Timestamp: time.Now(), Severity: SevHigh, Category: CatDNSRebind, Protocol: "DNS",
					SourceIP: srcIP, SourcePort: srcPort, DestPort: dstPort, ConnID: connID,
					Summary: fmt.Sprintf("DNS rebinding: %s resolves to private IP %s", qname, ip.String()),
					Details: map[string]any{"domain": qname, "private_ip": ip.String()},
				})
			}
		} else if rtype == dnsTypeAAAA && rdLength == 16 && offset+16 <= len(data) {
			ip := net.IP(data[offset : offset+16])
			if ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				a.bus.EmitDetection(Detection{
					ID: "DNS-REBIND-001", Timestamp: time.Now(), Severity: SevHigh, Category: CatDNSRebind, Protocol: "DNS",
					SourceIP: srcIP, SourcePort: srcPort, DestPort: dstPort, ConnID: connID,
					Summary: fmt.Sprintf("DNS rebinding: %s resolves to private IPv6 %s", qname, ip.String()),
					Details: map[string]any{"domain": qname, "private_ip": ip.String()},
				})
			}
		}

		offset += int(rdLength)
	}
}

func (a *DNSAnalyzer) detectTunneling(connID, srcIP string, srcPort, dstPort uint16, qname string, qtype uint16) {
	labels := strings.Split(qname, ".")
	if len(labels) < 2 {
		return
	}

	for i := 0; i < len(labels)-2; i++ {
		label := labels[i]
		if len(label) > 30 {
			a.bus.EmitDetection(Detection{
				ID: "DNS-TUN-001", Timestamp: time.Now(), Severity: SevHigh, Category: CatDNSTunnel, Protocol: "DNS",
				SourceIP: srcIP, SourcePort: srcPort, DestPort: dstPort, ConnID: connID,
				Summary: fmt.Sprintf("Long subdomain label (%d chars) — possible DNS tunneling", len(label)),
			})
		}

		entropy := shannonEntropy(label)
		if len(label) > 15 && entropy > 3.5 {
			a.bus.EmitDetection(Detection{
				ID: "DNS-TUN-002", Timestamp: time.Now(), Severity: SevHigh, Category: CatDNSTunnel, Protocol: "DNS",
				SourceIP: srcIP, SourcePort: srcPort, DestPort: dstPort, ConnID: connID,
				Summary: fmt.Sprintf("High-entropy subdomain (%.2f bits) — possible DNS tunneling", entropy),
			})
		}
	}

	if qtype == dnsTypeTXT && len(qname) > 60 {
		a.bus.EmitDetection(Detection{
			ID: "DNS-TUN-003", Timestamp: time.Now(), Severity: SevMedium, Category: CatDNSTunnel, Protocol: "DNS",
			SourceIP: srcIP, SourcePort: srcPort, DestPort: dstPort, ConnID: connID,
			Summary: fmt.Sprintf("Long TXT query (%d chars) — possible DNS tunneling", len(qname)),
		})
	}
}

func (a *DNSAnalyzer) detectDGA(connID, srcIP string, srcPort, dstPort uint16, qname string) {
	labels := strings.Split(qname, ".")
	if len(labels) < 2 {
		return
	}
	sld := labels[len(labels)-2]
	if len(sld) < 8 {
		return
	}

	entropy := shannonEntropy(sld)
	vowelRatio := vowelPercentage(sld)
	hasDigits := strings.ContainsAny(sld, "0123456789")
	hasLetters := strings.ContainsAny(strings.ToLower(sld), "abcdefghijklmnopqrstuvwxyz")

	dgaScore := 0.0
	if entropy > 3.5 {
		dgaScore += 0.3
	}
	if vowelRatio < 0.2 {
		dgaScore += 0.3
	}
	if hasDigits && hasLetters {
		dgaScore += 0.2
	}
	if len(sld) > 12 {
		dgaScore += 0.2
	}

	if dgaScore >= 0.6 {
		a.bus.EmitDetection(Detection{
			ID: "DNS-DGA-001", Timestamp: time.Now(), Severity: SevHigh, Category: CatDGA, Protocol: "DNS",
			SourceIP: srcIP, SourcePort: srcPort, DestPort: dstPort, ConnID: connID,
			Summary: fmt.Sprintf("Possible DGA domain detected (score: %.1f): %s", dgaScore, qname),
		})
	}
}

func shannonEntropy(s string) float64 {
	if len(s) == 0 {
		return 0
	}
	freq := make(map[rune]float64)
	for _, c := range s {
		freq[c]++
	}
	length := float64(len(s))
	entropy := 0.0
	for _, count := range freq {
		p := count / length
		if p > 0 {
			entropy -= p * math.Log2(p)
		}
	}
	return entropy
}

func vowelPercentage(s string) float64 {
	if len(s) == 0 {
		return 0
	}
	vowels := 0
	for _, c := range strings.ToLower(s) {
		if c == 'a' || c == 'e' || c == 'i' || c == 'o' || c == 'u' {
			vowels++
		}
	}
	return float64(vowels) / float64(len(s))
}
