const express = require('express');
const router = express.Router();
const { getAnalyticsSummary } = require('../controllers/analytics.controller');
const { protect } = require('../middleware/auth.middleware');

router.get('/summary', protect, getAnalyticsSummary);

module.exports = router;