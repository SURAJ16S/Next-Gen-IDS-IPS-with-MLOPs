const Threat = require('../models/Threat');

const getThreats = async (req, res) => {
  try {
    const threats = await Threat.find().sort({ createdAt: -1 });
    res.json(threats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createThreat = async (req, res) => {
  try {
    const threat = await Threat.create(req.body);
    res.status(201).json(threat);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateThreatStatus = async (req, res) => {
  try {
    const threat = await Threat.findByIdAndUpdate(
      req.params.id,
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