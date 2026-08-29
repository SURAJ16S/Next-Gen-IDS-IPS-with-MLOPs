// Web/backend/src/routes/block.routes.js
const express = require('express');
const router = express.Router();
const { listBlocked, createManualBlock, unblock } = require('../controllers/block.controller');
const { protect } = require('../middleware/auth.middleware');
// If you have a separate admin-only guard (adminOnly / requireRole('admin')),
// use it here in addition to `protect` — this endpoint controls live firewall
// state and should not be reachable by a regular authenticated user.

router.get('/', protect, listBlocked);
router.post('/', protect, createManualBlock);
router.patch('/:id/unblock', protect, unblock);

module.exports = router;

// Then in server.js, alongside the other app.use(...) route mounts:
//   const blockRoutes = require('./routes/block.routes');
//   app.use('/api/admin/blocked', blockRoutes);
