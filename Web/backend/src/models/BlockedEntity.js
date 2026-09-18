// Web/backend/src/models/BlockedEntity.js
//
// Represents a single block/tarpit/rate-limit action against an IP, IP range,
// JA3 fingerprint, or device fingerprint — created either automatically by
// the Decision Engine (via the Go agent -> /api/agent/security-event flow)
// or manually by an analyst from the dashboard.
//
// This is the single source of truth for "is X currently blocked" — Redis's
// gate:blocked:{ip} key (see redisSecurityClient.js) is only a fast-path
// cache of this collection, never the other way around.

const mongoose = require('mongoose');

const blockedEntitySchema = new mongoose.Schema(
  {
    targetType: {
      type: String,
      enum: ['ip', 'ip_range', 'ja3_fingerprint', 'device_fingerprint'],
      required: true,
    },
    targetValue: { type: String, required: true, index: true },

    reason: { type: String, required: true },
    protocol: { type: String }, // HTTP, SSH, FTP, DNS, Telnet, or "cross-protocol"

    mode: { type: String, enum: ['manual', 'automatic'], required: true },
    action: {
      type: String,
      enum: ['block', 'tarpit', 'rate_limit'],
      default: 'block',
    },

    riskScoreAtBlock: { type: Number, min: 0, max: 100 },
    modelVersion: { type: String }, // which ML model version triggered this, if automatic

    blockedBy: { type: String, default: 'system' }, // "system" or an admin user id
    expiresAt: { type: Date, default: null }, // null = indefinite

    status: {
      type: String,
      enum: ['active', 'unblocked', 'expired'],
      default: 'active',
      index: true,
    },
    unblockedBy: { type: String },
    unblockedAt: { type: Date },

    // Multi-tenant node scoping — null for manual admin blocks, set for automatic blocks from Go proxy
    nodeId:    { type: String, index: true }, // the Go proxy's registered nodeId that triggered this block
    nodeOwner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // user who owns the node
  },
  { timestamps: true }
);

// One active block per target at a time — prevents duplicate rows for the
// same IP piling up every time the Decision Engine re-fires.
blockedEntitySchema.index(
  { targetValue: 1, status: 1 },
  { unique: false } // not a hard unique constraint (history should be kept), enforced in controller logic instead
);

module.exports = mongoose.model('BlockedEntity', blockedEntitySchema);
