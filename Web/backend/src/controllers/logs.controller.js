const SystemLog = require('../models/SystemLog');
const { listWithPaging } = require('../utils/queryHelpers');
const getLogs = async (req, res) => {
  try {
    await listWithPaging(req, res, SystemLog, {
      allowedSort: ['createdAt', 'level', 'source', 'message'],
      legacyLimit: 200,
      scoped: false,
    });
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