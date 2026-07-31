const express = require('express');
const router = express.Router();
const { generateEnrollmentToken, enrollNode, getNodes, revokeNode } = require('../controllers/node.controller');
const { protect } = require('../middleware/auth.middleware');

// Public route for agents to enroll using the token
router.post('/enroll', enrollNode);

// Protected routes for dashboard admins
router.post('/enrollment-token', protect, generateEnrollmentToken);
router.get('/', protect, getNodes);
router.post('/:id/revoke', protect, revokeNode);

module.exports = router;
