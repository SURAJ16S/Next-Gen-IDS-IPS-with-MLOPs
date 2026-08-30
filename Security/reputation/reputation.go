// SPDX-License-Identifier: GPL-2.0
// reputation/reputation.go — IP reputation scoring via Redis.
// Provides fast-path lookups for known-bad IPs and dynamic score bumping
// on detection events. Redis DB 0 is the shared security keyspace.

package reputation

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const repDB = 0

// ScoreCritical is the delta added to an IP's reputation score on a CRITICAL detection.
const ScoreCritical = 20

// ScoreHigh is the delta added on a HIGH severity detection.
const ScoreHigh = 10

// ScoreMedium is the delta added on a MEDIUM severity detection.
const ScoreMedium = 5

// ScoreLow is the delta added on a LOW severity detection.
const ScoreLow = 1

// BlockThreshold is the score above which an IP is short-circuited past Tier-1 checks.
const BlockThreshold = 80

// Client wraps a Redis connection for all reputation operations.
type Client struct {
	rdb *redis.Client
}

// New creates a reputation Client connected to the given Redis address.
// Uses DB 0 (the shared security keyspace).
func New(addr string) *Client {
	return &Client{
		rdb: redis.NewClient(&redis.Options{
			Addr: addr,
			DB:   repDB,
		}),
	}
}

// Ping verifies connectivity to Redis. Call this at startup to fail-fast.
func (c *Client) Ping(ctx context.Context) error {
	return c.rdb.Ping(ctx).Err()
}

// Close cleanly shuts down the Redis connection pool.
func (c *Client) Close() error {
	return c.rdb.Close()
}

// GetScore returns the current reputation score (0–100) for an IP.
// Returns 0 if the IP has no entry yet (unknown = not yet bad).
func (c *Client) GetScore(ctx context.Context, ip string) (int, error) {
	key := fmt.Sprintf("rep:ip:%s", ip)
	val, err := c.rdb.HGet(ctx, key, "score").Result()
	if err == redis.Nil {
		return 0, nil // Unknown IP — treat as clean
	}
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(val)
}

// IsKnownBad checks whether an IP is present in any threat-intel feed SET.
// The three feeds checked here are ingested by feed_ingest.go.
func (c *Client) IsKnownBad(ctx context.Context, ip string) (bool, error) {
	feeds := []string{
		"rep:feed:abuseipdb",
		"rep:feed:otx",
		"rep:feed:spamhaus_drop",
		"rep:feed:firehol",
		"rep:feed:tor_exit",
		"rep:feed:botnet_c2",
	}
	for _, feed := range feeds {
		ok, err := c.rdb.SIsMember(ctx, feed, ip).Result()
		if err != nil {
			return false, err
		}
		if ok {
			return true, nil
		}
	}
	return false, nil
}

// BumpScore increments an IP's reputation score by delta and resets its 24h TTL.
// Use ScoreCritical / ScoreHigh / ScoreMedium / ScoreLow constants as delta.
// All writes are pipelined into a single round-trip.
func (c *Client) BumpScore(ctx context.Context, ip string, delta int) error {
	key := fmt.Sprintf("rep:ip:%s", ip)
	pipe := c.rdb.Pipeline()
	pipe.HIncrBy(ctx, key, "score", int64(delta))
	pipe.HSet(ctx, key, "last_seen", time.Now().Unix())
	pipe.Expire(ctx, key, 24*time.Hour)
	_, err := pipe.Exec(ctx)
	return err
}

// IsBlocked performs a fast-path check against the gate:blocked:{ip} key that
// the Node.js block controller writes when an IP is manually or auto-blocked.
// Redis is the cache; MongoDB is the source of truth.
func (c *Client) IsBlocked(ctx context.Context, ip string) (bool, error) {
	key := fmt.Sprintf("gate:blocked:%s", ip)
	exists, err := c.rdb.Exists(ctx, key).Result()
	return exists > 0, err
}

// ShouldShortCircuit is a convenience helper that returns true if the IP should
// be rejected immediately without running Tier-1 regex / Tier-3 ML checks.
// It returns true when:
//   - IP is explicitly blocked (gate:blocked:{ip} key exists), OR
//   - IP's accumulated reputation score exceeds BlockThreshold (80).
//
// Errors from Redis are treated as "allow" (fail-open) to avoid blocking
// legitimate traffic when Redis is temporarily unavailable.
func (c *Client) ShouldShortCircuit(ctx context.Context, ip string) (bool, string) {
	// Check explicit block first (cheapest path)
	blocked, err := c.IsBlocked(ctx, ip)
	if err == nil && blocked {
		return true, "explicitly-blocked"
	}

	// Check accumulated reputation score
	score, err := c.GetScore(ctx, ip)
	if err == nil && score > BlockThreshold {
		return true, fmt.Sprintf("rep-score-%d", score)
	}

	// Check threat-intel feeds
	bad, err := c.IsKnownBad(ctx, ip)
	if err == nil && bad {
		return true, "threat-intel-feed"
	}

	return false, ""
}
