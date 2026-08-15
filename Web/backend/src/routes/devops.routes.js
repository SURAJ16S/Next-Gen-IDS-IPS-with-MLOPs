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
  changeDeploymentPort,
} = require('../controllers/devops.controller');
const {
  getGithubAuthUrl,
  githubOAuthCallback,
  getGithubStatus,
  getGithubRepos,
  importGithubRepo,
  unlinkGithub,
  getGithubBranches,
  getGithubUserProfile,
} = require('../controllers/github.controller');
const { protect } = require('../middleware/auth.middleware');

// ─── GitHub OAuth ──────────────────────────────────────────────────────────────
// Public callback (GitHub redirects here — no protect middleware)
router.get('/github/callback', githubOAuthCallback);
// Protected GitHub routes
router.get('/github/auth-url', protect, getGithubAuthUrl);
router.get('/github/status',   protect, getGithubStatus);
router.get('/github/profile',  protect, getGithubUserProfile);
router.get('/github/repos',    protect, getGithubRepos);
router.get('/github/repos/:owner/:repo/branches', protect, getGithubBranches);
router.post('/github/import',  protect, importGithubRepo);
router.post('/github/unlink',  protect, unlinkGithub);

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
router.post('/:id/change-port', protect, changeDeploymentPort);

module.exports = router;