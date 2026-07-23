// SPDX-License-Identifier: GPL-2.0
// detect/generic_analyzer.go — Catch-all analyzer for protocols that don't
// have dedicated deep analyzers: Telnet, RDP, VNC, LDAP, IMAP, POP3,
// SOCKS, NTP, SNMP, and unknown protocols.

package detect

import (
	"fmt"
	"strings"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// Generic Analyzer
// ──────────────────────────────────────────────────────────────────────────────

// GenericAnalyzer handles protocols without dedicated analyzers.
type GenericAnalyzer struct {
	bus *DetectionBus
}

// NewGenericAnalyzer creates a generic analyzer.
func NewGenericAnalyzer(bus *DetectionBus) *GenericAnalyzer {
	return &GenericAnalyzer{bus: bus}
}

// Analyze inspects data for the given protocol and emits detections.
func (a *GenericAnalyzer) Analyze(connID, srcIP string, srcPort, dstPort uint16, protocol string, data []byte, fromClient bool) {
	if len(data) == 0 {
		return
	}

	proto := strings.ToLower(protocol)
	switch proto {
	case "telnet":
		a.analyzeTelnet(connID, srcIP, srcPort, dstPort, data, fromClient)
	case "rdp":
		a.analyzeRDP(connID, srcIP, srcPort, dstPort, data, fromClient)
	case "vnc":
		a.analyzeVNC(connID, srcIP, srcPort, dstPort, data, fromClient)
	case "ldap", "ldapv3":
		a.analyzeLDAP(connID, srcIP, srcPort, dstPort, data, fromClient)
	case "imap":
		a.analyzeIMAP(connID, srcIP, srcPort, dstPort, data, fromClient)
	case "pop3":
		a.analyzePOP3(connID, srcIP, srcPort, dstPort, data, fromClient)
	case "socks", "socks4", "socks5":
		a.analyzeSOCKS(connID, srcIP, srcPort, dstPort, data, fromClient)
	case "ntp":
		a.analyzeNTP(connID, srcIP, srcPort, dstPort, data, fromClient)
	case "snmp":
		a.analyzeSNMP(connID, srcIP, srcPort, dstPort, data, fromClient)
	default:
		// Unknown protocol — log basic data flow
		a.bus.EmitDetection(Detection{
			ID:         "GEN-FLOW-001",
			Timestamp:  time.Now(),
			Severity:   SevInfo,
			Category:   CatConnLifecycle,
			Protocol:   protocol,
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    fmt.Sprintf("Data flow: %d bytes %s", len(data), directionStr(fromClient)),
			ConnID:     connID,
			Details: map[string]any{
				"bytes":     len(data),
				"direction": directionStr(fromClient),
			},
		})
	}
}

// ── Telnet ──────────────────────────────────────────────────────────────────

func (a *GenericAnalyzer) analyzeTelnet(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	s := string(data)

	// Log text content (potential credential capture — log usernames only)
	if fromClient {
		// Filter out IAC sequences and look for text
		text := filterTelnetIAC(data)
		if len(text) > 0 && len(text) < 200 {
			a.bus.EmitDetection(Detection{
				ID:         "GEN-TELNET-CMD",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "Telnet",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("Telnet input: %s", truncate(string(text), 80)),
				ConnID:     connID,
			})
		}
	} else {
		// Server sending "login:" or "Password:" prompts
		lower := strings.ToLower(s)
		if strings.Contains(lower, "login:") || strings.Contains(lower, "username:") {
			a.bus.EmitDetection(Detection{
				ID:         "GEN-TELNET-LOGIN",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "Telnet",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    "Telnet login prompt detected",
				ConnID:     connID,
			})
		}
		if strings.Contains(lower, "incorrect") || strings.Contains(lower, "failed") ||
			strings.Contains(lower, "invalid") {
			a.bus.EmitDetection(Detection{
				ID:         "GEN-TELNET-AUTHFAIL",
				Timestamp:  time.Now(),
				Severity:   SevMedium,
				Category:   CatBruteForce,
				Protocol:   "Telnet",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    "Telnet authentication failure",
				ConnID:     connID,
			})
		}
	}
}

func filterTelnetIAC(data []byte) []byte {
	var result []byte
	i := 0
	for i < len(data) {
		if data[i] == 0xFF && i+2 < len(data) {
			// Skip IAC + command + option
			i += 3
			continue
		}
		if data[i] >= 32 && data[i] < 127 { // Printable ASCII
			result = append(result, data[i])
		}
		i++
	}
	return result
}

// ── RDP ──────────────────────────────────────────────────────────────────────

func (a *GenericAnalyzer) analyzeRDP(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if fromClient && len(data) >= 4 {
		// TPKT header: Version(0x03) + Reserved(0x00) + Length(2)
		if data[0] == 0x03 && data[1] == 0x00 {
			a.bus.EmitDetection(Detection{
				ID:         "GEN-RDP-CONN",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "RDP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    "RDP connection request",
				ConnID:     connID,
				Details: map[string]any{
					"pkt_size": len(data),
				},
			})

			// Check for NLA (Network Level Authentication)
			if len(data) >= 11 {
				// X.224 Connection Request
				reqFlags := data[len(data)-4 : len(data)]
				_ = reqFlags // NLA detection placeholder
			}
		}
	}
}

// ── VNC ──────────────────────────────────────────────────────────────────────

func (a *GenericAnalyzer) analyzeVNC(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	s := string(data)
	if strings.HasPrefix(s, "RFB ") {
		version := strings.TrimSpace(extractLine(s))
		a.bus.EmitDetection(Detection{
			ID:         "GEN-VNC-VER",
			Timestamp:  time.Now(),
			Severity:   SevInfo,
			Category:   CatProtocolDetect,
			Protocol:   "VNC",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    fmt.Sprintf("VNC version: %s", version),
			ConnID:     connID,
			Details: map[string]any{
				"version":   version,
				"direction": directionStr(fromClient),
			},
		})
	}

	// VNC auth type
	if !fromClient && len(data) >= 2 && !strings.HasPrefix(s, "RFB") {
		if data[0] == 0 && data[1] == 0 {
			a.bus.EmitDetection(Detection{
				ID:         "GEN-VNC-NOAUTH",
				Timestamp:  time.Now(),
				Severity:   SevHigh,
				Category:   CatUnauthAccess,
				Protocol:   "VNC",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    "VNC no authentication required",
				ConnID:     connID,
			})
		}
	}
}

// ── LDAP ─────────────────────────────────────────────────────────────────────

func (a *GenericAnalyzer) analyzeLDAP(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) < 6 {
		return
	}

	a.bus.EmitDetection(Detection{
		ID:         "GEN-LDAP-MSG",
		Timestamp:  time.Now(),
		Severity:   SevInfo,
		Category:   CatConnLifecycle,
		Protocol:   "LDAP",
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		Summary:    fmt.Sprintf("LDAP message: %d bytes %s", len(data), directionStr(fromClient)),
		ConnID:     connID,
	})

	// Check for LDAP injection in text portions
	s := string(data)
	if fromClient && (strings.Contains(s, "*)(") || strings.Contains(s, ")(cn=") ||
		strings.Contains(s, ")(uid=") || strings.Contains(s, ")(objectClass=")) {
		a.bus.EmitDetection(Detection{
			ID:          "GEN-LDAP-INJ",
			Timestamp:   time.Now(),
			Severity:    SevHigh,
			Category:    CatLDAPInjection,
			Protocol:    "LDAP",
			SourceIP:    srcIP,
			SourcePort:  srcPort,
			DestPort:    dstPort,
			Summary:     "LDAP injection pattern detected",
			ConnID:      connID,
			RawEvidence: truncate(s, 150),
		})
	}
}

// ── IMAP ─────────────────────────────────────────────────────────────────────

func (a *GenericAnalyzer) analyzeIMAP(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	s := string(data)

	if fromClient {
		upper := strings.ToUpper(s)
		if strings.Contains(upper, "LOGIN ") {
			a.bus.EmitDetection(Detection{
				ID:         "GEN-IMAP-LOGIN",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "IMAP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    "IMAP LOGIN attempt",
				ConnID:     connID,
			})
		}
	} else {
		if strings.Contains(s, "NO ") && (strings.Contains(strings.ToUpper(s), "LOGIN") ||
			strings.Contains(strings.ToUpper(s), "AUTH")) {
			a.bus.EmitDetection(Detection{
				ID:         "GEN-IMAP-AUTHFAIL",
				Timestamp:  time.Now(),
				Severity:   SevMedium,
				Category:   CatBruteForce,
				Protocol:   "IMAP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    "IMAP authentication failure",
				ConnID:     connID,
			})
		}
	}
}

// ── POP3 ─────────────────────────────────────────────────────────────────────

func (a *GenericAnalyzer) analyzePOP3(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	s := string(data)

	if fromClient {
		upper := strings.ToUpper(s)
		if strings.HasPrefix(upper, "USER ") {
			user := strings.TrimSpace(s[5:])
			a.bus.EmitDetection(Detection{
				ID:         "GEN-POP3-USER",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "POP3",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("POP3 USER: %s", truncate(user, 50)),
				ConnID:     connID,
			})
		}
		if strings.HasPrefix(upper, "PASS ") {
			a.bus.EmitDetection(Detection{
				ID:         "GEN-POP3-PASS",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "POP3",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    "POP3 PASS command (credentials in transit)",
				ConnID:     connID,
			})
		}
	} else {
		if strings.HasPrefix(s, "-ERR") {
			a.bus.EmitDetection(Detection{
				ID:         "GEN-POP3-ERR",
				Timestamp:  time.Now(),
				Severity:   SevMedium,
				Category:   CatBruteForce,
				Protocol:   "POP3",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("POP3 error: %s", truncate(s, 100)),
				ConnID:     connID,
			})
		}
	}
}

// ── SOCKS ────────────────────────────────────────────────────────────────────

func (a *GenericAnalyzer) analyzeSOCKS(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if !fromClient || len(data) < 3 {
		return
	}

	version := data[0]
	protoName := fmt.Sprintf("SOCKS%d", version)

	a.bus.EmitDetection(Detection{
		ID:         "GEN-SOCKS-CONN",
		Timestamp:  time.Now(),
		Severity:   SevInfo,
		Category:   CatConnLifecycle,
		Protocol:   protoName,
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		Summary:    fmt.Sprintf("%s connection request", protoName),
		ConnID:     connID,
		Details: map[string]any{
			"version": version,
		},
	})
}

// ── NTP ──────────────────────────────────────────────────────────────────────

func (a *GenericAnalyzer) analyzeNTP(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) < 48 {
		return
	}

	mode := data[0] & 0x07
	version := (data[0] >> 3) & 0x07

	// Mode 7 = monlist (amplification attack)
	if mode == 7 {
		a.bus.EmitDetection(Detection{
			ID:         "GEN-NTP-MONLIST",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatDDoS,
			Protocol:   "NTP",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    "NTP monlist request (amplification attack vector)",
			ConnID:     connID,
			Details: map[string]any{
				"mode":    mode,
				"version": version,
			},
		})
	} else {
		a.bus.EmitDetection(Detection{
			ID:         "GEN-NTP-REQ",
			Timestamp:  time.Now(),
			Severity:   SevInfo,
			Category:   CatConnLifecycle,
			Protocol:   "NTP",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    fmt.Sprintf("NTPv%d mode %d", version, mode),
			ConnID:     connID,
		})
	}
}

// ── SNMP ─────────────────────────────────────────────────────────────────────

func (a *GenericAnalyzer) analyzeSNMP(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) < 4 {
		return
	}

	a.bus.EmitDetection(Detection{
		ID:         "GEN-SNMP-MSG",
		Timestamp:  time.Now(),
		Severity:   SevInfo,
		Category:   CatConnLifecycle,
		Protocol:   "SNMP",
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		Summary:    "SNMP message detected",
		ConnID:     connID,
	})

	// Check for default community strings in the payload
	s := string(data)
	defaultCommunities := []string{"public", "private", "community", "default"}
	for _, community := range defaultCommunities {
		if strings.Contains(s, community) {
			a.bus.EmitDetection(Detection{
				ID:         "GEN-SNMP-DEFCOMM",
				Timestamp:  time.Now(),
				Severity:   SevHigh,
				Category:   CatUnauthAccess,
				Protocol:   "SNMP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("SNMP default community string: '%s'", community),
				ConnID:     connID,
				Details: map[string]any{
					"community": community,
				},
			})
			break
		}
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

func directionStr(fromClient bool) string {
	if fromClient {
		return "client→server"
	}
	return "server→client"
}
