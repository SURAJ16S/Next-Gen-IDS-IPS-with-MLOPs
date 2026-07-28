import { useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, AlertCircle, ShieldAlert } from 'lucide-react';
import { loginUser } from '../services/api';
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

  // Rate-limit state (L13)
  const [attemptCount, setAttemptCount] = useState(0);
  const [lockoutSeconds, setLockoutSeconds] = useState(0);

  const navigate = useNavigate();

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
  const handleSubmit = async (e) => {
    e.preventDefault();
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
        email:    email.trim().toLowerCase(),   // L3: lowercase normalization
        password: password.trim(),               // L9: trim
      });
      localStorage.setItem('token', res.data.token);
      localStorage.setItem('user', JSON.stringify(res.data));
      navigate('/');
    } catch (err) {
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

        {/* Attempts warning */}
        {attemptCount >= 3 && attemptCount < MAX_ATTEMPTS && !isLocked && (
          <div className="auth-error" style={{ background: 'rgba(234,179,8,0.1)', borderColor: 'rgba(234,179,8,0.3)', color: '#fde047' }}>
            <ShieldAlert size={14} />
            {MAX_ATTEMPTS - attemptCount} attempt{MAX_ATTEMPTS - attemptCount !== 1 ? 's' : ''} remaining before lockout
          </div>
        )}

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