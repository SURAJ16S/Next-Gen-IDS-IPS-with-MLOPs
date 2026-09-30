const Threat = require('../models/Threat');
const { ownerFilter, listWithPaging } = require('../utils/queryHelpers');
const getThreats = async (req, res) => {
  try {
    await listWithPaging(req, res, Threat, {
      allowedSort: ['createdAt', 'threatType', 'sourceIP', 'riskScore', 'status'],
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createThreat = async (req, res) => {
  try {
       const threat = await Threat.create({ ...req.body, nodeOwner: req.user._id });
    res.status(201).json(threat);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateThreatStatus = async (req, res) => {
  try {
     const threat = await Threat.findOneAndUpdate(
      { _id: req.params.id, ...ownerFilter(req) },
      { status: req.body.status },
      { new: true }
    );
    if (!threat) return res.status(404).json({ message: 'Threat not found' });
    res.json(threat);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getThreats, createThreat, updateThreatStatus };