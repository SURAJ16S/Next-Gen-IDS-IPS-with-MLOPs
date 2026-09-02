package detect

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestJSONLLogger_ProtocolRouting(t *testing.T) {
	tempDir := t.TempDir()
	logger, err := NewJSONLLogger(tempDir, 1)
	if err != nil {
		t.Fatalf("Failed to create logger: %v", err)
	}

	// Emit detections with different protocols
	d1 := Detection{Protocol: "HTTP", Summary: "Test 1"}
	d2 := Detection{Protocol: "ssh", Summary: "Test 2"}
	d3 := Detection{Protocol: "", Summary: "Test 3"} // Should route to "unknown"

	logger.OnDetection(d1)
	logger.OnDetection(d2)
	logger.OnDetection(d3)
	logger.Close()

	// Verify monolithic file still got all 3
	detContent, err := os.ReadFile(filepath.Join(tempDir, "detections.jsonl"))
	if err != nil {
		t.Fatalf("Failed to read detections.jsonl: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(detContent)), "\n")
	if len(lines) != 3 {
		t.Errorf("Expected 3 lines in detections.jsonl, got %d", len(lines))
	}

	// Verify protocol-specific files
	verifyProtocolLog(t, tempDir, logger.sessionTimestamp, "http", 1, "Test 1")
	verifyProtocolLog(t, tempDir, logger.sessionTimestamp, "ssh", 1, "Test 2")
	verifyProtocolLog(t, tempDir, logger.sessionTimestamp, "unknown", 1, "Test 3")
}

func verifyProtocolLog(t *testing.T, logDir, timestamp, proto string, expectedCount int, expectedSummary string) {
	filename := filepath.Join(logDir, "protocols", proto+"_"+timestamp+".jsonl")
	content, err := os.ReadFile(filename)
	if err != nil {
		t.Fatalf("Failed to read protocol file %s: %v", filename, err)
	}
	lines := strings.Split(strings.TrimSpace(string(content)), "\n")
	if len(lines) != expectedCount {
		t.Errorf("Expected %d lines in %s, got %d", expectedCount, filename, len(lines))
	}

	if expectedCount > 0 {
		var d Detection
		if err := json.Unmarshal([]byte(lines[0]), &d); err != nil {
			t.Fatalf("Failed to parse JSON in %s: %v", filename, err)
		}
		if d.Summary != expectedSummary {
			t.Errorf("Expected summary %q in %s, got %q", expectedSummary, filename, d.Summary)
		}
	}
}

func TestJSONLLogger_Rotation(t *testing.T) {
	tempDir := t.TempDir()
	// Set max size very low to trigger rotation immediately
	logger, err := NewJSONLLogger(tempDir, 0) // Will use default 100MB if <= 0, so let's override manually
	if err != nil {
		t.Fatalf("Failed to create logger: %v", err)
	}
	logger.maxFileSize = 10 // Very small to trigger rotation

	d1 := Detection{Protocol: "FTP", Summary: "Very long summary to trigger rotation"}
	logger.OnDetection(d1) // Writes to ftp_<originalTimestamp>.jsonl

	// Should have rotated
	time.Sleep(1 * time.Second)
	logger.OnDetection(d1)
	logger.Close()

	// Check directory for multiple FTP files
	entries, err := os.ReadDir(filepath.Join(tempDir, "protocols"))
	if err != nil {
		t.Fatalf("Failed to read protocols dir: %v", err)
	}

	ftpFilesCount := 0
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "ftp_") {
			ftpFilesCount++
		}
	}
	if ftpFilesCount < 2 {
		t.Errorf("Expected at least 2 ftp files after rotation, got %d", ftpFilesCount)
	}
}
