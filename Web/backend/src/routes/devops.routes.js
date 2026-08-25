const express = require('express');
const router = express.Router();
const {
  getDeployments,
  executeDeploymentDbQuery,
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
  getWorkspaceFiles,
  getWorkspaceFileContent,
  saveWorkspaceFile,
  getDbCollections,
  getDbCollectionData,
  insertDbRecord,
  updateDbRecord,
  deleteDbRecord,
  executeAgentChat,
  rollbackAgentPatches,
  updateAgentPermission,
  undoChatMessages,
  executePendingCommands,
  getChats,
  createChat,
  getChatMessages,
  updateCollaboratorPermissions,
  syncGithubCollaborators,
  downloadSecureEnvPdf
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
  publishBranchToGithub,
} = require('../controllers/github.controller');
const { protect, checkGithubEnabled } = require('../middleware/auth.middleware');
const { checkDeploymentAccess } = require('../middleware/access.middleware');

// ─── GitHub OAuth ──────────────────────────────────────────────────────────────
router.get('/github/callback', checkGithubEnabled, githubOAuthCallback);
router.get('/github/auth-url', protect, checkGithubEnabled, getGithubAuthUrl);
router.get('/github/status',   protect, checkGithubEnabled, getGithubStatus);
router.get('/github/profile',  protect, checkGithubEnabled, getGithubUserProfile);
router.get('/github/repos',    protect, checkGithubEnabled, getGithubRepos);
router.get('/github/repos/:owner/:repo/branches', protect, checkGithubEnabled, getGithubBranches);
router.post('/github/import',  protect, checkGithubEnabled, importGithubRepo);
router.post('/github/unlink',  protect, checkGithubEnabled, unlinkGithub);
router.post('/github/:id/publish-branch', protect, checkGithubEnabled, publishBranchToGithub);

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
router.put('/:id', protect, checkDeploymentAccess('build'), updateDeploymentStatus);
router.delete('/:id', protect, checkDeploymentAccess('build'), deleteDeployment);

// Pipeline execution routes
router.post('/upload', protect, uploadZip);
router.get('/:id/status', protect, checkDeploymentAccess('visibility'), getDeploymentStatus);
router.get('/:id/artifact', protect, checkDeploymentAccess('visibility'), downloadArtifact);
router.get('/:id/pdf-report', protect, checkDeploymentAccess('visibility'), downloadPdfReport);
router.post('/:id/stop-preview', protect, checkDeploymentAccess('build'), stopDeploymentPreview);
router.post('/:id/start-preview', protect, checkDeploymentAccess('build'), startDeploymentPreview);
router.post('/:id/change-port', protect, checkDeploymentAccess('build'), changeDeploymentPort);
router.post('/:id/run-query', protect, checkDeploymentAccess('build'), executeDeploymentDbQuery);

// Workspace File API
router.get('/:id/files', protect, checkDeploymentAccess('visibility'), getWorkspaceFiles);
router.get('/:id/files/content', protect, checkDeploymentAccess('visibility'), getWorkspaceFileContent);
router.post('/:id/files/save', protect, checkDeploymentAccess('build'), saveWorkspaceFile);

// Database API
router.get('/:id/db/collections', protect, checkDeploymentAccess('visibility'), getDbCollections);
router.get('/:id/db/collection/:collection', protect, checkDeploymentAccess('visibility'), getDbCollectionData);
router.post('/:id/db/insert', protect, checkDeploymentAccess('build'), insertDbRecord);
router.put('/:id/db/update', protect, checkDeploymentAccess('build'), updateDbRecord);
router.delete('/:id/db/delete', protect, checkDeploymentAccess('build'), deleteDbRecord);

// AI Agent Chat & Permission API
router.get('/:id/agent/chats', protect, checkDeploymentAccess('visibility'), getChats);
router.post('/:id/agent/chats', protect, checkDeploymentAccess('chat'), createChat);
router.get('/:id/agent/chats/:chatId', protect, checkDeploymentAccess('visibility'), getChatMessages);
router.post('/:id/agent/chat', protect, checkDeploymentAccess('chat'), executeAgentChat);
router.post('/:id/agent/chat/undo', protect, checkDeploymentAccess('chat'), undoChatMessages);
router.post('/:id/agent/rollback', protect, checkDeploymentAccess('chat'), rollbackAgentPatches);
router.post('/:id/agent/permission', protect, checkDeploymentAccess('chat'), updateAgentPermission);
router.post('/:id/agent/exec-pending', protect, checkDeploymentAccess('build'), executePendingCommands);

// Collaborator Roles & Secure PDF API
router.post('/:id/permissions', protect, checkDeploymentAccess('visibility'), updateCollaboratorPermissions);
router.post('/:id/sync-collaborators', protect, checkDeploymentAccess('visibility'), syncGithubCollaborators);
router.get('/:id/env-pdf', protect, checkDeploymentAccess('visibility'), downloadSecureEnvPdf);

module.exports = router;