const mongoose = require('mongoose');

const deploymentSchema = new mongoose.Schema(
  {
    projectName: { type: String, required: true },
    techStackDetected: { type: String },
    status: { type: String, enum: ['pending', 'building', 'scanning', 'deployed', 'failed'], default: 'pending' },
    vulnerabilitiesFound: { type: Number, default: 0 },
    deployedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    logs: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Deployment', deploymentSchema);