#!/usr/bin/env bash
# sandbox/generate_labeled_traffic.sh
#
# Runs each attack tool in its own labeled batch against the sandbox targets
# THROUGH your reverse proxy, and tags the resulting log window with a label
# — this is the "tag the whole tool-run batch" approach from the master plan
# section 6.5, step 1 (simpler and more reliable than trying to infer a label
# per-request after the fact).
#
# Fill in PROXY_HOST / PROXY_PORT / DVWA_SESSION_COOKIE before running.
# Run this AFTER Phase A (Redis) and the sandbox compose file are up, and
# AFTER you've confirmed normal browsing through the proxy works.

set -euo pipefail

PROXY_HOST="${PROXY_HOST:-127.0.0.1}"
PROXY_PORT="${PROXY_PORT:-8080}"
LOG_LABEL_DIR="${LOG_LABEL_DIR:-./labeled_runs}"
DVWA_COOKIE="${DVWA_COOKIE:-PHPSESSID=changeme; security=low}"

mkdir -p "$LOG_LABEL_DIR"

label_run() {
  local label="$1"
  local start_marker="$LOG_LABEL_DIR/${label}_start_$(date +%s).marker"
  echo "$(date -Iseconds) START label=$label" | tee "$start_marker"
}

echo "== 1. BENIGN baseline: manually click through DVWA + Juice Shop normal =="
echo "    flows for a few minutes right now, THEN press Enter to continue."
echo "    (This is your clean baseline for Model #1 / #3 — see master plan 6.3 step 1.)"
read -r -p "Press Enter once you've generated some normal browsing traffic... "
label_run "benign"

echo "== 2. SQLi via sqlmap =========================================="
label_run "sqli"
sqlmap -u "http://${PROXY_HOST}:${PROXY_PORT}/vulnerabilities/sqli/?id=1&Submit=Submit" \
  --cookie="$DVWA_COOKIE" \
  --batch --level=3 --risk=2 \
  --tamper=space2comment,between,charencode \
  --output-dir="$LOG_LABEL_DIR/sqlmap_output" || true

echo "== 3. XSS / fuzzing via OWASP ZAP CLI (or manual PayloadsAllTheThings) =="
label_run "xss"
echo "    Run ZAP's baseline/active scan against Juice Shop here, or manually"
echo "    replay payloads from PayloadsAllTheThings/XSS through the proxy."

echo "== 4. Recon / path traversal / forced browsing via dirb+wfuzz =========="
label_run "recon"
dirb "http://${PROXY_HOST}:${PROXY_PORT}/" -o "$LOG_LABEL_DIR/dirb_output.txt" || true

echo "== 5. Bot/scanner fingerprint via Nikto ================================"
label_run "bot_scanner"
nikto -h "http://${PROXY_HOST}:${PROXY_PORT}/" -output "$LOG_LABEL_DIR/nikto_output.txt" || true

echo "== 6. Brute-force (SSH/FTP, if those protocols are routed through the proxy too) =="
label_run "bruteforce"
echo "    Example (adjust target/port/wordlists to your sandbox SSH/FTP listener):"
echo "    hydra -l admin -P /usr/share/wordlists/rockyou.txt ssh://${PROXY_HOST}:2222"

echo ""
echo "Done. For each label above, take the slice of your Go collector's JSONL"
echo "logs between that label's start marker and the next one, and set"
echo '  "label": "<name>"'
echo "on each of those rows before feeding it into train_models.py's"
echo "web-classifier command — see feature_encoder.py's _label field and the"
echo "master plan section 6.5, step 2."
