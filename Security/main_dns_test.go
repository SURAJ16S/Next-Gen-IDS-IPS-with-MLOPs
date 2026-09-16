package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ngfw-monitor/detect"
	"ngfw-monitor/proxy"
)

type mockSubscriber struct {
	mu          sync.Mutex
	detCaptured bool
	det         detect.Detection
}

func (m *mockSubscriber) OnDetection(d detect.Detection) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d.ID == "ML-DNS-DGA" {
		m.det = d
		m.detCaptured = true
	}
}

func (m *mockSubscriber) OnConnectionClose(c detect.ConnectionRecord) {}

func TestDNSDrainLoopFeatures(t *testing.T) {
	// Start a local test server to mock the ML API
	var hitCount int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hitCount, 1)
		w.Header().Set("Content-Type", "application/json")
		
		// Return 1 response for our 1 vector
		resp := map[string]interface{}{
			"responses": []detect.MLScoreResponse{
				{
					RiskScore:         90.0,
					PredictedCategory: "dga",
					ContributingFeatures: map[string]float64{
						"domain_entropy": 4.5,
					},
				},
			},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	
	// We need it to listen on 8500 because mlServiceURL is hardcoded to localhost:8500
	l, err := net.Listen("tcp", "127.0.0.1:8500")
	if err != nil {
		t.Skip("Port 8500 is in use, skipping test")
	}
	server.Listener = l
	server.Start()
	defer server.Close()

	bus := detect.NewDetectionBus()
	cfg := proxy.DefaultConfig()
	cfg.Detection.DNSDGAMinScore = 50.0

	ms := &mockSubscriber{}
	bus.Subscribe(ms)

	go startDNSDrainLoop(bus, cfg)

	// Send a vector
	detect.DNSFeatureChan <- detect.DNSFeatureVector{
		SrcIP:  "10.0.0.1",
		ConnID: "conn-123",
	}

	// Wait for processing
	time.Sleep(200 * time.Millisecond)

	ms.mu.Lock()
	defer ms.mu.Unlock()

	if !ms.detCaptured {
		t.Fatal("Expected ML-DNS-DGA detection to be emitted")
	}

	if ms.det.Details == nil {
		t.Fatal("Details map is nil, expected to contain 'features'")
	}
	
	feats, ok := ms.det.Details["features"].(map[string]float64)
	if !ok {
		t.Fatalf("features missing or wrong type in Details: %v", ms.det.Details)
	}

	if val, ok := feats["domain_entropy"]; !ok || val != 4.5 {
		t.Errorf("Expected domain_entropy=4.5, got %v", val)
	}
}
