# ML Pipeline — Next-Gen IDS/IPS with MLOps

This directory contains the complete Tier-3 ML pipeline for the IDS/IPS system.
See `Security/ML Planning/00_MASTER_PLAN_ML_Detection_Redis_Dashboard.md` for the full build order and design rationale.

## Directory Layout

```
ML/
├── feature_encoder.py    # JSONL → numeric DataFrame (shared by training and inference)
├── train_models.py       # Trains all 5 models; uses MLflow for experiment tracking
├── scoring_service.py    # FastAPI scoring server (Tier-3, called by the Go proxy)
├── redis_reputation.py   # Tier-2 Redis reputation + rolling feature store (Python side)
├── requirements.txt      # Python dependencies
├── models/               # Trained .pkl artifacts (gitignored except .gitkeep)
└── notebooks/            # Exploratory analysis and error-analysis notebooks
```

## Quick Start

```bash
# 1. Create a virtual environment
python3 -m venv .venv && source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Smoke test the feature encoder (no logs needed)
python feature_encoder.py

# 4. Train unsupervised models (Phase E — no labeled data needed)
python train_models.py http-anomaly --input ../Security/logs/protocols/http_clean.jsonl
python train_models.py flow-anomaly --input ../Security/logs/flow_stats_clean.jsonl

# 5. Start the scoring service
uvicorn scoring_service:app --host 0.0.0.0 --port 8500 --workers 2

# 6. Check health
curl http://localhost:8500/health
```

## Model Inventory

| # | Model | Type | Training Command | Status |
|---|---|---|---|---|
| 1 | HTTP Payload Anomaly Scorer | Unsupervised (Isolation Forest) | `python train_models.py http-anomaly --input <clean_http.jsonl>` | Phase E |
| 2 | Web Attack Classifier | Supervised (Random Forest) | `python train_models.py web-classifier --input <labeled_http.jsonl>` | Phase F (needs labels) |
| 3 | Flow-level Anomaly Detector | Unsupervised (Isolation Forest) | `python train_models.py flow-anomaly --input <clean_flow.jsonl>` | Phase E |
| 4 | SSH/FTP/Telnet Brute-Force Classifier | Supervised (Random Forest) | `python train_models.py ssh-brute-classifier --input <labeled_ssh.jsonl>` | Phase F stretch |
| 5 | DNS Tunneling/DGA Detector | Supervised (Random Forest) | `python train_models.py dns-tunnel-dga --input <labeled_dns.jsonl>` | Phase F stretch |
| 6 | IP Reputation Score | Rule + weighted decay | See `redis_reputation.py` | Phase A |
| 7 | TLS/JA3+JA4 Fingerprint | Lookup | Feed-based, no training | Phase A |

## Scoring API Endpoints

| Method | Route | Input | Description |
|---|---|---|---|
| POST | `/score/http-payload` | `{ payload_stats, request, source_ip? }` | HTTP anomaly + web attack classification |
| POST | `/score/flow` | `{ flow_record, source_ip? }` | Flow-level anomaly detection |
| POST | `/score/ssh` | `{ ssh_record, source_ip? }` | SSH brute-force/bot classification |
| POST | `/score/dns` | `{ dns_record, source_ip? }` | DNS tunneling/DGA classification |
| GET | `/reputation/{ip}` | — | Tier-2 Redis reputation lookup |
| GET | `/health` | — | Service health + loaded model versions |

> **Fail-open contract:** The Go proxy calls each `/score/*` endpoint with a 50ms timeout. If the service is slow or down, it returns `risk_score=0, model_version="unavailable"` and proceeds with Tier-1/Tier-2 results only. An ML outage **never** blocks the proxy.

## MLflow Experiment Tracking

```bash
# Start the MLflow UI (from this directory)
mlflow ui

# Open http://localhost:5000 to view all training runs, metrics, and model artifacts.
```

Each `python train_models.py` run automatically logs:
- Hyperparameters
- Metrics (macro-F1, per-class precision/recall, CV scores)
- Model artifact (`.pkl` file)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_SECURITY_HOST` | `localhost` | Redis host for reputation/rolling counters |
| `REDIS_SECURITY_PORT` | `6379` | Redis port |

## Test Plan

### Unit / Integration Tests
```bash
# Smoke test encoder — exits 0 if all columns match
python feature_encoder.py

# Smoke test reputation client (requires Redis running)
python redis_reputation.py

# Start the scoring service and verify health
uvicorn scoring_service:app --port 8500 &
curl -s http://localhost:8500/health | python -m json.tool
```

### End-to-End (Phase I)
1. Start sandbox: `docker compose -f ../sandbox/docker-compose.sandbox.yml up -d`
2. Start the Go proxy pointing at the sandbox targets
3. Run `sqlmap` through the proxy
4. Verify `/score/http-payload` returns `risk_score > 70` for SQLi requests
5. Verify the dashboard shows a live `SecurityEvent` via Socket.IO

See `../sandbox/README.md` for full end-to-end testing instructions.
