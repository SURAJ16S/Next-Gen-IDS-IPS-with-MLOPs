# Notebooks

This directory holds exploratory analysis and error-analysis notebooks for the IDS/IPS ML pipeline.

## Suggested Notebooks

| Notebook | Purpose |
|---|---|
| `01_baseline_exploration.ipynb` | Explore a clean-baseline JSONL file, visualize feature distributions |
| `02_model1_http_anomaly.ipynb` | Train + evaluate the HTTP Isolation Forest interactively |
| `03_model3_flow_anomaly.ipynb` | Train + evaluate the flow-level Isolation Forest |
| `04_model2_web_classifier.ipynb` | Full supervised pipeline: label inspection, training, PR curves, error analysis |
| `05_feature_importance.ipynb` | Visualize top feature importances per model for the viva slide |
| `06_error_analysis.ipynb` | Pull false positives/negatives from the test set and inspect them |

## Getting Started

```bash
cd ML
source .venv/bin/activate      # (activate the ML venv created in ML/README.md)
pip install jupyter notebook   # if not already installed
jupyter notebook
```

Then open any `.ipynb` file from this directory.
All notebooks should import from `feature_encoder.py` and `train_models.py` using:

```python
import sys
sys.path.insert(0, '..')  # add ML/ parent to path if running from notebooks/
from feature_encoder import load_http_payload_features, HTTP_FEATURE_COLUMNS
```
