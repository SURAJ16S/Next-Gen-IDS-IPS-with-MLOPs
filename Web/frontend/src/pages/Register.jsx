import { useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  User, Mail, Lock, Phone, Calendar, AtSign,
  Eye, EyeOff, AlertCircle, CheckCircle, Info,
} from 'lucide-react';
import { registerUser } from '../services/api';
import './Auth.css';

// ─── Constants ────────────────────────────────────────────────────────────────
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','guerrillamail.com','tempmail.com','throwaway.email',
  'yopmail.com','maildrop.cc','sharklasers.com','spam4.me','trashmail.com',
  'trashmail.me','trashmail.net','10minutemail.com','fakeinbox.com',
  'dispostable.com','tempr.email','discard.email','throwam.com',
]);

const COMMON_PASSWORDS = new Set([
  'password','password1','123456','123456789','12345678','12345','1234567',
  'qwerty','abc123','football','iloveyou','admin','letmein','monkey',
  '1234567890','dragon','master','sunshine','princess','welcome',
  'shadow','superman','michael','batman','pass','test','hello','login',
  'access','admin123',
]);

// ─── Regex ────────────────────────────────────────────────────────────────────
const EMAIL_REGEX   = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
const NAME_REGEX    = /^[a-zA-Z\s\-']+$/;
const USERNAME_REGEX= /^[a-zA-Z][a-zA-Z0-9_\-]*$/;
const MOBILE_REGEX  = /^\+?[0-9]{10,15}$/;
const SCRIPT_RE     = /<script|javascript:|on\w+=/i;
const DOUBLE_DOT_RE = /\.\./;

// ─── Individual Field Validators (R1–R38) ─────────────────────────────────────

function validateFirstName(v) {
  const val = v.trim();
  if (!val) return 'First name is required';                                 // R35
  if (val.length < 2) return 'First name must be at least 2 characters';    // R1
  if (val.length > 50) return 'First name must be ≤ 50 characters';         // R2
  if (!NAME_REGEX.test(val)) return 'Only letters, hyphens, and apostrophes allowed'; // R3
  if (/\d/.test(val)) return 'First name cannot contain numbers';            // R4
  if (SCRIPT_RE.test(val)) return 'Invalid characters detected';            // R5
  return '';
}

function validateLastName(v) {
  const val = v.trim();
  if (!val) return 'Last name is required';
  if (val.length < 2) return 'Last name must be at least 2 characters';
  if (val.length > 50) return 'Last name must be ≤ 50 characters';
  if (!NAME_REGEX.test(val)) return 'Only letters, hyphens, and apostrophes allowed';
  if (/\d/.test(val)) return 'Last name cannot contain numbers';
  if (SCRIPT_RE.test(val)) return 'Invalid characters detected';
  return '';
}

function validateUsername(v) {
  const val = v.trim();
  if (!val) return 'Username is required';                                   // R35
  if (val.length < 3) return 'Username must be at least 3 characters';      // R7
  if (val.length > 30) return 'Username must be ≤ 30 characters';           // R8
  if (/\s/.test(val)) return 'Username cannot contain spaces';              // R10
  if (!USERNAME_REGEX.test(val))
    return 'Username must start with a letter. Only letters, numbers, _ or - allowed'; // R9, R11, R12
  return '';
}

function validateDob(v) {
  if (!v) return 'Date of birth is required';                                // R35
  const dob = new Date(v);
  if (isNaN(dob.getTime())) return 'Enter a valid date';                     // R14
  const now = new Date();
  if (dob >= now) return 'Date of birth cannot be today or in the future';  // R17
  const ageDays = (now - dob) / (1000 * 60 * 60 * 24);
  const age = ageDays / 365.25;
  if (age < 13) return 'You must be at least 13 years old to register';     // R15
  if (age > 120) return 'Please enter a valid date of birth';               // R16
  return '';
}

function validateMobile(v) {
  const val = v.trim();
  if (!val) return 'Mobile number is required';                              // R35
  if (!MOBILE_REGEX.test(val)) return 'Enter a valid mobile number (10–15 digits, optional +)'; // R18
  return '';
}

function validateEmail(v, isRegister = true) {
  const val = v.trim().toLowerCase();
  if (!val) return 'Email is required';
  if (val.length > 254) return 'Email must be ≤ 254 characters';
  if (/[<>"'`]/.test(val)) return 'Email contains invalid characters';      // R21/L5
  if (DOUBLE_DOT_RE.test(val)) return 'Email cannot have consecutive dots'; // R21/L6
  if (!EMAIL_REGEX.test(val)) return 'Enter a valid email address';
  if (isRegister) {                                                          // R22
    const domain = val.split('@')[1];
    if (domain && DISPOSABLE_DOMAINS.has(domain)) return 'Disposable email addresses are not allowed';
  }
  return '';
}

function validatePassword(v, username = '') {
  const val = v.trim();
  if (!val) return 'Password is required';                                   // R35
  if (val.length < 8) return 'Password must be at least 8 characters';      // R23
  if (val.length > 128) return 'Password is too long (max 128 chars)';      // R24
  if (!/[A-Z]/.test(val)) return 'Add at least one uppercase letter (A–Z)'; // R25
  if (!/[a-z]/.test(val)) return 'Add at least one lowercase letter (a–z)'; // R26
  if (!/[0-9]/.test(val)) return 'Add at least one number (0–9)';           // R27
  if (!/[!@#$%^&*()\-_=+\[\]{};:'",.<>?/\\|`~]/.test(val))
    return 'Add at least one special character (!@#$% etc.)';               // R28
  if (COMMON_PASSWORDS.has(val.toLowerCase()))
    return 'This password is too common. Choose a stronger one.';            // R30
  if (username && val.toLowerCase().includes(username.toLowerCase()))
    return 'Password cannot contain your username';                          // R29
  return '';
}

function validateConfirmPassword(v, password) {
  if (!v) return 'Please confirm your password';
  if (v !== password) return 'Passwords do not match';                       // R34
  return '';
}

// ─── Password Strength Meter (R31) ────────────────────────────────────────────
function getPasswordStrength(pwd) {
  if (!pwd) return { level: 0, label: '', color: 'transparent', width: 0 };
  let score = 0;
  if (pwd.length >= 8)  score++;
  if (pwd.length >= 12) score++;
  if (/[A-Z]/.test(pwd)) score++;
  if (/[0-9]/.test(pwd)) score++;
  if (/[^a-zA-Z0-9]/.test(pwd)) score++;
  if (COMMON_PASSWORDS.has(pwd.toLowerCase())) score = Math.min(score, 1);

  const levels = [
    { level: 0, label: '',             color: 'transparent',       width: 0   },
    { level: 1, label: 'Very Weak',    color: 'var(--sev-critical)', width: 20  },
    { level: 2, label: 'Weak',         color: 'var(--sev-high)',     width: 40  },
    { level: 3, label: 'Fair',         color: 'var(--sev-medium)',   width: 60  },
    { level: 4, label: 'Strong',       color: 'var(--accent-cyan)',  width: 80  },
    { level: 5, label: 'Very Strong',  color: 'var(--sev-low)',      width: 100 },
  ];
  return levels[Math.min(score, 5)];
}

// ─── Component ────────────────────────────────────────────────────────────────
const INITIAL_FORM = {
  firstName: '', lastName: '', username: '',
  dob: '', mobile: '', email: '',
  password: '', confirmPassword: '',
};
const INITIAL_ERRORS = {
  firstName: '', lastName: '', username: '',
  dob: '', mobile: '', email: '',
  password: '', confirmPassword: '',
};
const INITIAL_TOUCHED = Object.fromEntries(Object.keys(INITIAL_FORM).map(k => [k, false]));

function Register() {
  const [form, setForm]       = useState(INITIAL_FORM);
  const [errors, setErrors]   = useState(INITIAL_ERRORS);
  const [touched, setTouched] = useState(INITIAL_TOUCHED);
  const [showPwd,     setShowPwd]     = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [serverError, setServerError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const strength = getPasswordStrength(form.password);

  // ── Validate a single field ────────────────────────────────────────────────
  const validateField = useCallback((name, value, formSnapshot = form) => {
    switch (name) {
      case 'firstName':      return validateFirstName(value);
      case 'lastName':       return validateLastName(value);
      case 'username':       return validateUsername(value);
      case 'dob':            return validateDob(value);
      case 'mobile':         return validateMobile(value);
      case 'email':          return validateEmail(value, true);
      case 'password':       return validatePassword(value, formSnapshot.username);
      case 'confirmPassword':return validateConfirmPassword(value, formSnapshot.password);
      default: return '';
    }
  }, [form]);

  // ── Handle input change ────────────────────────────────────────────────────
  const handleChange = (e) => {
    const { name, value } = e.target;
    const newForm = { ...form, [name]: value };
    setForm(newForm);
    if (touched[name]) {
      const err = validateField(name, value, newForm);
      setErrors((prev) => ({ ...prev, [name]: err }));
      // Re-validate confirmPassword live if password changes
      if (name === 'password' && touched.confirmPassword) {
        setErrors((prev) => ({
          ...prev,
          confirmPassword: validateConfirmPassword(newForm.confirmPassword, value),
        }));
      }
    }
  };

  // ── Handle blur ───────────────────────────────────────────────────────────
  const handleBlur = (e) => {
    const { name, value } = e.target;
    setTouched((t) => ({ ...t, [name]: true }));
    setErrors((prev) => ({ ...prev, [name]: validateField(name, value) }));
  };

  // ── Check if form is fully valid (R37: submit guard) ──────────────────────
  const isFormValid = () => {
    for (const key of Object.keys(INITIAL_FORM)) {
      if (!form[key]) return false;
      if (validateField(key, form[key])) return false;
    }
    return true;
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault();
    // Touch all fields
    const allTouched = Object.fromEntries(Object.keys(INITIAL_FORM).map(k => [k, true]));
    setTouched(allTouched);
    // Validate all
    const allErrors = {};
    for (const key of Object.keys(INITIAL_FORM)) {
      allErrors[key] = validateField(key, form[key]);
    }
    setErrors(allErrors);
    if (Object.values(allErrors).some(Boolean)) return;

    setLoading(true);
    setServerError('');
    setSuccess('');
    try {
      await registerUser({
        firstName: form.firstName.trim(),
        lastName:  form.lastName.trim(),
        username:  form.username.trim().toLowerCase(),   // R13
        dob:       form.dob,
        mobile:    form.mobile.trim(),
        email:     form.email.trim().toLowerCase(),
        password:  form.password.trim(),
      });
      setSuccess('Account created successfully! Redirecting to sign in...');
      setTimeout(() => navigate('/login'), 2000);
    } catch (err) {
      const data = err.response?.data;
      if (data?.errors) {
        // Map backend 422 errors to field errors
        const mapped = {};
        for (const [field, msgs] of Object.entries(data.errors)) {
          mapped[field] = Array.isArray(msgs) ? msgs[0] : msgs;
        }
        setErrors((prev) => ({ ...prev, ...mapped }));
      } else {
        setServerError(data?.message || 'Registration failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  // ── Field helper: render label + input + error ─────────────────────────────
  const renderField = ({ name, label, type = 'text', placeholder, icon: Icon, children }) => {
    const err   = touched[name] ? errors[name] : '';
    const valid = touched[name] && !errors[name] && form[name];
    return (
      <div className={`auth-field ${err ? 'has-error' : valid ? 'has-success' : ''}`}>
        <label htmlFor={`reg-${name}`}>
          {label} <span className="required-star">*</span>
        </label>
        <div className="auth-input-wrap">
          {children || (
            <input
              id={`reg-${name}`}
              name={name}
              type={type}
              placeholder={placeholder}
              value={form[name]}
              onChange={handleChange}
              onBlur={handleBlur}
              aria-describedby={err ? `reg-${name}-error` : undefined}
              aria-invalid={!!err}
              autoComplete={
                name === 'email' ? 'email' :
                name === 'password' ? 'new-password' :
                name === 'confirmPassword' ? 'new-password' :
                name === 'dob' ? 'bday' :
                'off'
              }
            />
          )}
          {Icon && <Icon size={15} className="field-icon" />}
          {valid && <span className="field-check">✓</span>}
        </div>
        {err && (
          <p id={`reg-${name}-error`} className="field-error" role="alert">
            <AlertCircle size={11} /> {err}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="auth-bg">
      <div className="auth-card auth-card-wide">
        {/* Brand */}
        <div className="auth-brand">
          <div className="auth-shield">🛡️</div>
          <h1>Create Account</h1>
          <p>Register for IDPS Security Platform</p>
        </div>

        {serverError && (
          <div className="auth-error" role="alert">
            <AlertCircle size={14} /> {serverError}
          </div>
        )}
        {success && (
          <div className="auth-success" role="status">
            <CheckCircle size={14} /> {success}
          </div>
        )}

        <form className="auth-form" onSubmit={handleSubmit} noValidate>

          {/* ── Names (R1–R6) ──────────────────────────────────────────── */}
          <div className="auth-row">
            {renderField({ name: "firstName", label: "First Name", placeholder: "John", icon: User })}
            {renderField({ name: "lastName",  label: "Last Name",  placeholder: "Doe",  icon: User })}
          </div>

          {/* ── Username (R7–R13) ──────────────────────────────────────── */}
          {renderField({ name: "username", label: "Username", placeholder: "johndoe99", icon: AtSign })}
          <p className="field-hint">
            <Info size={11} /> 3–30 chars · letters, numbers, _ or - · must start with a letter
          </p>

          {/* ── DOB + Mobile (R14–R20) ──────────────────────────────────── */}
          <div className="auth-row">
            {renderField({ name: "dob", label: "Date of Birth", type: "date", icon: Calendar })}
            {renderField({ name: "mobile", label: "Mobile Number", placeholder: "+919876543210", icon: Phone })}
          </div>

          {/* ── Email (R21–R22) ─────────────────────────────────────────── */}
          {renderField({ name: "email", label: "Email Address", type: "email", placeholder: "you@example.com", icon: Mail })}

          {/* ── Password (R23–R32) ──────────────────────────────────────── */}
          {(() => {
            const err   = touched.password ? errors.password : '';
            const valid = touched.password && !errors.password && form.password;
            return (
              <div className={`auth-field ${err ? 'has-error' : valid ? 'has-success' : ''}`}>
                <label htmlFor="reg-password">
                  Password <span className="required-star">*</span>
                </label>
                <div className="auth-input-wrap">
                  <input
                    id="reg-password"
                    name="password"
                    type={showPwd ? 'text' : 'password'}
                    placeholder="Min 8 chars · uppercase · number · symbol"
                    value={form.password}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    autoComplete="new-password"
                    aria-describedby="reg-password-error"
                    aria-invalid={!!err}
                    maxLength={128}
                  />
                  <Lock size={15} className="field-icon" />
                  <button type="button" className="password-toggle"
                    onClick={() => setShowPwd(s => !s)}
                    aria-label={showPwd ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>

                {/* R31: Live strength meter */}
                {form.password && (
                  <div className="password-strength-wrap">
                    <div className="strength-bar-track">
                      {[1, 2, 3, 4, 5].map((lvl) => (
                        <div
                          key={lvl}
                          className="strength-bar-seg"
                          style={{
                            background: strength.level >= lvl ? strength.color : 'rgba(255,255,255,0.07)',
                            transition: 'background 0.3s',
                          }}
                        />
                      ))}
                    </div>
                    <span className="strength-label" style={{ color: strength.color }}>
                      {strength.label}
                    </span>
                  </div>
                )}

                {/* Password requirements checklist */}
                {touched.password && (
                  <div className="pwd-checklist">
                    <PwdCheck pass={form.password.length >= 8}         label="At least 8 characters" />
                    <PwdCheck pass={/[A-Z]/.test(form.password)}       label="One uppercase letter" />
                    <PwdCheck pass={/[a-z]/.test(form.password)}       label="One lowercase letter" />
                    <PwdCheck pass={/[0-9]/.test(form.password)}       label="One number" />
                    <PwdCheck pass={/[^a-zA-Z0-9]/.test(form.password)} label="One special character" />
                  </div>
                )}

                {err && (
                  <p id="reg-password-error" className="field-error" role="alert">
                    <AlertCircle size={11} /> {err}
                  </p>
                )}
              </div>
            );
          })()}

          {/* ── Confirm Password (R33–R34) ───────────────────────────────── */}
          {(() => {
            const err   = touched.confirmPassword ? errors.confirmPassword : '';
            const valid = touched.confirmPassword && !errors.confirmPassword && form.confirmPassword;
            const match = form.confirmPassword && form.password && form.confirmPassword === form.password;
            return (
              <div className={`auth-field ${err ? 'has-error' : valid ? 'has-success' : ''}`}>
                <label htmlFor="reg-confirm-password">
                  Confirm Password <span className="required-star">*</span>
                </label>
                <div className="auth-input-wrap">
                  <input
                    id="reg-confirm-password"
                    name="confirmPassword"
                    type={showConfirm ? 'text' : 'password'}
                    placeholder="Repeat your password"
                    value={form.confirmPassword}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    autoComplete="new-password"
                    aria-describedby="reg-confirm-error"
                    aria-invalid={!!err}
                    maxLength={128}
                    style={{
                      borderColor: form.confirmPassword
                        ? match ? 'var(--sev-low)' : 'var(--sev-critical)'
                        : undefined,
                    }}
                  />
                  <Lock size={15} className="field-icon" />
                  <button type="button" className="password-toggle"
                    onClick={() => setShowConfirm(s => !s)}
                    aria-label={showConfirm ? 'Hide' : 'Show'}
                    tabIndex={-1}
                  >
                    {showConfirm ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  {/* R33: real-time match indicator */}
                  {form.confirmPassword && (
                    <span className={`field-match-icon ${match ? 'match' : 'no-match'}`}>
                      {match ? '✓' : '✗'}
                    </span>
                  )}
                </div>
                {err && (
                  <p id="reg-confirm-error" className="field-error" role="alert">
                    <AlertCircle size={11} /> {err}
                  </p>
                )}
              </div>
            );
          })()}

          {/* ── Submit (R37–R38) ─────────────────────────────────────────── */}
          <button
            className="auth-btn"
            id="reg-submit"
            type="submit"
            disabled={loading}
            aria-busy={loading}
          >
            {loading && <span className="auth-btn-spinner" />}
            {loading ? 'Creating Account...' : 'Create Account'}
          </button>
        </form>

        <div className="auth-links">
          Already have an account?&nbsp;
          <Link to="/login" id="login-link">Sign In</Link>
        </div>
      </div>
    </div>
  );
}

// ─── Password requirement check item ──────────────────────────────────────────
function PwdCheck({ pass, label }) {
  return (
    <div className={`pwd-check-item ${pass ? 'pass' : 'fail'}`}>
      <span>{pass ? '✓' : '○'}</span>
      {label}
    </div>
  );
}

export default Register;