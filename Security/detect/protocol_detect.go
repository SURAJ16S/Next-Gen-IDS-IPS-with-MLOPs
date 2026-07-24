// SPDX-License-Identifier: GPL-2.0
// detect/protocol_detect.go — Magic-byte protocol fingerprinting engine.
// Reads the first bytes of every connection to identify the application
// protocol, even when running on non-standard ports. Flags mismatches
// as potential tunneling/C2 indicators.

package detect

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"strings"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// Protocol Fingerprint result
// ──────────────────────────────────────────────────────────────────────────────

// ProtocolFingerprint is the result of protocol detection.
type ProtocolFingerprint struct {
	Protocol   string  // Detected protocol name (e.g. "HTTP/1.1", "SSH-2.0")
	Confidence float64 // 0.0 — 1.0
	Version    string  // Full version string if extractable
	Mismatch   bool    // Protocol doesn't match expected service for this port
}

// ──────────────────────────────────────────────────────────────────────────────
// ProtocolDetector
// ──────────────────────────────────────────────────────────────────────────────

// ProtocolDetector identifies application protocols from initial connection bytes.
type ProtocolDetector struct {
	bus *DetectionBus
}

// NewProtocolDetector creates a protocol detector.
func NewProtocolDetector(bus *DetectionBus) *ProtocolDetector {
	return &ProtocolDetector{bus: bus}
}

// Detect identifies the protocol from initial data bytes.
// expectedService is the service configured for this port (e.g., "http", "ssh").
func (pd *ProtocolDetector) Detect(data []byte, listenPort uint16, expectedService string) ProtocolFingerprint {
	if len(data) == 0 {
		return ProtocolFingerprint{Protocol: "unknown", Confidence: 0}
	}

	fp := pd.fingerprint(data)

	// Check for protocol/port mismatch
	if fp.Protocol != "unknown" && expectedService != "" {
		fp.Mismatch = !protocolMatchesService(fp.Protocol, expectedService)
	}

	// Emit protocol detection event
	sev := SevInfo
	if fp.Mismatch {
		sev = SevHigh
	}

	det := Detection{
		ID:        "PROTO-DETECT-001",
		Timestamp: time.Now(),
		Severity:  sev,
		Category:  CatProtocolDetect,
		Protocol:  fp.Protocol,
		DestPort:  listenPort,
		Summary:   fmt.Sprintf("Detected protocol: %s (confidence: %.0f%%)", fp.Protocol, fp.Confidence*100),
		Details: map[string]any{
			"detected_protocol": fp.Protocol,
			"confidence":        fp.Confidence,
			"version":           fp.Version,
			"expected_service":  expectedService,
			"mismatch":          fp.Mismatch,
		},
	}

	if fp.Mismatch {
		det.ID = "PROTO-MISMATCH-001"
		det.Category = CatProtoMismatch
		det.Summary = fmt.Sprintf("Protocol mismatch: %s detected on port %d (expected %s) — possible tunneling/C2",
			fp.Protocol, listenPort, expectedService)
	}

	pd.bus.EmitDetection(det)

	return fp
}

// fingerprint performs the actual protocol identification.
func (pd *ProtocolDetector) fingerprint(data []byte) ProtocolFingerprint {
	// Try each detector in priority order (most specific first)

	// ── TLS/SSL (must be before HTTP since HTTPS starts with TLS) ──
	if fp := pd.detectTLS(data); fp.Confidence > 0 {
		return fp
	}

	// ── HTTP ──
	if fp := pd.detectHTTP(data); fp.Confidence > 0 {
		return fp
	}

	// ── SSH ──
	if fp := pd.detectSSH(data); fp.Confidence > 0 {
		return fp
	}

	// ── DNS ──
	if fp := pd.detectDNS(data); fp.Confidence > 0 {
		return fp
	}

	// ── SMTP ──
	if fp := pd.detectSMTP(data); fp.Confidence > 0 {
		return fp
	}

	// ── FTP ──
	if fp := pd.detectFTP(data); fp.Confidence > 0 {
		return fp
	}

	// ── MySQL ──
	if fp := pd.detectMySQL(data); fp.Confidence > 0 {
		return fp
	}

	// ── PostgreSQL ──
	if fp := pd.detectPostgreSQL(data); fp.Confidence > 0 {
		return fp
	}

	// ── Redis ──
	if fp := pd.detectRedis(data); fp.Confidence > 0 {
		return fp
	}

	// ── MongoDB ──
	if fp := pd.detectMongoDB(data); fp.Confidence > 0 {
		return fp
	}

	// ── SOCKS ──
	if fp := pd.detectSOCKS(data); fp.Confidence > 0 {
		return fp
	}

	// ── RDP ──
	if fp := pd.detectRDP(data); fp.Confidence > 0 {
		return fp
	}

	// ── VNC ──
	if fp := pd.detectVNC(data); fp.Confidence > 0 {
		return fp
	}

	// ── IMAP ──
	if fp := pd.detectIMAP(data); fp.Confidence > 0 {
		return fp
	}

	// ── POP3 ──
	if fp := pd.detectPOP3(data); fp.Confidence > 0 {
		return fp
	}

	// ── LDAP ──
	if fp := pd.detectLDAP(data); fp.Confidence > 0 {
		return fp
	}

	// ── Telnet ──
	if fp := pd.detectTelnet(data); fp.Confidence > 0 {
		return fp
	}

	// ── NTP ──
	if fp := pd.detectNTP(data); fp.Confidence > 0 {
		return fp
	}

	// ── SNMP ──
	if fp := pd.detectSNMP(data); fp.Confidence > 0 {
		return fp
	}

	// ── SIP ──
	if fp := pd.detectSIP(data); fp.Confidence > 0 {
		return fp
	}

	// ── DHCP ──
	if fp := pd.detectDHCP(data); fp.Confidence > 0 {
		return fp
	}

	// ── Syslog ──
	if fp := pd.detectSyslog(data); fp.Confidence > 0 {
		return fp
	}

	return ProtocolFingerprint{Protocol: "unknown", Confidence: 0}
}

// ──────────────────────────────────────────────────────────────────────────────
// Individual protocol detectors
// ──────────────────────────────────────────────────────────────────────────────

func (pd *ProtocolDetector) detectTLS(data []byte) ProtocolFingerprint {
	// TLS record: ContentType(1) + Version(2) + Length(2)
	// ContentType 0x16 = Handshake
	// Version: 0x0301 (TLS 1.0), 0x0302 (TLS 1.1), 0x0303 (TLS 1.2/1.3)
	if len(data) >= 3 && data[0] == 0x16 && data[1] == 0x03 {
		version := "unknown"
		switch data[2] {
		case 0x00:
			version = "SSL 3.0"
		case 0x01:
			version = "TLS 1.0"
		case 0x02:
			version = "TLS 1.1"
		case 0x03:
			version = "TLS 1.2/1.3"
		}

		proto := "TLS"
		if data[2] == 0x00 {
			proto = "SSL"
		}

		return ProtocolFingerprint{
			Protocol:   proto,
			Confidence: 0.95,
			Version:    version,
		}
	}

	// SSLv2 ClientHello: first byte is length, second byte 0x01
	if len(data) >= 3 && (data[0]&0x80) != 0 && data[2] == 0x01 {
		return ProtocolFingerprint{
			Protocol:   "SSL",
			Confidence: 0.7,
			Version:    "SSL 2.0",
		}
	}

	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectHTTP(data []byte) ProtocolFingerprint {
	s := string(data)

	// HTTP request methods
	httpMethods := []string{
		"GET ", "POST ", "PUT ", "DELETE ", "HEAD ",
		"OPTIONS ", "PATCH ", "CONNECT ", "TRACE ",
	}

	for _, method := range httpMethods {
		if strings.HasPrefix(s, method) {
			version := "HTTP/1.0"
			if strings.Contains(s, "HTTP/1.1") {
				version = "HTTP/1.1"
			} else if strings.Contains(s, "HTTP/2") {
				version = "HTTP/2"
			}
			return ProtocolFingerprint{
				Protocol:   version,
				Confidence: 0.99,
				Version:    version,
			}
		}
	}

	// HTTP/2 connection preface: "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"
	http2Preface := []byte("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
	if len(data) >= len(http2Preface) && bytes.Equal(data[:len(http2Preface)], http2Preface) {
		return ProtocolFingerprint{
			Protocol:   "HTTP/2",
			Confidence: 1.0,
			Version:    "HTTP/2",
		}
	}

	// HTTP response
	if strings.HasPrefix(s, "HTTP/") {
		version := "HTTP/1.0"
		if strings.HasPrefix(s, "HTTP/1.1") {
			version = "HTTP/1.1"
		}
		return ProtocolFingerprint{
			Protocol:   version,
			Confidence: 0.99,
			Version:    version,
		}
	}

	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectSSH(data []byte) ProtocolFingerprint {
	s := string(data)
	if strings.HasPrefix(s, "SSH-") {
		// Extract version: "SSH-2.0-OpenSSH_8.9"
		version := s
		if idx := strings.Index(s, "\r\n"); idx > 0 {
			version = s[:idx]
		} else if idx := strings.Index(s, "\n"); idx > 0 {
			version = s[:idx]
		}
		if len(version) > 80 {
			version = version[:80]
		}

		return ProtocolFingerprint{
			Protocol:   "SSH-2.0",
			Confidence: 1.0,
			Version:    version,
		}
	}
	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectDNS(data []byte) ProtocolFingerprint {
	// DNS over TCP: 2-byte length prefix + DNS message
	// DNS over UDP: direct DNS message
	// DNS header: ID(2) + Flags(2) + QDCount(2) + ANCount(2) + NSCount(2) + ARCount(2) = 12 bytes

	minLen := 12
	offset := 0

	// Check for TCP DNS (2-byte length prefix)
	if len(data) >= minLen+2 {
		tcpLen := binary.BigEndian.Uint16(data[:2])
		if int(tcpLen) <= len(data)-2 && tcpLen >= uint16(minLen) {
			offset = 2
		}
	}

	if len(data) >= offset+minLen {
		dnsData := data[offset:]
		flags := binary.BigEndian.Uint16(dnsData[2:4])

		// Check reasonable flag values
		opcode := (flags >> 11) & 0x0F
		rcode := flags & 0x0F

		// Opcode should be 0-5, rcode 0-10
		if opcode <= 5 && rcode <= 10 {
			qdCount := binary.BigEndian.Uint16(dnsData[4:6])
			// A valid DNS query usually has 1 question
			if qdCount >= 1 && qdCount <= 100 {
				return ProtocolFingerprint{
					Protocol:   "DNS",
					Confidence: 0.85,
					Version:    "DNS",
				}
			}
		}
	}

	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectSMTP(data []byte) ProtocolFingerprint {
	s := string(data)
	// SMTP server greeting: "220 hostname SMTP ..."
	if strings.HasPrefix(s, "220 ") && (strings.Contains(strings.ToUpper(s), "SMTP") ||
		strings.Contains(strings.ToUpper(s), "ESMTP") ||
		strings.Contains(strings.ToUpper(s), "MAIL")) {
		return ProtocolFingerprint{
			Protocol:   "SMTP",
			Confidence: 0.95,
			Version:    extractLine(s),
		}
	}

	// SMTP client commands
	upper := strings.ToUpper(s)
	if strings.HasPrefix(upper, "EHLO ") || strings.HasPrefix(upper, "HELO ") ||
		strings.HasPrefix(upper, "MAIL FROM:") {
		return ProtocolFingerprint{
			Protocol:   "SMTP",
			Confidence: 0.9,
			Version:    "SMTP",
		}
	}

	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectFTP(data []byte) ProtocolFingerprint {
	s := string(data)
	// FTP server greeting: "220 hostname FTP ..."
	// Distinguished from SMTP by containing "FTP" or known FTP server names
	if strings.HasPrefix(s, "220 ") && !strings.Contains(strings.ToUpper(s), "SMTP") &&
		!strings.Contains(strings.ToUpper(s), "ESMTP") {
		if strings.Contains(strings.ToUpper(s), "FTP") || strings.Contains(s, "vsftpd") ||
			strings.Contains(s, "ProFTPD") || strings.Contains(s, "FileZilla") ||
			strings.Contains(s, "Pure-FTPd") {
			return ProtocolFingerprint{
				Protocol:   "FTP",
				Confidence: 0.9,
				Version:    extractLine(s),
			}
		}
		// Generic 220 greeting - could be FTP or SMTP
		return ProtocolFingerprint{
			Protocol:   "FTP",
			Confidence: 0.5,
			Version:    extractLine(s),
		}
	}

	// FTP client commands
	upper := strings.ToUpper(s)
	if strings.HasPrefix(upper, "USER ") || strings.HasPrefix(upper, "PASS ") ||
		strings.HasPrefix(upper, "LIST") || strings.HasPrefix(upper, "RETR ") ||
		strings.HasPrefix(upper, "STOR ") {
		return ProtocolFingerprint{
			Protocol:   "FTP",
			Confidence: 0.85,
			Version:    "FTP",
		}
	}

	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectMySQL(data []byte) ProtocolFingerprint {
	// MySQL server greeting packet:
	// Length(3) + SeqID(1) + ProtocolVersion(1)
	// Protocol version 10 (0x0a) is standard
	if len(data) >= 5 {
		pktLen := int(data[0]) | int(data[1])<<8 | int(data[2])<<16
		seqID := data[3]
		protoVer := data[4]

		if seqID == 0 && protoVer == 0x0a && pktLen > 0 && pktLen < 65536 {
			// Try to extract server version string
			version := "MySQL"
			if len(data) > 5 {
				verEnd := bytes.IndexByte(data[5:], 0x00)
				if verEnd > 0 && verEnd < 50 {
					version = "MySQL " + string(data[5:5+verEnd])
				}
			}
			return ProtocolFingerprint{
				Protocol:   "MySQL",
				Confidence: 0.9,
				Version:    version,
			}
		}
	}
	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectPostgreSQL(data []byte) ProtocolFingerprint {
	// PostgreSQL startup message: Length(4) + Protocol(4)
	// Protocol version 3.0 = 0x00030000
	if len(data) >= 8 {
		msgLen := binary.BigEndian.Uint32(data[:4])
		proto := binary.BigEndian.Uint32(data[4:8])

		if proto == 0x00030000 && msgLen >= 8 && msgLen <= 10000 {
			return ProtocolFingerprint{
				Protocol:   "PostgreSQL",
				Confidence: 0.9,
				Version:    "PostgreSQL 3.0",
			}
		}

		// SSL request: protocol = 80877103 (0x04D2162F)
		if proto == 80877103 {
			return ProtocolFingerprint{
				Protocol:   "PostgreSQL",
				Confidence: 0.85,
				Version:    "PostgreSQL SSL",
			}
		}
	}

	// Server response: "R" authentication response
	if len(data) > 0 && data[0] == 'R' && len(data) >= 9 {
		return ProtocolFingerprint{
			Protocol:   "PostgreSQL",
			Confidence: 0.7,
			Version:    "PostgreSQL",
		}
	}

	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectRedis(data []byte) ProtocolFingerprint {
	if len(data) == 0 {
		return ProtocolFingerprint{}
	}

	// RESP protocol starts with:
	// * = Array, $ = Bulk String, + = Simple String, - = Error, : = Integer
	switch data[0] {
	case '*', '$', '+', '-', ':':
		s := string(data)
		// Check for common Redis commands in RESP format
		if strings.Contains(s, "PING") || strings.Contains(s, "AUTH") ||
			strings.Contains(s, "INFO") || strings.Contains(s, "SELECT") ||
			strings.HasPrefix(s, "+OK") || strings.HasPrefix(s, "+PONG") ||
			strings.HasPrefix(s, "-ERR") || strings.HasPrefix(s, "$") {
			return ProtocolFingerprint{
				Protocol:   "Redis",
				Confidence: 0.85,
				Version:    "Redis RESP",
			}
		}
		// Generic RESP
		return ProtocolFingerprint{
			Protocol:   "Redis",
			Confidence: 0.6,
			Version:    "Redis RESP",
		}
	}
	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectMongoDB(data []byte) ProtocolFingerprint {
	// MongoDB wire protocol: MsgHeader is 16 bytes minimum
	// Length(4) + RequestID(4) + ResponseTo(4) + OpCode(4)
	if len(data) >= 16 {
		msgLen := int(binary.LittleEndian.Uint32(data[:4]))
		opCode := binary.LittleEndian.Uint32(data[12:16])

		// Valid opcodes: OP_MSG=2013, OP_QUERY=2004, OP_REPLY=1, etc.
		validOps := map[uint32]bool{
			1: true, 2001: true, 2002: true, 2004: true, 2005: true,
			2006: true, 2007: true, 2013: true,
		}

		if msgLen >= 16 && msgLen <= 48*1024*1024 && validOps[opCode] {
			return ProtocolFingerprint{
				Protocol:   "MongoDB",
				Confidence: 0.85,
				Version:    "MongoDB Wire Protocol",
			}
		}
	}
	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectSOCKS(data []byte) ProtocolFingerprint {
	if len(data) >= 3 {
		// SOCKS5: Version(0x05) + NMethods(1) + Methods(N)
		if data[0] == 0x05 && int(data[1]) <= len(data)-2 {
			return ProtocolFingerprint{
				Protocol:   "SOCKS5",
				Confidence: 0.8,
				Version:    "SOCKS5",
			}
		}
		// SOCKS4: Version(0x04) + Command(0x01=CONNECT, 0x02=BIND)
		if data[0] == 0x04 && (data[1] == 0x01 || data[1] == 0x02) {
			return ProtocolFingerprint{
				Protocol:   "SOCKS4",
				Confidence: 0.8,
				Version:    "SOCKS4",
			}
		}
	}
	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectRDP(data []byte) ProtocolFingerprint {
	// RDP uses TPKT: Version(0x03) + Reserved(0x00) + Length(2)
	if len(data) >= 4 && data[0] == 0x03 && data[1] == 0x00 {
		tpktLen := binary.BigEndian.Uint16(data[2:4])
		if tpktLen >= 11 && int(tpktLen) <= len(data) {
			// Check for X.224 Connection Request (0xE0)
			if len(data) >= 7 && data[5] == 0xE0 {
				return ProtocolFingerprint{
					Protocol:   "RDP",
					Confidence: 0.9,
					Version:    "RDP (TPKT+X.224)",
				}
			}
			return ProtocolFingerprint{
				Protocol:   "RDP",
				Confidence: 0.7,
				Version:    "RDP (TPKT)",
			}
		}
	}
	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectVNC(data []byte) ProtocolFingerprint {
	s := string(data)
	if strings.HasPrefix(s, "RFB ") {
		version := extractLine(s)
		return ProtocolFingerprint{
			Protocol:   "VNC",
			Confidence: 0.95,
			Version:    version,
		}
	}
	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectIMAP(data []byte) ProtocolFingerprint {
	s := string(data)
	if strings.HasPrefix(s, "* OK") {
		if strings.Contains(strings.ToUpper(s), "IMAP") {
			return ProtocolFingerprint{
				Protocol:   "IMAP",
				Confidence: 0.9,
				Version:    extractLine(s),
			}
		}
		return ProtocolFingerprint{
			Protocol:   "IMAP",
			Confidence: 0.6,
			Version:    extractLine(s),
		}
	}
	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectPOP3(data []byte) ProtocolFingerprint {
	s := string(data)
	if strings.HasPrefix(s, "+OK") {
		if strings.Contains(strings.ToUpper(s), "POP") {
			return ProtocolFingerprint{
				Protocol:   "POP3",
				Confidence: 0.9,
				Version:    extractLine(s),
			}
		}
		return ProtocolFingerprint{
			Protocol:   "POP3",
			Confidence: 0.6,
			Version:    extractLine(s),
		}
	}
	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectLDAP(data []byte) ProtocolFingerprint {
	// LDAP uses BER/DER encoding: starts with SEQUENCE tag (0x30)
	if len(data) >= 6 && data[0] == 0x30 {
		// Read length
		length := 0
		offset := 1
		if data[1]&0x80 == 0 {
			length = int(data[1])
			offset = 2
		} else {
			numBytes := int(data[1] & 0x7F)
			if numBytes <= 4 && len(data) >= 2+numBytes {
				for i := 0; i < numBytes; i++ {
					length = (length << 8) | int(data[2+i])
				}
				offset = 2 + numBytes
			}
		}

		// Check for LDAP message ID (INTEGER tag = 0x02)
		if length > 0 && offset < len(data) && data[offset] == 0x02 {
			return ProtocolFingerprint{
				Protocol:   "LDAP",
				Confidence: 0.7,
				Version:    "LDAPv3",
			}
		}
	}
	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectTelnet(data []byte) ProtocolFingerprint {
	// Telnet IAC (Interpret As Command) sequences: 0xFF followed by command
	if len(data) >= 3 && data[0] == 0xFF {
		cmd := data[1]
		// Valid Telnet commands: WILL(0xFB), WONT(0xFC), DO(0xFD), DONT(0xFE), SB(0xFA)
		if cmd >= 0xFA && cmd <= 0xFE {
			return ProtocolFingerprint{
				Protocol:   "Telnet",
				Confidence: 0.85,
				Version:    "Telnet",
			}
		}
	}

	// Check for multiple IAC sequences
	iacCount := 0
	for i := 0; i < len(data)-1; i++ {
		if data[i] == 0xFF && data[i+1] >= 0xFA && data[i+1] <= 0xFE {
			iacCount++
		}
	}
	if iacCount >= 2 {
		return ProtocolFingerprint{
			Protocol:   "Telnet",
			Confidence: 0.9,
			Version:    "Telnet",
		}
	}

	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectNTP(data []byte) ProtocolFingerprint {
	// NTP: 48-byte minimum, LI(2 bits) + VN(3 bits) + Mode(3 bits) in first byte
	if len(data) >= 48 {
		li := (data[0] >> 6) & 0x03
		vn := (data[0] >> 3) & 0x07
		mode := data[0] & 0x07

		// Version 1-4, Mode 1-5 (client=3, server=4), LI 0-3
		if vn >= 1 && vn <= 4 && mode >= 1 && mode <= 5 && li <= 3 {
			return ProtocolFingerprint{
				Protocol:   "NTP",
				Confidence: 0.85,
				Version:    fmt.Sprintf("NTPv%d", vn),
			}
		}
	}
	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectSNMP(data []byte) ProtocolFingerprint {
	// SNMP uses ASN.1 BER: starts with SEQUENCE (0x30)
	// followed by INTEGER for version
	if len(data) >= 4 && data[0] == 0x30 {
		// Skip length encoding
		offset := 1
		if data[1]&0x80 == 0 {
			offset = 2
		} else {
			numBytes := int(data[1] & 0x7F)
			offset = 2 + numBytes
		}

		// Check for version INTEGER (0x02) with small value
		if offset < len(data) && data[offset] == 0x02 {
			if offset+2 < len(data) && data[offset+1] == 0x01 {
				version := data[offset+2]
				// SNMPv1=0, SNMPv2c=1, SNMPv3=3
				if version == 0 || version == 1 || version == 3 {
					return ProtocolFingerprint{
						Protocol:   "SNMP",
						Confidence: 0.75,
						Version:    fmt.Sprintf("SNMPv%d", version+1),
					}
				}
			}
		}
	}
	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectSIP(data []byte) ProtocolFingerprint {
	s := string(data)
	sipMethods := []string{"INVITE ", "REGISTER ", "ACK ", "BYE ", "CANCEL ", "OPTIONS ", "SUBSCRIBE "}
	for _, method := range sipMethods {
		if strings.HasPrefix(s, method) {
			return ProtocolFingerprint{
				Protocol:   "SIP",
				Confidence: 0.9,
				Version:    "SIP/2.0",
			}
		}
	}
	if strings.HasPrefix(s, "SIP/2.0") {
		return ProtocolFingerprint{
			Protocol:   "SIP",
			Confidence: 0.95,
			Version:    "SIP/2.0",
		}
	}
	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectDHCP(data []byte) ProtocolFingerprint {
	// DHCP/BOOTP: minimum 240 bytes, magic cookie at offset 236-239 = 0x63825363
	if len(data) >= 240 {
		op := data[0]    // 1=Request, 2=Reply
		htype := data[1] // Hardware type (1=Ethernet)

		if (op == 1 || op == 2) && htype == 1 {
			// Check magic cookie
			cookie := binary.BigEndian.Uint32(data[236:240])
			if cookie == 0x63825363 {
				return ProtocolFingerprint{
					Protocol:   "DHCP",
					Confidence: 0.95,
					Version:    "DHCP",
				}
			}
		}
	}
	return ProtocolFingerprint{}
}

func (pd *ProtocolDetector) detectSyslog(data []byte) ProtocolFingerprint {
	s := string(data)
	// Syslog: starts with <priority> where priority is a number in angle brackets
	if len(s) >= 3 && s[0] == '<' {
		// Find closing bracket
		end := strings.IndexByte(s, '>')
		if end > 1 && end <= 4 {
			// Check if content between < and > is numeric
			numStr := s[1:end]
			isNum := true
			for _, c := range numStr {
				if c < '0' || c > '9' {
					isNum = false
					break
				}
			}
			if isNum {
				return ProtocolFingerprint{
					Protocol:   "Syslog",
					Confidence: 0.75,
					Version:    "Syslog",
				}
			}
		}
	}
	return ProtocolFingerprint{}
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

// protocolMatchesService checks if a detected protocol matches the expected service.
func protocolMatchesService(protocol, service string) bool {
	protocol = strings.ToLower(protocol)
	service = strings.ToLower(service)

	matchMap := map[string][]string{
		"http":          {"http", "http/1.0", "http/1.1", "http/2"},
		"https":         {"tls", "ssl", "http/1.1", "http/2"},
		"ssh":           {"ssh", "ssh-2.0"},
		"dns":           {"dns"},
		"smtp":          {"smtp"},
		"smtps":         {"smtp", "tls", "ssl"},
		"ftp":           {"ftp"},
		"mysql":         {"mysql"},
		"postgresql":    {"postgresql"},
		"redis":         {"redis"},
		"mongodb":       {"mongodb"},
		"ldap":          {"ldap", "ldapv3"},
		"ldaps":         {"ldap", "ldapv3", "tls", "ssl"},
		"imap":          {"imap"},
		"imaps":         {"imap", "tls", "ssl"},
		"pop3":          {"pop3"},
		"pop3s":         {"pop3", "tls", "ssl"},
		"telnet":        {"telnet"},
		"rdp":           {"rdp"},
		"vnc":           {"vnc"},
		"socks":         {"socks4", "socks5"},
		"ntp":           {"ntp"},
		"snmp":          {"snmp"},
		"syslog":        {"syslog"},
		"sip":           {"sip"},
		"dhcp":          {"dhcp"},
		"kerberos":      {"kerberos"},
		"amqp":          {"amqp"},
		"kafka":         {"kafka"},
		"docker":        {"docker", "http", "http/1.1"},
		"k8s-api":       {"tls", "ssl", "http", "http/1.1", "http/2"},
		"kubelet":       {"tls", "ssl", "http", "http/1.1"},
		"smb":           {"smb"},
		"netbios":       {"netbios"},
		"elasticsearch": {"http", "http/1.1"},
		"openvpn":       {"openvpn"},
	}

	if validProtocols, ok := matchMap[service]; ok {
		for _, vp := range validProtocols {
			if strings.Contains(protocol, vp) {
				return true
			}
		}
	}

	return false
}

// extractLine extracts the first line from a string.
func extractLine(s string) string {
	if idx := strings.IndexAny(s, "\r\n"); idx > 0 {
		s = s[:idx]
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}
