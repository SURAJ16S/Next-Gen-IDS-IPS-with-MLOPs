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
  },
  { timestamps: true }
);

module.exports = mongoose.model('NetworkEvent', networkEventSchema);