# JA4 TLS Fingerprinting Testing Walkthrough

This guide provides step-by-step instructions for teammates to verify the new JA4+ TLS fingerprinting implementation.

## Prerequisites

1. Access to the development environment where the `ngfw-monitor` is running.
2. Ensure you are in the `Security` directory: `cd /home/kali/Desktop/Next-Gen-IDS-IPS-with-MLOPs/Security`

## 1. Verify Build and Unit Tests

- [ ] **Run all TLS Unit Tests:**
  ```bash
  go test ./detect/ -run "TLS|JA3|JA4|ComputeJA4" -v
  ```
  _Expected Result:_ All 8 tests must pass. You should see JA4 format tests and the `TestTLSInspector_JA4_BadFingerprint` test pass.

- [ ] **Build the Monitor:**
  ```bash
  go build -o ngfw-monitor .
  ```
  _Expected Result:_ Builds cleanly with no compilation errors.

## 2. Test End-to-End Live Traffic (TLS-HELLO-001)

We will start the proxy and send a test curl request to verify JA4 hashes are emitted into the detection logs.

- [ ] **Start the Proxy Server:**
  ```bash
  # In terminal 1
  sudo ./ngfw-monitor proxy
  ```

- [ ] **Generate TLS Traffic:**
  ```bash
  # In terminal 2
  # The proxy listens on 443 (auto-forwarding to 8443 per config)
  curl -k https://127.0.0.1:443/
  ```

- [ ] **Verify the Detection Log:**
  ```bash
  # The JSON logger writes to the logs/ directory by default
  tail -n 20 logs/detections.jsonl | grep "TLS-HELLO-001"
  ```
  _Expected Result:_ You should see a JSON line containing `"id":"TLS-HELLO-001"`. Inside the `details` object, you should see three hashes:
  - `"ja3_hash"`
  - `"ja3n_hash"`
  - `"ja4_hash"` (format: `t13i..._..._...` or similar)

## 3. Verify FoxIO JA4 Spec Correctness

Pick a `ja4_hash` from your logs and manually verify the format matches the FoxIO standard:
- [ ] **Prefix Shape:** The first segment must be 10 characters starting with `t`. Example: `t13i010200`
- [ ] **Hex Format:** The prefix is followed by exactly two `_` delimited hashes.
- [ ] **Hash Length:** The second and third segments must be exactly 12 characters of lower-case hex. Example: `8daaf6152771`

## 4. Test Malicious Fingerprint Blocking (TLS-JA4-BAD-001)

The system is wired to detect known-bad JA4 hashes via the `knownBadJA4` map. Currently, this map is waiting for the Redis feed integration to be fully populated, but we can verify the detection logic using the unit tests.

- [ ] **Run the specific Bad Fingerprint Test:**
  ```bash
  go test ./detect/ -run "TestTLSInspector_JA4_BadFingerprint" -v
  ```
  _Expected Result:_
  1. The test sends a dummy TLS ClientHello.
  2. It intercepts the generated `ja4_hash`.
  3. It manually adds that hash to `knownBadJA4` with the note `"Test Malware Stub"`.
  4. It sends a second dummy TLS ClientHello.
  5. It verifies that `TLS-JA4-BAD-001` is emitted with the correct note.
  6. The test should print `PASS`.

## Next Steps / Team Handoff

- **Data Pipeline:** The reputation system (`feed_ingest.go`) needs a new cron entry to pull the FoxIO JA4 feed and populate the `rep:feed:ja4_bad` Redis SET.
- **Proxy Tier-2 Lookup:** The proxy connection handler needs to check `ja4_hash` against Redis `rep:feed:ja4_bad` alongside the existing JA3 check.
