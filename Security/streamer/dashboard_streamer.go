// SPDX-License-Identifier: GPL-2.0
// streamer/dashboard_streamer.go — Async batched HTTP streamer for dashboard telemetry.

package streamer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"ngfw-monitor/detect"
)

const (
	batchSize   = 50
	flushEvery  = 2 * time.Second
	postTimeout = 5 * time.Second
)

// DashboardStreamer batches detections and posts them to the central web dashboard.
type DashboardStreamer struct {
	ch     chan detect.Detection
	url    string
	nodeId string
	secret string
	client *http.Client
}

// New initializes a new DashboardStreamer with config read from environment variables.
func New() *DashboardStreamer {
	return &DashboardStreamer{
		ch:     make(chan detect.Detection, 500),
		url:    os.Getenv("DASHBOARD_URL"),
		nodeId: os.Getenv("AGENT_NODE_ID"),
		secret: os.Getenv("AGENT_NODE_SECRET"),
		client: &http.Client{Timeout: postTimeout},
	}
}

// Send enqueues a detection for async batched delivery. Non-blocking — drops
// silently if channel is full (dashboard outage must never slow down the proxy).
func (s *DashboardStreamer) Send(d detect.Detection) {
	select {
	case s.ch <- d:
	default:
		// channel full — drop silently
	}
}

// OnDetection satisfies detect.DetectionSubscriber.
func (s *DashboardStreamer) OnDetection(d detect.Detection) {
	s.Send(d)
}

// OnConnectionClose satisfies detect.DetectionSubscriber.
func (s *DashboardStreamer) OnConnectionClose(c detect.ConnectionRecord) {}

// Run starts the flush loop. Call as `go s.Run(ctx)`.
func (s *DashboardStreamer) Run(ctx context.Context) {
	ticker := time.NewTicker(flushEvery)
	defer ticker.Stop()
	batch := make([]detect.Detection, 0, batchSize)

	flush := func() {
		if len(batch) == 0 || s.url == "" {
			return
		}
		s.post(batch)
		batch = batch[:0]
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return
		case d := <-s.ch:
			batch = append(batch, d)
			if len(batch) >= batchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

func (s *DashboardStreamer) post(batch []detect.Detection) {
	type payload struct {
		Detections []detect.Detection `json:"detections"`
	}

	body, err := json.Marshal(payload{Detections: batch})
	if err != nil {
		return
	}

	req, err := http.NewRequest(http.MethodPost, s.url+"/api/agent/telemetry/detections", bytes.NewReader(body))
	if err != nil {
		return
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Node-Id", s.nodeId)
	req.Header.Set("X-Node-Secret", s.secret)

	resp, err := s.client.Do(req)
	if err != nil {
		fmt.Printf("[streamer] POST failed: %v\n", err)
		return
	}
	resp.Body.Close()
}
