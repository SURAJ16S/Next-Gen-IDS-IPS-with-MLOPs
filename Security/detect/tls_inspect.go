// SPDX-License-Identifier: GPL-2.0
// detect/tls_inspect.go — TLS deep parsing and JA3/JA3S fingerprinting.
// Includes robust TCP stream reassembly for fragmented records and TLS 1.2
// certificate inspection. Note: TLS 1.3 certificates are encrypted and
// invisible to passive inspection.

package detect

import (
	"crypto/md5"
	"crypto/x509"
	"encoding/binary"
	"fmt"
	"strings"
	"sync"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// TLS Inspector
// ──────────────────────────────────────────────────────────────────────────────

const tlsMaxReassemblyBuf = 32768 // 32KB max buffer to prevent exhaustion

type tlsSession struct {
	mu      sync.Mutex
	connID  string
	srcIP   string
	srcPort uint16
	dstPort uint16

	clientBuf []byte
	serverBuf []byte

	clientHandshakeStream []byte
	serverHandshakeStream []byte

	clientHelloParsed bool
	serverHelloParsed bool
	serverCertParsed  bool

	sni string // Extracted from ClientHello

	clientEncrypted bool
	serverEncrypted bool
}

// TLSInspector analyzes TLS handshake traffic.
type TLSInspector struct {
	bus         *DetectionBus
	weakCiphers map[uint16]string
	knownBadJA3 map[string]string
	sessions    map[string]*tlsSession
	sessionMu   sync.Mutex
}

// NewTLSInspector creates a TLS inspector with weak cipher databases.
func NewTLSInspector(bus *DetectionBus) *TLSInspector {
	t := &TLSInspector{
		bus:      bus,
		sessions: make(map[string]*tlsSession),
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
		knownBadJA3: map[string]string{
			"6734f37431670b3ab4292b8f60f29984": "Trickbot Malware",
			"51c64c77e60f3980eea90869b68c58a8": "Metasploit Meterpreter",
			"e7d705a3286e19ea42f587b344ee6865": "Standard Kali Linux Client",
		},
	}
	bus.Subscribe(t)
	return t
}

func (t *TLSInspector) OnDetection(d Detection) {}

func (t *TLSInspector) OnConnectionClose(c ConnectionRecord) {
	t.sessionMu.Lock()
	delete(t.sessions, c.ConnID)
	t.sessionMu.Unlock()
}

// Analyze inspects TLS data and emits detections.
func (t *TLSInspector) Analyze(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) == 0 {
		return
	}

	t.sessionMu.Lock()
	sess, ok := t.sessions[connID]
	if !ok {
		sess = &tlsSession{
			connID:  connID,
			srcIP:   srcIP,
			srcPort: srcPort,
			dstPort: dstPort,
		}
		t.sessions[connID] = sess
	}
	t.sessionMu.Unlock()

	sess.mu.Lock()
	defer sess.mu.Unlock()

	if fromClient {
		if sess.clientEncrypted || len(sess.clientBuf) > tlsMaxReassemblyBuf {
			return
		}
		sess.clientBuf = append(sess.clientBuf, data...)
		t.extractRecords(sess, true)
		t.parseHandshakeStream(sess, true)
	} else {
		if sess.serverEncrypted || len(sess.serverBuf) > tlsMaxReassemblyBuf {
			return
		}
		sess.serverBuf = append(sess.serverBuf, data...)
		t.extractRecords(sess, false)
		t.parseHandshakeStream(sess, false)
	}
}

func (t *TLSInspector) extractRecords(sess *tlsSession, fromClient bool) {
	buf := sess.clientBuf
	if !fromClient {
		buf = sess.serverBuf
	}

	for len(buf) >= 5 {
		recordType := buf[0]
		recordLen := int(binary.BigEndian.Uint16(buf[3:5]))

		if len(buf) < 5+recordLen {
			break // Need more TCP data for this record
		}

		recordData := buf[5 : 5+recordLen]
		if recordType == 0x16 { // Handshake
			if fromClient {
				sess.clientHandshakeStream = append(sess.clientHandshakeStream, recordData...)
			} else {
				sess.serverHandshakeStream = append(sess.serverHandshakeStream, recordData...)
			}
		} else if recordType == 0x14 || recordType == 0x17 {
			// ChangeCipherSpec or ApplicationData means handshakes are encrypted from now on.
			if fromClient {
				sess.clientEncrypted = true
			} else {
				sess.serverEncrypted = true
			}
		}

		buf = buf[5+recordLen:]
	}

	if fromClient {
		sess.clientBuf = buf
	} else {
		sess.serverBuf = buf
	}
}

func (t *TLSInspector) parseHandshakeStream(sess *tlsSession, fromClient bool) {
	stream := sess.clientHandshakeStream
	if !fromClient {
		stream = sess.serverHandshakeStream
	}

	for len(stream) >= 4 {
		msgType := stream[0]
		msgLen := int(stream[1])<<16 | int(stream[2])<<8 | int(stream[3])

		if len(stream) < 4+msgLen {
			break // Need more record data for this handshake message
		}

		msgData := stream[4 : 4+msgLen]

		if fromClient && msgType == 0x01 && !sess.clientHelloParsed {
			t.parseClientHello(sess, msgData)
			sess.clientHelloParsed = true
		} else if !fromClient {
			if msgType == 0x02 && !sess.serverHelloParsed {
				t.parseServerHello(sess, msgData)
				sess.serverHelloParsed = true
			} else if msgType == 0x0B && !sess.serverCertParsed {
				t.parseCertificate(sess, msgData)
				sess.serverCertParsed = true
			}
		}

		stream = stream[4+msgLen:]
	}

	if fromClient {
		sess.clientHandshakeStream = stream
	} else {
		sess.serverHandshakeStream = stream
	}
}

// parseClientHello extracts all data from a TLS ClientHello message.
func (t *TLSInspector) parseClientHello(sess *tlsSession, data []byte) {
	if len(data) < 34 { // version(2) + random(32)
		return
	}

	offset := 0
	clientVersion := binary.BigEndian.Uint16(data[offset : offset+2])
	offset += 2 + 32 // Skip version + random

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
	hasPSK := false

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
				sess.sni = sni
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
			case 0x0029: // pre_shared_key
				hasPSK = true
			}

			offset += extLen
		}
	}

	// ── Compute JA3 fingerprint ──
	var filteredEC []string
	for _, ec := range ellipticCurves {
		if !isGREASE(ec) {
			filteredEC = append(filteredEC, fmt.Sprintf("%d", ec))
		}
	}

	ecpfStrs := make([]string, len(ecPointFormats))
	for i, pf := range ecPointFormats {
		ecpfStrs[i] = fmt.Sprintf("%d", pf)
	}

	filteredCiphers := filterGREASE16(cipherStrs, cipherSuites)
	filteredExts := filterGREASE16(extensionStrs, extensions)

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
		for _, sv := range supportedVersions {
			if sv == 0x0304 && !isGREASE(sv) {
				actualVersion = "TLS 1.3"
				break
			}
		}
	}

	sessionResumption := (sessionIDLen > 0) || hasPSK

	if ja3Note, found := t.knownBadJA3[ja3Hash]; found {
		t.bus.EmitDetection(Detection{
			ID:         "TLS-JA3-BAD-001",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatTLSKnownBadFingerprint,
			Protocol:   "TLS",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			Summary:    fmt.Sprintf("Malicious TLS Client JA3 detected: %s (%s)", ja3Hash, ja3Note),
			ConnID:     sess.connID,
			Details: map[string]any{
				"ja3_hash":   ja3Hash,
				"ja3_string": truncate(ja3String, 500),
				"note":       ja3Note,
			},
		})
	} else {
		t.bus.EmitDetection(Detection{
			ID:         "TLS-HELLO-001",
			Timestamp:  time.Now(),
			Severity:   SevInfo,
			Category:   CatProtocolDetect,
			Protocol:   "TLS",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			Summary:    fmt.Sprintf("TLS ClientHello: %s, SNI=%s, JA3=%s", actualVersion, sni, ja3Hash),
			ConnID:     sess.connID,
			Details: map[string]any{
				"ja3_hash":                   ja3Hash,
				"ja3_string":                 truncate(ja3String, 500),
				"tls_version":                actualVersion,
				"sni":                        sni,
				"alpn":                       alpn,
				"cipher_suite_count":         len(cipherSuites),
				"extension_count":            len(extensions),
				"supported_versions":         supportedVersions,
				"session_resumption_attempt": sessionResumption,
			},
		})
	}

	if len(weakFound) > 0 {
		t.bus.EmitDetection(Detection{
			ID:         "TLS-WEAK-001",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatTLSWeakCipher,
			Protocol:   "TLS",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			Summary:    fmt.Sprintf("Weak TLS cipher suites offered: %s", strings.Join(weakFound, ", ")),
			ConnID:     sess.connID,
			Details: map[string]any{
				"weak_ciphers": weakFound,
			},
		})
	}

	if clientVersion <= 0x0301 && len(supportedVersions) == 0 {
		t.bus.EmitDetection(Detection{
			ID:         "TLS-DOWNGRADE",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatTLSDowngrade,
			Protocol:   "TLS",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			Summary:    fmt.Sprintf("TLS downgrade: client only supports %s", tlsVersionString(clientVersion)),
			ConnID:     sess.connID,
		})
	}
}

// parseServerHello extracts data from a TLS ServerHello message.
func (t *TLSInspector) parseServerHello(sess *tlsSession, data []byte) {
	if len(data) < 34 { // version(2) + random(32)
		return
	}

	offset := 0
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
	offset += 2

	// Compression
	if offset >= len(data) {
		return
	}
	offset += 1

	// Extensions
	var extensions []uint16
	var extensionStrs []string
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
			offset += extLen
		}
	}

	filteredExts := filterGREASE16(extensionStrs, extensions)

	// JA3S = MD5(TLSVersion,SelectedCipher,Extensions)
	ja3sString := fmt.Sprintf("%d,%d,%s", serverVersion, selectedCipher, strings.Join(filteredExts, "-"))
	ja3sHash := fmt.Sprintf("%x", md5.Sum([]byte(ja3sString)))

	t.bus.EmitDetection(Detection{
		ID:         "TLS-SHELLO-001",
		Timestamp:  time.Now(),
		Severity:   SevInfo,
		Category:   CatProtocolDetect,
		Protocol:   "TLS",
		SourceIP:   sess.srcIP,
		SourcePort: sess.srcPort,
		DestPort:   sess.dstPort,
		Summary: fmt.Sprintf("TLS ServerHello: %s, Cipher=0x%04X, JA3S=%s",
			tlsVersionString(serverVersion), selectedCipher, ja3sHash),
		ConnID: sess.connID,
		Details: map[string]any{
			"ja3s_hash":       ja3sHash,
			"tls_version":     tlsVersionString(serverVersion),
			"selected_cipher": selectedCipher,
			"ja3s_string":     ja3sString,
		},
	})

	if name, isWeak := t.weakCiphers[selectedCipher]; isWeak {
		t.bus.EmitDetection(Detection{
			ID:         "TLS-WEAK-SEL",
			Timestamp:  time.Now(),
			Severity:   SevCritical,
			Category:   CatTLSWeakCipher,
			Protocol:   "TLS",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			Summary:    fmt.Sprintf("Server selected weak cipher: %s", name),
			ConnID:     sess.connID,
		})
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// TLS parsing helpers
// ──────────────────────────────────────────────────────────────────────────────

func extractSNI(data []byte) string {
	if len(data) < 5 {
		return ""
	}
	nameType := data[2]
	if nameType != 0 {
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

// parseCertificate extracts data from a TLS Certificate message.
func (t *TLSInspector) parseCertificate(sess *tlsSession, data []byte) {
	if len(data) < 3 {
		return
	}

	offset := 0
	certsLen := int(data[offset])<<16 | int(data[offset+1])<<8 | int(data[offset+2])
	offset += 3

	if offset+certsLen > len(data) {
		return
	}

	if offset+3 > len(data) {
		return
	}
	certLen := int(data[offset])<<16 | int(data[offset+1])<<8 | int(data[offset+2])
	offset += 3

	if offset+certLen > len(data) {
		return
	}

	certData := data[offset : offset+certLen]

	cert, err := x509.ParseCertificate(certData)
	if err != nil {
		return
	}

	t.bus.EmitDetection(Detection{
		ID:         "TLS-CERT-001",
		Timestamp:  time.Now(),
		Severity:   SevInfo,
		Category:   CatProtocolDetect,
		Protocol:   "TLS",
		SourceIP:   sess.srcIP,
		SourcePort: sess.srcPort,
		DestPort:   sess.dstPort,
		Summary:    fmt.Sprintf("TLS Certificate: Issuer=%s, Subject=%s", cert.Issuer.CommonName, cert.Subject.CommonName),
		ConnID:     sess.connID,
		Details: map[string]any{
			"issuer":     cert.Issuer.String(),
			"subject":    cert.Subject.String(),
			"not_before": cert.NotBefore,
			"not_after":  cert.NotAfter,
			"dns_names":  cert.DNSNames,
			"ip_addrs":   cert.IPAddresses,
		},
	})

	// Rule: Expired Certificate
	if time.Now().After(cert.NotAfter) {
		t.bus.EmitDetection(Detection{
			ID:         "TLS-CERT-EXPIRED",
			Timestamp:  time.Now(),
			Severity:   SevMedium,
			Category:   CatProtocolDetect,
			Protocol:   "TLS",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			Summary:    fmt.Sprintf("Expired TLS Certificate: %s", cert.Subject.CommonName),
			ConnID:     sess.connID,
		})
	}

	// Rule: SNI Mismatch
	if sess.sni != "" {
		if err := cert.VerifyHostname(sess.sni); err != nil {
			t.bus.EmitDetection(Detection{
				ID:         "TLS-SNI-MISMATCH",
				Timestamp:  time.Now(),
				Severity:   SevHigh,
				Category:   CatTLSSNIMismatch,
				Protocol:   "TLS",
				SourceIP:   sess.srcIP,
				SourcePort: sess.srcPort,
				DestPort:   sess.dstPort,
				Summary:    fmt.Sprintf("SNI mismatch: SNI=%s, CertCN=%s", sess.sni, cert.Subject.CommonName),
				ConnID:     sess.connID,
				Details: map[string]any{
					"sni":          sess.sni,
					"cert_cn":      cert.Subject.CommonName,
					"cert_dns":     cert.DNSNames,
				},
			})
		}
	}

	// Rule: Self-Signed Certificate
	if cert.Issuer.String() == cert.Subject.String() {
		t.bus.EmitDetection(Detection{
			ID:         "TLS-CERT-SELFSIGNED",
			Timestamp:  time.Now(),
			Severity:   SevLow,
			Category:   CatProtocolDetect,
			Protocol:   "TLS",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			Summary:    fmt.Sprintf("Self-Signed TLS Certificate: %s", cert.Subject.CommonName),
			ConnID:     sess.connID,
		})
	}

	// Rule: Weak Signature Algorithm
	sigAlg := cert.SignatureAlgorithm.String()
	if strings.Contains(sigAlg, "MD2") || strings.Contains(sigAlg, "MD5") || strings.Contains(sigAlg, "SHA1") {
		t.bus.EmitDetection(Detection{
			ID:         "TLS-CERT-WEAK-SIG",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatProtocolDetect,
			Protocol:   "TLS",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			Summary:    fmt.Sprintf("Weak Certificate Signature Algorithm (%s): %s", sigAlg, cert.Subject.CommonName),
			ConnID:     sess.connID,
		})
	}
}
