// SPDX-License-Identifier: GPL-2.0
// detect/flow_logger.go — JSONL logger for flow statistics.
// Writes completed FlowRecords to logs/flow_stats.jsonl, one JSON object
// per line. Supports the same rotation scheme as the detection logger.

package detect

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
	"context"
)

type FlowLogger struct {
	logDir      string
	file        *os.File
	mu          sync.Mutex
	maxFileSize int64
	currentSize int64
	count       atomic.Int64
	bus         *DetectionBus
}

func NewFlowLogger(logDir string, maxFileSizeMB int, bus *DetectionBus) (*FlowLogger, error) {
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return nil, fmt.Errorf("create log directory: %w", err)
	}

	path := filepath.Join(logDir, "flow_stats.jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, fmt.Errorf("open flow_stats log: %w", err)
	}

	stat, _ := f.Stat()
	maxSize := int64(maxFileSizeMB) * 1024 * 1024
	if maxSize <= 0 {
		maxSize = 100 * 1024 * 1024
	}

	return &FlowLogger{
		logDir:      logDir,
		file:        f,
		maxFileSize: maxSize,
		currentSize: stat.Size(),
		bus:         bus,
	}, nil
}

// LogFlow writes a single FlowRecord as a JSON line and scores it via ML.
func (fl *FlowLogger) LogFlow(rec FlowRecord) {
	fl.mu.Lock()
	defer fl.mu.Unlock()

	data, err := json.Marshal(rec)
	if err != nil {
		log.Printf("[flow-logger] Failed to marshal flow: %v", err)
		return
	}
	
	// Convert to map for ML scoring
	var flowMap map[string]interface{}
	if err := json.Unmarshal(data, &flowMap); err == nil && fl.bus != nil {
		go func(m map[string]interface{}, origRec FlowRecord) {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Millisecond)
			defer cancel()
			
			score, _ := ScoreFlow(ctx, m)
			if score != nil && score.RiskScore > 70 && score.ModelVersion != "unavailable" {
				sev := SevMedium
				if score.RiskScore > 85 {
					sev = SevHigh
				}
				
				fl.bus.EmitDetection(Detection{
					ID:         fmt.Sprintf("ML-FLOW-%s", score.PredictedCategory),
					Timestamp:  time.Now(),
					Severity:   sev,
					Category:   "ml-anomaly",
					Protocol:   origRec.Protocol,
					SourceIP:   origRec.SrcIP,
					SourcePort: origRec.SrcPort,
					DestPort:   origRec.DstPort,
					Summary: fmt.Sprintf("ML flow anomaly score %.1f — predicted: %s (model: %s)",
						score.RiskScore, score.PredictedCategory, score.ModelVersion),
					ConnID: origRec.FlowID,
					Details: map[string]any{
						"risk_score":         score.RiskScore,
						"predicted_category": score.PredictedCategory,
						"model_version":      score.ModelVersion,
					},
				})
			}
		}(flowMap, rec)
	}

	data = append(data, '\n')

	n, err := fl.file.Write(data)
	if err != nil {
		log.Printf("[flow-logger] Failed to write flow: %v", err)
		return
	}

	fl.count.Add(1)
	fl.currentSize += int64(n)

	if fl.currentSize >= fl.maxFileSize {
		fl.rotate()
	}
}

// Count returns the total number of flow records logged.
func (fl *FlowLogger) Count() int64 {
	return fl.count.Load()
}

// Close flushes and closes the log file.
func (fl *FlowLogger) Close() error {
	fl.mu.Lock()
	defer fl.mu.Unlock()
	return fl.file.Close()
}

// rotate renames the current log file and opens a fresh one.
// Must be called with fl.mu held.
func (fl *FlowLogger) rotate() {
	timestamp := time.Now().Format("20060102-150405")
	currentPath := filepath.Join(fl.logDir, "flow_stats.jsonl")
	rotatedPath := filepath.Join(fl.logDir, fmt.Sprintf("flow_stats.%s.jsonl", timestamp))

	fl.file.Close()
	if err := os.Rename(currentPath, rotatedPath); err != nil {
		log.Printf("[flow-logger] Failed to rotate: %v", err)
	}

	newFile, err := os.OpenFile(currentPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		log.Printf("[flow-logger] Failed to create new log: %v", err)
		return
	}

	fl.file = newFile
	fl.currentSize = 0
}
