const mongoose = require('mongoose');
const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || 'a3e8f8c9b1d0e8a7f6c5b4a3d2c1e0f9'; // 32 bytes key
const IV_LENGTH = 16;

const encrypt = (text) => {
  if (!text) return text;
  if (/^[0-9a-fA-F]{32}:[0-9a-fA-F]+$/.test(text)) return text;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (_) {
    return text;
  }
};

const decrypt = (text) => {
  if (!text) return text;
  if (!/^[0-9a-fA-F]{32}:[0-9a-fA-F]+$/.test(text)) return text;
  try {
    const parts = text.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (_) {
    return text;
  }
};

const deploymentSchema = new mongoose.Schema(
  {
    projectName: { type: String, required: true },
    techStackDetected: { type: String },
    architectureDetected: { type: String },
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
    deploymentType: { type: String, enum: ['zip', 'github'], default: 'zip' },
    // Environment file configuration submitted at upload time
    envFiles: [
      {
        path:    { type: String }, // relative path inside workspace, e.g. "backend/.env"
        content: { type: String, set: encrypt, get: decrypt }, // encrypted file content
      }
    ],
    recommendedUpgrades: [
      {
        manager: { type: String },
        package: { type: String },
        current: { type: String },
        latest:  { type: String },
        status:  { type: String }
      }
    ],
    upgradeMode: { type: String, enum: ['automatic', 'semi-automatic'], default: 'automatic' },
  },
  { 
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
  }
);

module.exports = mongoose.model('Deployment', deploymentSchema);