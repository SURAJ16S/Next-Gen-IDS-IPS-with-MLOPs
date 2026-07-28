const { body, validationResult } = require('express-validator');

// ─── Disposable email domains (most common throwaway providers) ───────────────
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  'yopmail.com', 'maildrop.cc', 'sharklasers.com', 'guerrillamailblock.com',
  'grr.la', 'guerrillamail.info', 'guerrillamail.biz', 'guerrillamail.de',
  'guerrillamail.net', 'guerrillamail.org', 'spam4.me', 'trashmail.com',
  'trashmail.me', 'trashmail.net', 'trashmail.at', 'trashmail.io',
  '10minutemail.com', 'fakeinbox.com', 'dispostable.com', 'mailnull.com',
  'spamgourmet.com', 'spamgourmet.net', 'spamgourmet.org', 'getairmail.com',
  'filzmail.com', 'spamfree24.org', 'tempr.email', 'discard.email',
  'incognitomail.com', 'spamotron.com', 'mailnull.com', 'throwam.com',
]);

// ─── Common weak passwords (NIST top-20) ──────────────────────────────────────
const COMMON_PASSWORDS = new Set([
  'password', 'password1', '123456', '123456789', '12345678', '12345',
  '1234567', 'qwerty', 'abc123', 'football', 'iloveyou', 'admin',
  'letmein', 'monkey', '1234567890', 'dragon', 'master', 'sunshine',
  'princess', 'welcome', 'shadow', 'superman', 'michael', 'batman',
  'pass', 'test', 'hello', 'login', 'access', 'admin123',
]);

// ─── Email rules (shared between login & register) ────────────────────────────
const emailRules = (fieldName = 'email') => [
  body(fieldName)
    .trim()
    .notEmpty().withMessage('Email is required')
    .isLength({ max: 254 }).withMessage('Email must be ≤ 254 characters')
    .isEmail().withMessage('Enter a valid email address')
    .normalizeEmail({ gmail_remove_dots: false })
    .not().matches(/[<>"'`]/).withMessage('Email contains invalid characters')
    .not().matches(/\.{2,}/).withMessage('Email cannot have consecutive dots')
    .custom((value) => {
      const domain = value.split('@')[1];
      if (domain && DISPOSABLE_DOMAINS.has(domain.toLowerCase())) {
        throw new Error('Disposable email addresses are not allowed');
      }
      return true;
    }),
];

// ─── Password rules (login — minimal, no complexity required) ─────────────────
const loginPasswordRules = () => [
  body('password')
    .trim()
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .isLength({ max: 128 }).withMessage('Password is too long (max 128 characters)'),
];

// ─── Password rules (register — full complexity) ──────────────────────────────
const registerPasswordRules = () => [
  body('password')
    .trim()
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .isLength({ max: 128 }).withMessage('Password is too long (max 128 characters)')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number')
    .matches(/[!@#$%^&*()\-_=+\[\]{};:'",.<>?/\\|`~]/)
      .withMessage('Password must contain at least one special character')
    .custom((value, { req }) => {
      if (COMMON_PASSWORDS.has(value.toLowerCase())) {
        throw new Error('This password is too common. Please choose a stronger one.');
      }
      const username = (req.body.username || '').toLowerCase();
      if (username && value.toLowerCase().includes(username)) {
        throw new Error('Password cannot contain your username');
      }
      return true;
    }),
];

// ─── Name rules ───────────────────────────────────────────────────────────────
const nameRules = (field, label) => [
  body(field)
    .trim()
    .notEmpty().withMessage(`${label} is required`)
    .isLength({ min: 2 }).withMessage(`${label} must be at least 2 characters`)
    .isLength({ max: 50 }).withMessage(`${label} must be ≤ 50 characters`)
    .matches(/^[a-zA-Z\s\-']+$/).withMessage(`${label} can only contain letters, hyphens, and apostrophes`)
    .not().matches(/<script|javascript:|on\w+=/i).withMessage(`${label} contains invalid characters`),
];

// ─── Username rules ───────────────────────────────────────────────────────────
const usernameRules = () => [
  body('username')
    .trim()
    .notEmpty().withMessage('Username is required')
    .isLength({ min: 3 }).withMessage('Username must be at least 3 characters')
    .isLength({ max: 30 }).withMessage('Username must be ≤ 30 characters')
    .matches(/^[a-zA-Z][a-zA-Z0-9_\-]*$/)
      .withMessage('Username must start with a letter and contain only letters, numbers, _ or -')
    .not().matches(/\s/).withMessage('Username cannot contain spaces'),
];

// ─── DOB rules ────────────────────────────────────────────────────────────────
const dobRules = () => [
  body('dob')
    .notEmpty().withMessage('Date of birth is required')
    .isDate().withMessage('Enter a valid date of birth')
    .custom((value) => {
      const dob = new Date(value);
      const now = new Date();
      if (dob >= now) throw new Error('Date of birth cannot be today or in the future');
      const age = Math.floor((now - dob) / (365.25 * 24 * 60 * 60 * 1000));
      if (age < 13) throw new Error('You must be at least 13 years old to register');
      if (age > 120) throw new Error('Please enter a valid date of birth');
      return true;
    }),
];

// ─── Mobile rules ─────────────────────────────────────────────────────────────
const mobileRules = () => [
  body('mobile')
    .trim()
    .notEmpty().withMessage('Mobile number is required')
    .matches(/^\+?[0-9]{10,15}$/)
      .withMessage('Mobile must be 10–15 digits, with optional leading +'),
];

// ─── Validation result handler ────────────────────────────────────────────────
const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const structured = {};
    errors.array().forEach((err) => {
      if (!structured[err.path]) structured[err.path] = [];
      structured[err.path].push(err.msg);
    });
    return res.status(422).json({
      message: 'Validation failed',
      errors: structured,
    });
  }
  next();
};

// ─── Composed middleware chains ───────────────────────────────────────────────
const validateLogin = [
  ...emailRules('email'),
  ...loginPasswordRules(),
  handleValidation,
];

const validateRegister = [
  ...nameRules('firstName', 'First name'),
  ...nameRules('lastName', 'Last name'),
  ...usernameRules(),
  ...dobRules(),
  ...mobileRules(),
  ...emailRules('email'),
  ...registerPasswordRules(),
  handleValidation,
];

module.exports = { validateLogin, validateRegister };
