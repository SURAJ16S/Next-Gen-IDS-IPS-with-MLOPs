"""
train_models.py
----------------
Trains all five model-inventory entries from
01_Protocol_Threat_Matrix_ML_Integration_and_Training_Data_Sources.md section 3:
  1. HTTP payload anomaly scorer     (IsolationForest, unsupervised)
  2. Web attack classifier           (RandomForestClassifier, supervised, needs labels)
  3. Flow-level anomaly detector     (IsolationForest, unsupervised)
  4. SSH/FTP/Telnet brute/bot clf.   (RandomForestClassifier, supervised, needs labels)
  5. DNS tunneling/DGA classifier    (RandomForestClassifier, supervised, needs labels)

Run examples:
    python train_models.py http-anomaly        --input logs/protocols/http_clean.jsonl
    python train_models.py flow-anomaly        --input logs/flow_stats_clean.jsonl
    python train_models.py web-classifier       --input logs/protocols/http_labeled.jsonl
    python train_models.py ssh-brute-classifier --input logs/protocols/ssh_labeled.jsonl
    python train_models.py dns-tunnel-dga       --input logs/protocols/dns_labeled.jsonl

Every run:
  - saves a versioned .pkl to models/
  - logs params + metrics to MLflow (run `mlflow ui` to view)
  - prints a plain-English summary so you don't have to open MLflow to sanity-check

Models #6 (IP reputation) and #7 (TLS/JA3+JA4 fingerprint) are intentionally
NOT trained here — they are rule/lookup-based (see redis_reputation.py),
not ML, per the explicit design decision in the threat-matrix doc section 3.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import joblib
import mlflow
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix, f1_score
from sklearn.model_selection import cross_val_score, train_test_split

from feature_encoder import (
    DNS_FEATURE_COLUMNS,
    FLOW_FEATURE_COLUMNS,
    HTTP_FEATURE_COLUMNS,
    SSH_FEATURE_COLUMNS,
    load_dns_features,
    load_flow_features,
    load_http_payload_features,
    load_ssh_features,
)

MODELS_DIR = Path(__file__).parent / "models"
MODELS_DIR.mkdir(exist_ok=True)


def _versioned_path(name: str) -> Path:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return MODELS_DIR / f"{name}_{ts}.pkl"


def _fit_score_scaler(raw_scores: np.ndarray) -> tuple[float, float]:
    """Simple min-max transform so decision_function() output (roughly -0.5..0.5)
    becomes a 0-100 risk_score, matching the serving contract."""
    lo, hi = float(np.percentile(raw_scores, 1)), float(np.percentile(raw_scores, 99))
    return lo, hi


def scale_to_risk(raw_scores: np.ndarray, lo: float, hi: float) -> np.ndarray:
    # NOTE: IsolationForest's decision_function is HIGHER for normal, LOWER for
    # anomalous — so we invert before scaling, since risk_score should be
    # HIGHER for anomalous.
    inverted = -raw_scores
    inv_lo, inv_hi = -hi, -lo
    scaled = (inverted - inv_lo) / max(inv_hi - inv_lo, 1e-9) * 100
    return np.clip(scaled, 0, 100)


def train_http_anomaly(input_path: str, contamination: float = 0.01) -> None:
    mlflow.set_experiment("ids-ml/http-anomaly")
    df = load_http_payload_features(input_path)
    if df.empty:
        raise SystemExit(f"No usable rows found in {input_path}")

    X = df[HTTP_FEATURE_COLUMNS]
    with mlflow.start_run(run_name="isolation-forest-http"):
        params = dict(n_estimators=200, contamination=contamination, random_state=42)
        mlflow.log_params(params)

        model = IsolationForest(**params)
        model.fit(X)

        raw = model.decision_function(X)
        lo, hi = _fit_score_scaler(raw)
        risk = scale_to_risk(raw, lo, hi)

        flagged_pct = float((risk > 70).mean() * 100)
        mlflow.log_metric("pct_flagged_on_training_baseline", flagged_pct)
        print(f"[http-anomaly] trained on {len(df)} rows. "
              f"{flagged_pct:.2f}% of the CLEAN baseline scored >70 risk "
              f"(this should be LOW — if it's high, your baseline wasn't as "
              f"clean as assumed, or contamination is set too low).")

        artifact = {"model": model, "score_lo": lo, "score_hi": hi,
                     "columns": HTTP_FEATURE_COLUMNS, "version": "http_anomaly_v1"}
        out_path = _versioned_path("http_anomaly")
        joblib.dump(artifact, out_path)
        mlflow.log_artifact(str(out_path))
        print(f"[http-anomaly] saved -> {out_path}")


def train_flow_anomaly(input_path: str, contamination: float = 0.01) -> None:
    mlflow.set_experiment("ids-ml/flow-anomaly")
    df = load_flow_features(input_path)
    if df.empty:
        raise SystemExit(f"No usable rows found in {input_path}")

    X = df[FLOW_FEATURE_COLUMNS]
    with mlflow.start_run(run_name="isolation-forest-flow"):
        params = dict(n_estimators=200, contamination=contamination, random_state=42)
        mlflow.log_params(params)

        model = IsolationForest(**params)
        model.fit(X)

        raw = model.decision_function(X)
        lo, hi = _fit_score_scaler(raw)
        risk = scale_to_risk(raw, lo, hi)
        flagged_pct = float((risk > 70).mean() * 100)
        mlflow.log_metric("pct_flagged_on_training_baseline", flagged_pct)
        print(f"[flow-anomaly] trained on {len(df)} rows. "
              f"{flagged_pct:.2f}% of the CLEAN baseline scored >70 risk.")

        artifact = {"model": model, "score_lo": lo, "score_hi": hi,
                     "columns": FLOW_FEATURE_COLUMNS, "version": "flow_anomaly_v1"}
        out_path = _versioned_path("flow_anomaly")
        joblib.dump(artifact, out_path)
        mlflow.log_artifact(str(out_path))
        print(f"[flow-anomaly] saved -> {out_path}")


def train_web_classifier(input_path: str) -> None:
    """Supervised. Expects each JSONL row to include a top-level "label" field
    (e.g. "benign", "sqli", "xss", "path_traversal", "cmd_injection"), which
    you set when generating the labeled batches in Phase D (see master plan
    section 6.5, step 1 — tag the whole tool-run batch, don't infer after the
    fact)."""
    mlflow.set_experiment("ids-ml/web-attack-classifier")
    df = load_http_payload_features(input_path)
    if df.empty or "_label" not in df.columns or df["_label"].isna().all():
        raise SystemExit(
            "No labeled rows found. Make sure each JSONL record has a "
            '"label" field before training the supervised classifier — '
            "see master plan section 6.5."
        )
    df = df.dropna(subset=["_label"])

    X = df[HTTP_FEATURE_COLUMNS]
    y = df["_label"]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, stratify=y, random_state=42
    )

    with mlflow.start_run(run_name="random-forest-web-classifier"):
        params = dict(n_estimators=300, max_depth=12, class_weight="balanced",
                       random_state=42)
        mlflow.log_params(params)

        clf = RandomForestClassifier(**params)
        clf.fit(X_train, y_train)

        y_pred = clf.predict(X_test)
        report = classification_report(y_test, y_pred, output_dict=True, zero_division=0)
        macro_f1 = f1_score(y_test, y_pred, average="macro", zero_division=0)
        mlflow.log_metric("macro_f1", macro_f1)
        for label, metrics in report.items():
            if isinstance(metrics, dict):
                for m_name, m_val in metrics.items():
                    mlflow.log_metric(f"{label}_{m_name}".replace(" ", "_"), m_val)

        print("[web-classifier] classification report:")
        print(classification_report(y_test, y_pred, zero_division=0))
        print("[web-classifier] confusion matrix (rows=true, cols=predicted):")
        labels_sorted = sorted(y.unique())
        cm = confusion_matrix(y_test, y_pred, labels=labels_sorted)
        print(pd.DataFrame(cm, index=labels_sorted, columns=labels_sorted))

        # 5-fold cross-validation for a more honest number on a modest dataset
        cv_scores = cross_val_score(clf, X, y, cv=5, scoring="f1_macro")
        print(f"[web-classifier] 5-fold CV macro-F1: "
              f"{cv_scores.mean():.3f} (+/- {cv_scores.std():.3f})")
        mlflow.log_metric("cv_macro_f1_mean", float(cv_scores.mean()))
        mlflow.log_metric("cv_macro_f1_std", float(cv_scores.std()))

        importances = pd.Series(clf.feature_importances_, index=HTTP_FEATURE_COLUMNS)
        importances = importances.sort_values(ascending=False)
        print("[web-classifier] top 10 feature importances (use this for your viva slide):")
        print(importances.head(10))

        artifact = {"model": clf, "columns": HTTP_FEATURE_COLUMNS,
                     "classes": list(clf.classes_), "version": "web_classifier_v1"}
        out_path = _versioned_path("web_classifier")
        joblib.dump(artifact, out_path)
        mlflow.log_artifact(str(out_path))
        print(f"[web-classifier] saved -> {out_path}")


def _train_generic_classifier(
    input_path: str,
    load_fn,
    feature_columns: list[str],
    experiment_name: str,
    run_name: str,
    model_name: str,
) -> None:
    """Shared supervised-training routine for Model #4 (SSH brute/bot) and
    Model #5 (DNS tunnel/DGA) — same shape as train_web_classifier, kept as
    a separate helper instead of duplicating the ~50 lines twice. See
    01_Protocol_Threat_Matrix_ML_Integration_and_Training_Data_Sources.md
    section 7 for the labeling process (Hydra/Medusa batches for SSH,
    dnschef/iodine/dnscat2 + Bambenek/Netlab360 DGA feed for DNS)."""
    mlflow.set_experiment(experiment_name)
    df = load_fn(input_path)
    if df.empty or "_label" not in df.columns or df["_label"].isna().all():
        raise SystemExit(
            f"No labeled rows found in {input_path}. Each JSONL record needs "
            'a "label" field — tag the whole generation batch at capture '
            "time (see threat-matrix doc section 6.2), don't infer labels after the fact."
        )
    df = df.dropna(subset=["_label"])

    X = df[feature_columns]
    y = df["_label"]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, stratify=y, random_state=42
    )

    with mlflow.start_run(run_name=run_name):
        params = dict(n_estimators=300, max_depth=12, class_weight="balanced",
                       random_state=42)
        mlflow.log_params(params)

        clf = RandomForestClassifier(**params)
        clf.fit(X_train, y_train)

        y_pred = clf.predict(X_test)
        report = classification_report(y_test, y_pred, output_dict=True, zero_division=0)
        macro_f1 = f1_score(y_test, y_pred, average="macro", zero_division=0)
        mlflow.log_metric("macro_f1", macro_f1)
        for label, metrics in report.items():
            if isinstance(metrics, dict):
                for m_name, m_val in metrics.items():
                    mlflow.log_metric(f"{label}_{m_name}".replace(" ", "_"), m_val)

        print(f"[{model_name}] classification report:")
        print(classification_report(y_test, y_pred, zero_division=0))
        labels_sorted = sorted(y.unique())
        cm = confusion_matrix(y_test, y_pred, labels=labels_sorted)
        print(f"[{model_name}] confusion matrix (rows=true, cols=predicted):")
        print(pd.DataFrame(cm, index=labels_sorted, columns=labels_sorted))

        cv_scores = cross_val_score(clf, X, y, cv=5, scoring="f1_macro")
        print(f"[{model_name}] 5-fold CV macro-F1: {cv_scores.mean():.3f} "
              f"(+/- {cv_scores.std():.3f})")
        mlflow.log_metric("cv_macro_f1_mean", float(cv_scores.mean()))
        mlflow.log_metric("cv_macro_f1_std", float(cv_scores.std()))

        importances = pd.Series(clf.feature_importances_, index=feature_columns)
        importances = importances.sort_values(ascending=False)
        print(f"[{model_name}] top feature importances:")
        print(importances.head(10))

        artifact = {"model": clf, "columns": feature_columns,
                     "classes": list(clf.classes_), "version": f"{model_name}_v1"}
        out_path = _versioned_path(model_name)
        joblib.dump(artifact, out_path)
        mlflow.log_artifact(str(out_path))
        print(f"[{model_name}] saved -> {out_path}")


def train_ssh_classifier(input_path: str) -> None:
    """Model #4 — SSH/FTP/Telnet brute-force & bot classifier. Labels:
    "benign" | "brute_force" | "cred_stuff" | "pwd_spray" | "bot"."""
    _train_generic_classifier(
        input_path, load_ssh_features, SSH_FEATURE_COLUMNS,
        experiment_name="ids-ml/ssh-brute-classifier",
        run_name="random-forest-ssh-brute",
        model_name="ssh_brute_classifier",
    )

    # Ablation pass: remove rule-adjacent features to see if ML learns them independently
    print("\n--- Running Feature Ablation Pass (Step 8) ---")
    ablation_cols = [c for c in SSH_FEATURE_COLUMNS if c not in ("banner_scan_flag", "hassh_known_bad")]
    _train_generic_classifier(
        input_path, load_ssh_features, ablation_cols,
        experiment_name="ids-ml/ssh-brute-classifier",
        run_name="random-forest-ssh-brute-ablated",
        model_name="ssh_brute_classifier_ablated",
    )


def train_dns_classifier(input_path: str) -> None:
    """Model #5 — DNS tunneling/DGA classifier. Labels:
    "benign" | "tunnel" | "dga" | "amplification"."""
    _train_generic_classifier(
        input_path, load_dns_features, DNS_FEATURE_COLUMNS,
        experiment_name="ids-ml/dns-tunnel-dga",
        run_name="random-forest-dns-tunnel-dga",
        model_name="dns_tunnel_dga_classifier",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p1 = sub.add_parser("http-anomaly", help="Train the unsupervised HTTP payload anomaly scorer")
    p1.add_argument("--input", required=True, help="Path to a JSONL file of CLEAN/benign HTTP payload records")
    p1.add_argument("--contamination", type=float, default=0.01)

    p2 = sub.add_parser("flow-anomaly", help="Train the unsupervised flow-level anomaly detector")
    p2.add_argument("--input", required=True, help="Path to a JSONL file of CLEAN/benign FlowRecords")
    p2.add_argument("--contamination", type=float, default=0.01)

    p3 = sub.add_parser("web-classifier", help="Train the supervised web attack classifier")
    p3.add_argument("--input", required=True, help="Path to a labeled JSONL file (each row has a 'label' field)")

    p4 = sub.add_parser("ssh-brute-classifier", help="Train Model #4: SSH/FTP/Telnet brute-force & bot classifier")
    p4.add_argument("--input", required=True, help="Labeled JSONL of SSH session summaries (Hydra/Medusa-generated batches)")

    p5 = sub.add_parser("dns-tunnel-dga", help="Train Model #5: DNS tunneling/DGA classifier")
    p5.add_argument("--input", required=True, help="Labeled JSONL of DNS query/window records (dnscat2/iodine + DGA feed batches)")

    args = parser.parse_args()
    if args.command == "http-anomaly":
        train_http_anomaly(args.input, args.contamination)
    elif args.command == "flow-anomaly":
        train_flow_anomaly(args.input, args.contamination)
    elif args.command == "web-classifier":
        train_web_classifier(args.input)
    elif args.command == "ssh-brute-classifier":
        train_ssh_classifier(args.input)
    elif args.command == "dns-tunnel-dga":
        train_dns_classifier(args.input)


if __name__ == "__main__":
    main()
