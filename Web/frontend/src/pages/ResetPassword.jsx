import { useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { Lock, AlertCircle, CheckCircle } from 'lucide-react';
import { resetPassword } from '../services/api';
import './Auth.css';

function ResetPassword() {
  const location = useLocation();
  const navigate = useNavigate();
  const { email, resetToken } = location.state || {};

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  if (!email || !resetToken) {
    navigate('/forgot-password');
    return null;
  }

  const getStrength = (pwd) => {
    if (!pwd) return { label: '', color: 'transparent', width: 0 };
    if (pwd.length < 6) return { label: 'Too short', color: 'var(--sev-critical)', width: 20 };
    if (pwd.length < 8) return { label: 'Weak', color: 'var(--sev-high)', width: 40 };
    if (/[A-Z]/.test(pwd) && /\d/.test(pwd) && /[^a-zA-Z0-9]/.test(pwd))
      return { label: 'Strong', color: 'var(--sev-low)', width: 100 };
    if (/[A-Z]/.test(pwd) || /\d/.test(pwd))
      return { label: 'Good', color: 'var(--sev-medium)', width: 70 };
    return { label: 'Fair', color: 'var(--accent-cyan)', width: 50 };
  };

  const strength = getStrength(password);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    try {
      await resetPassword({ email, resetToken, newPassword: password });
      setSuccess('Password reset successfully! Redirecting to sign in...');
      setTimeout(() => navigate('/login'), 2000);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-bg">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-shield">🔒</div>
          <h1>Reset Password</h1>
          <p>Create a new secure password for your account</p>
        </div>

        {error && (
          <div className="auth-error">
            <AlertCircle size={14} />
            {error}
          </div>
        )}
        {success && (
          <div className="auth-success">
            <CheckCircle size={14} />
            {success}
          </div>
        )}

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label>New Password</label>
            <div className="auth-input-wrap">
              <input
                id="reset-password"
                type="password"
                placeholder="Enter new password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Lock size={15} />
            </div>
            {password && (
              <div style={{ marginTop: '8px' }}>
                <div
                  style={{
                    height: '3px',
                    borderRadius: '99px',
                    background: 'rgba(255,255,255,0.06)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${strength.width}%`,
                      background: strength.color,
                      borderRadius: '99px',
                      transition: 'width 0.3s, background 0.3s',
                    }}
                  />
                </div>
                <div style={{ fontSize: '11px', color: strength.color, marginTop: '4px', fontWeight: 600 }}>
                  {strength.label}
                </div>
              </div>
            )}
          </div>

          <div className="auth-field">
            <label>Confirm New Password</label>
            <div className="auth-input-wrap">
              <input
                id="reset-confirm-password"
                type="password"
                placeholder="Repeat new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                style={{
                  borderColor:
                    confirmPassword && confirmPassword !== password
                      ? 'var(--sev-critical)'
                      : confirmPassword && confirmPassword === password
                      ? 'var(--sev-low)'
                      : undefined,
                }}
              />
              <Lock size={15} />
            </div>
          </div>

          <button className="auth-btn" id="reset-submit" type="submit" disabled={loading}>
            {loading && <span className="auth-btn-spinner" />}
            {loading ? 'Resetting...' : 'Reset Password'}
          </button>
        </form>

        <div className="auth-links">
          <Link to="/login" id="back-to-login-reset">← Back to Sign In</Link>
        </div>
      </div>
    </div>
  );
}

export default ResetPassword;