// SPDX-License-Identifier: GPL-2.0
// detect/smtp_analyzer.go — SMTP traffic analysis.
// Parses SMTP command sequences, detects open relay attempts, brute-force
// authentication, spam indicators, and phishing patterns.

package detect

import (
	"fmt"
	"strings"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// SMTP Analyzer
// ──────────────────────────────────────────────────────────────────────────────

// SMTPAnalyzer inspects SMTP traffic for security-relevant patterns.
type SMTPAnalyzer struct {
	bus *DetectionBus
}

// NewSMTPAnalyzer creates an SMTP analyzer.
func NewSMTPAnalyzer(bus *DetectionBus) *SMTPAnalyzer {
	return &SMTPAnalyzer{bus: bus}
}

// Analyze inspects SMTP data and emits detections.
func (a *SMTPAnalyzer) Analyze(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
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

// analyzeClientCommands parses SMTP commands from the client.
func (a *SMTPAnalyzer) analyzeClientCommands(connID, srcIP string, srcPort, dstPort uint16, lines []string) {
	rcptCount := 0
	var mailFrom, heloDomain string

	for _, line := range lines {
		if line == "" {
			continue
		}

		upper := strings.ToUpper(strings.TrimSpace(line))

		// ── EHLO/HELO ──
		if strings.HasPrefix(upper, "EHLO ") || strings.HasPrefix(upper, "HELO ") {
			heloDomain = strings.TrimSpace(line[5:])
			a.bus.EmitDetection(Detection{
				ID:        "SMTP-HELO-001",
				Timestamp: time.Now(),
				Severity:  SevInfo,
				Category:  CatConnLifecycle,
				Protocol:  "SMTP",
				SourceIP:  srcIP,
				SourcePort: srcPort,
				DestPort:  dstPort,
				Summary:   fmt.Sprintf("SMTP HELO/EHLO: %s", truncate(heloDomain, 100)),
				ConnID:    connID,
				Details: map[string]any{
					"helo_domain": heloDomain,
				},
			})
		}

		// ── MAIL FROM ──
		if strings.HasPrefix(upper, "MAIL FROM:") {
			mailFrom = extractEmailAddress(line[10:])
			a.bus.EmitDetection(Detection{
				ID:        "SMTP-FROM-001",
				Timestamp: time.Now(),
				Severity:  SevInfo,
				Category:  CatConnLifecycle,
				Protocol:  "SMTP",
				SourceIP:  srcIP,
				SourcePort: srcPort,
				DestPort:  dstPort,
				Summary:   fmt.Sprintf("SMTP MAIL FROM: %s", truncate(mailFrom, 100)),
				ConnID:    connID,
				Details: map[string]any{
					"sender": mailFrom,
				},
			})

			// ── Phishing: sender domain vs HELO domain mismatch ──
			if heloDomain != "" && mailFrom != "" {
				senderDomain := extractDomain(mailFrom)
				if senderDomain != "" && !strings.EqualFold(senderDomain, heloDomain) &&
					!strings.HasSuffix(strings.ToLower(heloDomain), "."+strings.ToLower(senderDomain)) {
					a.bus.EmitDetection(Detection{
						ID:        "SMTP-PHISH-001",
						Timestamp: time.Now(),
						Severity:  SevHigh,
						Category:  CatPhishing,
						Protocol:  "SMTP",
						SourceIP:  srcIP,
						SourcePort: srcPort,
						DestPort:  dstPort,
						Summary:   fmt.Sprintf("HELO/sender domain mismatch: HELO=%s, FROM=%s", heloDomain, senderDomain),
						ConnID:    connID,
						Details: map[string]any{
							"helo_domain":   heloDomain,
							"sender_domain": senderDomain,
							"sender":        mailFrom,
						},
					})
				}
			}
		}

		// ── RCPT TO ──
		if strings.HasPrefix(upper, "RCPT TO:") {
			rcptCount++
			recipient := extractEmailAddress(line[8:])
			a.bus.EmitDetection(Detection{
				ID:        "SMTP-RCPT-001",
				Timestamp: time.Now(),
				Severity:  SevInfo,
				Category:  CatConnLifecycle,
				Protocol:  "SMTP",
				SourceIP:  srcIP,
				SourcePort: srcPort,
				DestPort:  dstPort,
				Summary:   fmt.Sprintf("SMTP RCPT TO: %s", truncate(recipient, 100)),
				ConnID:    connID,
				Details: map[string]any{
					"recipient":  recipient,
					"rcpt_count": rcptCount,
				},
			})
		}

		// ── AUTH LOGIN/PLAIN ──
		if strings.HasPrefix(upper, "AUTH ") {
			authMethod := strings.TrimSpace(line[5:])
			if idx := strings.Index(authMethod, " "); idx > 0 {
				authMethod = authMethod[:idx]
			}
			a.bus.EmitDetection(Detection{
				ID:        "SMTP-AUTH-001",
				Timestamp: time.Now(),
				Severity:  SevInfo,
				Category:  CatConnLifecycle,
				Protocol:  "SMTP",
				SourceIP:  srcIP,
				SourcePort: srcPort,
				DestPort:  dstPort,
				Summary:   fmt.Sprintf("SMTP AUTH attempt: %s", strings.ToUpper(authMethod)),
				ConnID:    connID,
				Details: map[string]any{
					"auth_method": authMethod,
				},
			})
		}

		// ── STARTTLS ──
		if strings.HasPrefix(upper, "STARTTLS") {
			a.bus.EmitDetection(Detection{
				ID:        "SMTP-TLS-001",
				Timestamp: time.Now(),
				Severity:  SevInfo,
				Category:  CatConnLifecycle,
				Protocol:  "SMTP",
				SourceIP:  srcIP,
				SourcePort: srcPort,
				DestPort:  dstPort,
				Summary:   "SMTP STARTTLS upgrade requested",
				ConnID:    connID,
			})
		}
	}

	// ── Spam indicator: excessive recipients ──
	if rcptCount > 10 {
		a.bus.EmitDetection(Detection{
			ID:        "SMTP-SPAM-001",
			Timestamp: time.Now(),
			Severity:  SevHigh,
			Category:  CatSpam,
			Protocol:  "SMTP",
			SourceIP:  srcIP,
			SourcePort: srcPort,
			DestPort:  dstPort,
			Summary:   fmt.Sprintf("Excessive RCPT TO count: %d recipients (spam indicator)", rcptCount),
			ConnID:    connID,
			Details: map[string]any{
				"recipient_count": rcptCount,
			},
		})
	}
}

// analyzeServerResponses parses SMTP server responses.
func (a *SMTPAnalyzer) analyzeServerResponses(connID, srcIP string, srcPort, dstPort uint16, lines []string) {
	for _, line := range lines {
		if len(line) < 3 {
			continue
		}

		// Extract response code
		code := line[:3]

		switch {
		case code == "220":
			// Server greeting — emit for fingerprinting
			a.bus.EmitDetection(Detection{
				ID:        "SMTP-GREET-001",
				Timestamp: time.Now(),
				Severity:  SevInfo,
				Category:  CatProtocolDetect,
				Protocol:  "SMTP",
				SourceIP:  srcIP,
				SourcePort: srcPort,
				DestPort:  dstPort,
				Summary:   fmt.Sprintf("SMTP server greeting: %s", truncate(line, 120)),
				ConnID:    connID,
			})

		case code == "535" || code == "503":
			// Auth failure
			a.bus.EmitDetection(Detection{
				ID:        "SMTP-AUTH-FAIL",
				Timestamp: time.Now(),
				Severity:  SevMedium,
				Category:  CatBruteForce,
				Protocol:  "SMTP",
				SourceIP:  srcIP,
				SourcePort: srcPort,
				DestPort:  dstPort,
				Summary:   fmt.Sprintf("SMTP auth failure: %s", truncate(line, 100)),
				ConnID:    connID,
			})

		case code == "550":
			// Relay denied — this is good, means server isn't an open relay
			if strings.Contains(strings.ToUpper(line), "RELAY") {
				a.bus.EmitDetection(Detection{
					ID:        "SMTP-RELAY-001",
					Timestamp: time.Now(),
					Severity:  SevMedium,
					Category:  CatOpenRelay,
					Protocol:  "SMTP",
					SourceIP:  srcIP,
					SourcePort: srcPort,
					DestPort:  dstPort,
					Summary:   "SMTP relay attempt detected (denied by server)",
					ConnID:    connID,
				})
			}

		case code == "250" && strings.Contains(strings.ToUpper(line), "RELAY"):
			// Open relay!
			a.bus.EmitDetection(Detection{
				ID:        "SMTP-OPENRELAY",
				Timestamp: time.Now(),
				Severity:  SevCritical,
				Category:  CatOpenRelay,
				Protocol:  "SMTP",
				SourceIP:  srcIP,
				SourcePort: srcPort,
				DestPort:  dstPort,
				Summary:   "SMTP OPEN RELAY detected — server accepted relay request",
				ConnID:    connID,
			})
		}
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

// extractEmailAddress extracts an email address from SMTP envelope notation.
func extractEmailAddress(s string) string {
	s = strings.TrimSpace(s)
	if start := strings.Index(s, "<"); start >= 0 {
		if end := strings.Index(s, ">"); end > start {
			return s[start+1 : end]
		}
	}
	return s
}

// extractDomain extracts the domain part from an email address.
func extractDomain(email string) string {
	if idx := strings.LastIndex(email, "@"); idx >= 0 {
		return email[idx+1:]
	}
	return ""
}
