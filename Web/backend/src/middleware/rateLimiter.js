const rateLimit = require('express-rate-limit');

// ─── Login rate limiter: 10 attempts / 15 min per IP ─────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Only count failed attempts
  message: {
    message: 'Too many login attempts from this IP. Please try again in 15 minutes.',
    retryAfter: 900,
  },
  handler: (req, res, next, options) => {
    res.status(429).json(options.message);
  },
});

// ─── Register rate limiter: 5 attempts / 60 min per IP ───────────────────────
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 60 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many registration attempts from this IP. Please try again in 1 hour.',
    retryAfter: 3600,
  },
  handler: (req, res, next, options) => {
    res.status(429).json(options.message);
  },
});

// ─── OTP rate limiter: 3 OTP requests / 15 min per IP ────────────────────────
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many OTP requests. Please wait before requesting a new one.',
    retryAfter: 900,
  },
  handler: (req, res, next, options) => {
    res.status(429).json(options.message);
  },
});

module.exports = { loginLimiter, registerLimiter, otpLimiter };
