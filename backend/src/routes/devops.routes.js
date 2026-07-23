const express = require('express');
const router = express.Router();
const { getDeployments, createDeployment, updateDeploymentStatus } = require('../controllers/devops.controller');
const { protect } = require('../middleware/auth.middleware');

router.get('/', protect, getDeployments);
router.post('/', protect, createDeployment);
router.put('/:id', protect, updateDeploymentStatus);

module.exports = router;