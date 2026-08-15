const express = require('express');
const router = express.Router();
const {
  getDeployments,
  createDeployment,
  updateDeploymentStatus,
  uploadZip,
  getDeploymentStatus,
  downloadArtifact,
  getSuggestedPort,
  getActivePreviews,
  stopDeploymentPreview,
  startDeploymentPreview,
  deleteDeployment,
  listFixtures,
  generateFixture,
  downloadPdfReport,
  getFixtureReviews,
  createFixtureReview,
} = require('../controllers/devops.controller');
const { protect } = require('../middleware/auth.middleware');

// Static routes must be declared BEFORE dynamic :id routes
router.get('/suggest-port', protect, getSuggestedPort);
router.get('/previews', protect, getActivePreviews);
router.get('/fixtures', protect, listFixtures);
router.post('/fixtures/generate', protect, generateFixture);
router.get('/fixtures/:frameworkId/reviews', protect, getFixtureReviews);
router.post('/fixtures/:frameworkId/reviews', protect, createFixtureReview);

// Deployment CRUD
router.get('/', protect, getDeployments);
router.post('/', protect, createDeployment);
router.put('/:id', protect, updateDeploymentStatus);
router.delete('/:id', protect, deleteDeployment);

// Pipeline execution routes
router.post('/upload', protect, uploadZip);
router.get('/:id/status', protect, getDeploymentStatus);
router.get('/:id/artifact', protect, downloadArtifact);
router.get('/:id/pdf-report', protect, downloadPdfReport);
router.post('/:id/stop-preview', protect, stopDeploymentPreview);
router.post('/:id/start-preview', protect, startDeploymentPreview);

module.exports = router;