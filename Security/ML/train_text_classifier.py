"""
train_text_classifier.py
-------------------------
Trains Model #6: SMTP Spam/Phishing Text Classifier.
Uses TfidfVectorizer + LogisticRegression on a synthetic email corpus.
"""

import random
from pathlib import Path
import joblib
import mlflow
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.model_selection import train_test_split

MODELS_DIR = Path(__file__).parent / "models"
MODELS_DIR.mkdir(exist_ok=True)

def generate_synthetic_emails(num_records=2000):
    records = []
    spam_phrases = [
        "click here to claim your prize", "urgent account suspended",
        "viagra cheap fast delivery", "you have won a lottery",
        "please verify your password immediately", "wire transfer details",
        "limited time offer", "congratulations you are a winner",
        "update your billing information", "exclusive deal just for you"
    ]
    ham_phrases = [
        "meeting agenda for tomorrow", "let's catch up next week",
        "project update and status report", "can you review this pull request",
        "dinner plans for friday", "attached is the invoice for services",
        "thanks for your help", "happy birthday to you",
        "here are the meeting notes", "looking forward to our call"
    ]

    for _ in range(num_records):
        label = random.choice(["spam", "ham"])
        if label == "spam":
            text = " ".join(random.choices(spam_phrases, k=random.randint(2, 5)))
        else:
            text = " ".join(random.choices(ham_phrases, k=random.randint(2, 5)))
        
        records.append({"text": text, "label": label})
    return records

def train_smtp_classifier():
    mlflow.set_experiment("ids-ml/smtp-spam-classifier")
    
    print("Generating synthetic SMTP spam/ham dataset...")
    data = generate_synthetic_emails(5000)
    
    texts = [item["text"] for item in data]
    labels = [item["label"] for item in data]
    
    X_train, X_test, y_train, y_test = train_test_split(
        texts, labels, test_size=0.2, random_state=42
    )

    with mlflow.start_run(run_name="tfidf-logistic-smtp"):
        pipeline = Pipeline([
            ("tfidf", TfidfVectorizer(max_features=5000, ngram_range=(1, 2))),
            ("clf", LogisticRegression(random_state=42, class_weight="balanced"))
        ])
        
        print("Training TfidfVectorizer + LogisticRegression pipeline...")
        pipeline.fit(X_train, y_train)
        
        y_pred = pipeline.predict(X_test)
        
        print("[smtp_classifier] Classification Report:")
        print(classification_report(y_test, y_pred))
        
        print("[smtp_classifier] Confusion Matrix:")
        print(confusion_matrix(y_test, y_pred, labels=["ham", "spam"]))
        
        out_path = MODELS_DIR / "smtp_spam_classifier.pkl"
        joblib.dump(pipeline, out_path)
        mlflow.log_artifact(str(out_path))
        print(f"[smtp_classifier] saved -> {out_path}")

if __name__ == "__main__":
    train_smtp_classifier()
