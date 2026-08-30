# AlienVault OTX (Open Threat Exchange) — API Integration Guide

## Overview

AlienVault OTX (Open Threat Exchange) is a crowdsourced threat intelligence platform providing community-driven "pulses" containing malicious IP addresses, domain indicators, C2 infrastructures, and malware file hashes.

The Go security agent ([`Security/reputation/feed_ingest.go`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/Security/reputation/feed_ingest.go)) ingests indicators from AlienVault OTX into the Redis key `rep:feed:otx` for zero-latency, sub-millisecond firewall lookups (`SISMEMBER rep:feed:otx <ip>`).

---

## Configuration

Set your API key in `.env` and `Web/backend/.env`:

```env
OTX_KEY=028baf9a96973fecbf3578c4053efb039e873d9b0ba2837d471c3cad4470a057
OTX_API_KEY=028baf9a96973fecbf3578c4053efb039e873d9b0ba2837d471c3cad4470a057
```

---

## Endpoints Summary

| Endpoint | Method | Purpose | Header |
| :--- | :---: | :--- | :--- |
| `https://otx.alienvault.com/api/v1/indicators/IPv4/{ip}/general` | `GET` | Single IP Indicator Threat Query | `X-OTX-API-KEY` |
| `https://otx.alienvault.com/api/v1/pulses/subscribed` | `GET` | Bulk Subscribed Pulses Feed Ingestion | `X-OTX-API-KEY` |

---

## Live Response Sample

### Single IP Indicator Query (`GET /api/v1/indicators/IPv4/118.193.56.184/general`)

```json
{
    "whois": "http://whois.domaintools.com/118.193.56.184",
    "reputation": 0,
    "indicator": "118.193.56.184",
    "type": "IPv4",
    "type_title": "IPv4",
    "base_indicator": {
        "id": 3747387574,
        "indicator": "118.193.56.184",
        "type": "IPv4",
        "title": "",
        "description": "",
        "content": "",
        "access_type": "public",
        "access_reason": ""
    },
    "pulse_info": {
        "count": 50,
        "pulses": [
            {
                "id": "6a6d3e0e57891f3def758d2f",
                "name": "Honeypot Data – T-Pot - Sydney, Australia - August 2026",
                "description": "Indicators observed by T-Pot CE honeypots (Cowrie, Suricata, Dionaea, SentryPeer).",
                "modified": "2026-08-30T19:30:19.932000",
                "created": "2026-08-01T00:30:06.733000",
                "tags": [
                    "tpot",
                    "honeypot",
                    "suricata",
                    "cowrie",
                    "dionaea",
                    "honeytrap"
                ]
            }
        ]
    }
}
```

---

## Go Agent Ingestion Engine

Inside [`Security/reputation/feed_ingest.go`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/Security/reputation/feed_ingest.go):

```go
func (c *Client) ingestAlienVaultOTX(ctx context.Context, apiKey string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, alienVaultOTXURL, nil)
	if err != nil {
		return
	}
	req.Header.Set("X-OTX-API-KEY", apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := feedHTTPClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()

	var result otxSubscribedResponse
	json.NewDecoder(resp.Body).Decode(&result)
    
	// Store indicators into Redis SET rep:feed:otx
	c.writeIPSet(ctx, "rep:feed:otx", ips)
}
```
