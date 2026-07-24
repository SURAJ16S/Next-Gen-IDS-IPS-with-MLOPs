const mongoose = require('mongoose');

const systemLogSchema = new mongoose.Schema(
  {
    level: { type: String, enum: ['info', 'warning', 'error', 'critical'], default: 'info' },
    source: { type: String }, // proxy, devops-agent, ml-engine etc.
    message: { type: String, required: true },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SystemLog', systemLogSchema);