const bcrypt = require('bcryptjs');
const Node = require('../models/Node');

const agentAuth = async (req, res, next) => {
  const nodeId = req.headers['x-node-id'];
  const secret = req.headers['x-node-secret'];

  if (!nodeId || !secret) {
    return res.status(401).json({ message: 'Missing node credentials' });
  }

  try {
    const node = await Node.findOne({ nodeId, status: 'active' });
    if (!node || !node.nodeSecretKey) {
      return res.status(401).json({ message: 'Invalid or revoked node' });
    }

    const isMatch = await bcrypt.compare(secret, node.nodeSecretKey);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid node secret' });
    }

    req.node = node;
    
    // Asynchronously update lastSeen
    Node.updateOne({ _id: node._id }, { lastSeen: new Date() }).exec();
    
    next();
  } catch (error) {
    res.status(500).json({ message: 'Agent auth error' });
  }
};

module.exports = { agentAuth };
