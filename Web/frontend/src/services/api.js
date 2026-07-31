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

// Nodes
export const getNodes = () => api.get('/nodes');
export const generateEnrollmentToken = (name) => api.post('/nodes/enrollment-token', { name });
export const revokeNode = (nodeId) => api.post(`/nodes/${nodeId}/revoke`);

export default api;