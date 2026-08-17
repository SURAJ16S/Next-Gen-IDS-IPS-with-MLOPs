const mongoose = require('mongoose');

const devopsChatSchema = new mongoose.Schema(
  {
    deploymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Deployment', required: true },
    title: { type: String, default: 'New Chat Thread' },
    messages: [
      {
        role: { type: String, enum: ['user', 'agent'] },
        text: { type: String, required: true },
        pendingAction: {
          commands: [{ type: String }]
        },
        createdAt: { type: Date, default: Date.now }
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model('DevOpsChat', devopsChatSchema);
