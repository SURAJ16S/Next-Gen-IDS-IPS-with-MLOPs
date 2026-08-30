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

if __name__ == "__main__":
    logs_dir = Path(__file__).parent.parent / "logs" / "protocols"
    print(f"Generating synthetic baseline in {logs_dir}...")
    
    http_records = generate_http_baseline(1500)
    write_jsonl(http_records, logs_dir / "http.jsonl")
    print(f" - Wrote {len(http_records)} records to {logs_dir / 'http.jsonl'}")
    
    flow_records = generate_flow_baseline(1500)
    write_jsonl(flow_records, logs_dir / "flow.jsonl")
    print(f" - Wrote {len(flow_records)} records to {logs_dir / 'flow.jsonl'}")
    
    print("Generation complete.")
