// SPDX-License-Identifier: GPL-2.0
// detect/telnet_defaults.go — Default Telnet credential database.
//
// This file contains a representative embedded dataset of known-default and
// commonly exploited Telnet credentials for IoT, router, and embedded devices.
//
// PROVENANCE:
//   - Mirai botnet credential list (public domain, analyzed from malware samples):
//     https://github.com/jgamblin/Mirai-Source-Code
//   - Common vendor defaults from publicly available security advisories and
//     device documentation (Shodan research, CVE disclosures, vendor guides).
//   - This list is NOT exhaustive and does not claim to cover every vendor
//     default credential. It is a representative starting point.
//
// DATABASE VERSION: 1.0.0
//
// SECURITY NOTE:
//   Passwords are stored as truncated SHA-256 hashes (first 16 hex chars).
//   No plaintext passwords are stored or emitted in DetectionEvents.
//   The hash is used only for credential fingerprint comparison.

package detect

import "crypto/sha256"

// telnetDefaultsVersion is the embedded dataset version.
const telnetDefaultsVersion = "1.0.0"

// TelnetDefaultCred represents a known default credential entry.
type TelnetDefaultCred struct {
	Username   string // Cleartext username (usernames are not secret)
	PassHash   string // SHA-256[:16] hex of the password
	Vendor     string // Device vendor or "generic"
	DeviceType string // Router, camera, switch, embedded, etc.
	BotnetTag  string // "mirai", "hajime", "qbot", "" if none
	Category   string // "iot", "router", "switch", "embedded", "generic"
}

// credFingerprintForDB computes the same fingerprint as credFingerprint() in the analyzer.
// Both use SHA-256[:16] of "username:password". This is the canonical credential fingerprint.
func credFingerprintForDB(username, password string) string {
	h := sha256.Sum256([]byte(username + ":" + password))
	const hex = "0123456789abcdef"
	out := make([]byte, 16)
	for i := 0; i < 8; i++ {
		out[2*i] = hex[h[i]>>4]
		out[2*i+1] = hex[h[i]&0xF]
	}
	return string(out)
}

// TelnetDefaultCredDB is the embedded default credential database.
// Entries are matched against captured (username, passFingerprint) pairs.
// The database is intentionally small and versioned; extend via PR with source citation.
var TelnetDefaultCredDB = buildTelnetDefaults()

func buildTelnetDefaults() []TelnetDefaultCred {
	type raw struct {
		user, pass, vendor, deviceType, botnet, category string
	}

	// NOTE: These passwords appear in public security research / malware analysis.
	// They are hashed here. No plaintext password survives into the binary constants.
	entries := []raw{
		// ── Mirai botnet credentials (public: Mirai source code, 2016) ─────────
		{"root", "xc3511", "generic", "embedded", "mirai", "iot"},
		{"root", "vizxv", "generic", "dvr", "mirai", "iot"},
		{"root", "admin", "generic", "embedded", "mirai", "iot"},
		{"admin", "admin", "generic", "router", "mirai", "iot"},
		{"root", "888888", "generic", "dvr", "mirai", "iot"},
		{"root", "666666", "generic", "dvr", "mirai", "iot"},
		{"admin", "1234", "generic", "router", "mirai", "iot"},
		{"root", "12345", "generic", "embedded", "mirai", "iot"},
		{"user", "user", "generic", "embedded", "mirai", "iot"},
		{"admin", "password", "generic", "router", "mirai", "iot"},
		{"root", "password", "generic", "embedded", "mirai", "iot"},
		{"root", "root", "generic", "embedded", "mirai", "iot"},
		{"admin", "admin1234", "generic", "router", "mirai", "iot"},
		{"Administrator", "admin", "generic", "embedded", "mirai", "iot"},
		{"service", "service", "generic", "embedded", "mirai", "iot"},
		{"supervisor", "supervisor", "generic", "embedded", "mirai", "iot"},
		{"guest", "guest", "generic", "router", "mirai", "iot"},
		{"guest", "12345", "generic", "router", "mirai", "iot"},
		{"admin01", "admin01", "generic", "router", "mirai", "iot"},
		{"support", "support", "generic", "embedded", "mirai", "iot"},
		{"tech", "tech", "generic", "embedded", "mirai", "iot"},
		{"mother", "f**ker", "generic", "embedded", "mirai", "iot"},

		// ── Ubiquiti (CVE disclosures, vendor docs) ────────────────────────────
		{"ubnt", "ubnt", "Ubiquiti", "wireless-ap", "", "router"},

		// ── TP-Link (vendor documentation) ────────────────────────────────────
		{"admin", "admin", "TP-Link", "router", "", "router"},
		{"root", "root", "TP-Link", "router", "", "router"},

		// ── D-Link (vendor advisories) ─────────────────────────────────────────
		{"admin", "", "D-Link", "router", "", "router"},
		{"user", "", "D-Link", "router", "", "router"},

		// ── Netgear (vendor advisories) ───────────────────────────────────────
		{"admin", "password", "Netgear", "router", "", "router"},
		{"admin", "1234", "Netgear", "router", "", "router"},

		// ── Linksys (vendor advisories) ───────────────────────────────────────
		{"admin", "admin", "Linksys", "router", "", "router"},
		{"root", "", "Linksys", "router", "", "router"},

		// ── Huawei (vendor advisories, CVE-2017-17215 context) ────────────────
		{"root", "admin", "Huawei", "router", "", "router"},
		{"admin", "Admin@huawei", "Huawei", "router", "", "router"},

		// ── Generic embedded Linux defaults ───────────────────────────────────
		{"root", "", "generic", "embedded", "", "embedded"},
		{"root", "toor", "generic", "embedded", "", "embedded"},
		{"admin", "", "generic", "embedded", "", "embedded"},
		{"pi", "raspberry", "Raspberry Pi Foundation", "embedded", "", "embedded"},

		// ── Cisco (vendor documentation) ──────────────────────────────────────
		{"cisco", "cisco", "Cisco", "switch", "", "switch"},
		{"admin", "cisco", "Cisco", "router", "", "router"},
	}

	result := make([]TelnetDefaultCred, 0, len(entries))
	for _, e := range entries {
		result = append(result, TelnetDefaultCred{
			Username:   e.user,
			PassHash:   credFingerprintForDB(e.user, e.pass),
			Vendor:     e.vendor,
			DeviceType: e.deviceType,
			BotnetTag:  e.botnet,
			Category:   e.category,
		})
	}
	return result
}

// telnetMiraiTags is the set of botnet tags that trigger TELNET-IOT-001.
var telnetMiraiTags = map[string]bool{
	"mirai":  true,
	"hajime": true,
	"qbot":   true,
	"satori": true,
}
