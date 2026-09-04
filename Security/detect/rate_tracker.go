// SPDX-License-Identifier: GPL-2.0
// detect/rate_tracker.go — Sliding-window rate counters.
// Provides efficient per-IP, per-port rate limiting with automatic
// decay of old counters for memory efficiency.

package detect

import (
	"fmt"
	"sync"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// Sliding Window Counter
// ──────────────────────────────────────────────────────────────────────────────

// SlidingWindowCounter tracks event counts in a sliding time window.
type SlidingWindowCounter struct {
	mu        sync.Mutex
	window    time.Duration
	bucketDur time.Duration
	buckets   map[string]*bucketChain
}

type bucketChain struct {
	entries   []bucket
	lastPrune time.Time
}

type bucket struct {
	timestamp time.Time
	count     int64
}

// NewSlidingWindowCounter creates a counter with the given window duration.
// Events older than window are automatically dropped.
func NewSlidingWindowCounter(window time.Duration) *SlidingWindowCounter {
	bucketDur := window / 10
	if bucketDur < time.Second {
		bucketDur = time.Second
	}
	return &SlidingWindowCounter{
		window:    window,
		bucketDur: bucketDur,
		buckets:   make(map[string]*bucketChain),
	}
}

// Increment adds 1 to the counter for the given key and returns the current count.
func (c *SlidingWindowCounter) Increment(key string) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	chain, exists := c.buckets[key]
	if !exists {
		chain = &bucketChain{lastPrune: now}
		c.buckets[key] = chain
	}

	// Add to current bucket
	if len(chain.entries) > 0 {
		lastBucket := &chain.entries[len(chain.entries)-1]
		if now.Sub(lastBucket.timestamp) < c.bucketDur {
			lastBucket.count++
		} else {
			chain.entries = append(chain.entries, bucket{timestamp: now, count: 1})
		}
	} else {
		chain.entries = append(chain.entries, bucket{timestamp: now, count: 1})
	}

	// Prune old buckets periodically
	if now.Sub(chain.lastPrune) > c.window/2 {
		c.pruneChain(chain, now)
		chain.lastPrune = now
	}

	// Count total
	return c.countChain(chain, now)
}

// Count returns the current count for the given key without incrementing.
func (c *SlidingWindowCounter) Count(key string) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()

	chain, exists := c.buckets[key]
	if !exists {
		return 0
	}
	return c.countChain(chain, time.Now())
}

// Reset clears the counter for the given key.
func (c *SlidingWindowCounter) Reset(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.buckets, key)
}

// Cleanup removes all stale entries. Call periodically for memory efficiency.
func (c *SlidingWindowCounter) Cleanup() {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	for key, chain := range c.buckets {
		c.pruneChain(chain, now)
		if len(chain.entries) == 0 {
			delete(c.buckets, key)
		}
	}
}

// pruneChain removes entries outside the window. Must hold mu.
func (c *SlidingWindowCounter) pruneChain(chain *bucketChain, now time.Time) {
	cutoff := now.Add(-c.window)
	i := 0
	for i < len(chain.entries) && chain.entries[i].timestamp.Before(cutoff) {
		i++
	}
	if i > 0 {
		chain.entries = chain.entries[i:]
	}
}

// countChain sums up all entries within the window. Must hold mu.
func (c *SlidingWindowCounter) countChain(chain *bucketChain, now time.Time) int64 {
	cutoff := now.Add(-c.window)
	var total int64
	for _, b := range chain.entries {
		if b.timestamp.After(cutoff) {
			total += b.count
		}
	}
	return total
}

// Size returns the number of tracked keys.
func (c *SlidingWindowCounter) Size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.buckets)
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP Flood Tracker
// ──────────────────────────────────────────────────────────────────────────────

// HTTPFloodTracker monitors requests per endpoint to detect Application Layer DDoS.
type HTTPFloodTracker struct {
	counter   *SlidingWindowCounter
	threshold int64
	bus       *DetectionBus
}

// NewHTTPFloodTracker creates a tracker for HTTP floods (default: 100 req/sec per endpoint).
func NewHTTPFloodTracker(bus *DetectionBus, window time.Duration, threshold int64) *HTTPFloodTracker {
	return &HTTPFloodTracker{
		counter:   NewSlidingWindowCounter(window),
		threshold: threshold,
		bus:       bus,
	}
}

// TrackRequest increments the count for a given IP and endpoint, emitting an alert if it exceeds threshold.
func (h *HTTPFloodTracker) TrackRequest(srcIP, method, path string) {
	key := fmt.Sprintf("%s:%s:%s", srcIP, method, path)
	count := h.counter.Increment(key)

	if count == h.threshold {
		// Only emit once exactly at the threshold to prevent log spam
		h.bus.EmitDetection(Detection{
			ID:        "HTTP-FLOOD-001",
			Timestamp: time.Now(),
			Severity:  SevHigh,
			Category:  CatDDoS,
			Protocol:  "HTTP",
			SourceIP:  srcIP,
			Summary:   fmt.Sprintf("HTTP flood detected: %d requests to %s %s in %v", count, method, path, h.counter.window),
			Details: map[string]any{
				"method":     method,
				"path":       path,
				"req_count":  count,
				"threshold":  h.threshold,
				"window_sec": h.counter.window.Seconds(),
			},
		})
	}
}
