import { Routes, Route, Navigate } from 'react-router-dom';
import DashboardLayout from './layouts/DashboardLayout';
import AdminDashboardLayout from './layouts/AdminDashboardLayout';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import VerifyOtp from './pages/VerifyOtp';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import ThreatMonitoring from './pages/ThreatMonitoring';
import NetworkMonitoring from './pages/NetworkMonitoring';
import Analytics from './pages/Analytics';
import Logs from './pages/Logs';
import DevOps from './pages/DevOps';
import Settings from './pages/Settings';
import NodesPage from './pages/NodesPage';
import Fixtures from './pages/Fixtures';
import Profile from './pages/Profile';
import GithubCallbackRelay from './pages/GithubCallbackRelay';

import Agent from './pages/Agent';
import AdminRoute from './components/AdminRoute';
import AdminLogin from './pages/AdminLogin';

// Admin Pages
import AdminOverviewPage from './pages/AdminOverviewPage';
import AdminManageDevOps from './pages/AdminManageDevOps';
import AdminUsersPage from './pages/AdminUsersPage';
import AdminManageAgent from './pages/AdminManageAgent';
import AdminManageThreats from './pages/AdminManageThreats';
import AdminManageNetwork from './pages/AdminManageNetwork';
import AdminManageLogs from './pages/AdminManageLogs';
import AdminManageNodes from './pages/AdminManageNodes';
import AdminManageBlocklist from './pages/AdminManageBlocklist';

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/verify-otp" element={<VerifyOtp />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/github-callback" element={<GithubCallbackRelay />} />
      
      {/* Standard User Dashboard */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="threats" element={<ThreatMonitoring />} />
        <Route path="network" element={<NetworkMonitoring />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="logs" element={<Logs />} />
        <Route path="devops" element={<DevOps />} />
        <Route path="agent" element={<Agent />} />
        <Route path="nodes" element={<NodesPage />} />
        <Route path="fixtures" element={<Fixtures />} />
        <Route path="settings" element={<Settings />} />
        <Route path="profile" element={<Profile />} />
      </Route>

      {/* Admin Panel Dashboard */}
      <Route
        path="/admin"
        element={
          <AdminRoute>
            <AdminDashboardLayout />
          </AdminRoute>
        }
      >
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<AdminOverviewPage />} />
        <Route path="manage-devops" element={<AdminManageDevOps />} />
        <Route path="users" element={<AdminUsersPage />} />
        <Route path="manage-agent" element={<AdminManageAgent />} />
        <Route path="manage-threats" element={<AdminManageThreats />} />
        <Route path="manage-network" element={<AdminManageNetwork />} />
        <Route path="manage-logs" element={<AdminManageLogs />} />
        <Route path="manage-nodes" element={<AdminManageNodes />} />
        <Route path="blocklist" element={<AdminManageBlocklist />} />
      </Route>

      {/* Redirects for legacy links */}
      <Route path="/admin/agent-performance" element={<Navigate to="/admin/manage-agent" replace />} />
      <Route path="/agent-performance" element={<Navigate to="/admin/manage-agent" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;