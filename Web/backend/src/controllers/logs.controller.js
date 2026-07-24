const SystemLog = require('../models/SystemLog');

const getLogs = async (req, res) => {
  try {
    const logs = await SystemLog.find().sort({ createdAt: -1 }).limit(200);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createLog = async (req, res) => {
  try {
    const log = await SystemLog.create(req.body);
    res.status(201).json(log);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getLogs, createLog };