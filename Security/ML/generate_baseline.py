import json
import random
import os
from pathlib import Path
import datetime
import uuid

def generate_http_baseline(num_records=1000):
    records = []
    for _ in range(num_records):
        # Realistic benign HTTP stats
        req = {
            "method": random.choice(["GET", "POST", "GET", "GET"]),
            "uri_length": int(random.normalvariate(25, 10)),
            "query_param_count": random.randint(0, 3) if random.random() > 0.5 else 0,
            "content_length": int(random.normalvariate(500, 200)) if random.random() > 0.7 else 0,
            "header_count": int(random.normalvariate(12, 3)),
            "header_size": int(random.normalvariate(800, 200)),
            "duplicate_headers": 0,
            "cookie_count": random.randint(1, 4) if random.random() > 0.3 else 0,
            "jwt_present": random.choice([True, False, False]),
            "auth_present": random.choice([True, False, False]),
        }
        uri = {
            "entropy": random.uniform(2.0, 3.8),
            "digit_ratio": random.uniform(0.0, 0.15),
            "special_char_ratio": random.uniform(0.0, 0.08),
            "sql_keyword_count": 0,
            "xss_pattern_count": 0,
            "path_traversal_count": 0,
            "cmd_injection_count": 0,
            "base64_count": 0,
            "hex_count": 0,
        }
        body = {
            "entropy": random.uniform(0.0, 4.5) if req["content_length"] > 0 else 0.0,
            "sql_keyword_count": 0,
            "xss_pattern_count": 0,
            "token_count": int(random.normalvariate(50, 20)) if req["content_length"] > 0 else 0,
            "avg_token_length": random.uniform(3.0, 8.0) if req["content_length"] > 0 else 0.0,
        }
        ua = {
            "entropy": random.uniform(3.0, 4.2),
            "special_char_ratio": random.uniform(0.05, 0.15),
        }
        
        req["uri_length"] = max(1, req["uri_length"])
        req["content_length"] = max(0, req["content_length"])
        
        records.append({
            "request": req,
            "payload_stats": {
                "uri": uri,
                "body": body,
                "user_agent": ua
            }
        })
    return records

def generate_flow_baseline(num_records=1000):
    records = []
    for _ in range(num_records):
        # Realistic benign TCP flow stats (e.g., standard web browsing)
        records.append({
            "total_fwd_packets": int(random.normalvariate(10, 5)),
            "total_bwd_packets": int(random.normalvariate(12, 6)),
            "total_fwd_bytes": int(random.normalvariate(1500, 500)),
            "total_bwd_bytes": int(random.normalvariate(8000, 3000)),
            "fwd_pkt_len_max": int(random.normalvariate(500, 100)),
            "fwd_pkt_len_min": 0,
            "fwd_pkt_len_mean": random.uniform(50, 150),
            "fwd_pkt_len_std": random.uniform(10, 50),
            "bwd_pkt_len_max": int(random.normalvariate(1400, 100)),
            "bwd_pkt_len_min": 0,
            "bwd_pkt_len_mean": random.uniform(200, 800),
            "bwd_pkt_len_std": random.uniform(50, 300),
            "syn_count": 1,
            "ack_count": int(random.normalvariate(20, 10)),
            "fin_count": 1,
            "rst_count": 0,
            "psh_count": random.randint(2, 10),
            "urg_count": 0,
            "flow_pkts_per_sec": random.uniform(10, 500),
            "flow_bytes_per_sec": random.uniform(1000, 50000),
            "fwd_iat_mean": random.uniform(1, 50),
            "fwd_iat_std": random.uniform(1, 20),
            "fwd_iat_max": random.uniform(10, 100),
            "fwd_iat_min": random.uniform(0, 1),
            "bwd_iat_mean": random.uniform(1, 50),
            "bwd_iat_std": random.uniform(1, 20),
            "bwd_iat_max": random.uniform(10, 100),
            "bwd_iat_min": random.uniform(0, 1),
            "active_mean": random.uniform(10, 1000),
            "active_std": random.uniform(0, 100),
            "active_max": random.uniform(50, 1200),
            "active_min": random.uniform(1, 10),
            "idle_mean": random.uniform(0, 500),
            "idle_std": random.uniform(0, 100),
            "idle_max": random.uniform(0, 800),
            "idle_min": random.uniform(0, 10),
        })
    return records

def write_jsonl(records, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")

def generate_http_labeled(num_records=2000):
    records = []
    labels = ["benign", "sqli", "xss", "path_traversal", "cmd_injection"]
    for _ in range(num_records):
        label = random.choice(labels)
        req = {
            "method": "POST" if label != "benign" else random.choice(["GET", "POST"]),
            "uri_length": int(random.normalvariate(25, 10)),
            "query_param_count": random.randint(1, 5) if label != "benign" else random.randint(0, 3),
            "content_length": int(random.normalvariate(500, 200)),
            "header_count": int(random.normalvariate(12, 3)),
            "header_size": int(random.normalvariate(800, 200)),
            "duplicate_headers": 0,
            "cookie_count": random.randint(1, 4),
            "jwt_present": True,
            "auth_present": True,
        }
        uri = {
            "entropy": random.uniform(3.5, 5.0) if label != "benign" else random.uniform(2.0, 3.8),
            "digit_ratio": random.uniform(0.1, 0.3) if label != "benign" else random.uniform(0.0, 0.15),
            "special_char_ratio": random.uniform(0.1, 0.3) if label != "benign" else random.uniform(0.0, 0.08),
            "sql_keyword_count": random.randint(1, 5) if label == "sqli" else 0,
            "xss_pattern_count": random.randint(1, 5) if label == "xss" else 0,
            "path_traversal_count": random.randint(1, 5) if label == "path_traversal" else 0,
            "cmd_injection_count": random.randint(1, 5) if label == "cmd_injection" else 0,
            "base64_count": 0,
            "hex_count": 0,
        }
        body = {
            "entropy": random.uniform(3.5, 6.0) if label != "benign" else random.uniform(0.0, 4.5),
            "sql_keyword_count": random.randint(1, 5) if label == "sqli" else 0,
            "xss_pattern_count": random.randint(1, 5) if label == "xss" else 0,
            "token_count": int(random.normalvariate(50, 20)),
            "avg_token_length": random.uniform(3.0, 8.0),
        }
        ua = {
            "entropy": random.uniform(3.0, 4.2),
            "special_char_ratio": random.uniform(0.05, 0.15),
        }
        records.append({
            "label": label,
            "request": req,
            "payload_stats": {"uri": uri, "body": body, "user_agent": ua}
        })
    return records

def generate_ssh_labeled(num_records=2000):
    records = []
    labels = ["benign", "brute_force", "cred_stuff", "pwd_spray", "bot"]
    for _ in range(num_records):
        label = random.choice(labels)
        is_attack = label != "benign"
        records.append({
            "label": label,
            "failed_login_count_10min": random.randint(10, 100) if is_attack else random.randint(0, 3),
            "conn_count_10min": random.randint(20, 200) if is_attack else random.randint(1, 5),
            "distinct_ports_touched": random.randint(2, 10) if is_attack else 1,
            "avg_session_duration_ms": random.uniform(10, 1000) if is_attack else random.uniform(5000, 600000),
            "rapid_teardown_ratio": random.uniform(0.8, 1.0) if is_attack else random.uniform(0.0, 0.2),
            "hassh_seen_before": 1 if label == "bot" else 0,
            "hassh_known_bad": 1 if label == "bot" else 0,
            "banner_scan_flag": 1 if label in ["pwd_spray", "bot"] else 0,
            "weak_algo_flag": 1 if random.random() > 0.5 and is_attack else 0,
            "iat_std_ms": random.uniform(0, 5) if is_attack else random.uniform(100, 1000),
        })
    return records

def generate_dns_labeled(num_records=2000):
    records = []
    labels = ["benign", "tunnel", "dga", "amplification"]
    for _ in range(num_records):
        label = random.choice(labels)
        records.append({
            "label": label,
            "domain_entropy": random.uniform(4.5, 6.5) if label in ["tunnel", "dga"] else random.uniform(2.0, 3.8),
            "label_count": random.randint(4, 10) if label == "tunnel" else random.randint(2, 4),
            "sld_entropy": random.uniform(4.0, 6.0) if label == "dga" else random.uniform(2.0, 3.5),
            "query_length": random.randint(50, 255) if label == "tunnel" else random.randint(10, 40),
            "txt_query_ratio": random.uniform(0.8, 1.0) if label == "tunnel" else random.uniform(0.0, 0.1),
            "nxdomain_ratio_10min": random.uniform(0.7, 1.0) if label == "dga" else random.uniform(0.0, 0.05),
            "unique_subdomain_count_10min": random.randint(50, 500) if label == "tunnel" else random.randint(1, 10),
            "avg_response_size": random.randint(1000, 4096) if label == "amplification" else random.randint(50, 200),
            "query_rate_10min": random.randint(100, 1000) if label == "amplification" else random.randint(1, 20),
            "any_query_flag": 1 if label == "amplification" else 0,
        })
    return records

if __name__ == "__main__":
    logs_dir = Path(__file__).parent.parent / "logs" / "protocols"
    print(f"Generating synthetic baseline & labeled datasets in {logs_dir}...")
    
    http_records = generate_http_baseline(1500)
    write_jsonl(http_records, logs_dir / "http.jsonl")
    print(f" - Wrote {len(http_records)} records to {logs_dir / 'http.jsonl'}")
    
    flow_records = generate_flow_baseline(1500)
    write_jsonl(flow_records, logs_dir / "flow.jsonl")
    print(f" - Wrote {len(flow_records)} records to {logs_dir / 'flow.jsonl'}")

    http_labeled = generate_http_labeled(2000)
    write_jsonl(http_labeled, logs_dir / "http_labeled.jsonl")
    print(f" - Wrote {len(http_labeled)} records to {logs_dir / 'http_labeled.jsonl'}")

    ssh_labeled = generate_ssh_labeled(2000)
    write_jsonl(ssh_labeled, logs_dir / "ssh_labeled.jsonl")
    print(f" - Wrote {len(ssh_labeled)} records to {logs_dir / 'ssh_labeled.jsonl'}")

    dns_labeled = generate_dns_labeled(2000)
    write_jsonl(dns_labeled, logs_dir / "dns_labeled.jsonl")
    print(f" - Wrote {len(dns_labeled)} records to {logs_dir / 'dns_labeled.jsonl'}")
    
    print("Generation complete.")
