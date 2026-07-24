const mongoose = require('mongoose');

const mlResultSchema = new mongoose.Schema(
  {
    requestId: { type: String },
    sourceIP: { type: String },
    modelUsed: { type: String }, // IsolationForest, GradientBoostedTrees, OneClassSVM
    anomalyScore: { type: Number, required: true }, // 0-100
    classification: { type: String }, // benign, sqli, xss, anomaly etc.
    features: { type: mongoose.Schema.Types.Mixed }, // extracted feature vector
  },
  { timestamps: true }
);

module.exports = mongoose.model('MLResult', mlResultSchema);