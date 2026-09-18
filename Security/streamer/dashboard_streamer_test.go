// SPDX-License-Identifier: GPL-2.0
package streamer

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"ngfw-monitor/detect"
)

func TestDashboardStreamer_NonBlockingSend(t *testing.T) {
	s := New()

	// Fill channel to capacity (500)
	for i := 0; i < 500; i++ {
		s.Send(detect.Detection{ID: "TEST-001"})
	}

	// Channel is now full (500/500). 501st call MUST NOT block.
	done := make(chan struct{})
	go func() {
		s.Send(detect.Detection{ID: "TEST-OVERFLOW"})
		close(done)
	}()

	select {
	case <-done:
		// Success — didn't block
	case <-time.After(1 * time.Second):
		t.Fatal("Send() blocked when channel was full!")
	}
}

func TestDashboardStreamer_FlushAndPost(t *testing.T) {
	var postCount int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/telemetry/detections" {
			t.Errorf("Unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("X-Node-Id") != "node-123" {
			t.Errorf("Unexpected X-Node-Id: %s", r.Header.Get("X-Node-Id"))
		}
		if r.Header.Get("X-Node-Secret") != "secret-456" {
			t.Errorf("Unexpected X-Node-Secret: %s", r.Header.Get("X-Node-Secret"))
		}
		atomic.AddInt32(&postCount, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	s := &DashboardStreamer{
		ch:     make(chan detect.Detection, 500),
		url:    server.URL,
		nodeId: "node-123",
		secret: "secret-456",
		client: server.Client(),
	}

	ctx, cancel := context.WithCancel(context.Background())
	go s.Run(ctx)

	s.Send(detect.Detection{ID: "TEST-HTTP-001", SeverityStr: "HIGH", SourceIP: "1.2.3.4"})
	s.Send(detect.Detection{ID: "TEST-HTTP-002", SeverityStr: "CRITICAL", SourceIP: "5.6.7.8"})

	// Wait for ticker or cancel
	time.Sleep(100 * time.Millisecond)
	cancel()

	// Give time for final flush on cancel
	time.Sleep(200 * time.Millisecond)

	if atomic.LoadInt32(&postCount) == 0 {
		t.Errorf("Expected at least 1 HTTP POST, got 0")
	}
}
