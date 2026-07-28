import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, AlertCircle, Info } from 'lucide-react';
import { forgotPassword } from '../services/api';
import './Auth.css';

function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const res = await forgotPassword({ email });
      // In dev mode, OTP is returned in response — show it as a hint
      if (res.data.otp) {
        setInfo(`OTP sent! (Dev mode) Your OTP is: ${res.data.otp}`);
        setTimeout(() => navigate('/verify-otp', { state: { email } }), 2500);
      } else {
        navigate('/verify-otp', { state: { email } });
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to send OTP. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-bg">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-shield">🔐</div>
          <h1>Forgot Password</h1>
          <p>Enter your email to receive a one-time password</p>
        </div>

        {error && (
          <div className="auth-error">
            <AlertCircle size={14} />
            {error}
          </div>
        )}
        {info && (
          <div className="auth-info">
            <Info size={14} />
            {info}
          </div>
        )}

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label>Registered Email</label>
            <div className="auth-input-wrap">
              <input
                id="forgot-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
              <Mail size={15} />
            </div>
          </div>

          <button className="auth-btn" id="forgot-submit" type="submit" disabled={loading}>
            {loading && <span className="auth-btn-spinner" />}
            {loading ? 'Sending OTP...' : 'Send OTP'}
          </button>
        </form>

        <div className="auth-links">
          <Link to="/login" id="back-to-login">← Back to Sign In</Link>
        </div>
      </div>
    </div>
  );
}

export default ForgotPassword;