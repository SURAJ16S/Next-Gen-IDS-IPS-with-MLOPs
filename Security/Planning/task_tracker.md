# IDS/IPS Implementation Task Tracker
Started: 2026-09-04 | Last Updated: 2026-09-04T05:14

## WAVE 1 — Immediate (Detection Rules)
- [x] 1.1 Wire ScoreFlow() into flow pipeline (flow_logger.go)
- [x] 1.2 Add honeytoken endpoint detection — HTTP-HONEY-001 (http_analyzer.go)
- [x] 1.3 Add new HTTP rules — XPath, Open Redirect, Host Header, 0.CL, WebSocket Origin (http_analyzer.go)
- [x] 1.4 Add 17 missing tool UA fingerprints + CMS recon path detection (http_analyzer.go)
- [x] 1.5 SMTP STARTTLS stripping detection (smtp_analyzer.go)
- [x] 1.6 TLS SNI/Certificate mismatch rule (tls_inspect.go)
- [x] 1.7 FTP PORT command bounce detection (ftp_analyzer.go)
- [x] 1.8 DNS transaction ID mismatch / cache poisoning (dns_analyzer.go)

## WAVE 2 — High Priority (ML + Dashboard)
- [x] 2.1 Run sandbox + train ML Model #2 (web-classifier)
- [x] 2.2 Train ML Model #4 (SSH brute-force classifier)
- [x] 2.3 Train ML Model #5 (DNS tunnel/DGA classifier)
- [x] 2.4 Build AdminManageBlocklist.jsx
- [x] 2.5 Wire CaptchaGate into Login.jsx + auth routes
- [x] 2.6 Slowloris/Slow-POST behavioral detection (behavioral.go)
- [x] 2.7 Per-endpoint rate tracking for HTTP flood (rate_tracker.go)
- [x] 2.8 Malformed SSH packet detection (ssh_analyzer.go)

## WAVE 3 — Medium Priority
- [x] 3.1 SMTP spam/phishing text classifier (Model #6)
- [x] 3.2 SSH tunnel anomaly detection
- [x] 3.3 BFLA detection (role × endpoint)
- [x] 3.4 NTP/SNMP amplification factor tracking
- [x] 3.5 HASSH blocklist
- [x] 3.6 JA3/JA3S blocklist enforcement
- [x] 3.7 SSH CVE version watchlist

## WAVE 4 — Stretch Goals
- [x] 4.1 Cross-protocol session graph engine
- [x] 4.2 Detection regression as CI
- [x] 4.3 Adaptive threshold recalibration
- [x] 4.4 Deception mesh

## CHANGE LOG
| Time | Task | File Changed | What Was Done |
|---|---|---|---|
| 2026-09-04 02:46 | 1.2 | http_analyzer.go | Added HTTP-HONEY-001 honeytoken path detection (24 paths) |
| 2026-09-04 02:46 | 1.3 | http_analyzer.go | Added 5 new rules: XPath injection, Open Redirect, HTTP 0.CL smuggling, WebSocket Origin check, CMS recon paths |
| 2026-09-04 02:46 | 1.4 | http_analyzer.go | Added 17 missing attack tool UA fingerprints; added CMS recon path detection |
| 2026-09-04 02:46 | 1.3 | http_analyzer.go | Added Host Header Injection parsed check in analyzeRequest() |
| 2026-09-04 02:46 | 1.1 | flow_logger.go | Wired ScoreFlow() call on flow close — activates Model #3 |
| 2026-09-04 02:47 | 1.5 | smtp_analyzer.go | Added STARTTLS stripping state machine |
| 2026-09-04 02:47 | 1.6 | tls_inspect.go | Added SNI vs. certificate CN/SAN mismatch detection |
| 2026-09-04 02:47 | 1.7 | ftp_analyzer.go | Added PORT command IP mismatch (bounce attack) detection |
| 2026-09-04 02:47 | 1.8 | dns_analyzer.go | Added DNS TxID mismatch detection for cache poisoning |
