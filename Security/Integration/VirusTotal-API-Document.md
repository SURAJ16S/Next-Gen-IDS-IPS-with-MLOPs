# VirusTotal API v3 — Integration Guide

## Overview

VirusTotal aggregates threat analysis from 70+ top antivirus vendors, security scanners, and threat intelligence organizations.

The Go security agent ([`Security/reputation/feed_ingest.go`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/Security/reputation/feed_ingest.go)) connects to VirusTotal API v3 via `FetchVirusTotalIPReport()` to query vendor analysis statistics for suspicious IP addresses.

---

## Configuration

Set your VirusTotal API key in `.env` and `Web/backend/.env`:

```env
VIRUSTOTAL_KEY=bb81bcacf6b4fb7b5117f047066caabe115a5c4209d83d1f434e92e0f721af1e
VIRUSTOTAL_API_KEY=bb81bcacf6b4fb7b5117f047066caabe115a5c4209d83d1f434e92e0f721af1e
```

---

## Endpoint Details

- **URL**: `https://www.virustotal.com/api/v3/ip_addresses/{ip}`
- **HTTP Method**: `GET`
- **Headers**:
  - `x-apikey: <your_virustotal_key>`
  - `Accept: application/json`

---

## Live Response Sample

### IP Analysis Query (`GET /api/v3/ip_addresses/118.193.56.184`)

```json
{
    "data": {
        "id": "118.193.56.184",
        "type": "ip_address",
        "attributes": {
            "last_analysis_stats": {
                "malicious": 13,
                "suspicious": 3,
                "undetected": 29,
                "harmless": 46,
                "timeout": 0
            },
            "country": "TH",
            "asn": 135377,
            "as_owner": "UCLOUD INFORMATION TECHNOLOGY (HK) LIMITED",
            "regional_internet_registry": "APNIC"
        }
    }
}
```

---

## Go Agent Integration

In [`Security/reputation/feed_ingest.go`](file:///home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/Security/reputation/feed_ingest.go):

```go
res, err := c.FetchVirusTotalIPReport(ctx, "118.193.56.184", vtApiKey)
if err == nil && res.Malicious > 0 {
    // Increment local IP threat reputation in Redis
    c.BumpScore(ctx, ip, reputation.ScoreHigh)
}
```
