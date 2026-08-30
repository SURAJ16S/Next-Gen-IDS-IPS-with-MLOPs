#!/usr/bin/env bash
# =============================================================================
# ML/datasets/download_all.sh
# Next-Gen IDS/IPS — Dataset & Cheatsheet Download Script
# =============================================================================
# Usage:
#   cd ML/datasets && bash download_all.sh              # download everything
#   bash download_all.sh --skip-large                   # skip multi-GB datasets
#   bash download_all.sh --feeds-only                   # only refresh live feeds
#
# API KEYS NEEDED (you are registering manually — add to .env):
#   ABUSEIPDB_KEY  → https://www.abuseipdb.com/register
#   MAXMIND_KEY    → https://www.maxmind.com/en/geolite2/signup
#   GREYNOISE_KEY  → https://www.greynoise.io/signup
#   OTX_KEY        → https://otx.alienvault.com/accounts/register
#   PHISHTANK_KEY  → https://www.phishtank.com/register.php
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[SKIP]${NC} $*"; }
section() { echo -e "\n${BOLD}${CYAN}=== $* ===${NC}"; }

SKIP_LARGE=false
FEEDS_ONLY=false
for arg in "$@"; do
  case $arg in
    --skip-large) SKIP_LARGE=true ;;
    --feeds-only) FEEDS_ONLY=true ;;
  esac
done

[[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; info "Loaded .env"; } \
  || warn "No .env found — API-gated feeds will be skipped. Add keys and re-run."

section "Checking dependencies"
for dep in curl git unzip python3; do
  command -v "$dep" &>/dev/null && success "$dep" || { echo "Install: sudo apt install -y $dep"; exit 1; }
done

mkdir -p "$SCRIPT_DIR"/{public_datasets,cheatsheets/{payloads,seclists,nuclei,owasp_crs,owasp_api,crapi,dvga},dga_feeds,no_auth_feeds,self_generated,processed}

clone_or_pull() {
  local name="$1" url="$2" dest="$3"
  if [[ -d "$dest/.git" ]]; then
    info "$name: pulling latest..."; git -C "$dest" pull --quiet && success "$name updated"
  else
    info "Cloning $name..."; git clone --depth=1 --quiet "$url" "$dest" && success "$name cloned"
  fi
}

# =============================================================================
# SECTION 1 — CHEATSHEETS & PAYLOAD LIBRARIES
# =============================================================================
if [[ "$FEEDS_ONLY" == false ]]; then
section "Cheatsheets & Payload Libraries"

clone_or_pull "PayloadsAllTheThings" \
  "https://github.com/swisskyrepo/PayloadsAllTheThings.git" \
  "$SCRIPT_DIR/cheatsheets/payloads/PayloadsAllTheThings"

clone_or_pull "OWASP-CRS" \
  "https://github.com/coreruleset/coreruleset.git" \
  "$SCRIPT_DIR/cheatsheets/owasp_crs"

clone_or_pull "OWASP-API-Security" \
  "https://github.com/OWASP/API-Security.git" \
  "$SCRIPT_DIR/cheatsheets/owasp_api"

clone_or_pull "crAPI" \
  "https://github.com/OWASP/crAPI.git" \
  "$SCRIPT_DIR/cheatsheets/crapi"

clone_or_pull "DVGA" \
  "https://github.com/dolevf/Damn-Vulnerable-GraphQL-Application.git" \
  "$SCRIPT_DIR/cheatsheets/dvga"

clone_or_pull "HASSH-fingerprints" \
  "https://github.com/salesforce/hassh.git" \
  "$SCRIPT_DIR/no_auth_feeds/hassh"
[[ -f "$SCRIPT_DIR/no_auth_feeds/hassh/fingerprints/hasshRules.json" ]] && \
  cp "$SCRIPT_DIR/no_auth_feeds/hassh/fingerprints/hasshRules.json" \
     "$SCRIPT_DIR/no_auth_feeds/hassh_bad_fingerprints.json" && \
  success "HASSH fingerprints extracted"

if [[ "$SKIP_LARGE" == false ]]; then
  clone_or_pull "Nuclei-Templates" \
    "https://github.com/projectdiscovery/nuclei-templates.git" \
    "$SCRIPT_DIR/cheatsheets/nuclei"

  SECLISTS="$SCRIPT_DIR/cheatsheets/seclists"
  if [[ -d "$SECLISTS/.git" ]]; then
    git -C "$SECLISTS" pull --quiet && success "SecLists updated"
  else
    git clone --depth=1 --filter=blob:none --sparse \
      https://github.com/danielmiessler/SecLists.git "$SECLISTS" --quiet
    git -C "$SECLISTS" sparse-checkout set \
      Passwords/Default-Credentials \
      Passwords/Common-Credentials \
      Fuzzing/SQLi Fuzzing/XSS Fuzzing/SSRF \
      Discovery/Web-Content Discovery/DNS \
      Usernames/top-usernames-shortlist.txt
    success "SecLists (sparse) cloned"
  fi
else
  warn "Skipping large repos (Nuclei, SecLists) — remove --skip-large to get them"
fi
fi

# =============================================================================
# SECTION 2 — PUBLIC DATASETS
# =============================================================================
if [[ "$FEEDS_ONLY" == false && "$SKIP_LARGE" == false ]]; then
section "Public Labeled Datasets"

# UNSW-NB15
UNSW="$SCRIPT_DIR/public_datasets/UNSW-NB15"
if [[ ! -d "$UNSW" ]]; then
  mkdir -p "$UNSW"
  for f in UNSW-NB15_1.csv UNSW-NB15_2.csv UNSW-NB15_3.csv UNSW-NB15_4.csv UNSW-NB15-FEATURES-NAMES.csv; do
    curl -fsSL --retry 3 \
      "https://research.unsw.edu.au/sites/default/files/documents/$f" \
      -o "$UNSW/$f" && success "UNSW-NB15: $f" || warn "UNSW-NB15 $f not available at direct URL — download from https://research.unsw.edu.au/projects/unsw-nb15-dataset"
  done
else
  success "UNSW-NB15 already present"
fi

# CTU-13 binetflows (not PCAP — much smaller)
CTU="$SCRIPT_DIR/public_datasets/CTU-13"
if [[ ! -d "$CTU" ]]; then
  mkdir -p "$CTU"
  info "Downloading CTU-13 binetflow files (not PCAP)..."
  for i in {1..13}; do
    curl -fsSL --retry 2 \
      "https://mcfp.felk.cvut.cz/publicDatasets/CTU-Malware-Capture-Botnet-${i}/detailed-bidirectional-flow-labels/capture${i}.binetflow" \
      -o "$CTU/botnet_${i}.binetflow" \
      && success "CTU-13 scenario $i" \
      || warn "CTU-13 scenario $i not available (some are private)"
  done
else
  success "CTU-13 already present"
fi

# SpamAssassin corpus
SPAM="$SCRIPT_DIR/public_datasets/spam_phishing"
mkdir -p "$SPAM"
SA_BASE="https://spamassassin.apache.org/old/publiccorpus"
for arc in 20021010_easy_ham.tar.bz2 20021010_hard_ham.tar.bz2 20021010_spam.tar.bz2 \
           20030228_easy_ham.tar.bz2 20030228_hard_ham.tar.bz2 20030228_spam.tar.bz2; do
  [[ -f "$SPAM/$arc" ]] && success "SpamAssassin: $arc (cached)" && continue
  curl -fsSL --retry 3 -o "$SPAM/$arc" "$SA_BASE/$arc" \
    && success "SpamAssassin: $arc" || warn "SpamAssassin $arc failed"
done

echo ""
echo -e "${BOLD}${YELLOW}--- MANUAL DOWNLOADS REQUIRED (form-based, no direct URL) ---${NC}"
echo " D1 CIC-IDS2017  → https://www.unb.ca/cic/datasets/ids-2017.html"
echo "    Extract to: $SCRIPT_DIR/public_datasets/CIC-IDS2017/"
echo " D2 CIC-IDS2018  → https://www.unb.ca/cic/datasets/ids-2018.html"
echo "    Extract to: $SCRIPT_DIR/public_datasets/CIC-IDS2018/"
echo " D3 CIC-DDoS2019 → https://www.unb.ca/cic/datasets/ddos-2019.html"
echo "    Extract to: $SCRIPT_DIR/public_datasets/CIC-DDoS2019/"
echo " D4 CSIC 2010    → https://www.isi.csic.es/dataset/ (email request)"
echo "    Extract to: $SCRIPT_DIR/public_datasets/CSIC-2010/"
fi

# =============================================================================
# SECTION 3 — DGA FEEDS
# =============================================================================
section "DGA Domain Feeds"

curl -fsSL --retry 3 "https://osint.bambenekconsulting.com/feeds/dga-feed.txt" \
  -o "$SCRIPT_DIR/dga_feeds/bambenek_dga.txt" \
  && success "Bambenek DGA" || warn "Bambenek DGA failed"

curl -fsSL --retry 3 "https://osint.bambenekconsulting.com/feeds/c2-ipmasterlist.txt" \
  -o "$SCRIPT_DIR/no_auth_feeds/bambenek_c2_ips.txt" \
  && success "Bambenek C2 IPs" || warn "Bambenek C2 IPs failed"

# =============================================================================
# SECTION 4 — NO-AUTH THREAT INTEL FEEDS
# =============================================================================
section "No-Auth Threat Intel Feeds"
F="$SCRIPT_DIR/no_auth_feeds"

curl -fsSL --retry 3 "https://www.spamhaus.org/drop/drop.txt"    -o "$F/spamhaus_drop.txt"       && success "Spamhaus DROP"    || warn "Spamhaus DROP failed"
curl -fsSL --retry 3 "https://www.spamhaus.org/drop/edrop.txt"   -o "$F/spamhaus_edrop.txt"      && success "Spamhaus EDROP"   || warn "Spamhaus EDROP failed"
curl -fsSL --retry 3 "https://iplists.firehol.org/files/firehol_level1.netset" -o "$F/firehol_l1.netset" && success "FireHOL L1" || warn "FireHOL L1 failed"
curl -fsSL --retry 3 "http://cinsscore.com/list/ci-badguys.txt"  -o "$F/cins_army.txt"           && success "CINS Army"        || warn "CINS Army failed"
curl -fsSL --retry 3 "https://check.torproject.org/torbulkexitlist" -o "$F/tor_exits.txt"        && success "Tor exits"        || warn "Tor exits failed"
curl -fsSL --retry 3 "https://feodotracker.abuse.ch/downloads/ipblocklist.txt" -o "$F/feodo_c2.txt" && success "Feodo Tracker" || warn "Feodo failed"
curl -fsSL --retry 3 "https://sslbl.abuse.ch/blacklist/ja3_fingerprints.csv"   -o "$F/abusech_ja3.csv" && success "Abuse.ch JA3" || warn "JA3 feed failed"
curl -fsSL --retry 3 "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json" -o "$F/cisa_kev.json" && success "CISA KEV" || warn "CISA KEV failed"

# =============================================================================
# SECTION 5 — API-GATED FEEDS
# =============================================================================
section "API-Gated Feeds (reads from .env)"

if [[ -n "${ABUSEIPDB_KEY:-}" ]]; then
  curl -fsSL --retry 3 -G "https://api.abuseipdb.com/api/v2/blacklist" \
    --data-urlencode "confidenceMinimum=100" \
    -H "Key: $ABUSEIPDB_KEY" -H "Accept: text/plain" \
    -o "$F/abuseipdb_blacklist.txt" \
    && success "AbuseIPDB blacklist" || warn "AbuseIPDB failed"
else
  warn "AbuseIPDB skipped — set ABUSEIPDB_KEY in .env (https://www.abuseipdb.com/register)"
fi

if [[ -n "${MAXMIND_KEY:-}" ]]; then
  for db in GeoLite2-City GeoLite2-Country GeoLite2-ASN; do
    curl -fsSL --retry 3 \
      "https://download.maxmind.com/app/geoip_download?edition_id=${db}&license_key=${MAXMIND_KEY}&suffix=tar.gz" \
      -o "$F/${db}.tar.gz" && tar -xzf "$F/${db}.tar.gz" -C "$F/" \
      && success "MaxMind $db" || warn "MaxMind $db failed"
  done
else
  warn "MaxMind GeoLite2 skipped — set MAXMIND_KEY in .env (https://www.maxmind.com/en/geolite2/signup)"
fi

if [[ -n "${OTX_KEY:-}" ]]; then
  curl -fsSL --retry 3 \
    "https://otx.alienvault.com/api/v1/pulses/subscribed" \
    -H "X-OTX-API-KEY: $OTX_KEY" \
    -o "$F/otx_pulses.json" && success "AlienVault OTX" || warn "OTX failed"
else
  warn "AlienVault OTX skipped — set OTX_KEY in .env (https://otx.alienvault.com/accounts/register)"
fi

if [[ -n "${PHISHTANK_KEY:-}" ]]; then
  curl -fsSL --retry 3 \
    "http://data.phishtank.com/data/${PHISHTANK_KEY}/online-valid.csv" \
    -o "$F/phishtank.csv" && success "PhishTank" || warn "PhishTank failed"
else
  warn "PhishTank skipped — set PHISHTANK_KEY in .env (https://www.phishtank.com/register.php)"
fi

# =============================================================================
section "Summary"
echo ""
echo "Directory: $SCRIPT_DIR"
echo ""
du -sh "$SCRIPT_DIR"/*/  2>/dev/null || true
echo ""
echo "Re-run anytime to refresh feeds: bash download_all.sh --feeds-only"
echo "Add API keys to .env and re-run to get remaining feeds."
echo ""
echo -e "${GREEN}Done!${NC}"
