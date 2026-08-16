import axios from 'axios';

const API_BASE_URL = 'http://localhost:5000/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auth
export const loginUser = (data) => api.post('/auth/login', data);
export const registerUser = (data) => api.post('/auth/register', data);
export const forgotPassword = (data) => api.post('/auth/forgot-password', data);
export const verifyOtp = (data) => api.post('/auth/verify-otp', data);
export const resetPassword = (data) => api.post('/auth/reset-password', data);

// Dashboard
export const getDashboardStats = () => api.get('/dashboard/stats');
export const getRecentRequests = () => api.get('/dashboard/requests');

// Threats
export const getThreats = () => api.get('/threats');
export const createThreat = (data) => api.post('/threats', data);
export const updateThreatStatus = (id, status) => api.put(`/threats/${id}`, { status });

// Network
export const getNetworkEvents = () => api.get('/network');

// Logs
export const getLogs = () => api.get('/logs');

// Analytics
export const getAnalyticsSummary = () => api.get('/analytics/summary');

// DevOps
export const getDeployments = () => api.get('/devops');
export const createDeployment = (data) => api.post('/devops', data);
export const uploadDeploymentZip = (formData, onUploadProgress) => api.post('/devops/upload', formData, {
  headers: { 'Content-Type': 'multipart/form-data' },
  onUploadProgress
});
export const downloadDeploymentArtifact = (id) => api.get(`/devops/${id}/artifact`, {
  responseType: 'blob'
});
export const downloadDeploymentPdfReport = (id) => api.get(`/devops/${id}/pdf-report`, {
  responseType: 'blob'
});
export const suggestDeploymentPort = () => api.get('/devops/suggest-port');
export const getActivePreviews = () => api.get('/devops/previews');
export const stopDeploymentPreview = (id) => api.post(`/devops/${id}/stop-preview`);
export const startDeploymentPreview = (id) => api.post(`/devops/${id}/start-preview`);
export const changeDeploymentPort = (id, previewPort) => api.post(`/devops/${id}/change-port`, { previewPort });
export const executeDeploymentDbQuery = (id, query, dbType) => api.post(`/devops/${id}/run-query`, { query, dbType });
export const deleteDeployment = (id) => api.delete(`/devops/${id}`);

// GitHub OAuth
export const getGithubAuthUrl  = ()     => api.get('/devops/github/auth-url');
export const getGithubStatus   = ()     => api.get('/devops/github/status');
export const getGithubUserProfile = ()   => api.get('/devops/github/profile');
export const getGithubRepos    = ()     => api.get('/devops/github/repos');
export const getGithubBranches = (owner, repo) => api.get(`/devops/github/repos/${owner}/${repo}/branches`);
export const importGithubRepo  = (data) => api.post('/devops/github/import', data);
export const unlinkGithub      = ()     => api.post('/devops/github/unlink');

// Nodes
export const getNodes = () => api.get('/nodes');
export const generateEnrollmentToken = (name) => api.post('/nodes/enrollment-token', { name });
export const revokeNode = (nodeId) => api.post(`/nodes/${nodeId}/revoke`);

export default api;