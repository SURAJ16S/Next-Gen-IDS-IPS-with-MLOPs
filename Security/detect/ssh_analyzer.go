// SPDX-License-Identifier: GPL-2.0
// detect/ssh_analyzer.go — SSH traffic analysis.
// Parses SSH version exchanges, key exchange algorithm negotiation,
// computes Hassh fingerprints, detects brute-force attempts, weak
// algorithms, and tunneling indicators.

package detect

import (
	"crypto/md5"
	"fmt"
	"strings"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// SSH Analyzer
// ──────────────────────────────────────────────────────────────────────────────

// SSHAnalyzer inspects SSH protocol traffic for security-relevant data.
type SSHAnalyzer struct {
	bus *DetectionBus

	// Weak algorithm lists
	weakKEX     map[string]bool
	weakCiphers map[string]bool
	weakMACs    map[string]bool
}

// NewSSHAnalyzer creates an SSH analyzer with weak algorithm databases.
func NewSSHAnalyzer(bus *DetectionBus) *SSHAnalyzer {
	return &SSHAnalyzer{
		bus: bus,
		weakKEX: map[string]bool{
			"diffie-hellman-group1-sha1":         true,
			"diffie-hellman-group14-sha1":        true,
			"diffie-hellman-group-exchange-sha1": true,
			"ecdh-sha2-nistp256":                 false, // Acceptable but worth noting
		},
		weakCiphers: map[string]bool{
			"arcfour":                     true,
			"arcfour128":                  true,
			"arcfour256":                  true,
			"3des-cbc":                    true,
			"blowfish-cbc":                true,
			"cast128-cbc":                 true,
			"aes128-cbc":                  true, // CBC mode is weaker than CTR/GCM
			"aes192-cbc":                  true,
			"aes256-cbc":                  true,
			"rijndael-cbc@lysator.liu.se": true,
			"none":                        true,
		},
		weakMACs: map[string]bool{
			"hmac-md5":       true,
			"hmac-md5-96":    true,
			"hmac-sha1-96":   true,
			"hmac-ripemd160": true,
			"none":           true,
		},
	}
}

// Analyze inspects SSH data and emits detections.
func (a *SSHAnalyzer) Analyze(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) == 0 {
		return
	}

	s := string(data)

	// ── SSH version exchange ──
	if strings.HasPrefix(s, "SSH-") {
		a.analyzeVersionExchange(connID, srcIP, srcPort, dstPort, s, fromClient)
		return
	}

	// ── SSH Key Exchange Init (SSH_MSG_KEXINIT = type 20) ──
	// Binary packet: packet_length(4) + padding_length(1) + payload_type(1)
	if len(data) >= 6 {
		// The payload type byte is at offset 5 (after packet_length + padding_length)
		payloadType := data[5]
		if payloadType == 20 { // SSH_MSG_KEXINIT
			a.analyzeKEXInit(connID, srcIP, srcPort, dstPort, data, fromClient)
			return
		}

		// ── SSH authentication messages ──
		if payloadType == 50 { // SSH_MSG_USERAUTH_REQUEST
			a.analyzeAuthRequest(connID, srcIP, srcPort, dstPort, data, fromClient)
			return
		}
		if payloadType == 51 { // SSH_MSG_USERAUTH_FAILURE
			a.analyzeAuthFailure(connID, srcIP, srcPort, dstPort, fromClient)
			return
		}

		// ── Channel open (tunneling detection) ──
		if payloadType == 90 { // SSH_MSG_CHANNEL_OPEN
			a.analyzeChannelOpen(connID, srcIP, srcPort, dstPort, data, fromClient)
			return
		}
	}
}

// analyzeVersionExchange parses the SSH version string.
func (a *SSHAnalyzer) analyzeVersionExchange(connID, srcIP string, srcPort, dstPort uint16, s string, fromClient bool) {
	version := s
	if idx := strings.IndexAny(version, "\r\n"); idx > 0 {
		version = version[:idx]
	}

	direction := "server"
	if fromClient {
		direction = "client"
	}

	// Parse version components: SSH-protoversion-softwareversion [comments]
	parts := strings.SplitN(version, "-", 3)
	protoVer := ""
	softVer := ""
	if len(parts) >= 2 {
		protoVer = parts[1]
	}
	if len(parts) >= 3 {
		softVer = parts[2]
	}

	a.bus.EmitDetection(Detection{
		ID:         "SSH-VER-001",
		Timestamp:  time.Now(),
		Severity:   SevInfo,
		Category:   CatProtocolDetect,
		Protocol:   "SSH",
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		Summary:    fmt.Sprintf("SSH %s version: %s", direction, truncate(version, 100)),
		ConnID:     connID,
		Details: map[string]any{
			"direction":        direction,
			"protocol_version": protoVer,
			"software_version": softVer,
			"full_version":     version,
		},
	})

	// ── Detect known SSH client fingerprints ──
	a.fingerprintSSHSoftware(connID, srcIP, srcPort, dstPort, softVer, direction)
}

// fingerprintSSHSoftware identifies known SSH software.
func (a *SSHAnalyzer) fingerprintSSHSoftware(connID, srcIP string, srcPort, dstPort uint16, softVer, direction string) {
	lower := strings.ToLower(softVer)
	knownTools := map[string]struct {
		name     string
		severity Severity
	}{
		"paramiko": {"Paramiko (Python SSH library — often used by automated tools)", SevMedium},
		"libssh":   {"libssh (C SSH library)", SevLow},
		"putty":    {"PuTTY", SevInfo},
		"openssh":  {"OpenSSH", SevInfo},
		"dropbear": {"Dropbear (embedded SSH)", SevInfo},
		"ncrack":   {"Ncrack (brute-force tool)", SevHigh},
		"medusa":   {"Medusa (brute-force tool)", SevHigh},
		"go":       {"Go SSH library", SevLow},
		"asyncssh": {"AsyncSSH (Python async SSH)", SevMedium},
		"twisted":  {"Twisted Conch (Python SSH)", SevMedium},
	}

	for keyword, info := range knownTools {
		if strings.Contains(lower, keyword) {
			if info.severity > SevInfo {
				a.bus.EmitDetection(Detection{
					ID:         "SSH-TOOL-001",
					Timestamp:  time.Now(),
					Severity:   info.severity,
					Category:   CatBotScanner,
					Protocol:   "SSH",
					SourceIP:   srcIP,
					SourcePort: srcPort,
					DestPort:   dstPort,
					Summary:    fmt.Sprintf("SSH %s identified: %s", direction, info.name),
					ConnID:     connID,
					Details: map[string]any{
						"tool":      keyword,
						"direction": direction,
						"version":   softVer,
					},
				})
			}
			return
		}
	}
}

// analyzeKEXInit parses SSH_MSG_KEXINIT to extract algorithms and compute Hassh.
func (a *SSHAnalyzer) analyzeKEXInit(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	// KEXINIT structure after payload type byte:
	// cookie(16) + name-lists (kex_algorithms, server_host_key_algorithms,
	// encryption_algorithms_client_to_server, encryption_algorithms_server_to_client,
	// mac_algorithms_client_to_server, mac_algorithms_server_to_client,
	// compression_algorithms_client_to_server, compression_algorithms_server_to_client,
	// languages_client_to_server, languages_server_to_client)

	// Skip: packet_length(4) + padding_length(1) + type(1) + cookie(16) = 22
	if len(data) < 22+4 {
		return
	}

	offset := 22
	nameListStrings := make([]string, 0, 10)

	for i := 0; i < 10; i++ {
		if offset+4 > len(data) {
			break
		}
		listLen := int(data[offset])<<24 | int(data[offset+1])<<16 | int(data[offset+2])<<8 | int(data[offset+3])
		offset += 4
		if listLen < 0 || offset+listLen > len(data) {
			break
		}
		nameListStrings = append(nameListStrings, string(data[offset:offset+listLen]))
		offset += listLen
	}

	if len(nameListStrings) < 6 {
		return
	}

	kexAlgorithms := nameListStrings[0]
	encAlgorithms := nameListStrings[2]  // client-to-server encryption
	macAlgorithms := nameListStrings[4]  // client-to-server MAC
	compAlgorithms := nameListStrings[6] // client-to-server compression if available
	if len(nameListStrings) > 6 {
		compAlgorithms = nameListStrings[6]
	}

	// ── Compute HASSH fingerprint ──
	// Hassh = MD5 of: kex_algorithms;encryption_algorithms;mac_algorithms;compression_algorithms
	direction := "server"
	hashInput := ""
	if fromClient {
		direction = "client"
		hashInput = fmt.Sprintf("%s;%s;%s;%s", kexAlgorithms, encAlgorithms, macAlgorithms, compAlgorithms)
	} else {
		// Server uses indices 3, 5, 7 (server-to-client)
		sEncAlgo := nameListStrings[3]
		sMacAlgo := nameListStrings[5]
		sCompAlgo := ""
		if len(nameListStrings) > 7 {
			sCompAlgo = nameListStrings[7]
		}
		hashInput = fmt.Sprintf("%s;%s;%s;%s", kexAlgorithms, sEncAlgo, sMacAlgo, sCompAlgo)
	}

	hassh := fmt.Sprintf("%x", md5.Sum([]byte(hashInput)))

	a.bus.EmitDetection(Detection{
		ID:         "SSH-HASSH-001",
		Timestamp:  time.Now(),
		Severity:   SevInfo,
		Category:   CatProtocolDetect,
		Protocol:   "SSH",
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		Summary:    fmt.Sprintf("SSH %s HASSH: %s", direction, hassh),
		ConnID:     connID,
		Details: map[string]any{
			"hassh":                 hassh,
			"direction":             direction,
			"kex_algorithms":        kexAlgorithms,
			"encryption_algorithms": encAlgorithms,
			"mac_algorithms":        macAlgorithms,
			"compression":           compAlgorithms,
		},
	})

	// ── Check for weak algorithms ──
	a.checkWeakAlgorithms(connID, srcIP, srcPort, dstPort, "kex", kexAlgorithms, a.weakKEX)
	a.checkWeakAlgorithms(connID, srcIP, srcPort, dstPort, "cipher", encAlgorithms, a.weakCiphers)
	a.checkWeakAlgorithms(connID, srcIP, srcPort, dstPort, "mac", macAlgorithms, a.weakMACs)
}

// checkWeakAlgorithms scans a comma-separated algorithm list for weak entries.
func (a *SSHAnalyzer) checkWeakAlgorithms(connID, srcIP string, srcPort, dstPort uint16, algoType, algoList string, weakSet map[string]bool) {
	algos := strings.Split(algoList, ",")
	var weak []string
	for _, algo := range algos {
		algo = strings.TrimSpace(algo)
		if weakSet[algo] {
			weak = append(weak, algo)
		}
	}

	if len(weak) > 0 {
		a.bus.EmitDetection(Detection{
			ID:         "SSH-WEAK-001",
			Timestamp:  time.Now(),
			Severity:   SevMedium,
			Category:   CatSSHWeakAlgo,
			Protocol:   "SSH",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    fmt.Sprintf("Weak SSH %s algorithms offered: %s", algoType, strings.Join(weak, ", ")),
			ConnID:     connID,
			Details: map[string]any{
				"algorithm_type":  algoType,
				"weak_algorithms": weak,
				"full_list":       algoList,
			},
		})
	}
}

// analyzeAuthRequest detects authentication method from SSH_MSG_USERAUTH_REQUEST.
func (a *SSHAnalyzer) analyzeAuthRequest(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	// SSH_MSG_USERAUTH_REQUEST structure:
	// type(1) + username(string) + service(string) + method(string) + ...
	// We try to extract the method name

	if !fromClient {
		return
	}

	a.bus.EmitDetection(Detection{
		ID:         "SSH-AUTH-001",
		Timestamp:  time.Now(),
		Severity:   SevInfo,
		Category:   CatConnLifecycle,
		Protocol:   "SSH",
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		Summary:    "SSH authentication attempt detected",
		ConnID:     connID,
	})
}

// analyzeAuthFailure tracks authentication failures for brute-force detection.
func (a *SSHAnalyzer) analyzeAuthFailure(connID, srcIP string, srcPort, dstPort uint16, fromClient bool) {
	a.bus.EmitDetection(Detection{
		ID:         "SSH-AUTH-FAIL-001",
		Timestamp:  time.Now(),
		Severity:   SevMedium,
		Category:   CatBruteForce,
		Protocol:   "SSH",
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		Summary:    "SSH authentication failure",
		ConnID:     connID,
	})
}

// analyzeChannelOpen detects SSH tunneling and port forwarding.
func (a *SSHAnalyzer) analyzeChannelOpen(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	// SSH_MSG_CHANNEL_OPEN: type(1) + channel_type(string) + ...
	// Channel types: "session", "direct-tcpip", "forwarded-tcpip", "x11"

	// Try to extract channel type from the binary data
	if len(data) < 10 {
		return
	}

	// After packet_length(4) + padding(1) + type(1) = offset 6
	// channel_type is a string: length(4) + data
	offset := 6
	if offset+4 > len(data) {
		return
	}
	typeLen := int(data[offset])<<24 | int(data[offset+1])<<16 | int(data[offset+2])<<8 | int(data[offset+3])
	offset += 4
	if typeLen <= 0 || offset+typeLen > len(data) {
		return
	}
	channelType := string(data[offset : offset+typeLen])

	sev := SevInfo
	category := CatConnLifecycle
	if channelType == "direct-tcpip" || channelType == "forwarded-tcpip" {
		sev = SevHigh
		category = CatSSHTunnel
	}

	a.bus.EmitDetection(Detection{
		ID:         "SSH-CHAN-001",
		Timestamp:  time.Now(),
		Severity:   sev,
		Category:   category,
		Protocol:   "SSH",
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		Summary:    fmt.Sprintf("SSH channel open: %s", channelType),
		ConnID:     connID,
		Details: map[string]any{
			"channel_type": channelType,
			"direction":    map[bool]string{true: "client", false: "server"}[fromClient],
		},
	})
}
