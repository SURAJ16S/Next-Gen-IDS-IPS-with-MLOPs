import { useState, useCallback, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, AlertCircle, ShieldAlert } from 'lucide-react';
import { loginUser, linkGithubAccount } from '../services/api';
import './Auth.css';

const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 30;

const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
const SCRIPT_CHARS = /[<>"'`]/;
const DOUBLE_DOT   = /\.\./;

function validateEmail(value) {
  const v = value.trim().toLowerCase();
  if (!v) return 'Email is required';
  if (v.length > 254) return 'Email must be ≤ 254 characters';
  if (SCRIPT_CHARS.test(v)) return 'Email contains invalid characters';
  if (DOUBLE_DOT.test(v)) return 'Email cannot have consecutive dots';
  if (!EMAIL_REGEX.test(v)) return 'Enter a valid email address';
  return '';
}

function validatePassword(value) {
  const v = value.trim();
  if (!v) return 'Password is required';
  if (v.length < 8) return 'Password must be at least 8 characters';
  if (v.length > 128) return 'Password is too long';
  return '';
}

function AdminLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState({ email: false, password: false });
  const [fieldErrors, setFieldErrors] = useState({ email: '', password: '' });
  const [serverError, setServerError] = useState('');
  const [loading, setLoading] = useState(false);

  const [attemptCount, setAttemptCount] = useState(0);
  const [lockoutSeconds, setLockoutSeconds] = useState(0);

  // GitHub Link state
  const [linkState, setLinkState] = useState(null);
  const [linkPassword, setLinkPassword] = useState('');
  const [linkPasswordError, setLinkPasswordError] = useState('');
  const [showLinkPassword, setShowLinkPassword] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();

  // Detect GitHub Redirect Callback / Linking Actions
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    const userStr = params.get('user');
    const err = params.get('error');
    const action = params.get('action');

    if (action === 'link_github') {
      const emailParam = params.get('email');
      const ghUserParam = params.get('githubUsername');
      const linkTokenParam = params.get('linkToken');
      if (emailParam && ghUserParam && linkTokenParam) {
        setLinkState({
          email: emailParam,
          githubUsername: ghUserParam,
          linkToken: linkTokenParam,
        });
        navigate('/admin/login', { replace: true });
      }
    } else if (token && userStr) {
      try {
        const userObj = JSON.parse(decodeURIComponent(userStr));
        if (userObj.role === 'admin' || userObj.role === 'superadmin') {
          localStorage.setItem('token', token);
          localStorage.setItem('user', decodeURIComponent(userStr));
          navigate('/admin/dashboard');
        } else {
          setServerError('Access Denied: You are not authorized as an administrator.');
          navigate('/admin/login', { replace: true });
        }
      } catch (e) {
        setServerError('Failed to process GitHub authentication.');
      }
    } else if (err) {
      if (err === 'no_code') setServerError('Authorization code missing from GitHub.');
      else if (err === 'token_failed') setServerError('GitHub token exchange failed.');
      else setServerError('Authentication failed. Please try again.');
      navigate('/admin/login', { replace: true });
    }
  }, [location, navigate]);

  // Already authenticated checker
  useEffect(() => {
    try {
      const stored = localStorage.getItem('user');
      const token = localStorage.getItem('token');
      if (stored && token && !linkState) {
        const uObj = JSON.parse(stored);
        if (uObj.role === 'admin' || uObj.role === 'superadmin') {
          navigate('/admin/dashboard');
        }
      }
    } catch (_) {}
  }, [navigate, linkState]);

  const validate = useCallback((field, value) => {
    if (field === 'email') return validateEmail(value);
    if (field === 'password') return validatePassword(value);
    return '';
  }, []);

  const handleBlur = (field, value) => {
    setTouched((t) => ({ ...t, [field]: true }));
    setFieldErrors((e) => ({ ...e, [field]: validate(field, value) }));
  };

  const handleChange = (field, value) => {
    if (field === 'email') setEmail(value);
    if (field === 'password') setPassword(value);
    if (touched[field]) {
      setFieldErrors((e) => ({ ...e, [field]: validate(field, value) }));
    }
  };

  const startLockout = () => {
    setLockoutSeconds(LOCKOUT_SECONDS);
    const interval = setInterval(() => {
      setLockoutSeconds((s) => {
        if (s <= 1) { clearInterval(interval); return 0; }
        return s - 1;
      });
    }, 1000);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (lockoutSeconds > 0) return;

    const emailErr = validateEmail(email);
    const pwErr    = validatePassword(password);
    setTouched({ email: true, password: true });
    setFieldErrors({ email: emailErr, password: pwErr });
    if (emailErr || pwErr) return;

    setServerError('');
    setLoading(true);
    try {
      const res = await loginUser({
        email: email.trim().toLowerCase(),
        password: password.trim(),
      });

      if (res.data.role !== 'admin' && res.data.role !== 'superadmin') {
        setServerError('Access Denied: Only administrators are authorized to sign in here.');
        return;
      }

      localStorage.setItem('token', res.data.token);
      localStorage.setItem('user', JSON.stringify(res.data));
      navigate('/admin/dashboard');
    } catch (err) {
      setServerError('Invalid email or password');
      const newCount = attemptCount + 1;
      setAttemptCount(newCount);
      if (newCount >= MAX_ATTEMPTS) {
        startLockout();
        setAttemptCount(0);
        setServerError(`Too many failed attempts. Please wait ${LOCKOUT_SECONDS} seconds.`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleLinkSubmit = async (e) => {
    e.preventDefault();
    if (!linkPassword) return;

    setServerError('');
    setLinkPasswordError('');
    setLoading(true);

    try {
      const res = await linkGithubAccount({
        email: linkState.email,
        password: linkPassword,
        linkToken: linkState.linkToken,
      });

      if (res.data.role !== 'admin' && res.data.role !== 'superadmin') {
        setLinkPasswordError('Access Denied: Account linked belongs to a standard user.');
        return;
      }

      localStorage.setItem('token', res.data.token);
      localStorage.setItem('user', JSON.stringify(res.data));
      navigate('/admin/dashboard');
    } catch (err) {
      const msg = err.response?.data?.message || 'Verification failed. Please check your password.';
      setLinkPasswordError(msg);
    } finally {
      setLoading(false);
    }
  };

  const isLocked   = lockoutSeconds > 0;
  const emailErr   = touched.email    ? fieldErrors.email    : '';
  const pwErr      = touched.password ? fieldErrors.password : '';
  const formValid  = !fieldErrors.email && !fieldErrors.password && email && password;

  return (
    <div className="auth-bg">
      <div className="auth-card">
        {/* Brand */}
        <div className="auth-brand">
          <div className="auth-shield" style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--sev-critical)' }}>🛡️</div>
          <h1>Admin Console</h1>
          <p>NGFW MLOps Intrusion Detection System</p>
        </div>

        {serverError && (
          <div className="auth-error" role="alert" style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid var(--sev-critical)', color: 'var(--sev-critical)' }}>
            <ShieldAlert size={16} />
            {serverError}
          </div>
        )}

        {linkState ? (
          <form className="auth-form" onSubmit={handleLinkSubmit} noValidate>
            <div style={{ marginBottom: '16px', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              An admin account already exists for <strong>{linkState.email}</strong>. 
              Enter your password to link your GitHub account <strong>@{linkState.githubUsername}</strong>.
            </div>

            {linkPasswordError && (
              <div className="auth-error" role="alert">
                <AlertCircle size={15} />
                {linkPasswordError}
              </div>
            )}

            <div className={`auth-field ${linkPasswordError ? 'has-error' : ''}`}>
              <label htmlFor="link-password">Password</label>
              <div className="auth-input-wrap">
                <input
                  id="link-password"
                  type={showLinkPassword ? 'text' : 'password'}
                  placeholder="Enter your password"
                  value={linkPassword}
                  onChange={(e) => setLinkPassword(e.target.value)}
                  maxLength={128}
                  required
                />
                <Lock size={15} className="field-icon" />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowLinkPassword(s => !s)}
                  tabIndex={-1}
                >
                  {showLinkPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            <button
              className="auth-btn"
              type="submit"
              disabled={loading || !linkPassword}
              style={{ background: 'var(--accent-blue)' }}
            >
              {loading ? 'Linking...' : 'Verify & Link GitHub'}
            </button>

            <button
              type="button"
              className="auth-btn"
              onClick={() => setLinkState(null)}
              style={{
                marginTop: '8px',
                background: 'rgba(255,255,255,0.05)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-subtle)'
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <form className="auth-form" onSubmit={handleSubmit} noValidate>
              {/* Email */}
              <div className={`auth-field ${emailErr ? 'has-error' : touched.email && !emailErr ? 'has-success' : ''}`}>
                <label htmlFor="login-email">Admin Email <span className="required-star">*</span></label>
                <div className="auth-input-wrap">
                  <input
                    id="login-email"
                    type="email"
                    placeholder="admin@domain.com"
                    value={email}
                    onChange={(e) => handleChange('email', e.target.value)}
                    onBlur={(e) => handleBlur('email', e.target.value)}
                    autoComplete="email"
                    maxLength={254}
                    required
                  />
                  <Mail size={15} className="field-icon" />
                  {touched.email && !emailErr && <span className="field-check">✓</span>}
                </div>
                {emailErr && <p className="field-error"><AlertCircle size={11} /> {emailErr}</p>}
              </div>

              {/* Password */}
              <div className={`auth-field ${pwErr ? 'has-error' : touched.password && !pwErr ? 'has-success' : ''}`}>
                <label htmlFor="login-password">Password <span className="required-star">*</span></label>
                <div className="auth-input-wrap">
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => handleChange('password', e.target.value)}
                    onBlur={(e) => handleBlur('password', e.target.value)}
                    autoComplete="current-password"
                    maxLength={128}
                    required
                  />
                  <Lock size={15} className="field-icon" />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowPassword((s) => !s)}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {pwErr && <p className="field-error"><AlertCircle size={11} /> {pwErr}</p>}
              </div>

              <button
                className="auth-btn"
                id="login-submit"
                type="submit"
                disabled={loading || isLocked || !formValid}
                style={{ background: 'var(--accent-blue)' }}
              >
                {isLocked ? `Locked — wait ${lockoutSeconds}s` : loading ? 'Authenticating...' : 'Sign In as Admin'}
              </button>
            </form>

            <div className="auth-divider">or</div>

            <button
              type="button"
              onClick={() => { window.location.href = 'http://localhost:5000/api/auth/github?from=admin'; }}
              style={{
                width: '100%',
                background: '#24292f',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 'var(--radius-md)',
                color: '#fff',
                padding: '11px',
                fontWeight: 600,
                fontSize: '13.5px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                transition: 'opacity 0.15s',
                marginBottom: '16px',
                boxSizing: 'border-box'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
            >
              <img
                src="https://cdn-icons-png.flaticon.com/512/25/25231.png"
                alt="GitHub"
                style={{ width: '18px', height: '18px', filter: 'invert(1)' }}
              />
              Sign In with GitHub
            </button>
          </>
        )}

        <div className="auth-links">
          <Link to="/login">Standard User Sign In</Link>
        </div>
      </div>
    </div>
  );
}

export default AdminLogin;
