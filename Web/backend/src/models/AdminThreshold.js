const mongoose = require('mongoose');

const adminThresholdSchema = new mongoose.Schema(
  {
    feature: { type: String, required: true, unique: true }, // 'devops', 'agent', 'threats', 'network', 'logs', 'nodes'
    config: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdminThreshold', adminThresholdSchema, 'admin_thresholds');
