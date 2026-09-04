// SPDX-License-Identifier: GPL-2.0
// detect/threshold_calibrator.go — Adaptive Threshold Recalibration.

package detect

import (
	"sync"
	"time"
)

type ThresholdCalibrator struct {
	bus             *DetectionBus
	mu              sync.Mutex
	alertCounts     map[string]int // Category -> Count
	connectionCount int
	lastCalibration time.Time
}

func NewThresholdCalibrator(bus *DetectionBus) *ThresholdCalibrator {
	tc := &ThresholdCalibrator{
		bus:             bus,
		alertCounts:     make(map[string]int),
		lastCalibration: time.Now(),
	}
	bus.Subscribe(tc)
	go tc.calibrationLoop()
	return tc
}

func (tc *ThresholdCalibrator) OnDetection(d Detection) {
	if d.Severity < SevMedium {
		return
	}
	tc.mu.Lock()
	tc.alertCounts[d.Category]++
	tc.mu.Unlock()
}

func (tc *ThresholdCalibrator) OnConnectionClose(c ConnectionRecord) {
	tc.mu.Lock()
	tc.connectionCount++
	tc.mu.Unlock()
}

func (tc *ThresholdCalibrator) calibrationLoop() {
	// In production, this might be weekly. For demonstration, we'll run it every 15 minutes.
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()

	for {
		<-ticker.C
		tc.mu.Lock()
		
		totalAlerts := 0
		for _, count := range tc.alertCounts {
			totalAlerts += count
		}
		
		// If alert volume is extremely high relative to connections (e.g. >10% of all conns alert),
		// we might propose raising the threshold to reduce fatigue.
		// If alert volume is 0, we might propose lowering the threshold.
		var proposal string
		if tc.connectionCount > 100 {
			alertRatio := float64(totalAlerts) / float64(tc.connectionCount)
			if alertRatio > 0.10 {
				proposal = "High noise detected. Propose increasing BruteForce and PortScan thresholds by 20%."
			} else if alertRatio < 0.001 {
				proposal = "Low alert volume. Propose decreasing BruteForce and PortScan thresholds by 10% to increase sensitivity."
			}
		}

		if proposal != "" {
			// Emit out of band
			go func(prop string, alerts int, conns int) {
				tc.bus.EmitDetection(Detection{
					ID:         "SYS-RECALIBRATE-001",
					Timestamp:  time.Now(),
					Severity:   SevInfo,
					Category:   "system-calibration",
					Protocol:   "System",
					SourceIP:   "127.0.0.1",
					SourcePort: 0,
					DestPort:   0,
					Summary:    prop,
					ConnID:     "sys-calib",
					Details: map[string]any{
						"total_alerts":      alerts,
						"total_connections": conns,
						"proposal":          prop,
					},
				})
			}(proposal, totalAlerts, tc.connectionCount)
		}

		// Reset counters for next window
		tc.alertCounts = make(map[string]int)
		tc.connectionCount = 0
		tc.lastCalibration = time.Now()
		
		tc.mu.Unlock()
	}
}
