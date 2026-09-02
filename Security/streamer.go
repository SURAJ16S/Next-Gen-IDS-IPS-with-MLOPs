package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"ngfw-monitor/detect"
)

const maxBufSize = 10000

// TelemetryStreamer implements detect.DetectionSubscriber and sends telemetry to the dashboard.
type TelemetryStreamer struct {
	cfg      *NodeConfig
	stats    *detect.StatsCollector
	mu       sync.Mutex
	detBuf   []detect.Detection
	connBuf  []detect.ConnectionRecord
	dropped  int64
	stopCh   chan struct{}
	interval time.Duration
}

func NewTelemetryStreamer(cfg *NodeConfig, stats *detect.StatsCollector, interval time.Duration) *TelemetryStreamer {
	return &TelemetryStreamer{
		cfg:      cfg,
		stats:    stats,
		detBuf:   make([]detect.Detection, 0, maxBufSize),
		connBuf:  make([]detect.ConnectionRecord, 0, maxBufSize),
		stopCh:   make(chan struct{}),
		interval: interval,
	}
}

func (ts *TelemetryStreamer) Start() {
	go ts.loop()
}

func (ts *TelemetryStreamer) Stop() {
	close(ts.stopCh)
	ts.Flush()
}

func (ts *TelemetryStreamer) OnDetection(d detect.Detection) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	if len(ts.detBuf) >= maxBufSize {
		// Drop oldest
		ts.detBuf = ts.detBuf[1:]
		ts.dropped++
	}
	ts.detBuf = append(ts.detBuf, d)
}

func (ts *TelemetryStreamer) OnConnectionClose(c detect.ConnectionRecord) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	if len(ts.connBuf) >= maxBufSize {
		// Drop oldest
		ts.connBuf = ts.connBuf[1:]
		ts.dropped++
	}
	ts.connBuf = append(ts.connBuf, c)
}

func (ts *TelemetryStreamer) loop() {
	ticker := time.NewTicker(ts.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			ts.Flush()
		case <-ts.stopCh:
			return
		}
	}
}

func (ts *TelemetryStreamer) Flush() {
	ts.mu.Lock()
	if len(ts.detBuf) == 0 && len(ts.connBuf) == 0 {
		ts.mu.Unlock()
		return
	}

	detBatch := ts.detBuf
	connBatch := ts.connBuf
	droppedSnap := ts.dropped

	ts.detBuf = make([]detect.Detection, 0, maxBufSize)
	ts.connBuf = make([]detect.ConnectionRecord, 0, maxBufSize)
	ts.dropped = 0
	ts.mu.Unlock()

	ts.send(detBatch, connBatch, droppedSnap)
}

func (ts *TelemetryStreamer) send(detections []detect.Detection, connections []detect.ConnectionRecord, dropped int64) {
	if ts.cfg == nil || ts.cfg.DashboardURL == "" {
		return
	}

	payload := map[string]interface{}{
		"node_id":        ts.cfg.NodeID,
		"timestamp":      time.Now(),
		"detections":     detections,
		"connections":    connections,
		"dropped_events": dropped,
	}

	if ts.stats != nil {
		payload["protocol_stats"] = ts.stats.ProtocolConnStats()
		payload["detection_counts_by_protocol"] = ts.stats.ProtocolCounts()
	}

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[streamer] Failed to marshal telemetry: %v", err)
		return
	}

	endpoint := "/api/agent/telemetry"
	req, err := http.NewRequest("POST", ts.cfg.DashboardURL+endpoint, bytes.NewBuffer(payloadBytes))
	if err != nil {
		return
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Node-Id", ts.cfg.NodeID)
	req.Header.Set("X-Node-Secret", ts.cfg.NodeSecretKey)

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[streamer] Delivery failed: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		log.Println("[streamer] Unauthorized (401). Check Node Secret.")
	}
}
