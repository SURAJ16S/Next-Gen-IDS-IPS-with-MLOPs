import { Routes, Route } from 'react-router-dom';
import DashboardLayout from './layouts/DashboardLayout';
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

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/verify-otp" element={<VerifyOtp />} />
      <Route path="/reset-password" element={<ResetPassword />} />
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
        <Route path="nodes" element={<NodesPage />} />
        <Route path="fixtures" element={<Fixtures />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}

export default App;