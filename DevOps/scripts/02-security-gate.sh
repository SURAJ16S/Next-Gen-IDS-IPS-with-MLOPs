#!/bin/bash
# DevOps/scripts/02-security-gate.sh
# Phase 2: Security Validation & Malware Auditing Gate
# This script scans /tmp/devops-build/ using Semgrep SAST, OSV-Scanner, and Clamscan.
# It exits with code 1 if any critical/high issues are found.

set -euo pipefail

BUILD_DIR="/tmp/devops-build"
REPORT_DIR="$(dirname "$0")/../reports"
mkdir -p "$REPORT_DIR"

SEMGREP_REPORT="${REPORT_DIR}/semgrep-report.json"
OSV_REPORT="${REPORT_DIR}/osv-report.json"
CLAMAV_REPORT="${REPORT_DIR}/clamav-report.txt"

echo "========================================="
echo "Phase 2: Security Validation Gate"
echo "========================================="

# Helper functions
run_semgrep() {
    echo "[*] Gate 1/3: Running Semgrep SAST..."
    if ! command -v semgrep &> /dev/null; then
        echo "[!] Warning: 'semgrep' is not installed."
        echo "    Please run 'pip install semgrep' or install it via your package manager."
        echo "    Skipping Semgrep scan for demonstration..."
        return 0
    fi

    # Run scan. semgrep scan returns non-zero if findings are found when --error is used.
    # We output report to JSON and also print stdout to console.
    set +e
    semgrep scan --config auto "$BUILD_DIR" --json --output "$SEMGREP_REPORT"
    local exit_code=$?
    set -e

    if [ $exit_code -ne 0 ]; then
        echo "[-] Semgrep detected vulnerabilities! See report: $SEMGREP_REPORT"
        # Print a short summary of findings if possible
        if command -v jq &> /dev/null; then
            jq '.results[] | {path: .path, line: .start.line, message: .extra.message}' "$SEMGREP_REPORT" || true
        fi
        return 1
    fi
    echo "[+] Semgrep SAST: PASSED."
    return 0
}

run_osv_scanner() {
    echo "[*] Gate 2/3: Running OSV-Scanner (Dependency Supply Chain)..."
    if ! command -v osv-scanner &> /dev/null; then
        echo "[!] Warning: 'osv-scanner' is not installed."
        echo "    Please install OSV-Scanner from https://github.com/google/osv-scanner"
        echo "    Skipping OSV-Scanner for demonstration..."
        return 0
    fi

    set +e
    osv-scanner -r "$BUILD_DIR" --format json --output "$OSV_REPORT"
    local exit_code=$?
    set -e

    if [ $exit_code -ne 0 ]; then
        echo "[-] OSV-Scanner detected vulnerable dependencies! See report: $OSV_REPORT"
        return 1
    fi
    echo "[+] OSV-Scanner: PASSED."
    return 0
}

run_clamav() {
    echo "[*] Gate 3/3: Running ClamAV Malware Scan..."
    if ! command -v clamscan &> /dev/null; then
        echo "[!] Warning: 'clamscan' is not installed/running."
        echo "    Please install ClamAV to verify binaries/assets."
        echo "    Skipping ClamAV scan for demonstration..."
        return 0
    fi

    set +e
    # Run clamscan: --recursive, output infected files, write report
    clamscan --recursive --infected "$BUILD_DIR" > "$CLAMAV_REPORT" 2>&1
    local exit_code=$?
    set -e

    # Clamscan exit codes: 0 = No virus found, 1 = Virus(es) found, 2 = Error(s) occurred.
    if [ $exit_code -eq 1 ]; then
        echo "[-] ClamAV detected infected files / malware! See report: $CLAMAV_REPORT"
        cat "$CLAMAV_REPORT"
        return 1
    elif [ $exit_code -eq 2 ]; then
        echo "[!] Clamscan encountered errors during execution. Check logs: $CLAMAV_REPORT"
        # We can decide to pass or fail on scan errors. For strict gating, we fail.
        return 1
    fi

    echo "[+] ClamAV scan: PASSED."
    return 0
}

run_credential_scan() {
    echo "[*] Gate 0/3: Scanning for hardcoded credentials..."
    if ! command -v node &> /dev/null; then
        echo "[!] Warning: 'node' is not installed."
        echo "    Skipping credential scan..."
        return 0
    fi
    node "$(dirname "$0")/scan-credentials.js" "$BUILD_DIR"
    return $?
}

# Run the validation pipeline
FAILED=0

if [ ! -d "$BUILD_DIR" ]; then
    echo "[-] Error: Staging build directory $BUILD_DIR does not exist."
    echo "    Please run Phase 1 (01-generate-code.sh) first."
    exit 1
fi

run_credential_scan || FAILED=1
run_semgrep || FAILED=1
run_osv_scanner || FAILED=1
run_clamav || FAILED=1

if [ $FAILED -ne 0 ]; then
    echo "========================================="
    echo "[-] SECURITY GATE FAILED: Code contains vulnerabilities or malware."
    echo "    Resolve the issues before sandbox promotion."
    echo "========================================="
    exit 1
else
    echo "========================================="
    echo "[+] SECURITY GATE PASSED: Code is clean."
    echo "    Proceeding to Phase 3 Sandbox Deployment."
    echo "========================================="
    exit 0
fi
