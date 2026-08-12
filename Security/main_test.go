// SPDX-License-Identifier: GPL-2.0
// main_test.go — Integration tests for main proxy components like ConsoleLogger

package main

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"ngfw-monitor/detect"
)

// captureStdout temporarily redirects os.Stdout and returns the captured output
// as a string after the provided function executes.
func captureStdout(f func()) (string, error) {
	oldStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		return "", err
	}
	os.Stdout = w

	f()

	w.Close()
	os.Stdout = oldStdout

	var buf bytes.Buffer
	_, err = io.Copy(&buf, r)
	if err != nil {
		return "", err
	}

	return buf.String(), nil
}

func TestConsoleLogger_Output(t *testing.T) {
	// 1. Setup the bus and logger
	bus := detect.NewDetectionBus()
	logger := &ConsoleLogger{}
	bus.Subscribe(logger)

	// 2. Create a mock detection identical to what a protocol analyzer generates
	now := time.Now()
	mockDetection := detect.Detection{
		ID:          "TELNET-BOTNET-001",
		Timestamp:   now,
		Severity:    detect.SevCritical,
		Category:    detect.CatBotScanner,
		Protocol:    "Telnet",
		SourceIP:    "192.168.1.100",
		SourcePort:  54321,
		DestPort:    23,
		ConnID:      "mock-conn-123",
		Summary:     "Botnet execution chain or binary drop detected via Telnet",
		RawEvidence: "chmod +x payload.sh",
	}

	// 3. Capture Stdout and emit the detection
	output, err := captureStdout(func() {
		bus.EmitDetection(mockDetection)
		// Give the bus a moment to asynchronously deliver to subscribers
		time.Sleep(50 * time.Millisecond)
	})

	if err != nil {
		t.Fatalf("Failed to capture stdout: %v", err)
	}

	// 4. Assertions on the captured output
	
	// Check for the clear-screen escape code
	if !strings.Contains(output, "\r\033[K") {
		t.Errorf("Expected output to contain line-clearing escape code \\r\\033[K, got: %q", output)
	}

	// Check for the critical severity emoji
	if !strings.Contains(output, "🔴") {
		t.Errorf("Expected output to contain critical severity emoji (🔴), got: %q", output)
	}

	// Check for proper timestamp formatting
	timeStr := now.Format("15:04:05")
	if !strings.Contains(output, "["+timeStr+"]") {
		t.Errorf("Expected output to contain timestamp [%s], got: %q", timeStr, output)
	}

	// Check for network tuple
	if !strings.Contains(output, "192.168.1.100:54321 -> 23") {
		t.Errorf("Expected output to contain network tuple, got: %q", output)
	}

	// Check for summary string
	if !strings.Contains(output, mockDetection.Summary) {
		t.Errorf("Expected output to contain detection summary, got: %q", output)
	}
}
