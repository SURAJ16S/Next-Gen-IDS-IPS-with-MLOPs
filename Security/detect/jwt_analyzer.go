// SPDX-License-Identifier: GPL-2.0
// detect/jwt_analyzer.go — JWT structural validation (Tier-1, Phase B).
//
// Checks every HTTP request carrying an Authorization: Bearer <token> header
// for structural JWT weaknesses without requiring a full library — the proxy
// can only see the raw token, not verify its signature (that is the backend's
// job). What it CAN catch deterministically:
//   - Malformed tokens (not 3 dot-separated base64url segments)
//   - alg:none bypass (HIGH — classic JWT authentication bypass)
//   - Algorithm confusion (RS256 → HS256 downgrade)
//   - Expired tokens still being presented (MEDIUM advisory)
//
// See master plan §3.1 and threat-matrix doc §1 (CatJWTAlgNone,
// CatJWTAlgConfusion, CatJWTExpiredAccepted) for the full context.

package detect

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

// jwtHeader is the minimal set of fields we need from the JOSE header.
type jwtHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
}

// jwtPayload is the minimal set of claims we inspect.
type jwtPayload struct {
	Exp int64 `json:"exp"` // Unix timestamp; 0 = not present
	Iat int64 `json:"iat"`
}

// AnalyzeJWT inspects a raw Authorization header value (the full "Bearer …"
// string) and emits Detection events via bus for any findings.
// srcIP / srcPort / destPort / connID are passed through from the calling
// HTTP analyzer so the Detection has full context.
//
// Call this from http_analyzer.go after extracting the Authorization header.
func AnalyzeJWT(
	bus *DetectionBus,
	authHeader string,
	srcIP string,
	srcPort uint16,
	destPort uint16,
	connID string,
) {
	raw := strings.TrimSpace(authHeader)
	if !strings.HasPrefix(raw, "Bearer ") && !strings.HasPrefix(raw, "bearer ") {
		return // not a Bearer token — nothing to do
	}
	token := strings.TrimSpace(raw[len("Bearer "):])
	if strings.HasPrefix(raw, "bearer ") {
		token = strings.TrimSpace(raw[len("bearer "):])
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		bus.EmitDetection(Detection{
			ID:          "JWT-MALFORMED-001",
			Timestamp:   time.Now(),
			Severity:    SevMedium,
			Category:    CatJWTAlgNone, // re-use; malformed is a precursor to bypass attempts
			Protocol:    "HTTP",
			SourceIP:    srcIP,
			SourcePort:  srcPort,
			DestPort:    destPort,
			ConnID:      connID,
			Summary:     "Malformed JWT: does not have 3 dot-separated base64url segments",
			RawEvidence: truncate(token, 120),
		})
		return
	}

	header, err := decodeJWTPart(parts[0])
	if err != nil {
		bus.EmitDetection(Detection{
			ID:          "JWT-MALFORMED-002",
			Timestamp:   time.Now(),
			Severity:    SevLow,
			Category:    CatJWTAlgNone,
			Protocol:    "HTTP",
			SourceIP:    srcIP,
			SourcePort:  srcPort,
			DestPort:    destPort,
			ConnID:      connID,
			Summary:     "JWT header is not valid base64url-encoded JSON",
			RawEvidence: truncate(parts[0], 80),
		})
		return
	}

	var h jwtHeader
	if err := json.Unmarshal(header, &h); err == nil {
		alg := strings.ToLower(h.Alg)

		// --- alg:none bypass (CWE-347, OWASP A02) ---
		if alg == "none" || alg == "" {
			bus.EmitDetection(Detection{
				ID:         "JWT-ALG-NONE-001",
				Timestamp:  time.Now(),
				Severity:   SevCritical,
				Category:   CatJWTAlgNone,
				Protocol:   "HTTP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   destPort,
				ConnID:     connID,
				Summary:    "JWT alg:none bypass attempt — signature verification skipped by some libraries",
				Details:    map[string]any{"alg": h.Alg},
			})
		}

		// --- Algorithm confusion: HS256 presented where RS256/ES256 expected ---
		// Flag any asymmetric-to-symmetric downgrade. The proxy cannot know the
		// server's expected algorithm with certainty, so we flag HS256 on tokens
		// that appear to have come from an RS256-signed context (Typ=JWT) as
		// MEDIUM (advisory) — never auto-block on this alone.
		if alg == "hs256" || alg == "hs384" || alg == "hs512" {
			// Only emit if we have reason to suspect confusion — e.g. if the
			// payload has claims typical of a server-signed RS256 token.
			// For now emit LOW so analysts can correlate with backend 200s on
			// what should be RS256-only endpoints.
			bus.EmitDetection(Detection{
				ID:         "JWT-ALG-CONF-001",
				Timestamp:  time.Now(),
				Severity:   SevLow,
				Category:   CatJWTAlgConfusion,
				Protocol:   "HTTP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   destPort,
				ConnID:     connID,
				Summary:    "JWT uses symmetric HMAC algorithm — check for RS256→HS256 confusion attack if endpoint expects asymmetric keys",
				Details:    map[string]any{"alg": h.Alg},
			})
		}
	}

	// --- Expired token check ---
	payload, err := decodeJWTPart(parts[1])
	if err == nil {
		var p jwtPayload
		if err := json.Unmarshal(payload, &p); err == nil && p.Exp > 0 {
			if time.Now().Unix() > p.Exp {
				bus.EmitDetection(Detection{
					ID:         "JWT-EXPIRED-001",
					Timestamp:  time.Now(),
					Severity:   SevMedium,
					Category:   CatJWTExpiredAccepted,
					Protocol:   "HTTP",
					SourceIP:   srcIP,
					SourcePort: srcPort,
					DestPort:   destPort,
					ConnID:     connID,
					Summary:    "Expired JWT presented — backend accepting this token would indicate missing expiry validation",
					Details: map[string]any{
						"exp":        p.Exp,
						"expired_by": time.Now().Unix() - p.Exp,
					},
				})
			}
		}
	}
}

// decodeJWTPart base64url-decodes one segment of a JWT (no padding required).
func decodeJWTPart(segment string) ([]byte, error) {
	// JWT uses base64url without padding — add padding if needed.
	switch len(segment) % 4 {
	case 2:
		segment += "=="
	case 3:
		segment += "="
	}
	return base64.URLEncoding.DecodeString(segment)
}
