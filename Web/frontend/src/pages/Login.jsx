import { useState, useCallback, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, AlertCircle, ShieldAlert } from 'lucide-react';
import { loginUser, linkGithubAccount, refreshCaptcha } from '../services/api';
import CaptchaGate from '../components/CaptchaGate';
import './Auth.css';

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 30;

// ─── Validation rules ─────────────────────────────────────────────────────────
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
const SCRIPT_CHARS = /[<>"'`]/;
const DOUBLE_DOT   = /\.\./;

function validateEmail(value) {
  const v = value.trim().toLowerCase();
  if (!v) return 'Email is required';
  if (v.length > 254) return 'Email must be ≤ 254 characters';
  if (SCRIPT_CHARS.test(v)) return 'Email contains invalid characters';
  if (DOUBLE_DOT.test(v)) return 'Email cannot have consecutive dots';
  if (!EMAIL_REGEX.test(v)) return 'Enter a valid email address (e.g. user@domain.com)';
  return '';
}

function validatePassword(value) {
  const v = value.trim();
  if (!v) return 'Password is required';
  if (v.length < 8) return 'Password must be at least 8 characters';
  if (v.length > 128) return 'Password is too long (max 128 characters)';
  return '';
}

// ─── Component ────────────────────────────────────────────────────────────────
function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState({ email: false, password: false });
  const [fieldErrors, setFieldErrors] = useState({ email: '', password: '' });
  const [serverError, setServerError] = useState('');
  const [loading, setLoading] = useState(false);

  // Rate-limit & CAPTCHA state
  const [attemptCount, setAttemptCount] = useState(0);
  const [lockoutSeconds, setLockoutSeconds] = useState(0);
  const [captchaChallenge, setCaptchaChallenge] = useState(null);
  const [captchaToken, setCaptchaToken] = useState(null);
  const [captchaStatus, setCaptchaStatus] = useState('idle'); // 'idle' | 'error' | 'success'

  // GitHub Link state
  const [linkState, setLinkState] = useState(null);
  const [linkPassword, setLinkPassword] = useState('');
  const [linkPasswordError, setLinkPasswordError] = useState('');
  const [showLinkPassword, setShowLinkPassword] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();

  // Detect GitHub redirect
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
        navigate('/login', { replace: true });
      }
    } else if (token && userStr) {
      try {
        localStorage.setItem('token', token);
        localStorage.setItem('user', decodeURIComponent(userStr));
        navigate('/');
      } catch (e) {
        setServerError('Failed to process GitHub authentication.');
      }
    } else if (err) {
      if (err === 'no_code') setServerError('Authorization code missing from GitHub.');
      else if (err === 'token_failed') setServerError('GitHub token exchange failed.');
      else setServerError('Authentication failed. Please try again.');
      // Clean up search parameters from the URL so it's clean on refresh
      navigate('/login', { replace: true });
    }
  }, [location, navigate]);

  // ── Field-level validate ───────────────────────────────────────────────────
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

  // ── Lockout countdown ─────────────────────────────────────────────────────
  const startLockout = () => {
    setLockoutSeconds(LOCKOUT_SECONDS);
    const interval = setInterval(() => {
      setLockoutSeconds((s) => {
        if (s <= 1) { clearInterval(interval); return 0; }
        return s - 1;
      });
    }, 1000);
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = (e) => {
    if (e) e.preventDefault();
    doLogin(captchaToken);
  };

  const doLogin = async (overrideToken) => {
    if (lockoutSeconds > 0) return;

    // Touch all fields and validate
    const emailErr = validateEmail(email);
    const pwErr    = validatePassword(password);
    setTouched({ email: true, password: true });
    setFieldErrors({ email: emailErr, password: pwErr });
    if (emailErr || pwErr) return;

    setServerError('');
    setLoading(true);
    try {
      const res = await loginUser({
        email:    email.trim().toLowerCase(),
        password: password.trim(),
        captchaToken: overrideToken || captchaToken,
      });
      // Clear CAPTCHA if successful
      if (captchaChallenge) {
        setCaptchaStatus('success');
        await new Promise(r => setTimeout(r, 1500));
      }
      setCaptchaChallenge(null);
      setCaptchaToken(null);
      setCaptchaStatus('idle');
      
      localStorage.setItem('token', res.data.token);
      localStorage.setItem('user', JSON.stringify(res.data));
      navigate('/');
    } catch (err) {
      if (err.response?.status === 403 && err.response?.data?.captcha_required) {
        setCaptchaChallenge({
          challenge_id: err.response.data.challenge_id,
          image_svg: err.response.data.image_svg
        });
        setCaptchaStatus('error');
        setTimeout(() => setCaptchaStatus('idle'), 400); // Reset animation state
        setServerError('Security check required due to unusual request rate.');
        return;
      }

      // L14: Generic error — never reveal which field is wrong
      setServerError('Invalid email or password');

      // L13: track failed attempts
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
      localStorage.setItem('token', res.data.token);
      localStorage.setItem('user', JSON.stringify(res.data));
      navigate('/');
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
          <div className="auth-shield">🛡️</div>
          <h1>IDPS Platform</h1>
          <p>Sign in to your security dashboard</p>
        </div>

        {/* Server / lockout error (L14: generic message only) */}
        {(serverError || isLocked) && (
          <div className="auth-error" role="alert">
            <AlertCircle size={14} />
            {isLocked
              ? `Account temporarily locked. Try again in ${lockoutSeconds}s`
              : serverError}
          </div>
        )}

        {/* Captcha Gate challenge when required */}
        {captchaChallenge && (
          <div style={{ marginBottom: '16px' }}>
            <CaptchaGate
              challenge={captchaChallenge}
              loading={loading}
              status={captchaStatus}
              onToken={(token) => {
                setCaptchaToken(token);
                doLogin(token);
              }}
              onRefresh={async () => {
                setLoading(true);
                try {
                  const res = await refreshCaptcha();
                  setCaptchaChallenge(res.data);
                  setCaptchaStatus('idle');
                } catch (err) {
                  setServerError('Failed to refresh CAPTCHA.');
                }
                setLoading(false);
              }}
            />
          </div>
        )}

        {/* Attempts warning */}
        {attemptCount >= 3 && attemptCount < MAX_ATTEMPTS && !isLocked && (
          <div className="auth-error" style={{ background: 'rgba(234,179,8,0.1)', borderColor: 'rgba(234,179,8,0.3)', color: '#fde047' }}>
            <ShieldAlert size={14} />
            {MAX_ATTEMPTS - attemptCount} attempt{MAX_ATTEMPTS - attemptCount !== 1 ? 's' : ''} remaining before lockout
          </div>
        )}

        {linkState ? (
          <form className="auth-form" onSubmit={handleLinkSubmit} noValidate>
            <div style={{
              background: 'rgba(56,189,248,0.06)',
              border: '1px solid rgba(56,189,248,0.2)',
              borderRadius: 'var(--radius-md)',
              padding: '12px 14px',
              fontSize: '13px',
              lineHeight: '1.5',
              marginBottom: '18px',
              color: 'var(--text-muted)'
            }}>
              An account with the email <strong>{linkState.email}</strong> is already registered.
              To link your GitHub account <strong>@{linkState.githubUsername}</strong>, please enter your password.
            </div>

            {/* Password Field */}
            <div className={`auth-field ${linkPasswordError ? 'has-error' : ''}`}>
              <label htmlFor="link-password">
                Password <span className="required-star">*</span>
              </label>
              <div className="auth-input-wrap">
                <input
                  id="link-password"
                  type={showLinkPassword ? 'text' : 'password'}
                  placeholder="Enter your system password"
                  value={linkPassword}
                  onChange={(e) => {
                    setLinkPassword(e.target.value);
                    setLinkPasswordError('');
                  }}
                  required
                />
                <Lock size={15} className="field-icon" />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowLinkPassword((s) => !s)}
                  aria-label={showLinkPassword ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  {showLinkPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {linkPasswordError && (
                <p id="link-password-error" className="field-error" role="alert">
                  <AlertCircle size={11} /> {linkPasswordError}
                </p>
              )}
            </div>

            {/* Submit */}
            <button
              className="auth-btn"
              id="link-submit"
              type="submit"
              disabled={loading || !linkPassword}
              aria-busy={loading}
              style={{ marginBottom: '10px' }}
            >
              {loading && <span className="auth-btn-spinner" />}
              {loading ? 'Linking Account...' : 'Confirm & Link Account'}
            </button>

            <button
              type="button"
              className="auth-btn"
              style={{
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.15)',
                color: 'var(--text-color)',
                marginTop: '0'
              }}
              onClick={() => {
                setLinkState(null);
                setLinkPassword('');
                setLinkPasswordError('');
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <form className="auth-form" onSubmit={handleSubmit} noValidate>

              {/* ── Email (L1–L6) ───────────────────────────────────────────── */}
              <div className={`auth-field ${emailErr ? 'has-error' : touched.email && !emailErr ? 'has-success' : ''}`}>
                <label htmlFor="login-email">
                  Email Address <span className="required-star">*</span>
                </label>
                <div className="auth-input-wrap">
                  <input
                    id="login-email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => handleChange('email', e.target.value)}
                    onBlur={(e) => handleBlur('email', e.target.value)}
                    autoComplete="email"
                    aria-describedby="login-email-error"
                    aria-invalid={!!emailErr}
                    maxLength={254}
                    required
                  />
                  <Mail size={15} className="field-icon" />
                  {touched.email && !emailErr && <span className="field-check">✓</span>}
                </div>
                {emailErr && (
                  <p id="login-email-error" className="field-error" role="alert">
                    <AlertCircle size={11} /> {emailErr}
                  </p>
                )}
              </div>

              {/* ── Password (L7–L12) ──────────────────────────────────────── */}
              <div className={`auth-field ${pwErr ? 'has-error' : touched.password && !pwErr ? 'has-success' : ''}`}>
                <label htmlFor="login-password">
                  Password <span className="required-star">*</span>
                </label>
                <div className="auth-input-wrap">
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => handleChange('password', e.target.value)}
                    onBlur={(e) => handleBlur('password', e.target.value)}
                    autoComplete="current-password"  // L12: allow autocomplete
                    aria-describedby="login-password-error"
                    aria-invalid={!!pwErr}
                    maxLength={128}
                    required
                  />
                  <Lock size={15} className="field-icon" />
                  {/* L10: visibility toggle */}
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {pwErr && (
                  <p id="login-password-error" className="field-error" role="alert">
                    <AlertCircle size={11} /> {pwErr}
                  </p>
                )}
              </div>

              {/* ── Submit (R38: disabled until valid, locked) ──────────────── */}
              <button
                className="auth-btn"
                id="login-submit"
                type="submit"
                disabled={loading || isLocked || !formValid}
                aria-busy={loading}
              >
                {loading && <span className="auth-btn-spinner" />}
                {isLocked
                  ? `Locked — wait ${lockoutSeconds}s`
                  : loading
                  ? 'Authenticating...'
                  : 'Sign In'}
              </button>
            </form>

            <div className="auth-divider">or</div>

            <button
              type="button"
              onClick={() => { window.location.href = 'http://localhost:5000/api/auth/github'; }}
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
          <Link to="/forgot-password" id="forgot-password-link">Forgot Password?</Link>
          <br /><br />
          Don't have an account?&nbsp;
          <Link to="/register" id="register-link">Create Account</Link>
        </div>
      </div>
    </div>
  );
}

export default Login;