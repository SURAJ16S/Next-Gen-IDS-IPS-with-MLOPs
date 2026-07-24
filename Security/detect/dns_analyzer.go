// SPDX-License-Identifier: GPL-2.0
// detect/dns_analyzer.go — DNS traffic analysis.
// Parses DNS queries and responses, detects tunneling, DGA domains,
// DNS rebinding, zone transfer attempts, NXDOMAIN floods, and
// amplification attacks.

package detect

import (
	"encoding/binary"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode"
)

// ──────────────────────────────────────────────────────────────────────────────
// DNS Analyzer
// ──────────────────────────────────────────────────────────────────────────────

// DNSAnalyzer inspects DNS traffic for security-relevant patterns.
type DNSAnalyzer struct {
	bus *DetectionBus
}

// NewDNSAnalyzer creates a DNS analyzer.
func NewDNSAnalyzer(bus *DetectionBus) *DNSAnalyzer {
	return &DNSAnalyzer{bus: bus}
}

// DNS record type constants
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

// dnsTypeString returns a human-readable DNS record type name.
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

// Analyze inspects DNS data and emits detections.
func (a *DNSAnalyzer) Analyze(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) == 0 {
		return
	}

	// Handle DNS over TCP (2-byte length prefix)
	offset := 0
	if len(data) > 14 {
		tcpLen := binary.BigEndian.Uint16(data[:2])
		if int(tcpLen) == len(data)-2 {
			offset = 2
		}
	}

	if len(data)-offset < 12 {
		return // Too short for DNS header
	}

	dnsData := data[offset:]
	a.parseDNS(connID, srcIP, srcPort, dstPort, dnsData, fromClient)
}

// parseDNS parses a DNS message and emits detections.
func (a *DNSAnalyzer) parseDNS(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) < 12 {
		return
	}

	// DNS Header
	txID := binary.BigEndian.Uint16(data[0:2])
	flags := binary.BigEndian.Uint16(data[2:4])
	qdCount := binary.BigEndian.Uint16(data[4:6])
	anCount := binary.BigEndian.Uint16(data[6:8])
	// nsCount := binary.BigEndian.Uint16(data[8:10])
	// arCount := binary.BigEndian.Uint16(data[10:12])

	isResponse := (flags & 0x8000) != 0
	opcode := (flags >> 11) & 0x0F
	rcode := flags & 0x000F

	// Parse questions
	queryOffset := 12
	var queries []struct {
		name  string
		qtype uint16
	}

	for i := 0; i < int(qdCount); i++ {
		name, newOffset := parseDNSName(data, queryOffset)
		if newOffset < 0 || newOffset+4 > len(data) {
			break
		}
		qtype := binary.BigEndian.Uint16(data[newOffset : newOffset+2])
		// qclass := binary.BigEndian.Uint16(data[newOffset+2 : newOffset+4])
		queryOffset = newOffset + 4

		queries = append(queries, struct {
			name  string
			qtype uint16
		}{name, qtype})
	}

	if len(queries) == 0 {
		return
	}

	// First query for convenience
	qname := queries[0].name
	qtype := queries[0].qtype

	// ── Emit query/response metadata ──
	if fromClient && !isResponse {
		a.bus.EmitDetection(Detection{
			ID:         "DNS-QUERY-001",
			Timestamp:  time.Now(),
			Severity:   SevInfo,
			Category:   CatConnLifecycle,
			Protocol:   "DNS",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    fmt.Sprintf("DNS query: %s %s", dnsTypeString(qtype), qname),
			ConnID:     connID,
			Details: map[string]any{
				"transaction_id": txID,
				"qname":          qname,
				"qtype":          dnsTypeString(qtype),
				"qtype_num":      qtype,
				"opcode":         opcode,
				"query_count":    qdCount,
			},
		})
	}

	if isResponse {
		rcodeStr := dnsRcodeString(rcode)
		a.bus.EmitDetection(Detection{
			ID:         "DNS-RESP-001",
			Timestamp:  time.Now(),
			Severity:   SevInfo,
			Category:   CatConnLifecycle,
			Protocol:   "DNS",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    fmt.Sprintf("DNS response: %s %s → %s (answers: %d)", dnsTypeString(qtype), qname, rcodeStr, anCount),
			ConnID:     connID,
			Details: map[string]any{
				"transaction_id": txID,
				"qname":          qname,
				"qtype":          dnsTypeString(qtype),
				"rcode":          rcodeStr,
				"answer_count":   anCount,
			},
		})

		// ── NXDOMAIN tracking ──
		if rcode == 3 { // NXDOMAIN
			a.bus.EmitDetection(Detection{
				ID:         "DNS-NXDOMAIN-001",
				Timestamp:  time.Now(),
				Severity:   SevLow,
				Category:   CatNXDomainFlood,
				Protocol:   "DNS",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("NXDOMAIN for: %s", qname),
				ConnID:     connID,
				Details: map[string]any{
					"qname": qname,
				},
			})
		}

		// ── DNS Rebinding detection: check for private IPs in answers ──
		a.checkDNSRebinding(connID, srcIP, srcPort, dstPort, data, queryOffset, anCount, qname)
	}

	// ── Zone Transfer detection ──
	if qtype == dnsTypeAXFR || qtype == dnsTypeIXFR {
		a.bus.EmitDetection(Detection{
			ID:         "DNS-AXFR-001",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatZoneTransfer,
			Protocol:   "DNS",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    fmt.Sprintf("DNS zone transfer attempt (%s) for: %s", dnsTypeString(qtype), qname),
			ConnID:     connID,
			Details: map[string]any{
				"qname": qname,
				"qtype": dnsTypeString(qtype),
			},
		})
	}

	// ── ANY query (potential amplification) ──
	if qtype == dnsTypeANY {
		a.bus.EmitDetection(Detection{
			ID:         "DNS-AMP-001",
			Timestamp:  time.Now(),
			Severity:   SevMedium,
			Category:   CatDDoS,
			Protocol:   "DNS",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    fmt.Sprintf("DNS ANY query (amplification risk): %s", qname),
			ConnID:     connID,
		})
	}

	// ── NULL record type (tunneling indicator) ──
	if qtype == dnsTypeNULL {
		a.bus.EmitDetection(Detection{
			ID:         "DNS-NULL-001",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatDNSTunnel,
			Protocol:   "DNS",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    fmt.Sprintf("DNS NULL record query (tunneling indicator): %s", qname),
			ConnID:     connID,
		})
	}

	// ── DNS Tunneling detection ──
	a.detectTunneling(connID, srcIP, srcPort, dstPort, qname, qtype)

	// ── DGA detection ──
	a.detectDGA(connID, srcIP, srcPort, dstPort, qname)
}

// detectTunneling checks for DNS tunneling indicators.
func (a *DNSAnalyzer) detectTunneling(connID, srcIP string, srcPort, dstPort uint16, qname string, qtype uint16) {
	labels := strings.Split(qname, ".")
	if len(labels) < 2 {
		return
	}

	// Check subdomain labels (all except the last two: domain + TLD)
	for i := 0; i < len(labels)-2; i++ {
		label := labels[i]

		// ── Long subdomain label (>30 chars) ──
		if len(label) > 30 {
			a.bus.EmitDetection(Detection{
				ID:         "DNS-TUN-001",
				Timestamp:  time.Now(),
				Severity:   SevHigh,
				Category:   CatDNSTunnel,
				Protocol:   "DNS",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("Long subdomain label (%d chars) — possible DNS tunneling", len(label)),
				ConnID:     connID,
				Details: map[string]any{
					"label":        truncate(label, 80),
					"label_length": len(label),
					"full_qname":   truncate(qname, 200),
				},
			})
		}

		// ── High entropy subdomain (base64/hex encoded data) ──
		entropy := shannonEntropy(label)
		if len(label) > 15 && entropy > 3.5 {
			a.bus.EmitDetection(Detection{
				ID:         "DNS-TUN-002",
				Timestamp:  time.Now(),
				Severity:   SevHigh,
				Category:   CatDNSTunnel,
				Protocol:   "DNS",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("High-entropy subdomain (%.2f bits) — possible DNS tunneling", entropy),
				ConnID:     connID,
				Details: map[string]any{
					"label":   truncate(label, 80),
					"entropy": entropy,
					"qname":   truncate(qname, 200),
				},
			})
		}
	}

	// ── Excessive TXT queries (tunneling often uses TXT for larger payloads) ──
	if qtype == dnsTypeTXT {
		// Total QNAME length check
		if len(qname) > 60 {
			a.bus.EmitDetection(Detection{
				ID:         "DNS-TUN-003",
				Timestamp:  time.Now(),
				Severity:   SevMedium,
				Category:   CatDNSTunnel,
				Protocol:   "DNS",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("Long TXT query (%d chars) — possible DNS tunneling", len(qname)),
				ConnID:     connID,
				Details: map[string]any{
					"qname":  truncate(qname, 200),
					"length": len(qname),
				},
			})
		}
	}
}

// detectDGA checks if a domain looks algorithmically generated.
func (a *DNSAnalyzer) detectDGA(connID, srcIP string, srcPort, dstPort uint16, qname string) {
	labels := strings.Split(qname, ".")
	if len(labels) < 2 {
		return
	}

	// Check the second-level domain (SLD)
	sld := labels[len(labels)-2]
	if len(sld) < 8 {
		return // Too short for reliable DGA detection
	}

	// DGA indicators:
	// 1. High entropy
	// 2. No vowel patterns (not a real word)
	// 3. Excessive consonant clusters
	// 4. Mix of digits and letters

	entropy := shannonEntropy(sld)
	vowelRatio := vowelPercentage(sld)
	hasDigits := strings.ContainsAny(sld, "0123456789")
	hasLetters := false
	for _, c := range sld {
		if unicode.IsLetter(c) {
			hasLetters = true
			break
		}
	}

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
			ID:         "DNS-DGA-001",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatDGA,
			Protocol:   "DNS",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    fmt.Sprintf("Possible DGA domain detected (score: %.1f): %s", dgaScore, truncate(qname, 100)),
			ConnID:     connID,
			Details: map[string]any{
				"domain":       qname,
				"sld":          sld,
				"dga_score":    dgaScore,
				"entropy":      entropy,
				"vowel_ratio":  vowelRatio,
				"mixed_alpnum": hasDigits && hasLetters,
			},
		})
	}
}

// checkDNSRebinding looks for private IP addresses in DNS answer records.
func (a *DNSAnalyzer) checkDNSRebinding(connID, srcIP string, srcPort, dstPort uint16, data []byte, answerOffset int, anCount uint16, qname string) {
	offset := answerOffset

	for i := 0; i < int(anCount); i++ {
		if offset >= len(data) {
			break
		}

		// Skip name (could be pointer)
		_, newOffset := parseDNSName(data, offset)
		if newOffset < 0 || newOffset+10 > len(data) {
			break
		}

		rtype := binary.BigEndian.Uint16(data[newOffset : newOffset+2])
		// rclass := binary.BigEndian.Uint16(data[newOffset+2 : newOffset+4])
		// ttl := binary.BigEndian.Uint32(data[newOffset+4 : newOffset+8])
		rdLength := binary.BigEndian.Uint16(data[newOffset+8 : newOffset+10])
		offset = newOffset + 10

		if rtype == dnsTypeA && rdLength == 4 && offset+4 <= len(data) {
			ip := fmt.Sprintf("%d.%d.%d.%d", data[offset], data[offset+1], data[offset+2], data[offset+3])

			// Check for private IP ranges
			if isPrivateIP(ip) {
				a.bus.EmitDetection(Detection{
					ID:         "DNS-REBIND-001",
					Timestamp:  time.Now(),
					Severity:   SevHigh,
					Category:   CatDNSRebind,
					Protocol:   "DNS",
					SourceIP:   srcIP,
					SourcePort: srcPort,
					DestPort:   dstPort,
					Summary:    fmt.Sprintf("DNS rebinding: %s resolves to private IP %s", qname, ip),
					ConnID:     connID,
					Details: map[string]any{
						"domain":     qname,
						"private_ip": ip,
					},
				})
			}
		}

		offset += int(rdLength)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// DNS parsing helpers
// ──────────────────────────────────────────────────────────────────────────────

// parseDNSName parses a DNS name from wire format, handling compression pointers.
func parseDNSName(data []byte, offset int) (string, int) {
	var parts []string
	visited := make(map[int]bool)
	originalOffset := offset
	jumped := false

	for {
		if offset >= len(data) || visited[offset] {
			break
		}
		visited[offset] = true

		length := int(data[offset])
		if length == 0 {
			if !jumped {
				originalOffset = offset + 1
			}
			break
		}

		// Compression pointer: top 2 bits are 11
		if length&0xC0 == 0xC0 {
			if offset+1 >= len(data) {
				return strings.Join(parts, "."), -1
			}
			pointer := int(data[offset]&0x3F)<<8 | int(data[offset+1])
			if !jumped {
				originalOffset = offset + 2
			}
			offset = pointer
			jumped = true
			continue
		}

		offset++
		if offset+length > len(data) {
			break
		}
		parts = append(parts, string(data[offset:offset+length]))
		offset += length
	}

	return strings.Join(parts, "."), originalOffset
}

// dnsRcodeString returns a human-readable DNS RCODE.
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

// shannonEntropy calculates the Shannon entropy of a string.
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

// vowelPercentage returns the fraction of vowels in a string.
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

// isPrivateIP checks if an IP string is in a private/reserved range.
func isPrivateIP(ip string) bool {
	return strings.HasPrefix(ip, "10.") ||
		strings.HasPrefix(ip, "192.168.") ||
		strings.HasPrefix(ip, "127.") ||
		strings.HasPrefix(ip, "0.") ||
		strings.HasPrefix(ip, "169.254.") ||
		(len(ip) > 4 && ip[:4] >= "172." && ip[:4] <= "172." &&
			len(strings.Split(ip, ".")) >= 2)
}
