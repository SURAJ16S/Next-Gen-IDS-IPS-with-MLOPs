const SecurityEvent = require('../models/SecurityEvent');
const MLResult = require('../models/MLResult');

const getAnalyticsSummary = async (req, res) => {
  try {
    const totalEvents = await SecurityEvent.countDocuments();
    const blocked = await SecurityEvent.countDocuments({ action: 'block' });
    const tarpitted = await SecurityEvent.countDocuments({ action: 'tarpit' });
    const avgRisk = await MLResult.aggregate([
      { $group: { _id: null, avgScore: { $avg: '$anomalyScore' } } },
    ]);

    res.json({
      totalEvents,
      blocked,
      tarpitted,
      avgRiskScore: avgRisk[0]?.avgScore || 0,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getAnalyticsSummary };