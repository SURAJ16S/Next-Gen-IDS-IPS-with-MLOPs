const express = require('express');
const router = express.Router();
const { getDashboardStats, getRecentRequests } = require('../controllers/dashboard.controller');
const { protect } = require('../middleware/auth.middleware');

router.get('/stats', protect, getDashboardStats);
router.get('/requests', protect, getRecentRequests);

module.exports = router;