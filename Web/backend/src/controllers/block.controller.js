// Web/backend/src/controllers/block.controller.js
//
// Manual + automatic block/unblock management, following the same style as
// threat.controller.js / network.controller.js already in this codebase.
//
// This controller is the single place that:
//   1. writes the BlockedEntity record (Mongo = source of truth)
//   2. updates the Redis fast-path cache
//   3. tells the connected Go agent to add/remove the actual firewall rule
//   4. emits a Socket.IO event so the dashboard updates live
//
// Wire step 3 up to whatever agent-control channel your DevOps module
// already uses (devops.controller.js has the SSH/agent command patterns —
// reuse that transport, don't build a second one).

const BlockedEntity = require('../models/BlockedEntity');
const {
  cacheBlock,
  clearBlockCache,
} = require('../services/redisSecurityClient');

// Replace this with your actual agent command dispatch (see devops.controller.js
// for the existing SSH/agent-command pattern used elsewhere in this codebase).
async function pushFirewallRuleToAgent(nodeId, { targetType, targetValue, action }) {
  // TODO: wire to the real agent control channel.
  console.log(
    `[block.controller] TODO: instruct agent(${nodeId}) to ${action} ` +
      `${targetType}=${targetValue}`
  );
}

async function pushFirewallUnblockToAgent(nodeId, { targetType, targetValue }) {
  console.log(
    `[block.controller] TODO: instruct agent(${nodeId}) to remove block on ` +
      `${targetType}=${targetValue}`
  );
}

// ---------------------------------------------------------------------------
// GET /api/admin/blocked  — list, filterable by status/mode
// ---------------------------------------------------------------------------
const listBlocked = async (req, res) => {
  try {
    const { status, mode } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (mode) filter.mode = mode;

    const entries = await BlockedEntity.find(filter).sort({ createdAt: -1 }).limit(500);
    res.json(entries);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// POST /api/admin/blocked  — manual block (analyst-initiated from dashboard)
// body: { targetType, targetValue, reason, protocol, action, nodeId }
// ---------------------------------------------------------------------------
const createManualBlock = async (req, res) => {
  try {
    const { targetType, targetValue, reason, protocol, action, nodeId, expiresAt } = req.body;

    if (!targetType || !targetValue) {
      return res.status(400).json({ message: 'targetType and targetValue are required' });
    }

    const entry = await BlockedEntity.create({
      targetType,
      targetValue,
      reason: reason || 'manual: analyst action',
      protocol,
      mode: 'manual',
      action: action || 'block',
      blockedBy: req.user?.id || 'unknown-admin',
      expiresAt: expiresAt || null,
      status: 'active',
    });

    if (targetType === 'ip') {
      const ttl = expiresAt
        ? Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
        : null;
      await cacheBlock(targetValue, ttl);
    }

    if (nodeId) {
      await pushFirewallRuleToAgent(nodeId, { targetType, targetValue, action: entry.action });
    }

    const io = req.app.get('io'); // matches the pattern already used by socket.js
    if (io) io.emit('block:new', entry);

    res.status(201).json(entry);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// Called by the Go agent (not the dashboard) when the Decision Engine fires
// an automatic block. POST /api/agent/security-event should call this
// internally after writing the SecurityEvent — see master plan section 5.2.
// ---------------------------------------------------------------------------
const createAutomaticBlock = async ({
  targetType,
  targetValue,
  reason,
  protocol,
  action,
  riskScoreAtBlock,
  modelVersion,
  nodeId,
  autoExpireSeconds,
}) => {
  const expiresAt = autoExpireSeconds
    ? new Date(Date.now() + autoExpireSeconds * 1000)
    : null;

  const entry = await BlockedEntity.create({
    targetType,
    targetValue,
    reason,
    protocol,
    mode: 'automatic',
    action: action || 'block',
    riskScoreAtBlock,
    modelVersion,
    blockedBy: 'system',
    expiresAt,
    status: 'active',
  });

  if (targetType === 'ip') {
    await cacheBlock(targetValue, autoExpireSeconds || null);
  }

  if (nodeId) {
    await pushFirewallRuleToAgent(nodeId, { targetType, targetValue, action: entry.action });
  }

  return entry;
};

// ---------------------------------------------------------------------------
// PATCH /api/admin/blocked/:id/unblock — works for BOTH manual and
// automatic blocks; an analyst can always override an automatic block.
// ---------------------------------------------------------------------------
const unblock = async (req, res) => {
  try {
    const entry = await BlockedEntity.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Blocked entity not found' });
    if (entry.status !== 'active') {
      return res.status(400).json({ message: `Already ${entry.status}` });
    }

    entry.status = 'unblocked';
    entry.unblockedBy = req.user?.id || 'unknown-admin';
    entry.unblockedAt = new Date();
    await entry.save();

    if (entry.targetType === 'ip') {
      await clearBlockCache(entry.targetValue);
    }

    if (req.body.nodeId) {
      await pushFirewallUnblockToAgent(req.body.nodeId, {
        targetType: entry.targetType,
        targetValue: entry.targetValue,
      });
    }

    const io = req.app.get('io');
    if (io) io.emit('block:removed', entry);

    res.json(entry);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  listBlocked,
  createManualBlock,
  createAutomaticBlock, // exported for internal use by the agent security-event handler
  unblock,
};
