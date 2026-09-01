// SPDX-License-Identifier: GPL-2.0
// detect/stats.go — Aggregate statistics collector for detections.
// Tracks counts by category, severity, source IP, and protocol.
// Thread-safe for concurrent access from multiple analyzers.

package detect

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// StatsCollector — aggregates detection and connection statistics
// ──────────────────────────────────────────────────────────────────────────────

// StatsCollector implements DetectionSubscriber and tracks aggregate stats.
type StatsCollector struct {
	mu sync.RWMutex

	// Detection counts
	totalDetections atomic.Int64
	bySeverity      map[Severity]int64
	byCategory      map[string]int64
	byProtocol      map[string]int64
	bySourceIP      map[string]int64

	// Connection counts
	totalConnections atomic.Int64
	activeConns      atomic.Int64
	totalBytesIn     atomic.Int64
	totalBytesOut    atomic.Int64

	// Per-port stats
	byPort map[uint16]*PortStats

	// Per-protocol volume stats
	byProtocolConn map[string]*ProtocolConnStats

	// Top talkers — IPs with most detections
	startTime time.Time
}

// ProtocolConnStats holds traffic-volume stats per protocol.
type ProtocolConnStats struct {
	Protocol    string `json:"protocol"`
	Connections int64  `json:"connections"`
	BytesIn     int64  `json:"bytes_in"`
	BytesOut    int64  `json:"bytes_out"`
}

// PortStats tracks per-port statistics.
type PortStats struct {
	Connections int64    `json:"connections"`
	Detections  int64    `json:"detections"`
	BytesIn     int64    `json:"bytes_in"`
	BytesOut    int64    `json:"bytes_out"`
	MaxSeverity Severity `json:"max_severity"`
}

// TopTalkerEntry represents an IP with its detection count.
type TopTalkerEntry struct {
	IP         string `json:"ip"`
	Detections int64  `json:"detections"`
}

// NewStatsCollector creates a new statistics collector.
func NewStatsCollector() *StatsCollector {
	return &StatsCollector{
		bySeverity:     make(map[Severity]int64),
		byCategory:     make(map[string]int64),
		byProtocol:     make(map[string]int64),
		bySourceIP:     make(map[string]int64),
		byPort:         make(map[uint16]*PortStats),
		byProtocolConn: make(map[string]*ProtocolConnStats),
		startTime:      time.Now(),
	}
}

// OnDetection records a detection event.
func (s *StatsCollector) OnDetection(d Detection) {
	s.totalDetections.Add(1)

	s.mu.Lock()
	defer s.mu.Unlock()

	s.bySeverity[d.Severity]++
	s.byCategory[d.Category]++
	if d.Protocol != "" {
		s.byProtocol[d.Protocol]++
	}
	if d.SourceIP != "" {
		s.bySourceIP[d.SourceIP]++
	}

	// Update port stats
	ps := s.getOrCreatePortStats(d.DestPort)
	ps.Detections++
	if d.Severity > ps.MaxSeverity {
		ps.MaxSeverity = d.Severity
	}
}

// OnConnectionClose records a connection lifecycle event.
func (s *StatsCollector) OnConnectionClose(c ConnectionRecord) {
	s.totalConnections.Add(1)
	s.totalBytesIn.Add(c.BytesFromClient)
	s.totalBytesOut.Add(c.BytesToClient)

	s.mu.Lock()
	defer s.mu.Unlock()

	ps := s.getOrCreatePortStats(c.ListenPort)
	ps.Connections++
	ps.BytesIn += c.BytesFromClient
	ps.BytesOut += c.BytesToClient
	if c.MaxSeverity > ps.MaxSeverity {
		ps.MaxSeverity = c.MaxSeverity
	}

	if c.DetectedProtocol != "" {
		pvs, ok := s.byProtocolConn[c.DetectedProtocol]
		if !ok {
			pvs = &ProtocolConnStats{Protocol: c.DetectedProtocol}
			s.byProtocolConn[c.DetectedProtocol] = pvs
		}
		pvs.Connections++
		pvs.BytesIn += c.BytesFromClient
		pvs.BytesOut += c.BytesToClient
	}
}

// IncrementActive increments the active connection counter.
func (s *StatsCollector) IncrementActive() {
	s.activeConns.Add(1)
}

// DecrementActive decrements the active connection counter.
func (s *StatsCollector) DecrementActive() {
	s.activeConns.Add(-1)
}

// getOrCreatePortStats returns port stats, creating if needed. Must hold mu.
func (s *StatsCollector) getOrCreatePortStats(port uint16) *PortStats {
	ps, ok := s.byPort[port]
	if !ok {
		ps = &PortStats{}
		s.byPort[port] = ps
	}
	return ps
}

// ──────────────────────────────────────────────────────────────────────────────
// Read accessors (thread-safe)
// ──────────────────────────────────────────────────────────────────────────────

// TotalDetections returns the total detection count.
func (s *StatsCollector) TotalDetections() int64 {
	return s.totalDetections.Load()
}

// TotalConnections returns the total connection count.
func (s *StatsCollector) TotalConnections() int64 {
	return s.totalConnections.Load()
}

// ActiveConnections returns the current active connection count.
func (s *StatsCollector) ActiveConnections() int64 {
	return s.activeConns.Load()
}

// TotalBytesIn returns total bytes received from clients.
func (s *StatsCollector) TotalBytesIn() int64 {
	return s.totalBytesIn.Load()
}

// TotalBytesOut returns total bytes sent to clients.
func (s *StatsCollector) TotalBytesOut() int64 {
	return s.totalBytesOut.Load()
}

// SeverityCounts returns a copy of detection counts by severity.
func (s *StatsCollector) SeverityCounts() map[string]int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[string]int64)
	for sev, count := range s.bySeverity {
		result[sev.String()] = count
	}
	return result
}

// CategoryCounts returns a copy of detection counts by category.
func (s *StatsCollector) CategoryCounts() map[string]int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[string]int64)
	for cat, count := range s.byCategory {
		result[cat] = count
	}
	return result
}

// ProtocolCounts returns a copy of detection counts by protocol.
func (s *StatsCollector) ProtocolCounts() map[string]int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[string]int64)
	for proto, count := range s.byProtocol {
		result[proto] = count
	}
	return result
}

// ProtocolConnStats returns a copy of traffic-volume stats by protocol.
func (s *StatsCollector) ProtocolConnStats() map[string]*ProtocolConnStats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[string]*ProtocolConnStats)
	for proto, stats := range s.byProtocolConn {
		// return a copy so caller doesn't race
		cp := *stats
		result[proto] = &cp
	}
	return result
}

// TopTalkers returns the top N source IPs by detection count.
func (s *StatsCollector) TopTalkers(n int) []TopTalkerEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()

	entries := make([]TopTalkerEntry, 0, len(s.bySourceIP))
	for ip, count := range s.bySourceIP {
		entries = append(entries, TopTalkerEntry{IP: ip, Detections: count})
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Detections > entries[j].Detections
	})

	if n > len(entries) {
		n = len(entries)
	}
	return entries[:n]
}

// Uptime returns the duration since the stats collector was created.
func (s *StatsCollector) Uptime() time.Duration {
	return time.Since(s.startTime)
}
