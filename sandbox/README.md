# Sandbox — Attack Traffic Generation & End-to-End Testing

This directory contains an isolated, deliberately-vulnerable target environment for:
1. **Generating labeled attack traffic** (Phase D of the ML pipeline)
2. **End-to-end integration testing** of the full Tier-1 → Tier-2 → Tier-3 → dashboard pipeline

> ⚠️ **Security Warning:** These containers are intentionally vulnerable. Run them only on an isolated network and **never expose their ports directly to the internet**. They must only be reachable **through your reverse proxy**.

## Components

| Container | Image | Purpose | Internal Address |
|---|---|---|---|
| `sandbox-dvwa` | `vulnerables/web-dvwa` | SQL injection, XSS, CSRF, file upload, command injection | `dvwa:80` |
| `sandbox-juiceshop` | `bkimminich/juice-shop` | Full OWASP Top-10 coverage, API security | `juiceshop:3000` |
| `sandbox-redis` | `redis:7-alpine` | Optional: attack-tool bookkeeping only | `redis-sandbox:6379` |

## Quick Start

```bash
# 1. Start the sandbox (internal network only — no public ports exposed)
docker compose -f docker-compose.sandbox.yml up -d

# 2. Verify containers are running
docker compose -f docker-compose.sandbox.yml ps

# 3. Point your proxy at the sandbox targets
#    Edit Security/proxy_config.yaml backends to:
#      - dvwa:      http://127.0.0.1:8081  (after adding local port mapping, see below)
#      - juiceshop: http://127.0.0.1:8082

# 4. Add local port mappings for host-based proxy testing
#    In docker-compose.sandbox.yml, temporarily add:
#      dvwa:      ports: ["127.0.0.1:8081:80"]
#      juiceshop: ports: ["127.0.0.1:8082:3000"]
#    (Remove these before a real security test — only the proxy should reach them)
```

## Generating Labeled Training Data (Phase D)

```bash
# Set up environment
export PROXY_HOST=127.0.0.1
export PROXY_PORT=8080       # your Go proxy's listen port
export DVWA_COOKIE="PHPSESSID=<your-session>; security=low"

# Run the labeling script
bash generate_labeled_traffic.sh
```

The script will prompt you to generate benign baseline traffic first, then automatically runs:
- `sqlmap` → labels traffic as `sqli`
- Manual XSS / ZAP scan → labels as `xss`
- `dirb` → labels as `recon`
- `nikto` → labels as `bot_scanner`
- `hydra` (SSH/FTP) → labels as `bruteforce`

After each labeled run, slice the corresponding time window from your Go proxy's JSONL logs and add `"label": "<name>"` to each row before feeding into `ML/train_models.py`.

## End-to-End Live Test (Phase I)

```bash
# 1. Start the sandbox and the Go proxy
docker compose -f docker-compose.sandbox.yml up -d
cd Security && sudo ./ngfw-monitor   # select Integrated Mode

# 2. Confirm normal browsing works
curl http://<proxy-host>:<port>/

# 3. Run sqlmap through the proxy
sqlmap -u "http://<proxy-host>:<port>/vulnerabilities/sqli/?id=1&Submit=Submit" \
       --cookie="$DVWA_COOKIE" --batch

# Expected results:
#   - Tier-1 signatures fire immediately in the Go agent logs
#   - FastAPI /score/http-payload returns risk_score > 70 (once Phase G is wired)
#   - Dashboard shows live SecurityEvent via Socket.IO
#   - If risk_score > autoBlockThreshold, a BlockedEntity record appears
#     and sqlmap starts getting connection resets

# 4. Run Nikto for bot/scanner detection
nikto -h http://<proxy-host>:<port>/

# 5. Check the ML/scoring service
curl -s http://localhost:8500/health | python -m json.tool
```

## Attack Tool Reference

| Tool | Install | Usage |
|---|---|---|
| `sqlmap` | `sudo apt install sqlmap` | `sqlmap -u <url> --cookie=<c> --batch --tamper=space2comment` |
| `nikto` | `sudo apt install nikto` | `nikto -h <url>` |
| `dirb` | `sudo apt install dirb` | `dirb <url>` |
| `hydra` | `sudo apt install hydra` | `hydra -l admin -P rockyou.txt ssh://<host>` |
| `sqlmap` | pre-installed on Kali | Full tamper script coverage |

## Stopping the Sandbox

```bash
docker compose -f docker-compose.sandbox.yml down
```
