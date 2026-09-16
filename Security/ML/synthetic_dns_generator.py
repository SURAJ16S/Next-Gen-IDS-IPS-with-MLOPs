import json
import random
import os

random.seed(42)

def generate_row(label, family, domain_entropy, label_count, max_label_length, 
                 sld_entropy, digit_ratio, vowel_consonant_ratio, query_length,
                 any_query_flag, uncommon_qtype_ratio_1m, uncommon_qtype_ratio_10m,
                 nxdomain_ratio_10m, unique_subdomain_count, repeatability_factor,
                 avg_response_size_ewma):
    return {
        "_label": label,
        "family": family,
        "domain_entropy": domain_entropy,
        "label_count": label_count,
        "max_label_length": max_label_length,
        "sld_entropy": sld_entropy,
        "digit_ratio": digit_ratio,
        "vowel_consonant_ratio": vowel_consonant_ratio,
        "query_length": query_length,
        "any_query_flag": any_query_flag,
        "uncommon_qtype_ratio_1m": uncommon_qtype_ratio_1m,
        "uncommon_qtype_ratio_10m": uncommon_qtype_ratio_10m,
        "nxdomain_ratio_10m": nxdomain_ratio_10m,
        "unique_subdomain_count": unique_subdomain_count,
        "repeatability_factor": repeatability_factor,
        "avg_response_size_ewma": avg_response_size_ewma,
    }

def generate_benign():
    rows = []
    # Regular web traffic (low entropy, low ratios)
    for _ in range(300):
        rows.append(generate_row("benign", "benign-web",
            random.uniform(2.0, 3.2), random.randint(2, 4), random.uniform(5, 15),
            random.uniform(2.0, 3.2), random.uniform(0, 0.1), random.uniform(0.3, 0.8),
            random.uniform(10, 25), 0.0, random.uniform(0, 0.05), random.uniform(0, 0.05),
            random.uniform(0, 0.05), random.randint(1, 10), random.uniform(0.01, 0.1),
            random.uniform(50, 150)
        ))
    # CDN / Cloud Storage (high unique subdomain count, but low entropy)
    for _ in range(150):
        rows.append(generate_row("benign", "benign-cdn",
            random.uniform(2.5, 3.5), random.randint(3, 5), random.uniform(10, 25),
            random.uniform(2.0, 3.0), random.uniform(0.1, 0.3), random.uniform(0.2, 0.6),
            random.uniform(20, 45), 0.0, random.uniform(0, 0.1), random.uniform(0, 0.1),
            random.uniform(0.01, 0.1), random.randint(50, 500), random.uniform(0.5, 0.9),
            random.uniform(60, 200)
        ))
    # Dynamic DNS / Home IoT (low volume, occasional strange SLD)
    for _ in range(150):
        rows.append(generate_row("benign", "benign-iot",
            random.uniform(3.0, 4.0), random.randint(3, 4), random.uniform(10, 20),
            random.uniform(3.0, 4.0), random.uniform(0.2, 0.5), random.uniform(0.1, 0.5),
            random.uniform(15, 30), 0.0, random.uniform(0, 0.05), random.uniform(0, 0.05),
            random.uniform(0, 0.05), random.randint(1, 5), random.uniform(0.01, 0.2),
            random.uniform(40, 100)
        ))
    return rows

def generate_tunnel():
    rows = []
    # iodine style: high entropy, base32/64 encoded near 63 bytes max, NULL/TXT types
    for _ in range(250):
        rows.append(generate_row("tunnel", "tunnel-iodine",
            random.uniform(4.5, 5.5), random.randint(4, 7), random.uniform(50, 63),
            random.uniform(2.5, 3.5), random.uniform(0.2, 0.4), random.uniform(0.1, 0.3),
            random.uniform(150, 250), 0.0, random.uniform(0.8, 1.0), random.uniform(0.5, 0.8),
            random.uniform(0, 0.1), random.randint(100, 1000), random.uniform(0.8, 1.0),
            random.uniform(300, 500)
        ))
    # dnscat2 style: slightly smaller labels, CNAME/TXT heavy, bursty 1-min EWMA
    for _ in range(200):
        rows.append(generate_row("tunnel", "tunnel-dnscat2",
            random.uniform(4.2, 5.0), random.randint(3, 6), random.uniform(40, 60),
            random.uniform(2.5, 3.5), random.uniform(0.1, 0.3), random.uniform(0.1, 0.3),
            random.uniform(100, 200), 0.0, random.uniform(0.7, 1.0), random.uniform(0.3, 0.6),
            random.uniform(0, 0.1), random.randint(50, 500), random.uniform(0.7, 0.95),
            random.uniform(250, 450)
        ))
    return rows

def generate_dga():
    rows = []
    # Random-string DGA (Bambenek-style) - high SLD entropy, many digits, often NXDOMAINs
    for _ in range(250):
        rows.append(generate_row("dga", "dga-random",
            random.uniform(3.8, 4.8), random.randint(2, 3), random.uniform(15, 30),
            random.uniform(3.5, 4.5), random.uniform(0.4, 0.7), random.uniform(0.05, 0.2),
            random.uniform(15, 35), 0.0, random.uniform(0, 0.1), random.uniform(0, 0.1),
            random.uniform(0.3, 0.9), random.randint(20, 200), random.uniform(0.1, 0.4),
            random.uniform(40, 90)
        ))
    # Dictionary DGA (Matsnu/Suppobox-style) - concatenated words, low entropy, high vowel/consonant ratio
    for _ in range(200):
        rows.append(generate_row("dga", "dga-dict",
            random.uniform(2.5, 3.5), random.randint(2, 3), random.uniform(10, 25),
            random.uniform(2.2, 3.2), random.uniform(0, 0.05), random.uniform(0.4, 1.2),
            random.uniform(12, 30), 0.0, random.uniform(0, 0.1), random.uniform(0, 0.1),
            random.uniform(0.4, 0.9), random.randint(20, 150), random.uniform(0.1, 0.5),
            random.uniform(40, 90)
        ))
    return rows

def main():
    rows = []
    rows.extend(generate_benign())
    rows.extend(generate_tunnel())
    rows.extend(generate_dga())
    
    random.shuffle(rows)
    
    out_dir = "logs"
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "dns_labeled.jsonl")
    
    with open(out_path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
            
    print(f"Generated {len(rows)} samples in {out_path}")

if __name__ == "__main__":
    main()
