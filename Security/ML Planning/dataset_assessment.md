# Critical Assessment of ML Datasets for Modern IDS/IPS & WAF

A thorough review of the datasets and traffic generation tools specified in the `implementationPlan.md` reveals a highly ambitious and well-rounded foundation for building a Next-Gen IDS/IPS and WAF. 

However, to truly classify as "Next-Gen" and protect against modern web architectures (which are highly distributed, API-heavy, and cloud-native), there are a few notable gaps and areas for improvement.

---

## 1. Critical Weaknesses & "Missing" Datasets

### A. The "Age" Problem of Academic Web Datasets
* **The Issue**: Relying heavily on the **CSIC 2010 HTTP Dataset** for baseline WAF training is problematic. Modern web traffic is dominated by `application/json`, REST APIs, gRPC, and WebSockets.
* **Recommendation**: Treat CSIC 2010 as a supplemental payload source, not a baseline. Augment with modern API traffic datasets and rely heavily on your synthetic generation script (`generate_baseline.py`) updated for JSON and JWTs.

### B. Tool Overfitting & GoTestWAF
* **The Issue**: Training a Web Attack Classifier (Model #2) using only tools like `sqlmap`, `nikto`, and `commix` will likely result in the ML model learning the *behavior of the tool* rather than the *nature of the attack*.
* **Recommendation (GoTestWAF)**: 
  * **What it is**: [Wallarm's GoTestWAF](https://github.com/wallarm/gotestwaf) is an automated tool that generates thousands of highly evasive, modern web payloads (REST, SOAP, XML, JSON, gRPC). 
  * **Why it's useful**: It uses payload mutation to bypass regex-based WAFs. This forces the ML to learn semantic structure, not just raw keywords.
  * **How to run**: `docker run -v ${PWD}/reports:/app/reports wallarm/gotestwaf --url=http://<your-sandbox-ip>`

### C. Emerging Threats: AI / LLM Endpoints
* **The Issue**: Modern apps increasingly proxy requests to LLM APIs (OpenAI, Anthropic). 
* **Recommendation**: Add **Prompt Injection** and **LLM Jailbreak** payloads to your training set (e.g., from [JailbreakChat dataset](https://www.jailbreakchat.com/)).

---

## 2. External Feed Integration (For API Connections)

To make the Next-Gen IDS/IPS highly responsive, we integrate with external Threat Intel feeds. These feeds provide real-time known-bad IPs, hashes, and domains. When you create your APIs and dashboard, these are the integrations you'll need:

### **API-Gated Feeds (Require Registration)**
You must manually register for these, place the API keys in your `.env`, and the backend will fetch them periodically.
1. **AbuseIPDB Blacklist**: 
   - **Source**: [https://www.abuseipdb.com/](https://www.abuseipdb.com/)
   - **Usage**: Provides a confidence score for IPs. IPs with >90% confidence are injected into Redis (`rep:feed:abuseipdb`) for automatic Tier 2 blocking.
2. **MaxMind GeoLite2**: 
   - **Source**: [https://dev.maxmind.com/geoip/geolite2-free-geolocation-data](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data)
   - **Usage**: Provides ASN and Country data for incoming IPs. Highly useful for the Admin Dashboard to visualize attack origins.
3. **AlienVault OTX (Open Threat Exchange)**:
   - **Source**: [https://otx.alienvault.com/](https://otx.alienvault.com/)
   - **Usage**: Provides "pulses" containing malicious IPs, Domains, and Hashes.
4. **PhishTank**:
   - **Source**: [https://www.phishtank.com/developer_info.php](https://www.phishtank.com/developer_info.php)
   - **Usage**: Verified phishing URLs (useful for DNS/SMTP analysis).

### **No-Auth Feeds (Automated Download)**
These are already handled automatically by `download_all.sh` and can be pulled daily by your backend cron jobs:
- **Spamhaus DROP/EDROP**: High-confidence lists of hijacked netblocks.
- **FireHOL Level 1**: Composite blocklist of worst-offender IPs.
- **Abuse.ch JA3 Fingerprints**: TLS fingerprints of known malware/botnets.

---

## 3. Manual Dataset Download Sources

To train the core L3/L4 Flow and L7 Web models, you must download these massive datasets manually (due to academic license walls or form requirements) and place them in `ML/datasets/public_datasets/`:

| Dataset | Purpose | Download Link & Instructions |
|---|---|---|
| **CIC-IDS2017** | L3/L4 Flow Anomaly (Primary) | [Download Here](https://www.unb.ca/cic/datasets/ids-2017.html). Fill out the academic request form to get the download link for the CSV files. |
| **CIC-IDS2018** | L3/L4 Flow Anomaly (Infiltration/Lateral) | [Download Here](https://www.unb.ca/cic/datasets/ids-2018.html). AWS S3 bucket links provided after form submission. |
| **CIC-DDoS2019** | DDoS Patterns | [Download Here](https://www.unb.ca/cic/datasets/ddos-2019.html). Focus on the CSV captures. |
| **CSIC 2010** | Web Attack Payloads (Legacy) | [Download Here](https://www.isi.csic.es/dataset/). Requires an email request. |
| **UNSW-NB15** | Exploits, Fuzzers, Backdoors | [Download Here](https://research.unsw.edu.au/projects/unsw-nb15-dataset). Direct CSV downloads available on their research page. |

Once downloaded, extract them to their respective folders in `ML/datasets/public_datasets/`. The pipeline scripts (`feature_encoder.py` and `train_models.py`) expect them to be there.
