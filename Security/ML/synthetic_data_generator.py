import json
import random
import time
import os

def generate_benign(ip, is_scp=False):
    # Benign interactive or SCP
    return {
        "conn_id": f"conn_{random.randint(1000, 9999)}",
        "src_ip": ip,
        "flow_duration_ms": random.uniform(5000, 60000),
        "fwd_pkts": random.randint(50, 500),
        "bwd_pkts": random.randint(50, 500),
        "fwd_bytes": random.randint(2000, 50000),
        "bwd_bytes": random.randint(2000, 50000) if not is_scp else random.randint(1000000, 5000000),
        "fwd_pkt_len_mean": random.uniform(40, 100),
        "fwd_pkt_len_std": random.uniform(10, 30),
        "bwd_pkt_len_mean": random.uniform(40, 100) if not is_scp else random.uniform(1000, 1400),
        "bwd_pkt_len_std": random.uniform(10, 30),
        "fwd_iat_mean": random.uniform(100, 500),
        "fwd_iat_std": random.uniform(50, 200),
        "bwd_iat_mean": random.uniform(100, 500),
        "bwd_iat_std": random.uniform(50, 200),
        "fwd_bwd_byte_ratio": random.uniform(0.5, 2.0) if not is_scp else random.uniform(0.01, 0.05),
        "fwd_bwd_pkt_ratio": random.uniform(0.8, 1.2),
        "hassh_known_bad": False,
        "weak_algo_flag": False,
        "banner_scan_flag": False,
        "tcp_to_banner_ms": random.uniform(10, 50),
        "banner_to_kex_ms": random.uniform(20, 100),
        "kex_to_newkeys_ms": random.uniform(50, 200),
        "total_duration_ms": random.uniform(5000, 60000),
        "pkts_before_newkeys": random.randint(10, 15),
        "bytes_before_newkeys": random.randint(1000, 1500),
        "client_software_cat": "standard",
        "dst_failed_sessions_10min": random.randint(0, 2),
        "label": "benign"
    }

def generate_brute(ip, with_jitter=False, stealth=False):
    # Hydra brute force
    return {
        "conn_id": f"conn_{random.randint(1000, 9999)}",
        "src_ip": ip,
        "flow_duration_ms": random.uniform(100, 500) if not with_jitter else random.uniform(100, 2000),
        "fwd_pkts": random.randint(12, 18),
        "bwd_pkts": random.randint(10, 16),
        "fwd_bytes": random.randint(1200, 1800),
        "bwd_bytes": random.randint(1000, 1600),
        "fwd_pkt_len_mean": random.uniform(60, 80),
        "fwd_pkt_len_std": random.uniform(5, 15),
        "bwd_pkt_len_mean": random.uniform(60, 80),
        "bwd_pkt_len_std": random.uniform(5, 15),
        "fwd_iat_mean": random.uniform(10, 30) if not with_jitter else random.uniform(10, 150),
        "fwd_iat_std": random.uniform(2, 5) if not with_jitter else random.uniform(10, 50),
        "bwd_iat_mean": random.uniform(10, 30),
        "bwd_iat_std": random.uniform(2, 5),
        "fwd_bwd_byte_ratio": random.uniform(1.0, 1.2),
        "fwd_bwd_pkt_ratio": random.uniform(1.0, 1.2),
        "hassh_known_bad": not stealth, # rule evasion!
        "weak_algo_flag": not stealth,
        "banner_scan_flag": False,
        "tcp_to_banner_ms": random.uniform(5, 20),
        "banner_to_kex_ms": random.uniform(10, 30),
        "kex_to_newkeys_ms": random.uniform(20, 50),
        "total_duration_ms": random.uniform(100, 500),
        "pkts_before_newkeys": random.randint(12, 15),
        "bytes_before_newkeys": random.randint(1200, 1500),
        "client_software_cat": "scanner" if not stealth else "standard",
        "dst_failed_sessions_10min": random.randint(10, 100),
        "label": "brute_force"
    }

records = []
# Benign IPs
for _ in range(500):
    records.append(generate_benign("10.0.0.5", is_scp=random.random() < 0.2))

# Brute IPs
for _ in range(500):
    # 30% jittered, 20% stealth (avoids rules)
    records.append(generate_brute("192.168.1.100", with_jitter=random.random() < 0.3, stealth=random.random() < 0.2))

# Shuffle and write
random.shuffle(records)
os.makedirs("../logs", exist_ok=True)
with open("ssh_features.jsonl", "w") as f:
    for r in records:
        f.write(json.dumps(r) + "\n")

print("Generated 1000 synthetic SSH sessions into ssh_features.jsonl")
