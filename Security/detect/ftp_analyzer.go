// SPDX-License-Identifier: GPL-2.0
// detect/ftp_analyzer.go — FTP traffic analysis.
// Parses FTP commands and responses, detects brute-force login,
// anonymous access, FTP bounce attacks, and file transfer logging.

package detect

import (
	"fmt"
	"net"
	"strings"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// FTP Analyzer
// ──────────────────────────────────────────────────────────────────────────────

// FTPAnalyzer inspects FTP traffic for security-relevant patterns.
type FTPAnalyzer struct {
	bus *DetectionBus
}

// NewFTPAnalyzer creates an FTP analyzer.
func NewFTPAnalyzer(bus *DetectionBus) *FTPAnalyzer {
	return &FTPAnalyzer{bus: bus}
}

// Analyze inspects FTP data and emits detections.
func (a *FTPAnalyzer) Analyze(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) == 0 {
		return
	}

	s := string(data)
	lines := strings.Split(s, "\r\n")

	if fromClient {
		a.analyzeClientCommands(connID, srcIP, srcPort, dstPort, lines)
	} else {
		a.analyzeServerResponses(connID, srcIP, srcPort, dstPort, lines)
	}
}

// analyzeClientCommands parses FTP client commands.
func (a *FTPAnalyzer) analyzeClientCommands(connID, srcIP string, srcPort, dstPort uint16, lines []string) {
	for _, line := range lines {
		if line == "" {
			continue
		}

		upper := strings.ToUpper(strings.TrimSpace(line))
		parts := strings.SplitN(line, " ", 2)
		cmd := strings.ToUpper(parts[0])
		arg := ""
		if len(parts) > 1 {
			arg = parts[1]
		}

		switch cmd {
		case "USER":
			// ── Username detection ──
			sev := SevInfo
			if strings.EqualFold(arg, "anonymous") || strings.EqualFold(arg, "ftp") {
				sev = SevMedium
				a.bus.EmitDetection(Detection{
					ID:         "FTP-ANON-001",
					Timestamp:  time.Now(),
					Severity:   sev,
					Category:   CatAnonLogin,
					Protocol:   "FTP",
					SourceIP:   srcIP,
					SourcePort: srcPort,
					DestPort:   dstPort,
					Summary:    fmt.Sprintf("FTP anonymous login attempt: USER %s", arg),
					ConnID:     connID,
					Details: map[string]any{
						"username": arg,
					},
				})
			} else {
				a.bus.EmitDetection(Detection{
					ID:         "FTP-USER-001",
					Timestamp:  time.Now(),
					Severity:   sev,
					Category:   CatConnLifecycle,
					Protocol:   "FTP",
					SourceIP:   srcIP,
					SourcePort: srcPort,
					DestPort:   dstPort,
					Summary:    fmt.Sprintf("FTP login: USER %s", truncate(arg, 50)),
					ConnID:     connID,
					Details: map[string]any{
						"username": arg,
					},
				})
			}

		case "PASS":
			// Log that password was sent (don't log the actual password)
			a.bus.EmitDetection(Detection{
				ID:         "FTP-PASS-001",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "FTP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    "FTP PASS command sent (credentials in transit)",
				ConnID:     connID,
			})

		case "PORT":
			// ── FTP Bounce attack detection ──
			a.detectBounceAttack(connID, srcIP, srcPort, dstPort, arg)

		case "RETR":
			// File download
			a.bus.EmitDetection(Detection{
				ID:         "FTP-XFER-001",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "FTP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("FTP download: RETR %s", truncate(arg, 100)),
				ConnID:     connID,
				Details: map[string]any{
					"direction": "download",
					"filename":  arg,
				},
			})

		case "STOR":
			// File upload
			a.bus.EmitDetection(Detection{
				ID:         "FTP-XFER-002",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "FTP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("FTP upload: STOR %s", truncate(arg, 100)),
				ConnID:     connID,
				Details: map[string]any{
					"direction": "upload",
					"filename":  arg,
				},
			})

		case "DELE":
			// File deletion
			a.bus.EmitDetection(Detection{
				ID:         "FTP-DEL-001",
				Timestamp:  time.Now(),
				Severity:   SevMedium,
				Category:   CatDangerousCmd,
				Protocol:   "FTP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("FTP file deletion: DELE %s", truncate(arg, 100)),
				ConnID:     connID,
				Details: map[string]any{
					"filename": arg,
				},
			})

		case "RMD", "XRMD":
			// Directory removal
			a.bus.EmitDetection(Detection{
				ID:         "FTP-RMD-001",
				Timestamp:  time.Now(),
				Severity:   SevMedium,
				Category:   CatDangerousCmd,
				Protocol:   "FTP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("FTP directory removal: %s %s", cmd, truncate(arg, 100)),
				ConnID:     connID,
			})

		case "SITE":
			// SITE commands can be dangerous
			a.bus.EmitDetection(Detection{
				ID:         "FTP-SITE-001",
				Timestamp:  time.Now(),
				Severity:   SevMedium,
				Category:   CatDangerousCmd,
				Protocol:   "FTP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("FTP SITE command: %s", truncate(arg, 100)),
				ConnID:     connID,
			})
		}

		// ── Path traversal in FTP commands ──
		if strings.Contains(upper, "..") {
			a.bus.EmitDetection(Detection{
				ID:          "FTP-TRAV-001",
				Timestamp:   time.Now(),
				Severity:    SevHigh,
				Category:    CatPathTraversal,
				Protocol:    "FTP",
				SourceIP:    srcIP,
				SourcePort:  srcPort,
				DestPort:    dstPort,
				Summary:     fmt.Sprintf("Path traversal in FTP command: %s", truncate(line, 100)),
				ConnID:      connID,
				RawEvidence: truncate(line, 150),
			})
		}
	}
}

// analyzeServerResponses parses FTP server responses.
func (a *FTPAnalyzer) analyzeServerResponses(connID, srcIP string, srcPort, dstPort uint16, lines []string) {
	for _, line := range lines {
		if len(line) < 3 {
			continue
		}

		code := line[:3]

		switch code {
		case "220":
			// Server greeting
			a.bus.EmitDetection(Detection{
				ID:         "FTP-GREET-001",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatProtocolDetect,
				Protocol:   "FTP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("FTP server: %s", truncate(line, 120)),
				ConnID:     connID,
			})

		case "530":
			// Login failure
			a.bus.EmitDetection(Detection{
				ID:         "FTP-AUTH-FAIL",
				Timestamp:  time.Now(),
				Severity:   SevMedium,
				Category:   CatBruteForce,
				Protocol:   "FTP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    "FTP authentication failure",
				ConnID:     connID,
			})

		case "230":
			// Login successful
			a.bus.EmitDetection(Detection{
				ID:         "FTP-LOGIN-OK",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "FTP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    "FTP login successful",
				ConnID:     connID,
			})
		}
	}
}

// detectBounceAttack checks PORT command for FTP bounce attack.
// PORT command format: PORT h1,h2,h3,h4,p1,p2 — where IP=h1.h2.h3.h4, port=p1*256+p2
func (a *FTPAnalyzer) detectBounceAttack(connID, srcIP string, srcPort, dstPort uint16, arg string) {
	parts := strings.Split(strings.TrimSpace(arg), ",")
	if len(parts) != 6 {
		return
	}

	portIP := fmt.Sprintf("%s.%s.%s.%s", parts[0], parts[1], parts[2], parts[3])

	// If PORT IP doesn't match client IP, it's a bounce attack
	parsedIP := net.ParseIP(portIP)
	clientIP := net.ParseIP(srcIP)

	if parsedIP != nil && clientIP != nil && !parsedIP.Equal(clientIP) {
		a.bus.EmitDetection(Detection{
			ID:         "FTP-BOUNCE-001",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatFTPBounce,
			Protocol:   "FTP",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    fmt.Sprintf("FTP bounce attack: PORT pointing to %s (client is %s)", portIP, srcIP),
			ConnID:     connID,
			Details: map[string]any{
				"port_ip":   portIP,
				"client_ip": srcIP,
			},
		})
	}
}
