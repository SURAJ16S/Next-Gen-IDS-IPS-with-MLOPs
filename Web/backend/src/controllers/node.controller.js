const Node = require('../models/Node');
const EnrollmentToken = require('../models/EnrollmentToken');
const crypto = require('crypto');

// 1. Admin generates an enrollment token in the Dashboard
const generateEnrollmentToken = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: 'Node name is required' });

    // Generate 32 bytes of random data and convert to base64url
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenString = `ngfw_enroll_${rawToken}`;

    // Hash the token for storage
    const tokenHash = crypto.createHash('sha256').update(tokenString).digest('hex');

    // Token valid for 24 hours
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await EnrollmentToken.create({
      tokenHash,
      name,
      createdBy: req.user._id,
      expiresAt
    });

    // Return the raw token ONLY ONCE. It is not retrievable later.
    res.status(201).json({ token: tokenString, name, expiresAt });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 2. Go Agent hits this with the token to register
const enrollNode = async (req, res) => {
  try {
    const { enrollmentToken, hostname, ipAddress, osVersion } = req.body;

    if (!enrollmentToken) {
      return res.status(400).json({ message: 'Enrollment token is required' });
    }

    // Hash the provided token to compare with DB
    const tokenHash = crypto.createHash('sha256').update(enrollmentToken).digest('hex');

    const tokenRecord = await EnrollmentToken.findOne({ 
      tokenHash, 
      status: 'active',
      expiresAt: { $gt: new Date() }
    });

    if (!tokenRecord) {
      return res.status(401).json({ message: 'Invalid or expired enrollment token' });
    }

    // Mark token as used
    tokenRecord.status = 'used';
    await tokenRecord.save();

    // Create the Node
    const nodeId = crypto.randomUUID();
    const rawSecret = crypto.randomBytes(32).toString('hex');

    await Node.create({
      nodeId,
      hostname: hostname || tokenRecord.name,
      ipAddress,
      osVersion,
      status: 'active',
      nodeSecretKey: rawSecret, // Pre-save hook hashes this
      owner: tokenRecord.createdBy
    });

    // Return credentials to agent
    res.status(201).json({
      nodeId,
      nodeSecretKey: rawSecret
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Admin gets all nodes
const getNodes = async (req, res) => {
  try {
    const nodes = await Node.find().sort({ createdAt: -1 });
    res.json(nodes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Admin revokes node
const revokeNode = async (req, res) => {
  try {
    const node = await Node.findOneAndUpdate(
      { nodeId: req.params.id },
      { status: 'revoked' },
      { new: true }
    );
    if (!node) return res.status(404).json({ message: 'Node not found' });
    res.json(node);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { generateEnrollmentToken, enrollNode, getNodes, revokeNode };
