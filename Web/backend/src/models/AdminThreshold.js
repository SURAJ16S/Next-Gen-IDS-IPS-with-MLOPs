const mongoose = require('mongoose');

const adminThresholdSchema = new mongoose.Schema(
  {
    feature: { type: String, required: true, unique: true }, // 'devops', 'agent', 'threats', 'network', 'logs', 'nodes'
    config: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },

    // ── ML / Auto-block control (master plan §5.3) ──────────────────────────
    // These are stored under feature='ml_autoblock' for clean separation.
    // When autoBlockEnabled = false, the Decision Engine still writes
    // BlockedEntity records (status='pending_review') but doesn't enforce
    // them — "recommend, don't act" mode, safe for demos.
    autoBlockEnabled: {
      type: Boolean,
      default: true, // on by default; set false to run in advisory-only mode
    },
    autoBlockThreshold: {
      type: Number,
      default: 85, // risk_score >= this => auto-block fires
      min: 0,
      max: 100,
    },
    autoAlertThreshold: {
      type: Number,
      default: 60, // risk_score >= this (but < autoBlockThreshold) => alert-only
      min: 0,
      max: 100,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdminThreshold', adminThresholdSchema, 'admin_thresholds');

