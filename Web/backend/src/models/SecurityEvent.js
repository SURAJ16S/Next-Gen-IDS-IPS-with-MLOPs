const mongoose = require('mongoose');

const securityEventSchema = new mongoose.Schema(
  {
    protocol: { type: String, enum: ['HTTP', 'HTTPS', 'SSH', 'FTP', 'DNS', 'Telnet'], required: true },
    sourceIP: { type: String, required: true },
    destinationIP: { type: String },
    attackType: { type: String }, // SQLi, XSS, PathTraversal, BruteForce, etc.
    severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'low' },
    action: { type: String, enum: ['allow', 'alert', 'block', 'tarpit'], default: 'allow' },
    payload: { type: String },
    riskScore: { type: Number, default: 0 }, // 0-100 from ML

    // Multi-tenant node scoping — set by agent.controller.js from req.node
    nodeId:    { type: String, index: true }, // the Go proxy's registered nodeId
    nodeOwner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // user who owns this node
  },
  { timestamps: true }
);

module.exports = mongoose.model('SecurityEvent', securityEventSchema);