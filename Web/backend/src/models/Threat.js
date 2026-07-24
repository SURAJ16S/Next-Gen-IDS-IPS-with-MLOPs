const mongoose = require('mongoose');

const threatSchema = new mongoose.Schema(
  {
    threatType: { type: String, required: true }, // SQLi, XSS, BOLA, SSRF etc.
    sourceIP: { type: String, required: true },
    protocol: { type: String },
    riskScore: { type: Number, default: 0 },
    status: { type: String, enum: ['open', 'investigating', 'resolved', 'blocked'], default: 'open' },
    description: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Threat', threatSchema);