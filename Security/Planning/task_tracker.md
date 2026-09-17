# IDS/IPS Implementation Task Tracker
Started: 2026-09-04 | Last Updated: 2026-09-16T11:33

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
- [x] 3.3 BFLA detection (role x endpoint)
- [x] 3.4 NTP/SNMP amplification factor tracking
- [x] 3.5 HASSH blocklist
- [x] 3.6 JA3/JA3S blocklist enforcement
- [x] 3.7 SSH CVE version watchlist
- [x] 3.8 JA4 and JA3N TLS fingerprinting implementation and spec compliance

## WAVE 4 — Stretch Goals
- [x] 4.1 Cross-protocol session graph engine
- [x] 4.2 Detection regression as CI
- [x] 4.3 Adaptive threshold recalibration
- [x] 4.4 Deception mesh

## WAVE 5 — Benchmarking & Integration
- [ ] 5.1 GoTestWAF benchmarking against Go Proxy

## WAVE 6 — Dashboard Integration & DevOps Automation
- [x] 6A.1  Add Blocklist link to AdminSidebar.jsx
- [x] 6B.1  Add nodeId + nodeOwner to SecurityEvent, NetworkEvent, BlockedEntity models
- [x] 6B.2  Create Security/streamer/dashboard_streamer.go
- [x] 6B.3  Wire DashboardStreamer into Security/main.go DetectionBus
- [x] 6B.4  Update agent.controller.js: map Go Detection fields + stamp nodeId/nodeOwner
- [ ] 6B.5  Add per-user Socket.IO room join (join:myroom event)
- [ ] 6B.6  Wire createAutomaticBlock for CRITICAL severity in agent.controller.js
- [ ] 6B.7  Scope user-facing API queries by nodeOwner in threat/network/logs controllers
- [ ] 6C.1  Run sandbox + generate_labeled_traffic.sh (http.jsonl > 500 rows)
- [ ] 6C.2  Train Model #2 (web-classifier Random Forest, recall sqli >= 0.80)
- [ ] 6C.3  Restart FastAPI scoring service, verify all 3 models loaded
- [ ] 6D.1  Pull GoTestWAF Docker image + clone testcases
- [ ] 6D.2  Verify all prerequisites before scan
- [ ] 6D.3  Run GoTestWAF scan - save report to Security/reports/
- [ ] 6D.4  Analyze report; retrain if category detection < 50%
- [ ] 6E.1  Add ml-scoring-service to DevOps/docker-compose-devops.yml
- [ ] 6E.2  Create Security/ML/Dockerfile + .dockerignore
- [ ] 6E.3  Add DASHBOARD_URL, AGENT_NODE_ID, AGENT_NODE_SECRET to .env files
- [ ] 6E.4  Update LOCAL_TESTING_GUIDE.md with full startup sequence

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
| 2026-09-07 12:00 | 3.8 | tls_inspect.go / test | Corrected 7 JA4 spec deviations, added JA3N, tested fingerprint formats |
| 2026-09-16 11:33 | 6A.1 | AdminSidebar.jsx | Added ShieldOff icon + "IP Blocklist" nav entry to admin sidebar |
| 2026-09-16 11:33 | 6B.1 | SecurityEvent.js, NetworkEvent.js, BlockedEntity.js | Added nodeId + nodeOwner fields to all three models for multi-tenant node scoping |
| 2026-09-16 11:55 | 6B.2 | Security/streamer/dashboard_streamer.go | Created async batched HTTP telemetry streamer package for node-to-dashboard event posting |
| 2026-09-16 12:06 | 6B.3 | Security/main.go | Subscribed DashboardStreamer to DetectionBus in proxy setup and startup methods |
| 2026-09-16 12:15 | 6B.4 | agent.controller.js | Mapped Go Detection payload fields, stamped nodeId & nodeOwner, added ordered:false and owner room broadcasts |
