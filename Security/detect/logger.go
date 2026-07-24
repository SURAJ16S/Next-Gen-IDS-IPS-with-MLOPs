// SPDX-License-Identifier: GPL-2.0
// detect/logger.go — Structured JSONL logging for detections and connections.
// Writes one JSON object per line to detections.jsonl and connections.jsonl.
// Thread-safe and supports log rotation.

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
)

// ──────────────────────────────────────────────────────────────────────────────
// JSONLLogger — writes detection events and connection records to JSONL files
// ──────────────────────────────────────────────────────────────────────────────

// JSONLLogger implements DetectionSubscriber and writes events to JSONL files.
type JSONLLogger struct {
	logDir          string
	detectionFile   *os.File
	connectionFile  *os.File
	mu              sync.Mutex
	maxFileSize     int64 // Max size in bytes before rotation
	detectionBytes  int64
	connectionBytes int64
	detectionCount  atomic.Int64
	connectionCount atomic.Int64
}

// NewJSONLLogger creates a logger that writes to the given directory.
// It creates detections.jsonl and connections.jsonl files.
func NewJSONLLogger(logDir string, maxFileSizeMB int) (*JSONLLogger, error) {
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return nil, fmt.Errorf("create log directory: %w", err)
	}

	detPath := filepath.Join(logDir, "detections.jsonl")
	connPath := filepath.Join(logDir, "connections.jsonl")

	detFile, err := os.OpenFile(detPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, fmt.Errorf("open detections log: %w", err)
	}

	connFile, err := os.OpenFile(connPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		detFile.Close()
		return nil, fmt.Errorf("open connections log: %w", err)
	}

	// Get current file sizes for rotation tracking
	detStat, _ := detFile.Stat()
	connStat, _ := connFile.Stat()

	maxSize := int64(maxFileSizeMB) * 1024 * 1024
	if maxSize <= 0 {
		maxSize = 100 * 1024 * 1024 // Default 100MB
	}

	l := &JSONLLogger{
		logDir:          logDir,
		detectionFile:   detFile,
		connectionFile:  connFile,
		maxFileSize:     maxSize,
		detectionBytes:  detStat.Size(),
		connectionBytes: connStat.Size(),
	}

	return l, nil
}

// OnDetection writes a detection event to detections.jsonl.
func (l *JSONLLogger) OnDetection(d Detection) {
	l.mu.Lock()
	defer l.mu.Unlock()

	data, err := json.Marshal(d)
	if err != nil {
		log.Printf("[logger] Failed to marshal detection: %v", err)
		return
	}
	data = append(data, '\n')

	n, err := l.detectionFile.Write(data)
	if err != nil {
		log.Printf("[logger] Failed to write detection: %v", err)
		return
	}

	l.detectionCount.Add(1)
	l.detectionBytes += int64(n)

	// Check if rotation is needed
	if l.detectionBytes >= l.maxFileSize {
		l.rotateFile("detections")
	}
}

// OnConnectionClose writes a connection record to connections.jsonl.
func (l *JSONLLogger) OnConnectionClose(c ConnectionRecord) {
	l.mu.Lock()
	defer l.mu.Unlock()

	data, err := json.Marshal(c)
	if err != nil {
		log.Printf("[logger] Failed to marshal connection: %v", err)
		return
	}
	data = append(data, '\n')

	n, err := l.connectionFile.Write(data)
	if err != nil {
		log.Printf("[logger] Failed to write connection: %v", err)
		return
	}

	l.connectionCount.Add(1)
	l.connectionBytes += int64(n)

	// Check if rotation is needed
	if l.connectionBytes >= l.maxFileSize {
		l.rotateFile("connections")
	}
}

// rotateFile rotates a log file by renaming it with a timestamp suffix.
// Must be called with l.mu held.
func (l *JSONLLogger) rotateFile(fileType string) {
	timestamp := time.Now().Format("20060102-150405")
	baseName := fileType + ".jsonl"
	rotatedName := fmt.Sprintf("%s.%s.jsonl", fileType, timestamp)

	currentPath := filepath.Join(l.logDir, baseName)
	rotatedPath := filepath.Join(l.logDir, rotatedName)

	var currentFile **os.File
	var bytesCounter *int64

	switch fileType {
	case "detections":
		currentFile = &l.detectionFile
		bytesCounter = &l.detectionBytes
	case "connections":
		currentFile = &l.connectionFile
		bytesCounter = &l.connectionBytes
	default:
		return
	}

	// Close current file
	(*currentFile).Close()

	// Rename to rotated name
	if err := os.Rename(currentPath, rotatedPath); err != nil {
		log.Printf("[logger] Failed to rotate %s: %v", fileType, err)
	}

	// Open new file
	newFile, err := os.OpenFile(currentPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		log.Printf("[logger] Failed to create new %s log: %v", fileType, err)
		return
	}

	*currentFile = newFile
	*bytesCounter = 0
}

// DetectionCount returns the total number of detections logged.
func (l *JSONLLogger) DetectionCount() int64 {
	return l.detectionCount.Load()
}

// ConnectionCount returns the total number of connections logged.
func (l *JSONLLogger) ConnectionCount() int64 {
	return l.connectionCount.Load()
}

// Close flushes and closes all log files.
func (l *JSONLLogger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()

	var errs []error
	if err := l.detectionFile.Close(); err != nil {
		errs = append(errs, err)
	}
	if err := l.connectionFile.Close(); err != nil {
		errs = append(errs, err)
	}
	if len(errs) > 0 {
		return fmt.Errorf("close errors: %v", errs)
	}
	return nil
}
