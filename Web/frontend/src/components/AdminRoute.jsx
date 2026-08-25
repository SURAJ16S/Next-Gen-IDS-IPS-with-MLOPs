import { Navigate } from 'react-router-dom';

/**
 * AdminRoute - Restricts access to users with 'superadmin' or 'admin' role.
 * Reads user data stored in localStorage as JSON under the key 'user'.
 * Falls back to checking the JWT token if no user object is stored.
 */
function AdminRoute({ children }) {
  const token = localStorage.getItem('token');
  if (!token) {
    return <Navigate to="/admin/login" replace />;
  }

  // Try to get role from stored user profile
  try {
    const stored = localStorage.getItem('user');
    if (stored) {
      const user = JSON.parse(stored);
      if (user.role === 'superadmin' || user.role === 'admin') {
        return children;
      }
      // Logged in but not an admin
      return <Navigate to="/" replace />;
    }
  } catch (_) {}

  // If no user object stored but token exists, allow through
  // (backend will reject with 403 if not admin)
  return children;
}

export default AdminRoute;
