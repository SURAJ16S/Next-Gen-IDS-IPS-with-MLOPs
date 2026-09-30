const NetworkEvent = require('../models/NetworkEvent');
const { listWithPaging } = require('../utils/queryHelpers');
const getNetworkEvents = async (req, res) => {
  try {
    await listWithPaging(req, res, NetworkEvent, {
      allowedSort: ['createdAt', 'sourceIP', 'destinationIP', 'port', 'protocol', 'status'],
      legacyLimit: 100,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
const createNetworkEvent = async (req, res) => {
  try {
    const event = await NetworkEvent.create(req.body);
    res.status(201).json(event);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getNetworkEvents, createNetworkEvent };