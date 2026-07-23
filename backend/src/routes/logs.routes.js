const express = require('express');
const router = express.Router();
const { getLogs, createLog } = require('../controllers/logs.controller');
const { protect } = require('../middleware/auth.middleware');

router.get('/', protect, getLogs);
router.post('/', protect, createLog);

module.exports = router;