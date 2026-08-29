"""
scoring_service.py
-------------------
Tier-3 ML scoring service. One process, loads all trained models at startup,
exposes the routes described in the master plan section 6.7 / the Gap
Analysis doc section 4.3.

Run:
    uvicorn scoring_service:app --host 0.0.0.0 --port 8500 --workers 2

Go side integration reminder: call this with a strict timeout (~50ms) and
fail open (treat as risk_score=0, model_version="unavailable") if it doesn't
respond in time — an ML outage must never block the whole proxy.
"""

from __future__ import annotations

import glob
import os
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from feature_encoder import (
    DNS_FEATURE_COLUMNS,
    FLOW_FEATURE_COLUMNS,
    HTTP_FEATURE_COLUMNS,
    SSH_FEATURE_COLUMNS,
    encode_single_dns,
    encode_single_flow,
    encode_single_http_payload,
    encode_single_ssh,
)
from redis_reputation import (
    ReputationResult,
    build_behavioral_features,
    is_known_bad_feed_ip,
    lookup_reputation,
)

MODELS_DIR = Path(__file__).parent / "models"

app = FastAPI(title="IDS/IPS ML Scoring Service", version="0.1.0")

_loaded_models: dict[str, Any] = {}


def _latest_model_path(prefix: str) -> Path | None:
    candidates = sorted(glob.glob(str(MODELS_DIR / f"{prefix}_*.pkl")))
    return Path(candidates[-1]) if candidates else None


def _load_model(prefix: str) -> Any | None:
    path = _latest_model_path(prefix)
    if path is None:
        return None
    return joblib.load(path)


@app.on_event("startup")
def load_models() -> None:
    for prefix in (
        "http_anomaly", "flow_anomaly", "web_classifier",
        # Models #4 and #5 — see threat-matrix doc section 3 & 7. These are
        # optional at startup: if untrained, their routes below fail open
        # with risk_score=0, exactly like the original three.
        "ssh_brute_classifier", "dns_tunnel_dga_classifier",
    ):
        artifact = _load_model(prefix)
        if artifact is not None:
            _loaded_models[prefix] = artifact
            print(f"[startup] loaded {prefix} -> version {artifact.get('version')}")
        else:
            print(f"[startup] WARNING: no trained model found for '{prefix}' "
                  f"in {MODELS_DIR} — run train_models.py first. "
                  f"Requests to this route will return risk_score=0 with "
                  f"model_version='untrained' until a model is trained.")


# ---------------------------------------------------------------------------
# Request/response schemas — the contract from the master plan section 6.7 /
# Gap Analysis doc section 4.3, kept identical across routes so the Go side's
# Detection.Details map can absorb any of these responses the same way.
# ---------------------------------------------------------------------------

class ScoreResponse(BaseModel):
    risk_score: float = Field(..., ge=0, le=100)
    predicted_category: str | None = None
    confidence: float | None = None
    model_version: str
    contributing_features: dict[str, float] = {}


class HTTPPayloadRequest(BaseModel):
    payload_stats: dict
    request: dict = {}
    source_ip: str | None = None


class FlowRequest(BaseModel):
    flow_record: dict
    source_ip: str | None = None


class SSHRequest(BaseModel):
    ssh_record: dict
    source_ip: str | None = None


class DNSRequest(BaseModel):
    dns_record: dict
    source_ip: str | None = None


def _isolation_forest_score(artifact: dict, X: np.ndarray) -> tuple[float, dict[str, float]]:
    model = artifact["model"]
    raw = model.decision_function(X)[0]
    lo, hi = artifact["score_lo"], artifact["score_hi"]
    inverted, inv_lo, inv_hi = -raw, -hi, -lo
    scaled = float(np.clip((inverted - inv_lo) / max(inv_hi - inv_lo, 1e-9) * 100, 0, 100))
    top_features = dict(zip(artifact["columns"], X[0].tolist()))
    return scaled, top_features


@app.post("/score/http-payload", response_model=ScoreResponse)
def score_http_payload(req: HTTPPayloadRequest) -> ScoreResponse:
    X = encode_single_http_payload(req.payload_stats, req.request)

    response = ScoreResponse(risk_score=0.0, model_version="untrained")

    # Unsupervised anomaly score
    anomaly_artifact = _loaded_models.get("http_anomaly")
    anomaly_score = 0.0
    if anomaly_artifact is not None:
        anomaly_score, feats = _isolation_forest_score(anomaly_artifact, X)
        response.model_version = anomaly_artifact["version"]
        response.contributing_features.update(feats)

    # Supervised classification (if trained) — takes priority for the label,
    # anomaly score still contributes to the final risk number
    clf_artifact = _loaded_models.get("web_classifier")
    classifier_score = 0.0
    if clf_artifact is not None:
        clf = clf_artifact["model"]
        proba = clf.predict_proba(X)[0]
        classes = clf_artifact["classes"]
        best_idx = int(np.argmax(proba))
        predicted = classes[best_idx]
        confidence = float(proba[best_idx])
        response.predicted_category = predicted
        response.confidence = confidence
        if predicted != "benign":
            classifier_score = confidence * 100

    # Combine (see master plan / ML Module Doc section "combined score" —
    # weights are a starting point for calibration once you have real traffic)
    response.risk_score = round(max(anomaly_score * 0.5, classifier_score * 0.8), 2)

    # Fold in reputation, if we know the source IP
    if req.source_ip:
        rep = lookup_reputation(req.source_ip)
        response.contributing_features["reputation_score"] = float(rep.score)
        response.risk_score = min(100.0, response.risk_score + rep.score * 0.2)

    return response


@app.post("/score/flow", response_model=ScoreResponse)
def score_flow(req: FlowRequest) -> ScoreResponse:
    X = encode_single_flow(req.flow_record)
    artifact = _loaded_models.get("flow_anomaly")
    if artifact is None:
        return ScoreResponse(risk_score=0.0, model_version="untrained")

    score, feats = _isolation_forest_score(artifact, X)
    return ScoreResponse(
        risk_score=score,
        predicted_category="anomaly" if score > 70 else "benign",
        model_version=artifact["version"],
        contributing_features=feats,
    )


def _classifier_score(artifact: dict, X: np.ndarray) -> tuple[float, str, float]:
    """Shared scoring logic for any RandomForest-style classifier artifact
    saved by train_models.py's _train_generic_classifier(). Returns
    (risk_score, predicted_label, confidence). "benign" predictions score 0."""
    clf = artifact["model"]
    proba = clf.predict_proba(X)[0]
    classes = artifact["classes"]
    best_idx = int(np.argmax(proba))
    predicted = classes[best_idx]
    confidence = float(proba[best_idx])
    score = confidence * 100 if predicted != "benign" else 0.0
    return score, predicted, confidence


@app.post("/score/ssh", response_model=ScoreResponse)
def score_ssh(req: SSHRequest) -> ScoreResponse:
    """Model #4 — SSH/FTP/Telnet brute-force & bot classifier. See threat
    matrix doc sections 2.1/2.4/2.9 (CatSSHBruteForce, CatCredStuff,
    CatPwdSpray, CatTelnetIoT) and section 5 for how this plugs into the
    Cross-Layer Decision Engine alongside Tier 1/2."""
    X = encode_single_ssh(req.ssh_record)
    artifact = _loaded_models.get("ssh_brute_classifier")
    response = ScoreResponse(risk_score=0.0, model_version="untrained")
    if artifact is not None:
        score, predicted, confidence = _classifier_score(artifact, X)
        response.risk_score = round(score, 2)
        response.predicted_category = predicted
        response.confidence = confidence
        response.model_version = artifact["version"]
        response.contributing_features = dict(zip(SSH_FEATURE_COLUMNS, X[0].tolist()))

    if req.source_ip:
        rep = lookup_reputation(req.source_ip)
        response.contributing_features["reputation_score"] = float(rep.score)
        response.risk_score = min(100.0, response.risk_score + rep.score * 0.2)
    return response


@app.post("/score/dns", response_model=ScoreResponse)
def score_dns(req: DNSRequest) -> ScoreResponse:
    """Model #5 — DNS tunneling/DGA classifier. See threat matrix doc
    section 2.2 (CatDNSTunnel, CatDGA, CatDNSAmplification)."""
    X = encode_single_dns(req.dns_record)
    artifact = _loaded_models.get("dns_tunnel_dga_classifier")
    response = ScoreResponse(risk_score=0.0, model_version="untrained")
    if artifact is not None:
        score, predicted, confidence = _classifier_score(artifact, X)
        response.risk_score = round(score, 2)
        response.predicted_category = predicted
        response.confidence = confidence
        response.model_version = artifact["version"]
        response.contributing_features = dict(zip(DNS_FEATURE_COLUMNS, X[0].tolist()))

    if req.source_ip:
        rep = lookup_reputation(req.source_ip)
        response.contributing_features["reputation_score"] = float(rep.score)
        response.risk_score = min(100.0, response.risk_score + rep.score * 0.2)
    return response


class ReputationResponse(BaseModel):
    ip: str
    score: int
    known_bad: bool
    matched_feed: str | None = None
    behavioral: dict


@app.get("/reputation/{ip}", response_model=ReputationResponse)
def get_reputation(ip: str) -> ReputationResponse:
    rep: ReputationResult = lookup_reputation(ip)
    feed_match = is_known_bad_feed_ip(ip)
    behavioral = build_behavioral_features(ip)
    return ReputationResponse(
        ip=ip,
        score=max(rep.score, 90 if feed_match else 0),
        known_bad=rep.known_bad or bool(feed_match),
        matched_feed=feed_match,
        behavioral=behavioral,
    )


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "models_loaded": {k: v.get("version") for k, v in _loaded_models.items()},
    }
