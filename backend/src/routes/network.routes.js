const express = require('express');
const router = express.Router();
const { getNetworkEvents, createNetworkEvent } = require('../controllers/network.controller');
const { protect } = require('../middleware/auth.middleware');

router.get('/', protect, getNetworkEvents);
router.post('/', protect, createNetworkEvent);

module.exports = router;