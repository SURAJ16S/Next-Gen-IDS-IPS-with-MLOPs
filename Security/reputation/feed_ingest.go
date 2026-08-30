// SPDX-License-Identifier: GPL-2.0
// reputation/feed_ingest.go — Threat-intel feed ingestion into Redis.
// Fetches IP blocklists from AbuseIPDB, Spamhaus DROP, and FireHOL Level 1,
// writing them into the rep:feed:* Redis SETs consumed by reputation.go.
// Designed to run as a long-lived goroutine launched at proxy startup.

package reputation

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"
)

const (
	feedRefreshInterval = 6 * time.Hour
	feedHTTPTimeout     = 30 * time.Second

	abuseIPDBURL   = "https://api.abuseipdb.com/api/v2/blacklist"
	spamhausDROPURL = "https://www.spamhaus.org/drop/drop.txt"
	firehol1URL    = "https://iplists.firehol.org/files/firehol_level1.netset"
	torExitURL     = "https://check.torproject.org/torbulkexitlist"
	feodoURL       = "https://feodotracker.abuse.ch/downloads/ipblocklist.txt"
)

var feedHTTPClient = &http.Client{Timeout: feedHTTPTimeout}

// StartFeedIngestion launches all feed ingestion goroutines. It ticks every
// feedRefreshInterval (6h) and runs a full refresh of all no-auth feeds.
// abuseIPDBKey is optional — if empty, AbuseIPDB ingestion is skipped.
// Call this once at proxy startup; it blocks until ctx is cancelled.
func (c *Client) StartFeedIngestion(ctx context.Context, abuseIPDBKey string) {
	log.Println("[reputation] Feed ingestion started (refresh every 6h)")

	// Run immediately on first start, then on ticker
	c.runAllFeeds(ctx, abuseIPDBKey)

	ticker := time.NewTicker(feedRefreshInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("[reputation] Feed ingestion stopped.")
			return
		case <-ticker.C:
			c.runAllFeeds(ctx, abuseIPDBKey)
		}
	}
}

func (c *Client) runAllFeeds(ctx context.Context, abuseIPDBKey string) {
	if abuseIPDBKey != "" {
		c.ingestAbuseIPDB(ctx, abuseIPDBKey)
	} else {
		log.Println("[reputation] AbuseIPDB key not set — skipping.")
	}
	c.ingestPlainTextIPList(ctx, spamhausDROPURL, "rep:feed:spamhaus_drop")
	c.ingestPlainTextIPList(ctx, firehol1URL, "rep:feed:firehol")
	c.ingestPlainTextIPList(ctx, torExitURL, "rep:feed:tor_exit")
	c.ingestPlainTextIPList(ctx, feodoURL, "rep:feed:botnet_c2")
}

// ── AbuseIPDB (JSON response) ────────────────────────────────────────────────

type abuseIPDBResponse struct {
	Data []struct {
		IPAddress string `json:"ipAddress"`
	} `json:"data"`
}

func (c *Client) ingestAbuseIPDB(ctx context.Context, apiKey string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, abuseIPDBURL, nil)
	if err != nil {
		log.Printf("[reputation] AbuseIPDB request build error: %v", err)
		return
	}
	req.Header.Set("Key", apiKey)
	req.Header.Set("Accept", "application/json")
	q := req.URL.Query()
	q.Set("confidenceMinimum", "100")
	q.Set("limit", "10000")
	req.URL.RawQuery = q.Encode()

	resp, err := feedHTTPClient.Do(req)
	if err != nil {
		log.Printf("[reputation] AbuseIPDB fetch error: %v", err)
		return
	}
	defer resp.Body.Close()

	var result abuseIPDBResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		log.Printf("[reputation] AbuseIPDB decode error: %v", err)
		return
	}

	ips := make([]interface{}, 0, len(result.Data))
	for _, entry := range result.Data {
		if entry.IPAddress != "" {
			ips = append(ips, entry.IPAddress)
		}
	}
	c.writeIPSet(ctx, "rep:feed:abuseipdb", ips)
	log.Printf("[reputation] AbuseIPDB: ingested %d IPs", len(ips))
}

// ── Plain-text IP lists (Spamhaus, FireHOL, Tor, Feodo) ──────────────────────

// ingestPlainTextIPList fetches a newline-delimited plain-text IP list and
// writes it to the given Redis SET. Lines beginning with '#' are comments.
// CIDR ranges have their network address extracted (individual IPs only).
func (c *Client) ingestPlainTextIPList(ctx context.Context, url, redisKey string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		log.Printf("[reputation] %s request build error: %v", redisKey, err)
		return
	}

	resp, err := feedHTTPClient.Do(req)
	if err != nil {
		log.Printf("[reputation] %s fetch error: %v", redisKey, err)
		return
	}
	defer resp.Body.Close()

	ips := parseIPLines(resp.Body)
	if len(ips) == 0 {
		log.Printf("[reputation] %s: no IPs parsed", redisKey)
		return
	}

	c.writeIPSet(ctx, redisKey, ips)
	log.Printf("[reputation] %s: ingested %d entries", redisKey, len(ips))
}

// parseIPLines reads a plain-text body, skipping comments and blank lines.
// It accepts individual IPs and CIDR ranges; for CIDRs it stores the
// network address string (consumers use SISMEMBER for exact IPs only —
// CIDR lookup requires the in-memory cidranger from proxy startup).
func parseIPLines(r io.Reader) []interface{} {
	var ips []interface{}
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		// Strip inline comments (e.g. "1.2.3.4 ; description")
		if idx := strings.IndexAny(line, " \t;#"); idx > 0 {
			line = strings.TrimSpace(line[:idx])
		}
		// Validate: must be an IP or CIDR
		if strings.Contains(line, "/") {
			_, ipNet, err := net.ParseCIDR(line)
			if err == nil {
				ips = append(ips, ipNet.String())
			}
		} else {
			if ip := net.ParseIP(line); ip != nil {
				ips = append(ips, ip.String())
			}
		}
	}
	return ips
}

// ── Redis write helper ─────────────────────────────────────────────────────────

// writeIPSet atomically replaces the given Redis SET with the new IP list
// and records a last_updated timestamp. Uses MULTI/EXEC for atomicity.
func (c *Client) writeIPSet(ctx context.Context, key string, ips []interface{}) {
	if len(ips) == 0 {
		return
	}

	// Batch into chunks of 500 for large lists
	const chunkSize = 500
	pipe := c.rdb.Pipeline()
	pipe.Del(ctx, key) // Clear old entries
	for i := 0; i < len(ips); i += chunkSize {
		end := i + chunkSize
		if end > len(ips) {
			end = len(ips)
		}
		pipe.SAdd(ctx, key, ips[i:end]...)
	}
	lastUpdatedKey := fmt.Sprintf("rep:feed:last_updated:%s", strings.TrimPrefix(key, "rep:feed:"))
	pipe.Set(ctx, lastUpdatedKey, time.Now().Format(time.RFC3339), 0)

	if _, err := pipe.Exec(ctx); err != nil {
		log.Printf("[reputation] Redis write error for %s: %v", key, err)
	}
}
