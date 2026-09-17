# JA3 / JA4 TLS Fingerprinting — Implementation Status & Roadmap

**Status:** JA3 fully implemented; JA4 planned
**Relevant file:** [`Security/detect/tls_inspect.go`](../detect/tls_inspect.go)
**Tier:** Tier-2 (Rule/Lookup) — runs before the ML scoring service (Tier-3)

---

## 1. What JA3 and JA4 Are

Both fingerprint a TLS connection **before any encrypted data is exchanged**, by
reading the `ClientHello` packet the client sends at the very start of the
handshake. The `ClientHello` contains a list of the client's cryptographic
preferences: TLS versions, cipher suites, extensions, and supported elliptic
curves.

JA3 and JA4 turn these fields into a compact hash that identifies the
**underlying client application** — regardless of what the client claims to be
at the HTTP layer.

**Core insight:** An attacker can fake a `User-Agent` header in one line of code.
Faking the TLS stack of a real browser is far harder — it requires either running
actual browser code or maintaining a custom TLS implementation that mimics it
exactly. Most attack tools (sqlmap, Nikto, Hydra, most malware C2 clients) do
neither: they use whatever default TLS their language/library gives them
(Python's `ssl`, Go's `crypto/tls`, OpenSSL), and that stack has a stable,
identifiable fingerprint.

---

## 2. JA3 vs. JA4 — Technical Difference

| Aspect | JA3 | JA4 |
|---|---|---|
| **Hash** | Single MD5 of concatenated fields | Two truncated SHA-256 hashes + a human-readable prefix |
| **Field order** | Uses fields in the exact order they appear in `ClientHello` | Sorts cipher suites and extensions before hashing |
| **Readability** | Fully opaque — `51c64c77e60f3980eea8bb132507d100` tells you nothing | Prefix is readable: `t13d1516h2` = TCP, TLS 1.3, SNI present, 15 ciphers, 16 exts, ALPN=h2 |
| **GREASE handling** | Must strip GREASE values before hashing | Also strips GREASE — same requirement |
| **Coverage** | `ClientHello` fields only | `ClientHello` with more robust SNI/ALPN handling |
| **Stability vs Chrome 110+** | ❌ Breaks — Chrome randomizes extension order | ✅ Fixed — sorting before hashing neutralises permutation |

---

## 3. Why JA4 Exists: Chrome 110 Broke JA3

Since Chrome 110 (early 2023), Chromium-based browsers randomize the order of
TLS extensions in every new `ClientHello` to prevent fingerprinting and protocol
ossification. Because JA3 hashes fields in the order they appear, this has a
direct consequence:

- **The same real Chrome browser now produces a different JA3 hash on almost
  every connection.** If you tried to build a JA3-based allowlist of
  "known-good browser fingerprints," it would be essentially unbounded for
  Chrome traffic.

JA4 fixes this by sorting cipher/extension lists before hashing. One real
browser → one stable JA4, regardless of Chrome's permutation.

---

## 4. Why JA3-Only Still Works for This Project

This is the important nuance. Our use case is **not** "detect bots impersonating
Chrome" — it is **"identify known attack tooling."** That distinction matters:

- Tools like `sqlmap`, Nikto, custom Python `requests`/`urllib3` scripts,
  Metasploit modules, and most malware C2 clients use **static, non-randomized**
  TLS stacks. They do not perform Chrome-style permutation.
- For a **blocklist match** against known-malicious fingerprints (exactly what
  we do against the Abuse.ch JA3 feed), plain JA3 remains **fully reliable** —
  the tools we are trying to catch are not the ones causing the instability
  problem.
- JA3's fragility only becomes a real problem if it is used as an **allowlist**
  ("only let known-good browser JA3s through"), or against bots using headless
  Chrome/Puppeteer/Playwright (which inherit real Chrome's randomization). We
  do neither of those.

**Conclusion:** The current JA3-only implementation is a correct, defensible
scope decision for a known-malicious-tool bouncer. It is not a gap — it is an
intentional scope choice that should be stated explicitly in the report and in
the viva, not left implicit.

---

## 5. What Is Actually Implemented in the Code

All of this is in [`Security/detect/tls_inspect.go`](../detect/tls_inspect.go):

### 5.1 JA3 — Client Fingerprint (Lines 306–329, fully implemented)

```
// ── Compute JA3 fingerprint ──

filteredCiphers := filterGREASE16(cipherStrs, cipherSuites)   // L.319
filteredExts    := filterGREASE16(extensionStrs, extensions)   // L.320

ja3String := fmt.Sprintf("%d,%s,%s,%s,%s",
    clientVersion,
    strings.Join(filteredCiphers, "-"),
    strings.Join(filteredExts,    "-"),
    strings.Join(filteredEC,      "-"),
    strings.Join(ecpfStrs,        "-"),
)                                                              // L.322–328
ja3Hash := fmt.Sprintf("%x", md5.Sum([]byte(ja3String)))       // L.329
```

Fields parsed: `ClientVersion`, cipher suites, extensions, elliptic curves,
EC point formats. GREASE-stripping is done via `filterGREASE16()` (L.578–586)
which calls `isGREASE()` (L.574–576): `v & 0x0F0F == 0x0A0A`.

The hash and raw string are emitted as Detection `TLS-HELLO-001` (category
`CatProtocolDetect`), with both `ja3_hash` and `ja3_string` in the `Details`
map. The raw string is capped at 500 chars via `truncate()`.

**GREASE-stripping verdict: ✅ Correctly implemented.**
The `isGREASE` check covers all GREASE values (they all match `0x_A_A` pattern)
for both cipher suites and extensions. Elliptic curves also filtered via the
same check. This is the most common JA3 implementation bug — it is not present
here.

### 5.2 JA3S — Server Fingerprint (Lines 451–455, fully implemented)

```
// JA3S = MD5(TLSVersion, SelectedCipher, Extensions)
ja3sString := fmt.Sprintf("%d,%d,%s",
    serverVersion, selectedCipher,
    strings.Join(filteredExts, "-"))
ja3sHash := fmt.Sprintf("%x", md5.Sum([]byte(ja3sString)))
```

Emitted as Detection `TLS-SHELLO-001`. This fingerprints what the **server
chose** to respond with, which helps identify misconfigured or unusual servers.

### 5.3 JA4 — NOT implemented

Mentioned in planning and gap-analysis documents as a planned feature. No JA4
computation exists in the current Go code. Only JA3 is computed.

### 5.4 Other TLS Detections in `tls_inspect.go` (context)

| Detection ID | Rule | Category |
|---|---|---|
| `TLS-WEAK-001` | Weak cipher offered in `ClientHello` | `CatTLSWeakCipher` |
| `TLS-WEAK-SEL` | Server selected a weak cipher | `CatTLSWeakCipher` |
| `TLS-DOWNGRADE` | Client only supports SSL 3.0 / TLS 1.0 | `CatTLSDowngrade` |
| `TLS-CERT-EXPIRED` | Certificate past `NotAfter` | `CatProtocolDetect` |
| `TLS-CERT-SELFSIGNED` | Issuer == Subject | `CatProtocolDetect` |
| `TLS-CERT-WEAK-SIG` | MD2/MD5/SHA1 signature algorithm | `CatProtocolDetect` |

---

## 6. How JA3 Feeds Into the Tier-2 Lookup Layer

The full detection pipeline for a TLS connection is:

```
TLS ClientHello received
    │
    ├─ tls_inspect.go: parse ClientHello
    │       ↓
    │   emit TLS-HELLO-001 with ja3_hash in Details
    │
    ├─ Tier-2 lookup (redis_reputation.py / reputation/ package):
    │       SISMEMBER rep:feed:ja3_bad <ja3_hash>
    │       → if hit: emit CatTLSKnownBadFingerprint (planned), auto-block
    │
    └─ Tier-3 ML scoring (ml_client.go):
            only reached if Tier-2 did not short-circuit
            (50ms fail-open timeout)
```

The Redis key `rep:feed:ja3_bad` is a SET of known-malicious JA3 hashes,
populated by the feed ingestion job from the **Abuse.ch JA3 feed**
(`https://sslbl.abuse.ch/blacklist/ja3_fingerprints.csv`), scheduled weekly
per the implementation plan (Feed F10).

> **Note on `CatTLSKnownBadFingerprint`:** The constant is defined in
> `detection.go` and noted as "planned" in `covered_attacks_summary.md`. The JA3
> hash is already computed and emitted on every connection — the remaining work
> is the Tier-2 lookup that checks it against `rep:feed:ja3_bad` and fires the
> category if it matches.

---

## 7. Recommendations

### Rec 1 — Verify the JA3 feed lookup is actually wired up (Tier-2 gap)

The JA3 hash is computed (✅) and `rep:feed:ja3_bad` is planned (✅), but
the actual lookup — `SISMEMBER rep:feed:ja3_bad <ja3_hash>` — is the missing
link. Confirm this runs in the `reputation/` package or the HTTP proxy handler
**before** calls reach `ml_client.go`. Without it, JA3 is computed but never
used for blocking.

### Rec 2 — Add JA3N as an intermediate step (small code change)

JA3N is JA3 with the extension list **sorted before** joining — same MD5 hash
format, same field set, one code change. It fixes the Chrome permutation
problem without a new hash algorithm. In `tls_inspect.go`, it is a one-liner
before building `ja3String`:

```go
// Current (JA3):
filteredExts := filterGREASE16(extensionStrs, extensions)

// Add for JA3N:
sort.Strings(filteredExts)   // sort before joining — neutralises Chrome permutation
```

This is worth adding even if full JA4 lands later, because it immediately
stabilises fingerprints for any Chromium-based scanner tool.

### Rec 3 — Implement full JA4 client fingerprinting

By 2026, JA4 is standard at Cloudflare, Akamai, AWS, and in Suricata/Zeek.
JA4 feeds (FoxIO JA4+ database) are increasingly what gets published alongside
or instead of JA3 from threat-intel sources. The FoxIO reference implementation
is at `github.com/FoxIO-LLC/ja4`.

The JA4 string format is:

```
t13d1516h2_<sorted-cipher-sha256-prefix>_<sorted-ext-sha256-prefix>

Where the prefix is:
  t   = transport (t=TCP, q=QUIC, d=DTLS)
  13  = TLS version (13 = 1.3, 12 = 1.2, etc.)
  d   = SNI present (d = domain, i = IP, n = none)
  15  = cipher count (hex)
  16  = extension count (hex)
  h2  = ALPN (or "00" if absent)
```

In `tls_inspect.go`, all the necessary fields are **already parsed**
(`clientVersion`, `supportedVersions`, `sni`, `alpn`, `cipherSuites`,
`extensions`). JA4 would be an additional ~30 lines after the existing
JA3 block (L.306–329), not a new module.

**Scope boundary:** Stay to JA4 client + existing JA3S server. The wider JA4+
family (JA4H for HTTP headers, JA4L for latency, JA4SSH for SSH) are
out of scope for this project phase — a footnote in the report is sufficient.

### Rec 4 — Document the MD5 choice explicitly

JA3 uses MD5. This is correct and intentional — MD5's known collision
vulnerabilities are only relevant when MD5 is used as a **cryptographic
integrity guarantee**. Here it is used as a **fast fingerprint-matching key**:
we compute an MD5 and look it up in a Redis SET. Collisions in this context are
irrelevant (two different TLS stacks hashing to the same bucket is far less
dangerous than a missed block). This is worth one explicit paragraph in the
final report to pre-empt a panel question about "isn't MD5 broken?"

---

## 8. Implementation Checklist

- [ ] **Wire up the JA3 feed lookup in Tier-2**
  - Pull `ja3_hash` from `TLS-HELLO-001` Detection details
  - Run `SISMEMBER rep:feed:ja3_bad <ja3_hash>` against Redis
  - If match: emit `CatTLSKnownBadFingerprint`, trigger block
  - Confirm `download_all.sh` or feed job populates `rep:feed:ja3_bad` weekly

- [ ] **Add JA3N (quick win)**
  - In `parseClientHello()`, add `sort.Strings(filteredExts)` before building
    `ja3String`
  - Emit `ja3n_hash` alongside `ja3_hash` in `TLS-HELLO-001` Details
  - No feed change needed — JA3N hashes are not yet a separate feed format

- [ ] **Implement JA4 in `tls_inspect.go`**
  - All required fields are already parsed — compute JA4 prefix + hash
    after the existing JA3 block
  - Emit `ja4_hash` in `TLS-HELLO-001` Details
  - Run `SISMEMBER rep:feed:ja4_bad <ja4_hash>` in the Tier-2 lookup
  - Add FoxIO JA4+ database to `download_all.sh` feed ingestion (Feed F11,
    already planned in the implementation plan)

- [ ] **Add MD5 justification paragraph to evaluation chapter**

---

## 9. Quick Reference

| Aspect | Detail |
|---|---|
| **Both do** | Fingerprint a TLS client from the handshake, without decrypting traffic |
| **JA3 weakness** | Order-dependent hash breaks for any client randomising extension order (Chrome 110+) |
| **JA4 fix** | Sorts fields before hashing — permutation no longer changes the output |
| **Why JA3 still works for us** | Our targets (sqlmap, scripts, malware) use static TLS stacks — they do not permute |
| **GREASE stripping** | ✅ Correctly implemented via `isGREASE()` in `tls_inspect.go` L.574–576 |
| **JA3 implementation** | ✅ Live — `tls_inspect.go` L.306–329; emits `TLS-HELLO-001` |
| **JA3S implementation** | ✅ Live — `tls_inspect.go` L.453–455; emits `TLS-SHELLO-001` |
| **JA4 implementation** | ❌ Not yet — all fields already parsed; ~30 lines of new code needed |
| **Feed source** | Abuse.ch JA3 feed → `rep:feed:ja3_bad` Redis SET (Feed F10) |
| **Future feed** | FoxIO JA4+ database (Feed F11, already in implementation plan) |
| **MD5 use** | Fast lookup key, not cryptographic integrity — collision risk is irrelevant here |
