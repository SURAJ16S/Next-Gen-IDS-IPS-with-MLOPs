# Protocol Detection Documentation

This directory contains per-protocol detection engine documentation.

Each protocol subdirectory contains a `README.md` with:
- **Type** — what the analyzer does and its inspection scope
- **Architecture** — state machine, detection method, key data structures  
- **Installation and Configuration** — how to configure the proxy for this protocol
- **Required Info to Detect** — what signals are needed and which are unavailable
- **Detection Output** — complete rule reference with sample JSON output
- **Known Issues** — limitations, false positive sources, known blindspots
- **Remarks** — operational recommendations and planned enhancements

## Protocols

| Protocol | Status | Rules | Doc |
|:---------|:-------|:------|:----|
| [SSH](ssh/README.md) | ✅ Implemented | SSH-VER-001, SSH-PROTO-001, SSH-TOOL-001, SSH-HASSH-001, SSH-WEAK-KEX/CIPHER/MAC, SSH-MALFORM-001, SSH-SCAN-001, SSH-BRUTE-001 | [ssh/README.md](ssh/README.md) |
| HTTP | ✅ Implemented | HTTP-SQLI-*, HTTP-XSS-*, HTTP-LFI-*, ... | — |
| DNS | ✅ Implemented | DNS-TUNNEL-*, DNS-DGA-*, ... | — |
| SMTP | ✅ Implemented | SMTP-RELAY-*, SMTP-SPAM-*, ... | — |
| FTP | ✅ Implemented | FTP-BOUNCE-*, FTP-ANON-*, ... | — |
| TLS | ✅ Implemented | TLS-WEAK-*, TLS-EXPIRED-*, ... | — |
| Database (MySQL/PostgreSQL/Redis/MongoDB) | ✅ Implemented | DB-INJECT-*, DB-UNAUTH-*, ... | — |
