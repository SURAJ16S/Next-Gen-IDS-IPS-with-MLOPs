// SPDX-License-Identifier: GPL-2.0
// detect/payload_stats.go — Statistical feature extraction for HTTP payloads.
// Computes Shannon entropy, character class ratios, encoding detection counts,
// and attack-pattern keyword counts. These continuous numerical features are
// what ML anomaly models (Isolation Forest, GBT) need to detect zero-day
// attacks that bypass signature-based detectors.

package detect

import (
	"math"
	"regexp"
	"strings"
	"unicode"
)

// ──────────────────────────────────────────────────────────────────────────────
// PayloadStats — continuous numerical features for ML ingestion
// ──────────────────────────────────────────────────────────────────────────────

// PayloadStats holds the statistical profile of a payload (URI, body, header).
type PayloadStats struct {
	// ── Basic Metrics ──
	Length int `json:"length"`

	// ── Shannon Entropy ──
	Entropy float64 `json:"entropy"` // 0.0 = uniform, ~4.5+ = high randomness/obfuscation

	// ── Character Class Ratios (0.0–1.0) ──
	DigitRatio        float64 `json:"digit_ratio"`
	UpperRatio        float64 `json:"upper_ratio"`
	LowerRatio        float64 `json:"lower_ratio"`
	SpecialCharRatio  float64 `json:"special_char_ratio"`
	WhitespaceRatio   float64 `json:"whitespace_ratio"`
	NonPrintableRatio float64 `json:"non_printable_ratio"`

	// ── Encoding Detection Counts ──
	Base64Count  int `json:"base64_count"`  // Number of base64-like substrings
	HexCount     int `json:"hex_count"`     // Number of hex-encoded sequences (0x... or %XX)
	UnicodeCount int `json:"unicode_count"` // Number of unicode escape sequences

	// ── Attack Pattern Counts (graded signal, not binary) ──
	SQLKeywordCount    int `json:"sql_keyword_count"`
	XSSPatternCount    int `json:"xss_pattern_count"`
	PathTraversalCount int `json:"path_traversal_count"`
	CmdInjectionCount  int `json:"cmd_injection_count"`
	HTMLTagCount       int `json:"html_tag_count"`
	JSPatternCount     int `json:"js_pattern_count"`

	// ── Token Statistics ──
	TokenCount     int     `json:"token_count"` // Number of whitespace-separated tokens
	AvgTokenLength float64 `json:"avg_token_length"`
	MaxTokenLength int     `json:"max_token_length"`
}

// ──────────────────────────────────────────────────────────────────────────────
// Pre-compiled regexes for pattern counting
// ──────────────────────────────────────────────────────────────────────────────

var (
	reBase64  = regexp.MustCompile(`[A-Za-z0-9+/]{20,}={0,2}`)
	reHex     = regexp.MustCompile(`(?i)(0x[0-9a-f]{4,}|(%[0-9a-f]{2}){3,})`)
	reUnicode = regexp.MustCompile(`(?i)(\\u[0-9a-f]{4}|%u[0-9a-f]{4})`)

	reSQLKeywords = regexp.MustCompile(`(?i)\b(select|union|insert|update|delete|drop|alter|exec|execute|truncate|create|replace|grant|revoke|information_schema|sleep|benchmark|waitfor|concat|group_concat|load_file|into\s+outfile|into\s+dumpfile)\b`)
	reXSSPatterns = regexp.MustCompile(`(?i)(<\s*script|on(error|load|click|mouseover|focus|submit|change)\s*=|javascript\s*:|document\.\s*(cookie|write|location)|alert\s*\(|eval\s*\(|fromCharCode)`)
	rePathTrav    = regexp.MustCompile(`(?i)(\.\.[\\/]|%2e%2e|%252e|/etc/passwd|/proc/self|/windows/system32|boot\.ini|%00)`)
	reCmdInject   = regexp.MustCompile("(?i)([|;&`]\\s*(cat|ls|dir|whoami|id|uname|pwd|wget|curl|nc|bash|sh|cmd|powershell)|\\$\\(|/bin/(sh|bash))")
	reHTMLTags    = regexp.MustCompile(`<\s*[a-zA-Z][^>]*>`)
	reJSPatterns  = regexp.MustCompile(`(?i)(eval\s*\(|setTimeout\s*\(|setInterval\s*\(|Function\s*\(|\.constructor|\.prototype|__proto__|require\s*\(|import\s*\()`)
)

// ──────────────────────────────────────────────────────────────────────────────
// ComputePayloadStats — the main entry point
// ──────────────────────────────────────────────────────────────────────────────

// ComputePayloadStats computes all statistical features for the given payload.
func ComputePayloadStats(payload string) PayloadStats {
	if len(payload) == 0 {
		return PayloadStats{}
	}

	stats := PayloadStats{
		Length: len(payload),
	}

	// ── Character class counting ──
	var digits, upper, lower, special, whitespace, nonPrintable int
	for _, r := range payload {
		switch {
		case unicode.IsDigit(r):
			digits++
		case unicode.IsUpper(r):
			upper++
		case unicode.IsLower(r):
			lower++
		case unicode.IsSpace(r):
			whitespace++
		case !unicode.IsPrint(r):
			nonPrintable++
		default:
			special++
		}
	}

	total := float64(len(payload))
	stats.DigitRatio = float64(digits) / total
	stats.UpperRatio = float64(upper) / total
	stats.LowerRatio = float64(lower) / total
	stats.SpecialCharRatio = float64(special) / total
	stats.WhitespaceRatio = float64(whitespace) / total
	stats.NonPrintableRatio = float64(nonPrintable) / total

	// ── Shannon Entropy ──
	stats.Entropy = payloadShannonEntropy(payload)

	// ── Encoding detection ──
	stats.Base64Count = len(reBase64.FindAllString(payload, -1))
	stats.HexCount = len(reHex.FindAllString(payload, -1))
	stats.UnicodeCount = len(reUnicode.FindAllString(payload, -1))

	// ── Pattern counts (graded signal) ──
	stats.SQLKeywordCount = len(reSQLKeywords.FindAllString(payload, -1))
	stats.XSSPatternCount = len(reXSSPatterns.FindAllString(payload, -1))
	stats.PathTraversalCount = len(rePathTrav.FindAllString(payload, -1))
	stats.CmdInjectionCount = len(reCmdInject.FindAllString(payload, -1))
	stats.HTMLTagCount = len(reHTMLTags.FindAllString(payload, -1))
	stats.JSPatternCount = len(reJSPatterns.FindAllString(payload, -1))

	// ── Token statistics ──
	tokens := strings.Fields(payload)
	stats.TokenCount = len(tokens)
	if len(tokens) > 0 {
		totalLen := 0
		maxLen := 0
		for _, t := range tokens {
			tl := len(t)
			totalLen += tl
			if tl > maxLen {
				maxLen = tl
			}
		}
		stats.AvgTokenLength = float64(totalLen) / float64(len(tokens))
		stats.MaxTokenLength = maxLen
	}

	return stats
}

// payloadShannonEntropy computes the Shannon entropy of a string in bits.
// Higher values indicate more randomness/obfuscation.
func payloadShannonEntropy(s string) float64 {
	if len(s) == 0 {
		return 0
	}

	freq := make(map[rune]int)
	for _, r := range s {
		freq[r]++
	}

	length := float64(len([]rune(s)))
	entropy := 0.0
	for _, count := range freq {
		p := float64(count) / length
		if p > 0 {
			entropy -= p * math.Log2(p)
		}
	}
	return math.Round(entropy*10000) / 10000 // 4 decimal places
}
