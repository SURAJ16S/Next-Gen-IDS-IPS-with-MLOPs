# Comprehensive Threat Coverage Matrix

Here is the complete list of all attacks and vulnerabilities the NGFW IDS/IPS defends against, categorized by protocol. 

## 1. Web Application & API (HTTP/HTTPS)
*   **Injections:** SQL Injection (SQLi), NoSQL Injection, Command Injection (RCE), LDAP Injection, XPath Injection, Server-Side Template Injection (SSTI), Host-Header Injection, CRLF Injection.
*   **File & Directory:** Path/Directory Traversal, Local File Inclusion (LFI), Remote File Inclusion (RFI), Malicious File Upload (webshells, oversized).
*   **Cross-Site Attacks:** Cross-Site Scripting (XSS), Cross-Site Request Forgery (CSRF).
*   **API & Authorization:** Broken Object-Level Authorization (BOLA), Broken Function-Level Authorization (BFLA), Mass Assignment, API Resource Abuse (unbounded pagination).
*   **Authentication & JWT:** JWT `alg:none` bypass, JWT Algorithm Confusion, Expired JWT acceptance.
*   **Exploits & Logic Flaws:** Log4Shell (`${jndi:}`), XML External Entity (XXE) / Billion Laughs, Insecure Deserialization (ysoserial, pickle), Server-Side Request Forgery (SSRF), HTTP Request Smuggling, Open Redirect, GraphQL Abuse, WebSocket Hijacking.
*   **Recon & Scanners:** Bot/Scanner traffic, Directory/Endpoint Brute-Force.
*   **Information Leakage:** Credential Leaks, Information Leakage (stack traces, debug pages), Missing Security Headers, Clickjacking.
*   **Denial of Service:** Slowloris / Slow-POST, Volumetric DDoS (HTTP flood).

## 2. Secure Shell (SSH)
*   SSH Brute-Force Login
*   Weak/Legacy Key-Exchange Algorithms
*   SSH Tunneling / Port-Forwarding Abuse
*   Malformed SSH Packets
*   Banner/Version Scanning
*   Known-Malicious Client Fingerprints (HASSH)
*   CVE-based Exploitation (e.g., OpenSSH regreSSHion)

## 3. Domain Name System (DNS)
*   DNS Tunneling (Data exfiltration)
*   DGA (Domain Generation Algorithm) Botnet Domains
*   DNS Rebinding
*   Unauthorized Zone Transfers (AXFR)
*   NXDOMAIN Floods (DoS)
*   DNS Amplification (Reflection DoS)
*   DNS Cache Poisoning / Spoofing

## 4. File Transfer Protocol (FTP)
*   Anonymous Login Abuse
*   FTP Bounce Attack (Port scanning)
*   Data-Channel Abuse (Exfiltration)
*   Brute-Force Login
*   Cleartext Credential Exposure

## 5. Telnet
*   IoT Default-Credential Login (Mirai-style)
*   Banner Scanning / Reconnaissance
*   Credential Stuffing
*   Password Spraying
*   Cleartext Session Hijacking

## 6. Email (SMTP)
*   Open Relay Abuse
*   Spam Origination
*   Phishing Content
*   STARTTLS Stripping / Downgrade

## 7. Databases (MySQL, PostgreSQL, Redis, MongoDB)
*   Dangerous Administrative Commands (`DROP`, `FLUSHALL`)
*   Unauthenticated Access Attempts
*   Direct SQLi bypassing the app layer

## 8. Transport Layer Security (TLS)
*   Weak Cipher Suites
*   Protocol Downgrades (SSLv3, TLS 1.0)
*   SNI / Certificate Mismatches
*   Expired Certificates
*   Self-Signed Certificates
*   Malicious TLS Clients (JA3 / JA4 Fingerprinting)

## 9. Generic & Fallback (RDP, VNC, SNMP, UDP)
*   Known Exploit Traffic Signatures (Nuclei/Snort)
*   RDP Brute-Force & BlueKeep-class exploits
*   NTP/SNMP Amplification Abuse
*   SNMP Default Community Strings (`public`/`private`)

## 10. Cross-Protocol & Behavioral (Network-Wide)
*   Port Scanning (SYN, FIN, Xmas)
*   Cross-Protocol Brute-Force Rates
*   Beaconing (C2 check-ins)
*   Command-and-Control (C2) Traffic
*   Generic Tunneling (Protocol-in-protocol)
*   Lateral Movement
*   Protocol/Port Mismatch (e.g., SSH running on port 80)
*   Time-Based Access Anomalies
*   Data Exfiltration (Abnormal outbound volume)
*   Known-Bad IP Reputation (AbuseIPDB, Spamhaus, Tor exits)
