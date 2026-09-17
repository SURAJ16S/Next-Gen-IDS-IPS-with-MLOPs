const mongoose = require('mongoose');

const networkEventSchema = new mongoose.Schema(
  {
    sourceIP: { type: String, required: true },
    destinationIP: { type: String },
    port: { type: Number },
    protocol: { type: String },
    packetSize: { type: Number },
    connectionDuration: { type: Number },
    ja4Fingerprint: { type: String },
    status: { type: String, enum: ['normal', 'suspicious', 'blocked'], default: 'normal' },

    // Multi-tenant node scoping — set by agent.controller.js from req.node
    nodeId:    { type: String, index: true }, // the Go proxy's registered nodeId
    nodeOwner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // user who owns this node
  },
  { timestamps: true }
);

module.exports = mongoose.model('NetworkEvent', networkEventSchema);