const mongoose = require('mongoose');

const enrollmentTokenSchema = new mongoose.Schema({
  tokenHash: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'used', 'revoked'],
    default: 'active'
  },
  expiresAt: {
    type: Date,
    required: true
  }
}, { timestamps: true });

// Automatically expire tokens using MongoDB TTL index
enrollmentTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('EnrollmentToken', enrollmentTokenSchema);
