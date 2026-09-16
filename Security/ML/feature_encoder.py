"""
feature_encoder.py
-------------------
Turns the JSONL logs your Go collector already writes (PayloadStats for HTTP,
FlowRecord for L4 flows) into flat, numeric pandas DataFrames the models can
train/predict on.

This file intentionally does NOT do any modeling — it only knows how to go
from "one JSON object per line" to "one row per DataFrame, numeric columns
only, no NaNs left behind." Keep it that way: one job per file.

Usage:
    from feature_encoder import load_http_payload_features, load_flow_features

    df = load_http_payload_features("logs/protocols/http.jsonl")
    X = df[HTTP_FEATURE_COLUMNS]          # numeric matrix, ready for sklearn
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Column lists — keep these in one place so training and serving never drift
# apart from each other (a very common, very silent source of bugs: training
# on 16 columns and then scoring on 15 because someone renamed a field).
# ---------------------------------------------------------------------------

HTTP_FEATURE_COLUMNS = [
    # from PayloadStats (uri / body / user_agent — flattened with a prefix)
    "uri_entropy", "uri_digit_ratio", "uri_special_char_ratio",
    "uri_sql_keyword_count", "uri_xss_pattern_count", "uri_path_traversal_count",
    "uri_cmd_injection_count", "uri_base64_count", "uri_hex_count",
    "body_entropy", "body_sql_keyword_count", "body_xss_pattern_count",
    "body_token_count", "body_avg_token_length",
    "ua_entropy", "ua_special_char_ratio",
    # from request metadata (HTTP-FEAT-001 in your data-collection inventory)
    "uri_length", "query_param_count", "content_length", "header_count",
    "header_size", "duplicate_headers", "cookie_count",
]

FLOW_FEATURE_COLUMNS = [
    "total_fwd_packets", "total_bwd_packets", "total_fwd_bytes", "total_bwd_bytes",
    "fwd_pkt_len_max", "fwd_pkt_len_min", "fwd_pkt_len_mean", "fwd_pkt_len_std",
    "bwd_pkt_len_max", "bwd_pkt_len_min", "bwd_pkt_len_mean", "bwd_pkt_len_std",
    "syn_count", "ack_count", "fin_count", "rst_count", "psh_count", "urg_count",
    "flow_pkts_per_sec", "flow_bytes_per_sec",
    "fwd_iat_mean", "fwd_iat_std", "fwd_iat_max", "fwd_iat_min",
    "bwd_iat_mean", "bwd_iat_std", "bwd_iat_max", "bwd_iat_min",
    "active_mean", "active_std", "active_max", "active_min",
    "idle_mean", "idle_std", "idle_max", "idle_min",
]

# --- Model #4: SSH/FTP/Telnet brute-force & bot classifier -----------------
# See 01_Protocol_Threat_Matrix_ML_Integration_and_Training_Data_Sources.md
# section 2.1/2.4/2.9 for the threats this feeds (CatSSHBruteForce,
# CatCredStuff, CatPwdSpray, CatTelnetIoT). Most of these numbers are the
# per-IP rolling counters already defined in the master plan's Redis schema
# (roll:conn:{ip}, roll:failedlogin:{ip}) plus a couple of SSH-specific flags.
SSH_FEATURE_COLUMNS = [
    # --- L4 Features ---
    "flow_duration_ms",
    "fwd_pkts", "bwd_pkts", "fwd_bytes", "bwd_bytes",
    "fwd_pkt_len_mean", "fwd_pkt_len_std",
    "bwd_pkt_len_mean", "bwd_pkt_len_std",
    "fwd_iat_mean", "fwd_iat_std",
    "bwd_iat_mean", "bwd_iat_std",
    # --- Derived Ratios ---
    "fwd_bwd_byte_ratio", "fwd_bwd_pkt_ratio",
    # --- L7 SSH Features ---
    "hassh_known_bad", "weak_algo_flag", "banner_scan_flag",
    "tcp_to_banner_ms", "banner_to_kex_ms", "kex_to_newkeys_ms",
    "total_duration_ms", "pkts_before_newkeys", "bytes_before_newkeys",
    "client_software_cat", # Mapped to int (0=standard, 1=auto, 2=scanner, 3=unknown)
    # --- Behavioral Aggregates ---
    "dst_failed_sessions_10min",
]

# --- Model #5: DNS tunneling / DGA detector ---------------------------------
# See threat matrix section 2.2 (CatDNSTunnel, CatDGA, CatNXDomainFlood).
# domain_entropy / label_count are already flagged as needed fields in the
# Protocol Data Collection Inventory doc section 12.7 — this is the numeric
# contract those fields must satisfy once implemented.
DNS_FEATURE_COLUMNS = [
    "domain_entropy",             # shannonEntropy() already implemented in dns_analyzer.go — reuse, don't reimplement
    "label_count",                # number of dot-separated labels
    "sld_entropy",                # entropy of the second-level domain specifically (dga's usual target)
    "query_length",
    "txt_query_ratio",            # fraction of queries in this window that were TXT/NULL (tunneling signal)
    "nxdomain_ratio_10min",       # fraction of queries from this IP resolving NXDOMAIN in last 10 min
    "unique_subdomain_count_10min",
    "avg_response_size",
    "query_rate_10min",
    "any_query_flag",             # 0/1 — ANY query type used (amplification signal, synopsis section 8)
]


def _read_jsonl(path: str | Path) -> Iterable[dict]:
    path = Path(path)
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                # one bad line should never kill an entire training run
                continue


def _flatten_http_record(rec: dict) -> dict:
    """Flatten one merged HTTP log record (see the sample template in
    Protocol-Data-Collection-Inventory-and-Templates.md, section 1) into a
    single flat dict matching HTTP_FEATURE_COLUMNS."""
    req = rec.get("request", {}) or {}
    ps = rec.get("payload_stats", {}) or {}
    uri = ps.get("uri", {}) or {}
    body = ps.get("body", {}) or {}
    ua = ps.get("user_agent", {}) or {}

    return {
        "uri_entropy": uri.get("entropy", 0.0),
        "uri_digit_ratio": uri.get("digit_ratio", 0.0),
        "uri_special_char_ratio": uri.get("special_char_ratio", 0.0),
        "uri_sql_keyword_count": uri.get("sql_keyword_count", 0),
        "uri_xss_pattern_count": uri.get("xss_pattern_count", 0),
        "uri_path_traversal_count": uri.get("path_traversal_count", 0),
        "uri_cmd_injection_count": uri.get("cmd_injection_count", 0),
        "uri_base64_count": uri.get("base64_count", 0),
        "uri_hex_count": uri.get("hex_count", 0),
        "body_entropy": body.get("entropy", 0.0),
        "body_sql_keyword_count": body.get("sql_keyword_count", 0),
        "body_xss_pattern_count": body.get("xss_pattern_count", 0),
        "body_token_count": body.get("token_count", 0),
        "body_avg_token_length": body.get("avg_token_length", 0.0),
        "ua_entropy": ua.get("entropy", 0.0),
        "ua_special_char_ratio": ua.get("special_char_ratio", 0.0),
        "uri_length": req.get("uri_length", 0),
        "query_param_count": req.get("query_param_count", 0),
        "content_length": req.get("content_length", 0),
        "header_count": req.get("header_count", 0),
        "header_size": req.get("header_size", 0),
        "duplicate_headers": req.get("duplicate_headers", 0),
        "cookie_count": req.get("cookie_count", 0),
        # passthrough metadata, useful for joins/labeling but NOT fed to the model
        "_conn_id": rec.get("conn_id"),
        "_source_ip": rec.get("source_ip"),
        "_label": rec.get("label"),  # populated only for self-generated labeled batches
    }


def _flatten_flow_record(rec: dict) -> dict:
    """Flatten one FlowRecord (flow_stats.jsonl) into FLOW_FEATURE_COLUMNS."""
    out = {col: rec.get(col, 0.0) for col in FLOW_FEATURE_COLUMNS}
    out["_flow_id"] = rec.get("flow_id")
    out["_src_ip"] = rec.get("src_ip")
    out["_label"] = rec.get("label")
    return out


def _flatten_ssh_record(rec: dict) -> dict:
    """Flatten one SSH session summary record into SSH_FEATURE_COLUMNS.
    Expected upstream shape (Go side, once emitted alongside the existing
    Detection events): one JSON object per closed SSH session, with the
    rolling-counter fields pulled from Redis DB 1 at session-close time."""
    out = {col: float(rec.get(col, 0.0)) for col in SSH_FEATURE_COLUMNS if col != "client_software_cat"}
    
    # Handle boolean flags explicitly to ensure they are 0.0/1.0
    for flag in ["hassh_known_bad", "weak_algo_flag", "banner_scan_flag"]:
        out[flag] = 1.0 if rec.get(flag) else 0.0
    
    # Handle categorical client_software_cat
    cat_str = str(rec.get("client_software_cat", "unknown")).lower()
    if cat_str == "standard":
        out["client_software_cat"] = 0.0
    elif cat_str == "auto":
        out["client_software_cat"] = 1.0
    elif cat_str == "scanner":
        out["client_software_cat"] = 2.0
    else:
        out["client_software_cat"] = 3.0

    out["_conn_id"] = rec.get("conn_id")
    out["_source_ip"] = rec.get("src_ip")
    out["_label"] = rec.get("label")  # "benign" | "brute_force" | "cred_stuff" | "pwd_spray" | "bot"
    return out


def _flatten_dns_record(rec: dict) -> dict:
    """Flatten one DNS query/window record into DNS_FEATURE_COLUMNS."""
    out = {col: rec.get(col, 0.0) for col in DNS_FEATURE_COLUMNS}
    out["_conn_id"] = rec.get("conn_id")
    out["_source_ip"] = rec.get("source_ip")
    out["_label"] = rec.get("label")  # "benign" | "tunnel" | "dga" | "amplification"
    return out


def load_ssh_features(jsonl_path: str | Path) -> pd.DataFrame:
    rows = [_flatten_ssh_record(r) for r in _read_jsonl(jsonl_path)]
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df[SSH_FEATURE_COLUMNS] = df[SSH_FEATURE_COLUMNS].apply(
        pd.to_numeric, errors="coerce"
    ).fillna(0.0)
    return df


def load_dns_features(jsonl_path: str | Path) -> pd.DataFrame:
    rows = [_flatten_dns_record(r) for r in _read_jsonl(jsonl_path)]
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df[DNS_FEATURE_COLUMNS] = df[DNS_FEATURE_COLUMNS].apply(
        pd.to_numeric, errors="coerce"
    ).fillna(0.0)
    return df


def encode_single_ssh(ssh_record_obj: dict) -> np.ndarray:
    flat = _flatten_ssh_record(ssh_record_obj)
    return np.array([[flat[c] for c in SSH_FEATURE_COLUMNS]], dtype=float)


def encode_single_dns(dns_record_obj: dict) -> np.ndarray:
    flat = _flatten_dns_record(dns_record_obj)
    return np.array([[flat[c] for c in DNS_FEATURE_COLUMNS]], dtype=float)


def load_http_payload_features(jsonl_path: str | Path) -> pd.DataFrame:
    rows = [_flatten_http_record(r) for r in _read_jsonl(jsonl_path)]
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df[HTTP_FEATURE_COLUMNS] = df[HTTP_FEATURE_COLUMNS].apply(
        pd.to_numeric, errors="coerce"
    ).fillna(0.0)
    return df


def load_flow_features(jsonl_path: str | Path) -> pd.DataFrame:
    rows = [_flatten_flow_record(r) for r in _read_jsonl(jsonl_path)]
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df[FLOW_FEATURE_COLUMNS] = df[FLOW_FEATURE_COLUMNS].apply(
        pd.to_numeric, errors="coerce"
    ).fillna(0.0)
    return df


def encode_single_http_payload(payload_stats_obj: dict, request_meta: dict) -> np.ndarray:
    """Used at INFERENCE time (one live request, not a training batch).
    Must produce columns in the exact same order as HTTP_FEATURE_COLUMNS."""
    rec = {"payload_stats": payload_stats_obj, "request": request_meta}
    flat = _flatten_http_record(rec)
    return np.array([[flat[c] for c in HTTP_FEATURE_COLUMNS]], dtype=float)


def encode_single_flow(flow_record_obj: dict) -> np.ndarray:
    flat = _flatten_flow_record(flow_record_obj)
    return np.array([[flat[c] for c in FLOW_FEATURE_COLUMNS]], dtype=float)


if __name__ == "__main__":
    # quick smoke test with a synthetic record, so `python feature_encoder.py`
    # gives you an immediate sanity check without needing real logs yet
    sample = {
        "conn_id": "test1",
        "source_ip": "203.0.113.10",
        "request": {"uri_length": 6, "query_param_count": 0, "content_length": 32,
                     "header_count": 9, "header_size": 412, "duplicate_headers": 0,
                     "cookie_count": 2},
        "payload_stats": {
            "uri": {"entropy": 3.1, "digit_ratio": 0.0, "special_char_ratio": 0.05,
                     "sql_keyword_count": 0, "xss_pattern_count": 0,
                     "path_traversal_count": 0, "cmd_injection_count": 0,
                     "base64_count": 0, "hex_count": 0},
            "body": {"entropy": 4.8, "sql_keyword_count": 3, "xss_pattern_count": 0,
                      "token_count": 4, "avg_token_length": 7.2},
            "user_agent": {"entropy": 4.2, "special_char_ratio": 0.08},
        },
    }
    flat = _flatten_http_record(sample)
    print("Flattened HTTP columns check:", all(c in flat for c in HTTP_FEATURE_COLUMNS))
    print(pd.DataFrame([flat])[HTTP_FEATURE_COLUMNS])

    sample_ssh = {
        "conn_id": "test_ssh1",
        "src_ip": "203.0.113.11",
        "flow_duration_ms": 1500.5,
        "fwd_pkts": 10, "bwd_pkts": 12,
        "fwd_bytes": 1000, "bwd_bytes": 3500,
        "fwd_pkt_len_mean": 100.0, "fwd_pkt_len_std": 10.0,
        "bwd_pkt_len_mean": 291.6, "bwd_pkt_len_std": 50.0,
        "fwd_iat_mean": 150.0, "fwd_iat_std": 20.0,
        "bwd_iat_mean": 125.0, "bwd_iat_std": 15.0,
        "fwd_bwd_byte_ratio": 0.285, "fwd_bwd_pkt_ratio": 0.833,
        "hassh_known_bad": False,
        "weak_algo_flag": True,
        "banner_scan_flag": False,
        "tcp_to_banner_ms": 10.5,
        "banner_to_kex_ms": 25.1,
        "kex_to_newkeys_ms": 55.0,
        "total_duration_ms": 1500.5,
        "pkts_before_newkeys": 5,
        "bytes_before_newkeys": 800,
        "client_software_cat": "standard",
        "dst_failed_sessions_10min": 0
    }
    flat_ssh = _flatten_ssh_record(sample_ssh)
    print("\nFlattened SSH columns check:", all(c in flat_ssh for c in SSH_FEATURE_COLUMNS))
    print(pd.DataFrame([flat_ssh])[SSH_FEATURE_COLUMNS])
