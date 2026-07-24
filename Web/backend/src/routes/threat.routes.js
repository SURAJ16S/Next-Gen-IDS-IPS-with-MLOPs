const express = require('express');
const router = express.Router();
const { getThreats, createThreat, updateThreatStatus } = require('../controllers/threat.controller');
const { protect } = require('../middleware/auth.middleware');

router.get('/', protect, getThreats);
router.post('/', protect, createThreat);
router.put('/:id', protect, updateThreatStatus);

module.exports = router;