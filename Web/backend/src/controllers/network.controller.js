const NetworkEvent = require('../models/NetworkEvent');

const getNetworkEvents = async (req, res) => {
  try {
    const events = await NetworkEvent.find().sort({ createdAt: -1 }).limit(100);
    res.json(events);
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