// SPDX-License-Identifier: GPL-2.0
// detect/session_tracker.go — L7 HTTP Session tracking.

package detect

import (
	"fmt"
	"sync"
	"time"
)

// SessionStats holds statistics for a logical HTTP session.
type SessionStats struct {
	SessionID    string
	ClientIP     string
	UserAgent    string
	StartTime    time.Time
	LastSeen     time.Time
	RequestCount int
	UniqueURIs   map[string]bool
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

	// Emit session stats on specific intervals (e.g., every 10 requests) to provide continuous features
	if session.RequestCount%10 == 0 {
		st.emitSessionStats(session)
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
