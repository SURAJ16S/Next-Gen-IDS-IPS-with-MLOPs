// SPDX-License-Identifier: GPL-2.0
// detect/protocol.go — Canonical protocol types and normalization.

package detect

import "strings"

// Protocol is a canonical application-layer protocol identifier.
type Protocol string

const (
	ProtocolHTTP     Protocol = "HTTP"
	ProtocolTLS      Protocol = "TLS"
	ProtocolSSH      Protocol = "SSH"
	ProtocolFTP      Protocol = "FTP"
	ProtocolFTPS     Protocol = "FTPS"
	ProtocolDNS      Protocol = "DNS"
	ProtocolSMTP     Protocol = "SMTP"
	ProtocolTelnet   Protocol = "TELNET"
	ProtocolMySQL    Protocol = "MYSQL"
	ProtocolPostgres Protocol = "POSTGRES"
	ProtocolRedis    Protocol = "REDIS"
	ProtocolMongoDB  Protocol = "MONGODB"
	ProtocolRDP      Protocol = "RDP"
	ProtocolSNMP     Protocol = "SNMP"
	ProtocolNTP      Protocol = "NTP"
	ProtocolSOCKS    Protocol = "SOCKS"
	ProtocolVNC      Protocol = "VNC"
	ProtocolIMAP     Protocol = "IMAP"
	ProtocolPOP3     Protocol = "POP3"
	ProtocolLDAP     Protocol = "LDAP"
	ProtocolSIP      Protocol = "SIP"
	ProtocolDHCP     Protocol = "DHCP"
	ProtocolUnknown  Protocol = "UNKNOWN"
)

// NormaliseProtocol converts a raw fingerprint string to a canonical Protocol.
func NormaliseProtocol(raw string) Protocol {
	upper := strings.ToUpper(raw)
	switch {
	case strings.HasPrefix(upper, "HTTP/"):
		return ProtocolHTTP
	case strings.HasPrefix(upper, "TLS") || strings.HasPrefix(upper, "SSL"):
		return ProtocolTLS
	case strings.HasPrefix(upper, "SSH-"):
		return ProtocolSSH
	case strings.Contains(upper, "FTP"):
		if strings.Contains(upper, "FTPS") {
			return ProtocolFTPS
		}
		return ProtocolFTP
	case strings.Contains(upper, "DNS"):
		return ProtocolDNS
	case strings.Contains(upper, "SMTP"):
		return ProtocolSMTP
	case strings.Contains(upper, "TELNET"):
		return ProtocolTelnet
	case strings.Contains(upper, "MYSQL"):
		return ProtocolMySQL
	case strings.Contains(upper, "POSTGRES"):
		return ProtocolPostgres
	case strings.Contains(upper, "REDIS"):
		return ProtocolRedis
	case strings.Contains(upper, "MONGODB"):
		return ProtocolMongoDB
	case strings.Contains(upper, "RDP"):
		return ProtocolRDP
	case strings.Contains(upper, "SNMP"):
		return ProtocolSNMP
	case strings.Contains(upper, "NTP"):
		return ProtocolNTP
	case strings.Contains(upper, "SOCKS"):
		return ProtocolSOCKS
	case strings.Contains(upper, "VNC"):
		return ProtocolVNC
	case strings.Contains(upper, "IMAP"):
		return ProtocolIMAP
	case strings.Contains(upper, "POP3"):
		return ProtocolPOP3
	case strings.Contains(upper, "LDAP"):
		return ProtocolLDAP
	case strings.Contains(upper, "SIP"):
		return ProtocolSIP
	case strings.Contains(upper, "DHCP"):
		return ProtocolDHCP
	default:
		return ProtocolUnknown
	}
}
