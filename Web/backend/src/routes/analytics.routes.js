const express = require('express');
const router = express.Router();
const { getAnalyticsSummary, getAgentPerformance, simulateAgentLoad } = require('../controllers/analytics.controller');
const { protect, adminOnly } = require('../middleware/auth.middleware');

router.get('/summary', protect, getAnalyticsSummary);
router.get('/agent-performance', protect, adminOnly, getAgentPerformance);
router.post('/simulate-load', protect, adminOnly, simulateAgentLoad);

module.exports = router;