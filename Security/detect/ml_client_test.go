// SPDX-License-Identifier: GPL-2.0
package detect

import (
	"context"
	"testing"
	"time"
)

func TestMLServiceHealthy(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	healthy := MLServiceHealthy(ctx)
	if !healthy {
		t.Log("Note: ML service is not reachable (fail-open behavior will be active)")
	} else {
		t.Log("✓ ML service is healthy and loaded models")
	}
}

func TestScoreHTTPPayload(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	sampleStats := map[string]interface{}{
		"method":            "GET",
		"uri_length":        25,
		"query_param_count": 1,
		"content_length":    0,
		"header_count":      10,
		"header_size":       500,
		"jwt_present":       false,
		"auth_present":      false,
		"entropy":           2.5,
		"sql_keyword_count": 0,
		"xss_pattern_count": 0,
	}

	res, err := ScoreHTTPPayload(ctx, sampleStats)
	if err != nil {
		t.Fatalf("ScoreHTTPPayload returned error: %v", err)
	}
	t.Logf("✓ ML Response: RiskScore=%.2f, ModelVersion=%s", res.RiskScore, res.ModelVersion)
}
