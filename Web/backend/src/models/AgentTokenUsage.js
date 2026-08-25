const mongoose = require('mongoose');

const agentTokenUsageSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, unique: true },
    jobId: { type: String, required: true },
    username: { type: String, default: 'Anonymous' },
    techStack: { type: String, default: 'MERN' },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    avgSpeed: { type: Number, default: 0 }, // tokens per second
    requestCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

module.exports = mongoose.model('AgentTokenUsage', agentTokenUsageSchema);
