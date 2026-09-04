// SPDX-License-Identifier: GPL-2.0
// detect/behavioral.go — Cross-protocol behavioral detection engine.
// Analyzes patterns across all connections to detect port scanning,
// brute-force attacks, beaconing (C2), data exfiltration, and
// time-based anomalies.

package detect

import (
	"fmt"
	"sync"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// Behavioral Engine
// ──────────────────────────────────────────────────────────────────────────────

// BehavioralEngine tracks cross-connection patterns for anomaly detection.
type BehavioralEngine struct {
	bus *DetectionBus

	// Thresholds
	connPerMinThreshold int
	portScanThreshold   int
	bruteForceThreshold int

	// Per-IP tracking
	mu          sync.Mutex
	ipTrackers  map[string]*ipTracker
	lastCleanup time.Time
}

// ipTracker maintains state for a single source IP.
type ipTracker struct {
	// Connection rate
	connections []time.Time // Timestamps of recent connections

	// Port scan detection
	portsSeen map[uint16]time.Time // Unique ports accessed

	// Auth failure tracking (brute-force)
	authFailures []time.Time

	// Data volume tracking
	totalBytesOut int64 // Bytes sent TO this client (outbound data)
	totalBytesIn  int64 // Bytes received FROM this client

	// Beaconing detection
	connectionIntervals []time.Duration // Time between connections

	// Last activity
	lastSeen      time.Time
	firstSeen     time.Time
	lastRateAlert time.Time
}

// NewBehavioralEngine creates a behavioral detection engine.
func NewBehavioralEngine(bus *DetectionBus, connPerMin, portScan, bruteForce int) *BehavioralEngine {
	if connPerMin <= 0 {
		connPerMin = 120
	}
	if portScan <= 0 {
		portScan = 10
	}
	if bruteForce <= 0 {
		bruteForce = 5
	}

	engine := &BehavioralEngine{
		bus:                 bus,
		connPerMinThreshold: connPerMin,
		portScanThreshold:   portScan,
		bruteForceThreshold: bruteForce,
		ipTrackers:          make(map[string]*ipTracker),
		lastCleanup:         time.Now(),
	}

	return engine
}

// TrackConnection records a new connection from an IP to a port.
func (b *BehavioralEngine) TrackConnection(srcIP string, dstPort uint16) {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := time.Now()

	// Periodic cleanup of old trackers
	if now.Sub(b.lastCleanup) > 5*time.Minute {
		b.cleanup(now)
		b.lastCleanup = now
	}

	tracker, exists := b.ipTrackers[srcIP]
	if !exists {
		tracker = &ipTracker{
			portsSeen: make(map[uint16]time.Time),
			firstSeen: now,
		}
		b.ipTrackers[srcIP] = tracker
	}

	// Record connection interval for beaconing detection
	if !tracker.lastSeen.IsZero() {
		interval := now.Sub(tracker.lastSeen)
		tracker.connectionIntervals = append(tracker.connectionIntervals, interval)
		// Keep last 20 intervals
		if len(tracker.connectionIntervals) > 20 {
			tracker.connectionIntervals = tracker.connectionIntervals[len(tracker.connectionIntervals)-20:]
		}
	}

	tracker.lastSeen = now
	tracker.connections = append(tracker.connections, now)
	tracker.portsSeen[dstPort] = now

	// Prune old connections (keep last 5 minutes)
	cutoff := now.Add(-5 * time.Minute)
	pruned := tracker.connections[:0]
	for _, t := range tracker.connections {
		if t.After(cutoff) {
			pruned = append(pruned, t)
		}
	}
	tracker.connections = pruned

	// ── Connection rate check ──
	recentCount := len(tracker.connections)
	if recentCount > b.connPerMinThreshold {
		if now.Sub(tracker.lastRateAlert) > 1*time.Minute {
			b.bus.EmitDetection(Detection{
				ID:        "BEH-RATE-001",
				Timestamp: now,
				Severity:  SevHigh,
				Category:  CatDDoS,
				Protocol:  "TCP",
				SourceIP:  srcIP,
				DestPort:  dstPort,
				Summary:   fmt.Sprintf("High connection rate: %d connections in 5 minutes from %s", recentCount, srcIP),
				Details: map[string]any{
					"connections_5min": recentCount,
					"threshold":        b.connPerMinThreshold,
				},
			})
			tracker.lastRateAlert = now
		}
	}

	// ── Port scan detection ──
	// Count unique ports accessed in the last 60 seconds
	recentPorts := make(map[uint16]bool)
	portCutoff := now.Add(-60 * time.Second)
	for port, ts := range tracker.portsSeen {
		if ts.After(portCutoff) {
			recentPorts[port] = true
		}
	}

	if len(recentPorts) >= b.portScanThreshold {
		ports := make([]uint16, 0, len(recentPorts))
		for p := range recentPorts {
			ports = append(ports, p)
		}
		b.bus.EmitDetection(Detection{
			ID:        "BEH-SCAN-001",
			Timestamp: now,
			Severity:  SevHigh,
			Category:  CatPortScan,
			Protocol:  "TCP",
			SourceIP:  srcIP,
			DestPort:  dstPort,
			Summary:   fmt.Sprintf("Port scan detected: %s probed %d ports in 60 seconds", srcIP, len(recentPorts)),
			Details: map[string]any{
				"ports_scanned": ports,
				"port_count":    len(recentPorts),
				"threshold":     b.portScanThreshold,
			},
		})
	}

	// ── Beaconing detection ──
	b.detectBeaconing(srcIP, tracker, now)
}

// TrackAuthFailure records an authentication failure for brute-force detection.
func (b *BehavioralEngine) TrackAuthFailure(srcIP string, dstPort uint16, protocol string) {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := time.Now()
	tracker, exists := b.ipTrackers[srcIP]
	if !exists {
		tracker = &ipTracker{
			portsSeen: make(map[uint16]time.Time),
			firstSeen: now,
		}
		b.ipTrackers[srcIP] = tracker
	}

	tracker.authFailures = append(tracker.authFailures, now)

	// Prune old failures (keep last 5 minutes)
	cutoff := now.Add(-5 * time.Minute)
	pruned := tracker.authFailures[:0]
	for _, t := range tracker.authFailures {
		if t.After(cutoff) {
			pruned = append(pruned, t)
		}
	}
	tracker.authFailures = pruned

	// Check threshold
	if len(tracker.authFailures) >= b.bruteForceThreshold {
		b.bus.EmitDetection(Detection{
			ID:        "BEH-BRUTE-001",
			Timestamp: now,
			Severity:  SevCritical,
			Category:  CatBruteForce,
			Protocol:  protocol,
			SourceIP:  srcIP,
			DestPort:  dstPort,
			Summary:   fmt.Sprintf("Brute-force attack: %d auth failures in 5 minutes from %s on %s", len(tracker.authFailures), srcIP, protocol),
			Details: map[string]any{
				"failure_count": len(tracker.authFailures),
				"threshold":     b.bruteForceThreshold,
				"protocol":      protocol,
			},
		})
	}
}

// TrackDataVolume records data transfer volume for exfiltration detection.
func (b *BehavioralEngine) TrackDataVolume(srcIP string, bytesIn, bytesOut int64) {
	b.mu.Lock()
	defer b.mu.Unlock()

	tracker, exists := b.ipTrackers[srcIP]
	if !exists {
		return
	}

	tracker.totalBytesIn += bytesIn
	tracker.totalBytesOut += bytesOut

	// ── Data exfiltration detection ──
	// Large outbound data (server → client) with small inbound
	if tracker.totalBytesOut > 10*1024*1024 { // More than 10MB outbound
		ratio := float64(tracker.totalBytesOut) / float64(tracker.totalBytesIn+1)
		if ratio > 100 { // 100:1 out:in ratio
			b.bus.EmitDetection(Detection{
				ID:        "BEH-EXFIL-001",
				Timestamp: time.Now(),
				Severity:  SevHigh,
				Category:  CatDataExfil,
				Protocol:  "TCP",
				SourceIP:  srcIP,
				Summary:   fmt.Sprintf("Possible data exfiltration: %s received %.1f MB (ratio %.0f:1)", srcIP, float64(tracker.totalBytesOut)/(1024*1024), ratio),
				Details: map[string]any{
					"bytes_out": tracker.totalBytesOut,
					"bytes_in":  tracker.totalBytesIn,
					"ratio":     ratio,
				},
			})
		}
	}
}

// TrackSlowConnection records connections that have existed for a long duration with little data transfer (Slowloris/Slow-POST).
func (b *BehavioralEngine) TrackSlowConnection(srcIP string, dstPort uint16, duration time.Duration, bytesIn int64) {
	if duration > 30*time.Second && bytesIn < 1024 {
		b.bus.EmitDetection(Detection{
			ID:        "BEH-SLOWLORIS-001",
			Timestamp: time.Now(),
			Severity:  SevHigh,
			Category:  CatDDoS,
			Protocol:  "TCP",
			SourceIP:  srcIP,
			DestPort:  dstPort,
			Summary:   fmt.Sprintf("Slowloris/Slow-POST detected: %s held connection for %v but sent only %d bytes", srcIP, duration, bytesIn),
			Details: map[string]any{
				"duration_sec": duration.Seconds(),
				"bytes_in":     bytesIn,
			},
		})
	}
}

// detectBeaconing checks for regular periodic connections (C2 pattern).
func (b *BehavioralEngine) detectBeaconing(srcIP string, tracker *ipTracker, now time.Time) {
	intervals := tracker.connectionIntervals
	if len(intervals) < 5 {
		return // Need at least 5 intervals for meaningful analysis
	}

	// Calculate mean and standard deviation of intervals
	var sum time.Duration
	for _, interval := range intervals {
		sum += interval
	}
	mean := sum / time.Duration(len(intervals))

	var varianceSum float64
	for _, interval := range intervals {
		diff := float64(interval - mean)
		varianceSum += diff * diff
	}
	stddev := time.Duration(0)
	if len(intervals) > 1 {
		variance := varianceSum / float64(len(intervals)-1)
		if variance > 0 {
			// Approximate sqrt
			stddev = time.Duration(sqrt(variance))
		}
	}

	// Beaconing: regular intervals with low variance
	// If std deviation is less than 20% of the mean, it's suspiciously regular
	if mean > 5*time.Second && mean < 10*time.Minute {
		coefficient := float64(stddev) / float64(mean)
		if coefficient < 0.2 { // Less than 20% variance
			b.bus.EmitDetection(Detection{
				ID:        "BEH-BEACON-001",
				Timestamp: now,
				Severity:  SevHigh,
				Category:  CatBeaconing,
				Protocol:  "TCP",
				SourceIP:  srcIP,
				Summary: fmt.Sprintf("Beaconing detected: %s connecting every ~%s (CV=%.2f)",
					srcIP, mean.Round(time.Second), coefficient),
				Details: map[string]any{
					"mean_interval":        mean.String(),
					"std_deviation":        stddev.String(),
					"coefficient_variance": coefficient,
					"sample_count":         len(intervals),
				},
			})
		}
	}
}

// cleanup removes stale IP trackers.
func (b *BehavioralEngine) cleanup(now time.Time) {
	cutoff := now.Add(-10 * time.Minute)
	for ip, tracker := range b.ipTrackers {
		if tracker.lastSeen.Before(cutoff) {
			delete(b.ipTrackers, ip)
		}
	}
}

// sqrt is a simple integer square root for time.Duration.
func sqrt(x float64) float64 {
	if x <= 0 {
		return 0
	}
	z := x / 2
	for i := 0; i < 10; i++ {
		z = z - (z*z-x)/(2*z)
	}
	return z
}
