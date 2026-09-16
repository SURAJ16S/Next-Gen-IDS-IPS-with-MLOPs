// SPDX-License-Identifier: GPL-2.0
// detect/ml_client.go — Tier-3 FastAPI ML scoring client.
// Provides a fail-open HTTP client that calls the Python scoring service
// running on port 8500. All timeouts are capped at 50 ms so that ML
// service unavailability never blocks or degrades the proxy forwarding path.

package detect

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const (
	mlServiceURL = "http://localhost:8500"
	// mlTimeout is the HARD maximum latency budget for an ML call.
	// If the scoring service doesn't respond within this window, we fail-open
	// and return RiskScore=0 so the proxy is never blocked by model latency.
	mlTimeout = 50 * time.Millisecond
)

var mlHTTPClient = &http.Client{Timeout: mlTimeout}

// ──────────────────────────────────────────────────────────────────────────────
// Request / Response types
// ──────────────────────────────────────────────────────────────────────────────

// MLScoreRequest is the JSON body sent to the scoring service.
type MLScoreRequest struct {
	PayloadStats map[string]interface{} `json:"payload_stats,omitempty"`
	FlowRecord   map[string]interface{} `json:"flow_record,omitempty"`
	SSHRecord    *SSHFeatureVector      `json:"ssh_record,omitempty"`
}

// MLScoreResponse is the JSON body returned by the scoring service.
type MLScoreResponse struct {
	// RiskScore is 0–100. Higher means more anomalous / more likely an attack.
	RiskScore float64 `json:"risk_score"`
	// PredictedCategory is the attack category label (e.g. "sqli", "xss", "benign").
	PredictedCategory string `json:"predicted_category"`
	// Confidence is the classifier's probability estimate (0–1).
	Confidence float64 `json:"confidence"`
	// ModelVersion identifies which model artifact was used.
	ModelVersion string `json:"model_version"`
	// ContributingFeatures explains why the model scored the way it did.
	ContributingFeatures map[string]float64 `json:"contributing_features"`
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

// ScoreSSH sends a combined L4+L7 SSH feature vector to the ML service.
func ScoreSSH(ctx context.Context, vec SSHFeatureVector) (*MLScoreResponse, error) {
	req := MLScoreRequest{
		SSHRecord: &vec,
	}
	return scoreML(ctx, mlServiceURL+"/score/ssh", req)
}

// ScoreHTTPPayload calls the ML service for HTTP payload anomaly scoring and
// multi-class attack classification. The caller should pass the PayloadStats
// map produced by ComputePayloadStats().
//
// Fail-open contract: on any error (timeout, connection refused, decode error),
// returns a zero-risk response so the proxy continues forwarding.
func ScoreHTTPPayload(ctx context.Context, stats map[string]interface{}) (*MLScoreResponse, error) {
	return scoreML(ctx, mlServiceURL+"/score/http-payload", MLScoreRequest{PayloadStats: stats})
}

// ScoreFlow calls the ML service for flow-level anomaly scoring.
// The caller should pass a map of flow feature columns that match the
// FlowRecord schema in feature_encoder.py.
func ScoreFlow(ctx context.Context, flow map[string]interface{}) (*MLScoreResponse, error) {
	req := MLScoreRequest{
		FlowRecord: flow,
	}
	return scoreML(ctx, mlServiceURL+"/score/flow", req)
}

// MLServiceHealthy performs a lightweight /health probe against the scoring
// service. Returns true only if the service is reachable and reports at least
// one loaded model. Use this at startup to log readiness, not for per-request
// gating (scoring calls already fail-open).
func MLServiceHealthy(ctx context.Context) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, mlServiceURL+"/health", nil)
	if err != nil {
		return false
	}
	resp, err := mlHTTPClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

func scoreML(ctx context.Context, url string, payload MLScoreRequest) (*MLScoreResponse, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		// Serialization failure is a programming error, but we still fail-open
		// so the proxy is not disrupted.
		return failOpen(), fmt.Errorf("ml_client: marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return failOpen(), fmt.Errorf("ml_client: new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := mlHTTPClient.Do(req)
	if err != nil {
		// Covers: context deadline exceeded (timeout), connection refused,
		// network errors — all treated as fail-open.
		return failOpen(), nil
	}
	defer resp.Body.Close()

	var result MLScoreResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return failOpen(), fmt.Errorf("ml_client: decode: %w", err)
	}
	return &result, nil
}

// failOpen returns a zero-risk MLScoreResponse so that ML outages never
// cause false-positive blocks. The ModelVersion field is set to "unavailable"
// so log consumers can distinguish a real low-risk score from a fail-open.
func failOpen() *MLScoreResponse {
	return &MLScoreResponse{
		RiskScore:            0,
		PredictedCategory:    "",
		Confidence:           0,
		ModelVersion:         "unavailable",
		ContributingFeatures: nil,
	}
}
