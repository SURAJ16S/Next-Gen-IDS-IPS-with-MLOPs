// SPDX-License-Identifier: GPL-2.0
// proxy/config.go — Proxy configuration types and YAML loading.
// Defines the structure for multi-port proxy listener configuration,
// TLS interception settings, and provides YAML file parsing.

package proxy

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// ──────────────────────────────────────────────────────────────────────────────
// Configuration types
// ──────────────────────────────────────────────────────────────────────────────

// ProxyConfig is the top-level proxy configuration.
type ProxyConfig struct {
	Listeners        []ListenerConfig `yaml:"listeners"`
	TLS              TLSConfig        `yaml:"tls"`
	Logging          LoggingConfig    `yaml:"logging"`
	Detection        DetectionConfig  `yaml:"detection"`
	CentralDashboard string           `yaml:"central_dashboard_url"`
}

// ListenerConfig defines how a single port is proxied.
type ListenerConfig struct {
	ListenPort  uint16 `yaml:"listen_port"`
	BackendAddr string `yaml:"backend_addr"` // host:port of actual service
	Transport   string `yaml:"transport"`    // "tcp", "udp", "tcp+tls"
	Service     string `yaml:"service"`      // Protocol hint: "http", "ssh", "dns", etc.
	Enabled     bool   `yaml:"enabled"`
}

// TLSConfig holds TLS interception settings.
type TLSConfig struct {
	Enabled       bool   `yaml:"enabled"`
	CACertFile    string `yaml:"ca_cert_file"`
	CAKeyFile     string `yaml:"ca_key_file"`
	CertCacheSize int    `yaml:"cert_cache_size"`
}

// LoggingConfig holds logging settings.
type LoggingConfig struct {
	Dir           string `yaml:"dir"`
	MaxFileSizeMB int    `yaml:"max_file_size_mb"`
}

// DetectionConfig holds detection engine settings.
type DetectionConfig struct {
	RateLimit         RateLimitConfig `yaml:"rate_limit"`
	MaxPayloadInspect int             `yaml:"max_payload_inspect_bytes"` // Max bytes to inspect per stream
}

// RateLimitConfig holds rate-limiting thresholds.
type RateLimitConfig struct {
	ConnectionsPerMinute int `yaml:"connections_per_minute"`
	ConnectionsPerSecond int `yaml:"connections_per_second"`
	PortScanThreshold    int `yaml:"port_scan_threshold"`   // Unique ports in 60s
	BruteForceThreshold  int `yaml:"brute_force_threshold"` // Auth failures in 60s
}

// ──────────────────────────────────────────────────────────────────────────────
// Loaders
// ──────────────────────────────────────────────────────────────────────────────

// LoadConfig reads and parses a YAML configuration file.
func LoadConfig(path string) (*ProxyConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := &ProxyConfig{}
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	// Apply defaults
	cfg.applyDefaults()

	// Validate
	if err := cfg.validate(); err != nil {
		return nil, fmt.Errorf("validate config: %w", err)
	}

	return cfg, nil
}

// DefaultConfig returns a comprehensive default configuration covering
// all major ports and services.
func DefaultConfig() *ProxyConfig {
	cfg := &ProxyConfig{
		Listeners: []ListenerConfig{
			// ── Web ──
			{ListenPort: 80, BackendAddr: "127.0.0.1:8080", Transport: "tcp", Service: "http", Enabled: true},
			{ListenPort: 3000, BackendAddr: "127.0.0.1:13000", Transport: "tcp", Service: "http", Enabled: true},
			{ListenPort: 443, BackendAddr: "127.0.0.1:8443", Transport: "tcp+tls", Service: "https", Enabled: true},
			{ListenPort: 8080, BackendAddr: "127.0.0.1:18080", Transport: "tcp", Service: "http", Enabled: true},
			{ListenPort: 8443, BackendAddr: "127.0.0.1:18443", Transport: "tcp+tls", Service: "https", Enabled: true},

			// ── Remote Access ──
			{ListenPort: 22, BackendAddr: "127.0.0.1:2222", Transport: "tcp", Service: "ssh", Enabled: true},
			{ListenPort: 23, BackendAddr: "127.0.0.1:2323", Transport: "tcp", Service: "telnet", Enabled: true},
			{ListenPort: 3389, BackendAddr: "127.0.0.1:13389", Transport: "tcp", Service: "rdp", Enabled: true},
			{ListenPort: 5900, BackendAddr: "127.0.0.1:15900", Transport: "tcp", Service: "vnc", Enabled: true},

			// ── Email ──
			{ListenPort: 25, BackendAddr: "127.0.0.1:2525", Transport: "tcp", Service: "smtp", Enabled: true},
			{ListenPort: 465, BackendAddr: "127.0.0.1:1465", Transport: "tcp+tls", Service: "smtps", Enabled: true},
			{ListenPort: 587, BackendAddr: "127.0.0.1:1587", Transport: "tcp", Service: "smtp", Enabled: true},
			{ListenPort: 110, BackendAddr: "127.0.0.1:1110", Transport: "tcp", Service: "pop3", Enabled: true},
			{ListenPort: 995, BackendAddr: "127.0.0.1:1995", Transport: "tcp+tls", Service: "pop3s", Enabled: true},
			{ListenPort: 143, BackendAddr: "127.0.0.1:1143", Transport: "tcp", Service: "imap", Enabled: true},
			{ListenPort: 993, BackendAddr: "127.0.0.1:1993", Transport: "tcp+tls", Service: "imaps", Enabled: true},

			// ── DNS ──
			{ListenPort: 53, BackendAddr: "127.0.0.1:5353", Transport: "tcp", Service: "dns", Enabled: true},
			{ListenPort: 53, BackendAddr: "127.0.0.1:5353", Transport: "udp", Service: "dns", Enabled: true},

			// ── File Transfer ──
			{ListenPort: 21, BackendAddr: "127.0.0.1:2121", Transport: "tcp", Service: "ftp", Enabled: true},
			{ListenPort: 69, BackendAddr: "127.0.0.1:6969", Transport: "udp", Service: "tftp", Enabled: true},

			// ── Databases ──
			{ListenPort: 3306, BackendAddr: "127.0.0.1:13306", Transport: "tcp", Service: "mysql", Enabled: true},
			{ListenPort: 5432, BackendAddr: "127.0.0.1:15432", Transport: "tcp", Service: "postgresql", Enabled: true},
			{ListenPort: 6379, BackendAddr: "127.0.0.1:16379", Transport: "tcp", Service: "redis", Enabled: true},
			{ListenPort: 27017, BackendAddr: "127.0.0.1:37017", Transport: "tcp", Service: "mongodb", Enabled: true},

			// ── Directory Services ──
			{ListenPort: 389, BackendAddr: "127.0.0.1:1389", Transport: "tcp", Service: "ldap", Enabled: true},
			{ListenPort: 636, BackendAddr: "127.0.0.1:1636", Transport: "tcp+tls", Service: "ldaps", Enabled: true},
			{ListenPort: 88, BackendAddr: "127.0.0.1:1088", Transport: "tcp", Service: "kerberos", Enabled: true},

			// ── Monitoring & Infrastructure ──
			{ListenPort: 161, BackendAddr: "127.0.0.1:1161", Transport: "udp", Service: "snmp", Enabled: true},
			{ListenPort: 514, BackendAddr: "127.0.0.1:1514", Transport: "udp", Service: "syslog", Enabled: true},
			{ListenPort: 123, BackendAddr: "127.0.0.1:1123", Transport: "udp", Service: "ntp", Enabled: true},
			{ListenPort: 5672, BackendAddr: "127.0.0.1:15672", Transport: "tcp", Service: "amqp", Enabled: true},
			{ListenPort: 9092, BackendAddr: "127.0.0.1:19092", Transport: "tcp", Service: "kafka", Enabled: true},

			// ── Proxy/VPN ──
			{ListenPort: 1080, BackendAddr: "127.0.0.1:11080", Transport: "tcp", Service: "socks", Enabled: true},
			{ListenPort: 1194, BackendAddr: "127.0.0.1:11194", Transport: "udp", Service: "openvpn", Enabled: true},

			// ── Container/Orchestration ──
			{ListenPort: 2375, BackendAddr: "127.0.0.1:12375", Transport: "tcp", Service: "docker", Enabled: true},
			{ListenPort: 6443, BackendAddr: "127.0.0.1:16443", Transport: "tcp+tls", Service: "k8s-api", Enabled: true},
			{ListenPort: 10250, BackendAddr: "127.0.0.1:20250", Transport: "tcp+tls", Service: "kubelet", Enabled: true},

			// ── Misc well-known ──
			{ListenPort: 111, BackendAddr: "127.0.0.1:1111", Transport: "tcp", Service: "rpc", Enabled: true},
			{ListenPort: 135, BackendAddr: "127.0.0.1:1135", Transport: "tcp", Service: "msrpc", Enabled: true},
			{ListenPort: 139, BackendAddr: "127.0.0.1:1139", Transport: "tcp", Service: "netbios", Enabled: true},
			{ListenPort: 445, BackendAddr: "127.0.0.1:1445", Transport: "tcp", Service: "smb", Enabled: true},
			{ListenPort: 873, BackendAddr: "127.0.0.1:1873", Transport: "tcp", Service: "rsync", Enabled: true},
			{ListenPort: 9200, BackendAddr: "127.0.0.1:19200", Transport: "tcp", Service: "elasticsearch", Enabled: true},
		},
		TLS: TLSConfig{
			Enabled:       false, // Disabled by default, user enables when ready
			CACertFile:    "proxy/certs/ca.crt",
			CAKeyFile:     "proxy/certs/ca.key",
			CertCacheSize: 1000,
		},
		Logging: LoggingConfig{
			Dir:           "logs",
			MaxFileSizeMB: 100,
		},
		Detection: DetectionConfig{
			MaxPayloadInspect: 65536, // 64KB per stream direction
			RateLimit: RateLimitConfig{
				ConnectionsPerMinute: 120,
				ConnectionsPerSecond: 30,
				PortScanThreshold:    10,
				BruteForceThreshold:  5,
			},
		},
		CentralDashboard: "http://localhost:5000",
	}

	return cfg
}

// applyDefaults fills in zero-value fields with sensible defaults.
func (c *ProxyConfig) applyDefaults() {
	if c.CentralDashboard == "" {
		c.CentralDashboard = "http://localhost:5000"
	}
	if c.Logging.Dir == "" {
		c.Logging.Dir = "logs"
	}
	if c.Logging.MaxFileSizeMB <= 0 {
		c.Logging.MaxFileSizeMB = 100
	}
	if c.Detection.MaxPayloadInspect <= 0 {
		c.Detection.MaxPayloadInspect = 65536
	}
	if c.Detection.RateLimit.ConnectionsPerMinute <= 0 {
		c.Detection.RateLimit.ConnectionsPerMinute = 120
	}
	if c.Detection.RateLimit.ConnectionsPerSecond <= 0 {
		c.Detection.RateLimit.ConnectionsPerSecond = 30
	}
	if c.Detection.RateLimit.PortScanThreshold <= 0 {
		c.Detection.RateLimit.PortScanThreshold = 10
	}
	if c.Detection.RateLimit.BruteForceThreshold <= 0 {
		c.Detection.RateLimit.BruteForceThreshold = 5
	}
	if c.TLS.CertCacheSize <= 0 {
		c.TLS.CertCacheSize = 1000
	}

	for i := range c.Listeners {
		if c.Listeners[i].Transport == "" {
			c.Listeners[i].Transport = "tcp"
		}
	}
}

// validate checks the configuration for errors.
func (c *ProxyConfig) validate() error {
	if len(c.Listeners) == 0 {
		return fmt.Errorf("no listeners configured")
	}

	seen := make(map[string]bool)
	for i, l := range c.Listeners {
		if l.ListenPort == 0 {
			return fmt.Errorf("listener[%d]: listen_port is required", i)
		}
		if l.BackendAddr == "" {
			return fmt.Errorf("listener[%d] (port %d): backend_addr is required", i, l.ListenPort)
		}

		// Allow duplicate ports only if different transport (tcp vs udp)
		key := fmt.Sprintf("%d/%s", l.ListenPort, l.Transport)
		if seen[key] {
			return fmt.Errorf("listener[%d]: duplicate port/transport %s", i, key)
		}
		seen[key] = true
	}

	return nil
}

// EnabledListeners returns only listeners with Enabled=true.
func (c *ProxyConfig) EnabledListeners() []ListenerConfig {
	var result []ListenerConfig
	for _, l := range c.Listeners {
		if l.Enabled {
			result = append(result, l)
		}
	}
	return result
}

// SaveConfig writes the configuration to a YAML file.
func SaveConfig(cfg *ProxyConfig, path string) error {
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	return os.WriteFile(path, data, 0644)
}

// HasListener returns true if the config already has an enabled TCP listener on the given port.
func (c *ProxyConfig) HasListener(port uint16) bool {
	for _, l := range c.Listeners {
		if l.ListenPort == port && l.Transport == "tcp" && l.Enabled {
			return true
		}
	}
	return false
}

// AddOrUpdateListener adds a new TCP listener for the given listen port forwarding to
// backendPort on localhost, or enables an existing disabled listener for that port.
// If a matching enabled listener already exists it is left unchanged.
func (c *ProxyConfig) AddOrUpdateListener(listenPort, backendPort uint16, service string) {
	// Check for an existing entry (enabled or disabled) with matching port + transport
	for i, l := range c.Listeners {
		if l.ListenPort == listenPort && l.Transport == "tcp" {
			// Re-enable and update backend if the entry was disabled
			c.Listeners[i].Enabled = true
			c.Listeners[i].BackendAddr = fmt.Sprintf("127.0.0.1:%d", backendPort)
			if service != "" {
				c.Listeners[i].Service = service
			}
			return
		}
	}

	// No existing entry — append a new one
	if service == "" {
		service = "http" // generic default service label
	}
	c.Listeners = append(c.Listeners, ListenerConfig{
		ListenPort:  listenPort,
		BackendAddr: fmt.Sprintf("127.0.0.1:%d", backendPort),
		Transport:   "tcp",
		Service:     service,
		Enabled:     true,
	})
}
