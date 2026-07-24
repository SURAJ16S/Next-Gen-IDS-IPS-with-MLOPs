const SecurityEvent = require('../models/SecurityEvent');
const Threat = require('../models/Threat');
const NetworkEvent = require('../models/NetworkEvent');
const Deployment = require('../models/Deployment');
const SystemLog = require('../models/SystemLog');

const getDashboardStats = async (req, res) => {
  try {
    const totalThreats = await Threat.countDocuments();
    const openThreats = await Threat.countDocuments({ status: 'open' });
    const totalNetworkEvents = await NetworkEvent.countDocuments();
    const activeDeployments = await Deployment.countDocuments({ status: 'deployed' });
    const recentEvents = await SecurityEvent.find().sort({ createdAt: -1 }).limit(10);

    res.json({
      totalThreats,
      openThreats,
      totalNetworkEvents,
      activeDeployments,
      recentEvents,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getRecentRequests = async (req, res) => {
  try {
    const requests = await SystemLog.find({ source: 'request-logger' })
      .sort({ createdAt: -1 })
      .limit(20);
    res.json(requests);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getDashboardStats, getRecentRequests };