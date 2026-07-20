// SPDX-License-Identifier: GPL-2.0
// detect/tls_inspect.go — TLS ClientHello deep parsing and JA3 fingerprinting.
// Inspects TLS handshake data to extract SNI, cipher suites, extensions,
// and computes JA3 fingerprints for client identification.

package detect

import (
	"crypto/md5"
	"encoding/binary"
	"fmt"
	"strings"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// TLS Inspector
// ──────────────────────────────────────────────────────────────────────────────

// TLSInspector analyzes TLS handshake traffic.
type TLSInspector struct {
	bus *DetectionBus

	// Weak cipher suite IDs
	weakCiphers map[uint16]string
}

// NewTLSInspector creates a TLS inspector with weak cipher databases.
func NewTLSInspector(bus *DetectionBus) *TLSInspector {
	return &TLSInspector{
		bus: bus,
		weakCiphers: map[uint16]string{
			0x0000: "TLS_NULL_WITH_NULL_NULL",
			0x0001: "TLS_RSA_WITH_NULL_MD5",
			0x0002: "TLS_RSA_WITH_NULL_SHA",
			0x0004: "TLS_RSA_WITH_RC4_128_MD5",
			0x0005: "TLS_RSA_WITH_RC4_128_SHA",
			0x000A: "TLS_RSA_WITH_3DES_EDE_CBC_SHA",
			0x0017: "TLS_DH_anon_EXPORT_WITH_RC4_40_MD5",
			0x0018: "TLS_DH_anon_WITH_RC4_128_MD5",
			0x0019: "TLS_DH_anon_WITH_3DES_EDE_CBC_SHA",
			0x0060: "TLS_RSA_EXPORT1024_WITH_RC4_56_MD5",
			0x0061: "TLS_RSA_EXPORT1024_WITH_RC2_CBC_56_MD5",
			0x0062: "TLS_RSA_EXPORT1024_WITH_DES_CBC_SHA",
			0x0064: "TLS_RSA_EXPORT1024_WITH_RC4_56_SHA",
		},
	}
}

// Analyze inspects TLS data and emits detections.
func (t *TLSInspector) Analyze(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) < 6 {
		return
	}

	// Check for TLS record header
	if data[0] != 0x16 { // Handshake
		return
	}

	// Record layer version
	recordVersion := uint16(data[1])<<8 | uint16(data[2])
	// recordLength := binary.BigEndian.Uint16(data[3:5])

	// Handshake message starts at offset 5
	if len(data) < 6 {
		return
	}

	handshakeType := data[5]

	if fromClient && handshakeType == 0x01 { // ClientHello
		t.parseClientHello(connID, srcIP, srcPort, dstPort, data[5:], recordVersion)
	} else if !fromClient && handshakeType == 0x02 { // ServerHello
		t.parseServerHello(connID, srcIP, srcPort, dstPort, data[5:], recordVersion)
	}
}

// parseClientHello extracts all data from a TLS ClientHello message.
func (t *TLSInspector) parseClientHello(connID, srcIP string, srcPort, dstPort uint16, data []byte, recordVersion uint16) {
	// ClientHello structure:
	// HandshakeType(1) + Length(3) + ClientVersion(2) + Random(32) +
	// SessionIDLength(1) + SessionID(var) + CipherSuitesLength(2) +
	// CipherSuites(var) + CompressionMethodsLength(1) + CompressionMethods(var) +
	// ExtensionsLength(2) + Extensions(var)

	if len(data) < 38 { // Minimum: type(1) + len(3) + version(2) + random(32)
		return
	}

	offset := 1 // Skip handshake type
	// Skip handshake length (3 bytes)
	offset += 3

	// Client version
	clientVersion := binary.BigEndian.Uint16(data[offset : offset+2])
	offset += 2

	// Skip random (32 bytes)
	offset += 32

	// Session ID
	if offset >= len(data) {
		return
	}
	sessionIDLen := int(data[offset])
	offset += 1 + sessionIDLen
	if offset >= len(data) {
		return
	}

	// Cipher suites
	if offset+2 > len(data) {
		return
	}
	cipherSuitesLen := int(binary.BigEndian.Uint16(data[offset : offset+2]))
	offset += 2

	var cipherSuites []uint16
	var cipherStrs []string
	var weakFound []string

	for i := 0; i < cipherSuitesLen && offset+2 <= len(data); i += 2 {
		cs := binary.BigEndian.Uint16(data[offset : offset+2])
		cipherSuites = append(cipherSuites, cs)
		cipherStrs = append(cipherStrs, fmt.Sprintf("%d", cs))

		if name, isWeak := t.weakCiphers[cs]; isWeak {
			weakFound = append(weakFound, name)
		}
		offset += 2
	}

	// Compression methods
	if offset >= len(data) {
		return
	}
	compLen := int(data[offset])
	offset += 1 + compLen

	// Extensions
	var extensions []uint16
	var extensionStrs []string
	var sni string
	var alpn []string
	var ellipticCurves []uint16
	var ecPointFormats []uint8
	var supportedVersions []uint16

	if offset+2 <= len(data) {
		extTotalLen := int(binary.BigEndian.Uint16(data[offset : offset+2]))
		offset += 2
		extEnd := offset + extTotalLen

		for offset+4 <= len(data) && offset < extEnd {
			extType := binary.BigEndian.Uint16(data[offset : offset+2])
			extLen := int(binary.BigEndian.Uint16(data[offset+2 : offset+4]))
			offset += 4

			extensions = append(extensions, extType)
			extensionStrs = append(extensionStrs, fmt.Sprintf("%d", extType))

			extData := data[offset:]
			if extLen > len(extData) {
				break
			}
			extData = extData[:extLen]

			switch extType {
			case 0x0000: // server_name (SNI)
				sni = extractSNI(extData)
			case 0x0010: // ALPN
				alpn = extractALPN(extData)
			case 0x000A: // supported_groups (elliptic_curves)
				ellipticCurves = extractEllipticCurves(extData)
			case 0x000B: // ec_point_formats
				if len(extData) > 1 {
					for _, b := range extData[1:] {
						ecPointFormats = append(ecPointFormats, b)
					}
				}
			case 0x002B: // supported_versions
				supportedVersions = extractSupportedVersions(extData)
			}

			offset += extLen
		}
	}

	// ── Compute JA3 fingerprint ──
	// JA3 = MD5(TLSVersion,Ciphers,Extensions,EllipticCurves,EllipticCurvePointFormats)
	ecStrs := make([]string, len(ellipticCurves))
	for i, ec := range ellipticCurves {
		ecStrs[i] = fmt.Sprintf("%d", ec)
	}
	ecpfStrs := make([]string, len(ecPointFormats))
	for i, pf := range ecPointFormats {
		ecpfStrs[i] = fmt.Sprintf("%d", pf)
	}

	// Filter out GREASE values (0x?A?A pattern)
	filteredCiphers := filterGREASE16(cipherStrs, cipherSuites)
	filteredExts := filterGREASE16(extensionStrs, extensions)
	filteredEC := filterGREASEStr(ecStrs)

	ja3String := fmt.Sprintf("%d,%s,%s,%s,%s",
		clientVersion,
		strings.Join(filteredCiphers, "-"),
		strings.Join(filteredExts, "-"),
		strings.Join(filteredEC, "-"),
		strings.Join(ecpfStrs, "-"),
	)
	ja3Hash := fmt.Sprintf("%x", md5.Sum([]byte(ja3String)))

	// Determine actual TLS version
	actualVersion := tlsVersionString(clientVersion)
	if len(supportedVersions) > 0 {
		// TLS 1.3 advertises via supported_versions extension
		for _, sv := range supportedVersions {
			if sv == 0x0304 {
				actualVersion = "TLS 1.3"
				break
			}
		}
	}

	// ── Emit ClientHello detection ──
	t.bus.EmitDetection(Detection{
		ID:        "TLS-HELLO-001",
		Timestamp: time.Now(),
		Severity:  SevInfo,
		Category:  CatProtocolDetect,
		Protocol:  "TLS",
		SourceIP:  srcIP,
		SourcePort: srcPort,
		DestPort:  dstPort,
		Summary:   fmt.Sprintf("TLS ClientHello: %s, SNI=%s, JA3=%s", actualVersion, sni, ja3Hash),
		ConnID:    connID,
		Details: map[string]any{
			"ja3_hash":           ja3Hash,
			"ja3_string":        truncate(ja3String, 500),
			"tls_version":       actualVersion,
			"record_version":    tlsVersionString(recordVersion),
			"sni":               sni,
			"alpn":              alpn,
			"cipher_suite_count": len(cipherSuites),
			"extension_count":   len(extensions),
			"supported_versions": supportedVersions,
		},
	})

	// ── Weak cipher detection ──
	if len(weakFound) > 0 {
		t.bus.EmitDetection(Detection{
			ID:        "TLS-WEAK-001",
			Timestamp: time.Now(),
			Severity:  SevHigh,
			Category:  CatTLSWeakCipher,
			Protocol:  "TLS",
			SourceIP:  srcIP,
			SourcePort: srcPort,
			DestPort:  dstPort,
			Summary:   fmt.Sprintf("Weak TLS cipher suites offered: %s", strings.Join(weakFound, ", ")),
			ConnID:    connID,
			Details: map[string]any{
				"weak_ciphers": weakFound,
			},
		})
	}

	// ── TLS downgrade detection ──
	if clientVersion <= 0x0301 && len(supportedVersions) == 0 {
		t.bus.EmitDetection(Detection{
			ID:        "TLS-DOWNGRADE",
			Timestamp: time.Now(),
			Severity:  SevHigh,
			Category:  CatTLSDowngrade,
			Protocol:  "TLS",
			SourceIP:  srcIP,
			SourcePort: srcPort,
			DestPort:  dstPort,
			Summary:   fmt.Sprintf("TLS downgrade: client only supports %s", tlsVersionString(clientVersion)),
			ConnID:    connID,
		})
	}
}

// parseServerHello extracts data from a TLS ServerHello message.
func (t *TLSInspector) parseServerHello(connID, srcIP string, srcPort, dstPort uint16, data []byte, recordVersion uint16) {
	if len(data) < 38 {
		return
	}

	offset := 4 // Skip type(1) + length(3)
	serverVersion := binary.BigEndian.Uint16(data[offset : offset+2])
	offset += 2 + 32 // Skip version + random

	// Session ID
	if offset >= len(data) {
		return
	}
	sessionIDLen := int(data[offset])
	offset += 1 + sessionIDLen

	// Selected cipher suite
	if offset+2 > len(data) {
		return
	}
	selectedCipher := binary.BigEndian.Uint16(data[offset : offset+2])

	// JA3S = MD5(TLSVersion,SelectedCipher,Extensions)
	ja3sString := fmt.Sprintf("%d,%d,", serverVersion, selectedCipher)
	ja3sHash := fmt.Sprintf("%x", md5.Sum([]byte(ja3sString)))

	t.bus.EmitDetection(Detection{
		ID:        "TLS-SHELLO-001",
		Timestamp: time.Now(),
		Severity:  SevInfo,
		Category:  CatProtocolDetect,
		Protocol:  "TLS",
		SourceIP:  srcIP,
		SourcePort: srcPort,
		DestPort:  dstPort,
		Summary:   fmt.Sprintf("TLS ServerHello: %s, Cipher=0x%04X, JA3S=%s",
			tlsVersionString(serverVersion), selectedCipher, ja3sHash),
		ConnID: connID,
		Details: map[string]any{
			"ja3s_hash":       ja3sHash,
			"tls_version":     tlsVersionString(serverVersion),
			"selected_cipher": selectedCipher,
		},
	})

	// Check if selected cipher is weak
	if name, isWeak := t.weakCiphers[selectedCipher]; isWeak {
		t.bus.EmitDetection(Detection{
			ID:        "TLS-WEAK-SEL",
			Timestamp: time.Now(),
			Severity:  SevCritical,
			Category:  CatTLSWeakCipher,
			Protocol:  "TLS",
			SourceIP:  srcIP,
			SourcePort: srcPort,
			DestPort:  dstPort,
			Summary:   fmt.Sprintf("Server selected weak cipher: %s", name),
			ConnID:    connID,
		})
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// TLS parsing helpers
// ──────────────────────────────────────────────────────────────────────────────

func extractSNI(data []byte) string {
	// ServerNameList: Length(2) + ServerName entries
	if len(data) < 5 {
		return ""
	}
	// listLen := binary.BigEndian.Uint16(data[0:2])
	nameType := data[2]
	if nameType != 0 { // host_name
		return ""
	}
	nameLen := int(binary.BigEndian.Uint16(data[3:5]))
	if 5+nameLen > len(data) {
		return ""
	}
	return string(data[5 : 5+nameLen])
}

func extractALPN(data []byte) []string {
	if len(data) < 2 {
		return nil
	}
	// listLen := binary.BigEndian.Uint16(data[0:2])
	offset := 2
	var protocols []string
	for offset < len(data) {
		pLen := int(data[offset])
		offset++
		if offset+pLen > len(data) {
			break
		}
		protocols = append(protocols, string(data[offset:offset+pLen]))
		offset += pLen
	}
	return protocols
}

func extractEllipticCurves(data []byte) []uint16 {
	if len(data) < 2 {
		return nil
	}
	// listLen := binary.BigEndian.Uint16(data[0:2])
	offset := 2
	var curves []uint16
	for offset+2 <= len(data) {
		curves = append(curves, binary.BigEndian.Uint16(data[offset:offset+2]))
		offset += 2
	}
	return curves
}

func extractSupportedVersions(data []byte) []uint16 {
	if len(data) < 1 {
		return nil
	}
	listLen := int(data[0])
	offset := 1
	var versions []uint16
	for i := 0; i < listLen && offset+2 <= len(data); i += 2 {
		versions = append(versions, binary.BigEndian.Uint16(data[offset:offset+2]))
		offset += 2
	}
	return versions
}

func tlsVersionString(v uint16) string {
	switch v {
	case 0x0300:
		return "SSL 3.0"
	case 0x0301:
		return "TLS 1.0"
	case 0x0302:
		return "TLS 1.1"
	case 0x0303:
		return "TLS 1.2"
	case 0x0304:
		return "TLS 1.3"
	default:
		return fmt.Sprintf("0x%04X", v)
	}
}

// isGREASE checks if a TLS value is a GREASE (Generate Random Extensions And Sustain Extensibility) value.
func isGREASE(v uint16) bool {
	return v&0x0F0F == 0x0A0A
}

func filterGREASE16(strs []string, vals []uint16) []string {
	var result []string
	for i, v := range vals {
		if !isGREASE(v) {
			result = append(result, strs[i])
		}
	}
	return result
}

func filterGREASEStr(strs []string) []string {
	// For EC curves, already converted to string; just return as-is
	return strs
}
