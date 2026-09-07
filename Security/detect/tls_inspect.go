// SPDX-License-Identifier: GPL-2.0
// detect/tls_inspect.go — TLS deep parsing, JA3/JA3N/JA3S/JA4 fingerprinting.
// Includes robust TCP stream reassembly for fragmented records and TLS 1.2
// certificate inspection. Note: TLS 1.3 certificates are encrypted and
// invisible to passive inspection.
//
// Fingerprint hierarchy:
//   JA3   — MD5 of (version,ciphers,extensions,curves,ecpf) in wire order
//   JA3N  — Same as JA3 but extensions sorted before hashing (Chrome-stable)
//   JA3S  — MD5 of (version,selectedCipher,extensions) from ServerHello
//   JA4   — FoxIO two-part SHA-256 prefix fingerprint (Chrome 110+ stable)

package detect

import (
	"crypto/md5"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
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
	knownBadJA3 map[string]string // JA3 MD5 hash → threat label
	knownBadJA4 map[string]string // JA4 fingerprint → threat label
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
		// knownBadJA4 is populated from the FoxIO JA4+ threat-intel database.
		// JA4 fingerprints are stable across Chrome 110+ (extension-order randomisation
		// does not affect them) and are the preferred feed format going forward.
		// Feed: https://github.com/FoxIO-LLC/ja4/tree/main/technical_details
		// Redis key: rep:feed:ja4_bad  (populated by feed_ingest job)
		knownBadJA4: map[string]string{
			// Example entries — replace with live FoxIO feed data.
			// Format: "t13d<N><N>h2_<12hexchars>_<12hexchars>" : "<threat label>"
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
	var signatureAlgorithms []uint16 // parsed for JA4 extension hash (Bug #2 fix)
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
			case 0x000D: // signature_algorithms — required in JA4 extension hash (FoxIO spec §ext-hash)
				signatureAlgorithms = extractSignatureAlgorithms(extData)
			case 0x002B: // supported_versions
				supportedVersions = extractSupportedVersions(extData)
			case 0x0029: // pre_shared_key
				hasPSK = true
			}

			offset += extLen
		}
	}

	// ── Compute JA3 fingerprint (wire order — do NOT sort; preserves feed compatibility) ──
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
	filteredExts := filterGREASE16(extensionStrs, extensions) // wire order — unchanged for JA3

	ja3String := fmt.Sprintf("%d,%s,%s,%s,%s",
		clientVersion,
		strings.Join(filteredCiphers, "-"),
		strings.Join(filteredExts, "-"),
		strings.Join(filteredEC, "-"),
		strings.Join(ecpfStrs, "-"),
	)
	ja3Hash := fmt.Sprintf("%x", md5.Sum([]byte(ja3String)))

	// ── Compute JA3N fingerprint (sorted extensions — Chrome 110+ stable) ──
	// JA3N is identical to JA3 except extension types are sorted **numerically**
	// before joining. This neutralises Chrome's ClientHello extension-order
	// randomisation introduced in Chrome 110 (early 2023). Attack-tool stacks
	// (sqlmap, scripts, malware) typically use static TLS implementations and
	// produce identical JA3 and JA3N values.
	//
	// Bug #7 fix: sort numerically, not lexicographically. Lexicographic sort on
	// decimal strings breaks for values ≥ 10 (e.g. "9" > "10" as strings).
	sortedExtVals := make([]uint16, 0, len(filteredExts))
	for _, s := range filteredExts {
		v, _ := strconv.ParseUint(s, 10, 16)
		sortedExtVals = append(sortedExtVals, uint16(v))
	}
	sort.Slice(sortedExtVals, func(i, j int) bool { return sortedExtVals[i] < sortedExtVals[j] })
	sortedExts := make([]string, len(sortedExtVals))
	for i, v := range sortedExtVals {
		sortedExts[i] = fmt.Sprintf("%d", v)
	}
	ja3nString := fmt.Sprintf("%d,%s,%s,%s,%s",
		clientVersion,
		strings.Join(filteredCiphers, "-"),
		strings.Join(sortedExts, "-"),
		strings.Join(filteredEC, "-"),
		strings.Join(ecpfStrs, "-"),
	)
	ja3nHash := fmt.Sprintf("%x", md5.Sum([]byte(ja3nString)))

	// ── Determine actual TLS version ──
	actualVersion := tlsVersionString(clientVersion)
	if len(supportedVersions) > 0 {
		for _, sv := range supportedVersions {
			if sv == 0x0304 && !isGREASE(sv) {
				actualVersion = "TLS 1.3"
				break
			}
		}
	}

	// ── Compute JA4 fingerprint (FoxIO spec, 2023) ──
	// JA4 format: {a}_{b}_{c}
	//   a = t{tlsVer}{sniFlag}{cipherCount:02}{extCount:02}{alpnFirstLast}
	//   b = SHA-256[:12] of sorted comma-joined GREASE-filtered cipher hex codes
	//   c = SHA-256[:12] of (sorted ext hex codes)_(sorted sig-alg hex codes)
	ja4Hash := computeJA4(clientVersion, supportedVersions, sni, alpn, cipherSuites, extensions, signatureAlgorithms)

	sessionResumption := (sessionIDLen > 0) || hasPSK

	// ── Emit TLS-JA3-BAD-001 if JA3 matches known-bad feed ──
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
				"ja3n_hash":  ja3nHash,
				"ja4_hash":   ja4Hash,
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
			Summary:    fmt.Sprintf("TLS ClientHello: %s, SNI=%s, JA3=%s JA4=%s", actualVersion, sni, ja3Hash, ja4Hash),
			ConnID:     sess.connID,
			Details: map[string]any{
				"ja3_hash":                   ja3Hash,
				"ja3_string":                 truncate(ja3String, 500),
				"ja3n_hash":                  ja3nHash,
				"ja4_hash":                   ja4Hash,
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

	// ── Emit TLS-JA4-BAD-001 if JA4 matches known-bad feed ──
	// This fires independently of the JA3 check so both can alert on the same
	// connection without one suppressing the other.
	if ja4Note, found := t.knownBadJA4[ja4Hash]; found {
		t.bus.EmitDetection(Detection{
			ID:         "TLS-JA4-BAD-001",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatTLSKnownBadFingerprint,
			Protocol:   "TLS",
			SourceIP:   sess.srcIP,
			SourcePort: sess.srcPort,
			DestPort:   sess.dstPort,
			Summary:    fmt.Sprintf("Malicious TLS Client JA4 detected: %s (%s)", ja4Hash, ja4Note),
			ConnID:     sess.connID,
			Details: map[string]any{
				"ja4_hash":   ja4Hash,
				"ja3_hash":   ja3Hash,
				"ja3n_hash":  ja3nHash,
				"note":       ja4Note,
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

// extractSignatureAlgorithms parses the signature_algorithms extension (type 0x000D).
// Format: 2-byte total list length, followed by 2-byte SignatureScheme values.
// Required for correct JA4 extension hash (FoxIO spec: ext_hash = SHA-256(ext_types_"_"_sig_algs)).
func extractSignatureAlgorithms(data []byte) []uint16 {
	if len(data) < 2 {
		return nil
	}
	listLen := int(binary.BigEndian.Uint16(data[0:2]))
	offset := 2
	var schemes []uint16
	for i := 0; i < listLen && offset+2 <= len(data); i += 2 {
		schemes = append(schemes, binary.BigEndian.Uint16(data[offset:offset+2]))
		offset += 2
	}
	return schemes
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

// ── JA4 fingerprint implementation ────────────────────────────────────────────
// Spec: https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md
//
// JA4 format: {prefix}_{cipherHash}_{extHash}
//
//	{prefix}     = t{tlsVer}{sniFlag}{cipherCount:02}{extCount:02}{alpnFirstLast}
//	{cipherHash} = SHA-256[:12] of comma-joined sorted 4-char lowercase hex cipher codes
//	{extHash}    = SHA-256[:12] of:
//	                 (sorted 4-char hex ext types, SNI+ALPN excluded)
//	                 _ (sorted 4-char hex sig-alg scheme values)
//
// Fixes applied vs. initial implementation:
//	#1  Ciphers use 4-char lowercase hex (was: 5-char decimal)
//	#2  Signature algorithms appended to ext hash input after "_" separator
//	#3  Extension types use 4-char lowercase hex (was: 5-char decimal)
//	#4  SNI-absent flag is "i" (IP), not "n" (spec §SNI)
//	#5  ALPN token is first+last char of first protocol, not first 2 chars
//
// All fields are computed from already-parsed ClientHello data — no additional
// parsing needed. The function is pure (no side-effects) so it is easily testable.
func computeJA4(
	clientVersion uint16,
	supportedVersions []uint16,
	sni string,
	alpn []string,
	cipherSuites []uint16,
	extensions []uint16,
	sigAlgs []uint16, // signature_algorithms extension values (ext type 0x000D)
) string {
	// ── 1. Determine TLS version token ──────────────────────────────────────
	// Prefer the highest non-GREASE supported_versions entry; fall back to the
	// ClientHello legacy_version field. (Spec: handshake version is ignored.)
	effectiveVer := clientVersion
	for _, sv := range supportedVersions {
		if !isGREASE(sv) && sv > effectiveVer {
			effectiveVer = sv
		}
	}
	verToken := ja4TLSVersionToken(effectiveVer)

	// ── 2. SNI flag ──────────────────────────────────────────────────────────
	// FoxIO spec §SNI: SNI present → 'd' (domain), absent → 'i' (IP address).
	// Bug #4 fix: was incorrectly using 'n'; spec clearly states 'i' for no SNI.
	sniFlag := "i"
	if sni != "" {
		sniFlag = "d"
	}

	// ── 3. Cipher suites: GREASE-filtered, 4-char hex, sorted, count ≤ 99 ────
	// Bug #1 fix: spec says "cipher hex codes sorted in hex order".
	// 4-char lowercase hex strings sort lexicographically into correct hex order.
	var filteredCS []string
	for _, cs := range cipherSuites {
		if !isGREASE(cs) {
			filteredCS = append(filteredCS, fmt.Sprintf("%04x", cs))
		}
	}
	sort.Strings(filteredCS) // lexicographic on 4-char hex == hex order ✓
	cipherCount := len(filteredCS)
	if cipherCount > 99 {
		cipherCount = 99
	}

	// ── 4. Extensions: GREASE-filtered, 4-char hex, SNI+ALPN excluded from hash
	// Bug #3 fix: spec says "extension hex codes"; was using decimal.
	// filteredExtAll  → used for extension count in prefix (includes SNI, ALPN).
	// filteredExtHash → used for the hash input (SNI=0x0000, ALPN=0x0010 excluded;
	//                   they are captured in the prefix instead — per FoxIO spec).
	var filteredExtAll []string
	var filteredExtHash []string
	for _, ext := range extensions {
		if isGREASE(ext) {
			continue
		}
		h := fmt.Sprintf("%04x", ext)
		filteredExtAll = append(filteredExtAll, h)
		if ext != 0x0000 && ext != 0x0010 {
			filteredExtHash = append(filteredExtHash, h)
		}
	}
	sort.Strings(filteredExtAll)
	sort.Strings(filteredExtHash)
	extCount := len(filteredExtAll)
	if extCount > 99 {
		extCount = 99
	}

	// ── 5. ALPN token: first + last character of first protocol ──────────────
	// Bug #5 fix: spec says "first and last characters of first ALPN extension
	// value". Was using first 2 chars (wrong for protocols like "http/1.1" where
	// correct token is 'h'+'1'="h1", not "ht").
	alpnToken := "00"
	if len(alpn) > 0 {
		p := alpn[0]
		switch len(p) {
		case 0:
			// no-op — alpnToken stays "00"
		case 1:
			// single-char protocol: repeat it
			alpnToken = string(p[0]) + string(p[0])
		default:
			// first + last char
			alpnToken = string(p[0]) + string(p[len(p)-1])
		}
	}

	// ── 6. Build human-readable prefix ───────────────────────────────────────
	prefix := fmt.Sprintf("t%s%s%02d%02d%s",
		verToken,
		sniFlag,
		cipherCount,
		extCount,
		alpnToken,
	)

	// ── 7. Cipher hash: SHA-256[:12] of comma-joined sorted hex ciphers ──────
	cipherInput := strings.Join(filteredCS, ",")
	cipherSum := sha256.Sum256([]byte(cipherInput))
	cipherHashFull := hex.EncodeToString(cipherSum[:])
	cipherHash := cipherHashFull
	if len(cipherHash) > 12 {
		cipherHash = cipherHash[:12]
	}

	// ── 8. Extension hash: SHA-256[:12] of (ext_types)_(sig_algs) ────────────
	// Bug #2 fix: spec §ext-hash says the hash input is:
	//   (comma-joined sorted ext hex codes) + "_" + (comma-joined sorted sig-alg hex codes)
	// GREASE-filter sig algs, format as 4-char hex, sort in hex order.
	var filteredSigAlgs []string
	for _, sa := range sigAlgs {
		if !isGREASE(sa) {
			filteredSigAlgs = append(filteredSigAlgs, fmt.Sprintf("%04x", sa))
		}
	}
	sort.Strings(filteredSigAlgs) // hex order ✓

	extInput := strings.Join(filteredExtHash, ",") + "_" + strings.Join(filteredSigAlgs, ",")
	extSum := sha256.Sum256([]byte(extInput))
	extHashFull := hex.EncodeToString(extSum[:])
	extHash := extHashFull
	if len(extHash) > 12 {
		extHash = extHash[:12]
	}

	// ── 9. Assemble final JA4 fingerprint ────────────────────────────────────
	return fmt.Sprintf("%s_%s_%s", prefix, cipherHash, extHash)
}

// ja4TLSVersionToken converts a TLS wire-format version to the JA4 two-char token.
// Reference: FoxIO JA4 spec §3 TLS Version.
func ja4TLSVersionToken(v uint16) string {
	switch v {
	case 0x0300:
		return "s3" // SSL 3.0
	case 0x0301:
		return "10" // TLS 1.0
	case 0x0302:
		return "11" // TLS 1.1
	case 0x0303:
		return "12" // TLS 1.2
	case 0x0304:
		return "13" // TLS 1.3
	default:
		return "00" // Unknown
	}
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
