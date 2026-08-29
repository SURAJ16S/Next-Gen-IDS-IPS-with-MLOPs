// SPDX-License-Identifier: GPL-2.0
// detect/session_tracker.go — L7 HTTP Session tracking.

package detect

import (
	"fmt"
	"regexp"
	"sync"
	"time"
)

// idHit records one access to a parameterised URI template with a specific id.
type idHit struct {
	URITemplate string
	IDValue     string
	Timestamp   time.Time
}

// SessionStats holds statistics for a logical HTTP session.
type SessionStats struct {
	SessionID    string
	ClientIP     string
	UserAgent    string
	StartTime    time.Time
	LastSeen     time.Time
	RequestCount int
	UniqueURIs   map[string]bool

	// BOLA/ID-enumeration tracking — sliding list of recent id accesses.
	// Master plan §3.2: "sliding list of (uri_template, id_value, timestamp)".
	idHits []idHit
}

// SessionTracker tracks logical HTTP sessions.
type SessionTracker struct {
	bus      *DetectionBus
	mu       sync.Mutex
	sessions map[string]*SessionStats
}

// NewSessionTracker creates a new session tracker.
func NewSessionTracker(bus *DetectionBus) *SessionTracker {
	return &SessionTracker{
		bus:      bus,
		sessions: make(map[string]*SessionStats),
	}
}

// TrackRequest updates the session state for a new HTTP request.
func (st *SessionTracker) TrackRequest(srcIP, userAgent, uri string) {
	st.mu.Lock()
	defer st.mu.Unlock()

	// Default session key is IP + UserAgent
	sessionKey := fmt.Sprintf("%s|%s", srcIP, userAgent)

	session, exists := st.sessions[sessionKey]
	if !exists {
		session = &SessionStats{
			SessionID:    sessionKey,
			ClientIP:     srcIP,
			UserAgent:    userAgent,
			StartTime:    time.Now(),
			RequestCount: 0,
			UniqueURIs:   make(map[string]bool),
		}
		st.sessions[sessionKey] = session
	}

	session.LastSeen = time.Now()
	session.RequestCount++
	session.UniqueURIs[uri] = true

	// --- BOLA / ID-enumeration check (master plan §3.2) ---
	st.trackBOLA(session, uri)

	// Emit session stats on specific intervals (e.g., every 10 requests) to provide continuous features
	if session.RequestCount%10 == 0 {
		st.emitSessionStats(session)
	}
}

// reIDParam matches common REST ID patterns: /api/orders/123 or /users/abc-uuid
var reIDParam = regexp.MustCompile(`^((?:/[a-zA-Z_-]+)+)/([a-zA-Z0-9_-]{1,64})((?:/[a-zA-Z_-]*)*)$`)

// trackBOLA extracts the URI template + id, appends to the session's sliding
// window, and fires CatBOLA if the same template is accessed with many
// distinct IDs in a short window — a strong BOLA/ID-enumeration signal.
func (st *SessionTracker) trackBOLA(session *SessionStats, uri string) {
	m := reIDParam.FindStringSubmatch(uri)
	if m == nil {
		return // URI doesn't look like a parameterised REST resource
	}
	prefix, idValue := m[1], m[2]
	template := prefix + "/{id}" + m[3]

	now := time.Now()
	session.idHits = append(session.idHits, idHit{
		URITemplate: template,
		IDValue:     idValue,
		Timestamp:   now,
	})

	// Trim hits older than 5 minutes
	cutoff := now.Add(-5 * time.Minute)
	fresh := session.idHits[:0]
	for _, h := range session.idHits {
		if h.Timestamp.After(cutoff) {
			fresh = append(fresh, h)
		}
	}
	session.idHits = fresh

	// Count distinct IDs for this template in the window
	distinctIDs := map[string]struct{}{}
	for _, h := range session.idHits {
		if h.URITemplate == template {
			distinctIDs[h.IDValue] = struct{}{}
		}
	}

	// Threshold: 20+ distinct IDs for the same template in 5 min = enumeration
	const bolaThreshold = 20
	if len(distinctIDs) >= bolaThreshold {
		st.bus.EmitDetection(Detection{
			ID:        "BOLA-ENUM-001",
			Timestamp: now,
			Severity:  SevHigh,
			Category:  CatBOLA,
			Protocol:  "HTTP",
			SourceIP:  session.ClientIP,
			Summary: fmt.Sprintf(
				"BOLA/ID-enumeration: %d distinct IDs accessed on template %q in 5 min — likely object-level auth bypass probe",
				len(distinctIDs), template,
			),
			Details: map[string]any{
				"session_id":    session.SessionID,
				"uri_template":  template,
				"distinct_ids":  len(distinctIDs),
				"window_min":    5,
				"request_count": session.RequestCount,
			},
		})
	}
}

func (st *SessionTracker) emitSessionStats(session *SessionStats) {
	duration := time.Since(session.StartTime).Minutes()
	if duration == 0 {
		duration = 0.01 // Prevent division by zero
	}
	reqPerMin := float64(session.RequestCount) / duration

	st.bus.EmitDetection(Detection{
		ID:        "HTTP-SESSION-001",
		Timestamp: time.Now(),
		Severity:  SevInfo,
		Category:  "ml-features",
		Protocol:  "HTTP",
		SourceIP:  session.ClientIP,
		Summary:   fmt.Sprintf("Session stats: %d requests, %.2f req/min", session.RequestCount, reqPerMin),
		Details: map[string]any{
			"session_id":       session.SessionID,
			"request_count":    session.RequestCount,
			"session_duration": time.Since(session.StartTime).Seconds(),
			"req_per_min":      reqPerMin,
			"unique_uris":      len(session.UniqueURIs),
		},
	})
}

