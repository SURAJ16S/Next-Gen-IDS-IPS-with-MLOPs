const mongoose = require('mongoose');

const deploymentSchema = new mongoose.Schema(
  {
    projectName: { type: String, required: true },
    techStackDetected: { type: String },
    status: { type: String, enum: ['pending', 'building', 'scanning', 'deployed', 'failed'], default: 'pending' },
    vulnerabilitiesFound: { type: Number, default: 0 },
    deployedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    logs: { type: String },
    jobId: { type: String, unique: true },
    buildLogs: [{ type: String }],
    scanReport: { type: mongoose.Schema.Types.Mixed },
    artifactPath: { type: String },
    containerName: { type: String },
    sessionId: { type: String },
    // Preview process tracking
    previewPort: { type: Number },
    previewPid:  { type: Number },
    previewStatus: { type: String, enum: ['running', 'stopped', 'none'], default: 'none' },
    targetSubfolder: { type: String },
    isGuiApp: { type: Boolean, default: false },
    // Environment file configuration submitted at upload time
    envFiles: [
      {
        path:    { type: String }, // relative path inside workspace, e.g. "backend/.env"
        content: { type: String }, // raw file content
      }
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Deployment', deploymentSchema);