const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middleware/auth.middleware');
const {
  getAdminDashboardStats,
  getAllUsers,
  updateUserRole,
  updateUserStatus,
  getFeatureThresholds,
  updateFeatureThresholds,
  getAllDeployments,
  getAllThreats,
  getAllNetworkEvents,
  getAllSystemLogs,
  purgeLogs
} = require('../controllers/admin.controller');

// All routes are fully secured by Authentication and Admin Authorization check
router.use(protect);
router.use(adminOnly);

router.get('/stats', getAdminDashboardStats);
router.get('/users', getAllUsers);
router.put('/users/:id/role', updateUserRole);
router.put('/users/:id/status', updateUserStatus);
router.get('/thresholds/:feature', getFeatureThresholds);
router.put('/thresholds/:feature', updateFeatureThresholds);
router.get('/deployments', getAllDeployments);
router.get('/threats', getAllThreats);
router.get('/network', getAllNetworkEvents);
router.get('/logs', getAllSystemLogs);
router.post('/logs/purge', purgeLogs);

module.exports = router;
