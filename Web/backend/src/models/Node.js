const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const nodeSchema = new mongoose.Schema(
  {
    nodeId: { type: String, required: true, unique: true },
    hostname: { type: String, required: true },
    ipAddress: { type: String, required: true },
    osVersion: { type: String, required: true },
    pairingCode: { type: String },
    pairingCodeExpiry: { type: Date },
    status: { type: String, enum: ['pending', 'claimed', 'active', 'revoked'], default: 'pending' },
    nodeSecretKey: { type: String },
    lastSeen: { type: Date },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

nodeSchema.pre('save', async function () {
  if (!this.isModified('nodeSecretKey') || !this.nodeSecretKey) return;
  // Check if it's already hashed
  if (!this.nodeSecretKey.startsWith('$2')) {
    const salt = await bcrypt.genSalt(10);
    this.nodeSecretKey = await bcrypt.hash(this.nodeSecretKey, salt);
  }
});

module.exports = mongoose.model('Node', nodeSchema);
