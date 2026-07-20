// SPDX-License-Identifier: GPL-2.0
// service_detector.go — NGFW eBPF Traffic Monitor
// Detects the service/process listening on a given port using a multi-tiered
// approach: active socket inspection → known-port map → Unknown Service.

package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// ──────────────────────────────────────────────────────────────────────────────
// Tier 2: Well-Known Port Map
// ──────────────────────────────────────────────────────────────────────────────

// wellKnownPorts maps common port numbers to their canonical service names.
// This is used as a fallback when no active listener is found on the port.
var wellKnownPorts = map[uint16]string{
	20:    "FTP (Data Transfer)",
	21:    "FTP (Control)",
	22:    "SSH",
	23:    "Telnet",
	25:    "SMTP",
	53:    "DNS",
	67:    "DHCP (Server)",
	68:    "DHCP (Client)",
	69:    "TFTP",
	80:    "HTTP",
	88:    "Kerberos",
	110:   "POP3",
	111:   "RPC",
	119:   "NNTP",
	123:   "NTP",
	135:   "Microsoft RPC",
	137:   "NetBIOS Name Service",
	138:   "NetBIOS Datagram",
	139:   "NetBIOS Session",
	143:   "IMAP",
	161:   "SNMP",
	162:   "SNMP Trap",
	179:   "BGP",
	194:   "IRC",
	389:   "LDAP",
	443:   "HTTPS",
	445:   "SMB / Microsoft-DS",
	465:   "SMTPS",
	514:   "Syslog",
	515:   "LPD / Printing",
	587:   "SMTP (Submission)",
	631:   "IPP / CUPS",
	636:   "LDAPS",
	873:   "rsync",
	993:   "IMAPS",
	995:   "POP3S",
	1080:  "SOCKS Proxy",
	1194:  "OpenVPN",
	1433:  "Microsoft SQL Server",
	1521:  "Oracle DB",
	1723:  "PPTP VPN",
	2049:  "NFS",
	2375:  "Docker (unencrypted)",
	2376:  "Docker (TLS)",
	3000:  "Node.js / Grafana (Dev)",
	3306:  "MySQL / MariaDB",
	3389:  "RDP (Remote Desktop)",
	4000:  "Ember.js / Rails Dev",
	4443:  "HTTPS Alternate",
	5000:  "Flask / UPnP",
	5432:  "PostgreSQL",
	5900:  "VNC",
	5672:  "RabbitMQ AMQP",
	6379:  "Redis",
	6443:  "Kubernetes API",
	7000:  "Cassandra",
	8000:  "HTTP Dev Server",
	8080:  "HTTP Alternate / Proxy",
	8081:  "HTTP Alternate 2",
	8083:  "InfluxDB",
	8086:  "InfluxDB HTTP",
	8088:  "InfluxDB Cluster",
	8443:  "HTTPS Alternate",
	8888:  "Jupyter Notebook",
	9000:  "SonarQube / PHP-FPM",
	9090:  "Prometheus",
	9092:  "Apache Kafka",
	9200:  "Elasticsearch HTTP",
	9300:  "Elasticsearch Cluster",
	10250: "Kubernetes Kubelet",
	15672: "RabbitMQ Management",
	27017: "MongoDB",
	27018: "MongoDB Shard",
	27019: "MongoDB Config",
}

// ──────────────────────────────────────────────────────────────────────────────
// ServiceInfo holds the enriched result of the detection
// ──────────────────────────────────────────────────────────────────────────────

// ServiceInfo captures all information found about a service on a given port.
type ServiceInfo struct {
	ProcessName string // e.g. "sshd", "nginx"
	PID         int    // 0 if not found
	User        string // e.g. "root", "www-data"
	Command     string // Full command line from /proc/<pid>/cmdline
	WellKnown   string // e.g. "SSH", "HTTPS"
	Proto       string // "TCP", "UDP", or "TCP+UDP"
}

// DisplayName returns a short, human-readable description of the service.
func (s ServiceInfo) DisplayName() string {
	if s.ProcessName != "" && s.WellKnown != "" {
		if s.PID > 0 {
			return fmt.Sprintf("%s [%s] PID:%d", s.WellKnown, s.ProcessName, s.PID)
		}
		return fmt.Sprintf("%s [%s]", s.WellKnown, s.ProcessName)
	}
	if s.ProcessName != "" {
		if s.PID > 0 {
			return fmt.Sprintf("%s (PID:%d)", s.ProcessName, s.PID)
		}
		return s.ProcessName
	}
	if s.WellKnown != "" {
		return s.WellKnown + " (no active listener)"
	}
	return "Unknown Service"
}

// StatusBadge returns an emoji badge indicating detection confidence.
func (s ServiceInfo) StatusBadge() string {
	switch {
	case s.ProcessName != "" && s.PID > 0:
		return "🟢" // Active listener found with PID
	case s.ProcessName != "":
		return "🟡" // Process found but no PID
	case s.WellKnown != "":
		return "🟠" // Well-known port, no active listener
	default:
		return "⚪" // Unknown
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Tier 1a: Active Detection via `ss`
// ──────────────────────────────────────────────────────────────────────────────

// detectViaSS uses the `ss` socket statistics utility to find the process
// listening on the given port. Returns (processName, pid, user) or empty strings.
// This is the most accurate method on modern Linux systems.
func detectViaSS(port uint16) (processName string, pid int, user string, proto string) {
	portStr := strconv.Itoa(int(port))

	// Run ss: -l=listening, -p=processes, -t=tcp, -u=udp, -n=numeric, -H=no header
	// sport filter matches local (src) port
	cmd := exec.Command("ss", "-lptunH", fmt.Sprintf("sport = :%s", portStr))
	out, err := cmd.Output()
	if err != nil {
		return
	}

	// Track which protocols are seen
	seenTCP := false
	seenUDP := false

	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 1 {
			continue
		}

		// Determine protocol from first column: "tcp", "udp", "tcp6", "udp6"
		netProto := strings.ToLower(fields[0])
		if strings.HasPrefix(netProto, "tcp") {
			seenTCP = true
		} else if strings.HasPrefix(netProto, "udp") {
			seenUDP = true
		}

		// Parse process info — ss emits it as: users:(("sshd",pid=1234,fd=3))
		// Find the field that contains "users:(("
		for _, f := range fields {
			if strings.HasPrefix(f, "users:((") {
				name, p, u := parseSsUsers(f)
				if processName == "" {
					processName = name
					pid = p
					user = u
				}
			}
		}
	}

	switch {
	case seenTCP && seenUDP:
		proto = "TCP+UDP"
	case seenTCP:
		proto = "TCP"
	case seenUDP:
		proto = "UDP"
	}

	return
}

// parseSsUsers parses the users:((...)) field from ss output.
// Format example: users:(("sshd",pid=1234,fd=3))
func parseSsUsers(s string) (name string, pid int, user string) {
	// Strip users:(( and trailing ))
	s = strings.TrimPrefix(s, "users:((")
	s = strings.TrimSuffix(s, "))")
	// Split on ),( for multiple users — take the first entry
	entries := strings.Split(s, "),(")
	if len(entries) == 0 {
		return
	}
	entry := entries[0]

	// entry: "sshd",pid=1234,fd=3
	parts := strings.Split(entry, ",")
	for i, part := range parts {
		part = strings.TrimSpace(part)
		if i == 0 {
			// Process name is quoted
			name = strings.Trim(part, "\"")
		} else if strings.HasPrefix(part, "pid=") {
			pidStr := strings.TrimPrefix(part, "pid=")
			pid, _ = strconv.Atoi(pidStr)
		}
	}

	// Look up the user from /proc/<pid>/status if we have a pid
	if pid > 0 {
		user = lookupUserForPID(pid)
	}
	return
}

// ──────────────────────────────────────────────────────────────────────────────
// Tier 1b: Active Detection via /proc/net (pure-Go fallback)
// ──────────────────────────────────────────────────────────────────────────────

// detectViaProc uses /proc/net/tcp, /proc/net/tcp6, /proc/net/udp, /proc/net/udp6
// to find the inode for a listening socket on the given port, then walks
// /proc/[pid]/fd to match it to a process. Used when `ss` is unavailable.
func detectViaProc(port uint16) (processName string, pid int, user string, proto string) {
	portHex := fmt.Sprintf("%04X", port)

	// Check TCP and UDP proc files
	type result struct {
		inode string
		proto string
	}

	var inodes []result

	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		if inode := findInodeInProcNet(f, portHex, "0A"); inode != "" { // 0A = LISTEN state
			inodes = append(inodes, result{inode, "TCP"})
		}
	}
	for _, f := range []string{"/proc/net/udp", "/proc/net/udp6"} {
		if inode := findInodeInProcNet(f, portHex, "07"); inode != "" { // 07 = UNCONN (UDP listening)
			inodes = append(inodes, result{inode, "UDP"})
		}
	}

	if len(inodes) == 0 {
		return
	}

	// Collect unique inodes and protocols
	inodeSet := make(map[string]bool)
	protoSet := make(map[string]bool)
	for _, r := range inodes {
		inodeSet[r.inode] = true
		protoSet[r.proto] = true
	}

	// Determine combined protocol string
	if protoSet["TCP"] && protoSet["UDP"] {
		proto = "TCP+UDP"
	} else if protoSet["TCP"] {
		proto = "TCP"
	} else {
		proto = "UDP"
	}

	// Walk /proc to find which process owns the inode
	for _, inode := range inodes {
		pName, pPid, pUser := findProcessByInode(inode.inode)
		if pName != "" {
			processName = pName
			pid = pPid
			user = pUser
			return
		}
	}
	return
}

// findInodeInProcNet scans a /proc/net/ file (tcp, udp, etc.) for a line
// where the local port matches portHex and the socket state matches stateHex.
// Returns the socket inode string if found.
func findInodeInProcNet(path, portHex, stateHex string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Scan() // Skip header line
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		// Format: sl local_address rem_address st tx_queue rx_queue ... inode
		// local_address is IP:PORT in hex (big-endian IP, big-endian port for IPv4)
		// For IPv6, it's different but the port part is still hex.
		if len(fields) < 10 {
			continue
		}
		localAddr := fields[1]
		state := fields[3]

		// Extract port from local_address (it's after the colon)
		colonIdx := strings.LastIndex(localAddr, ":")
		if colonIdx < 0 {
			continue
		}
		localPort := localAddr[colonIdx+1:]

		if strings.EqualFold(localPort, portHex) && strings.EqualFold(state, stateHex) {
			// inode is at index 9
			return fields[9]
		}
	}
	return ""
}

// findProcessByInode walks /proc/[pid]/fd to find the process that owns
// the socket with the given inode.
func findProcessByInode(inode string) (processName string, pid int, user string) {
	socketTarget := fmt.Sprintf("socket:[%s]", inode)

	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pidStr := entry.Name()
		// Only numeric entries are process directories
		p, err := strconv.Atoi(pidStr)
		if err != nil {
			continue
		}

		fdDir := filepath.Join("/proc", pidStr, "fd")
		fds, err := os.ReadDir(fdDir)
		if err != nil {
			continue // No permission or process gone
		}

		for _, fd := range fds {
			link, err := os.Readlink(filepath.Join(fdDir, fd.Name()))
			if err != nil {
				continue
			}
			if link == socketTarget {
				// Found it — read the process name from /proc/<pid>/comm
				comm, _ := os.ReadFile(filepath.Join("/proc", pidStr, "comm"))
				processName = strings.TrimSpace(string(comm))
				pid = p
				user = lookupUserForPID(p)
				return
			}
		}
	}
	return
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

// lookupUserForPID reads /proc/<pid>/status to extract the UID, then
// resolves it to a username by reading /etc/passwd. Returns empty if failed.
func lookupUserForPID(pid int) string {
	statusPath := fmt.Sprintf("/proc/%d/status", pid)
	f, err := os.Open(statusPath)
	if err != nil {
		return ""
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "Uid:") {
			// Uid: real  effective  saved  filesystem
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				uid := fields[1]
				return resolveUID(uid)
			}
		}
	}
	return ""
}

// resolveUID looks up a UID in /etc/passwd and returns the username.
func resolveUID(uid string) string {
	f, err := os.Open("/etc/passwd")
	if err != nil {
		return uid
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		parts := strings.Split(scanner.Text(), ":")
		if len(parts) >= 3 && parts[2] == uid {
			return parts[0] // username
		}
	}
	return uid
}

// lookupCommandLine reads the full command line from /proc/<pid>/cmdline.
func lookupCommandLine(pid int) string {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return ""
	}
	// Arguments are separated by null bytes
	return strings.ReplaceAll(strings.TrimRight(string(data), "\x00"), "\x00", " ")
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API: detectService
// ──────────────────────────────────────────────────────────────────────────────

// detectService performs a comprehensive, multi-tiered detection of the service
// running on the given port. It returns a populated ServiceInfo struct.
//
// Detection tiers (in order of priority):
//  1. `ss` utility — fastest, most accurate, gives PID and process name
//  2. /proc/net + /proc/[pid]/fd walk — pure-Go fallback, works without `ss`
//  3. Well-known port map — name lookup when no active listener is found
func detectService(port uint16) ServiceInfo {
	info := ServiceInfo{}

	// Tier 2 lookup (always populate, overridden later by active detection)
	if name, ok := wellKnownPorts[port]; ok {
		info.WellKnown = name
	}

	// Tier 1a: try `ss` first (most reliable on modern Linux)
	pName, pid, user, proto := detectViaSS(port)

	// Tier 1b: if `ss` failed, fall back to /proc walk
	if pName == "" {
		pName, pid, user, proto = detectViaProc(port)
	}

	if pName != "" {
		info.ProcessName = pName
		info.PID = pid
		info.User = user
		info.Proto = proto

		// Enrich with full command line if we have a PID
		if pid > 0 {
			info.Command = lookupCommandLine(pid)
		}
	}

	return info
}
