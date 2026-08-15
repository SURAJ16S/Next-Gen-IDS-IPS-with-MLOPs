const express = require('express');
const router = express.Router();
const {
  registerUser,
  loginUser,
  forgotPassword,
  verifyOtp,
  resetPassword,
  getMe,
  githubLoginRedirect,
  githubLoginCallback,
} = require('../controllers/auth.controller');
const { protect } = require('../middleware/auth.middleware');
const { validateLogin, validateRegister } = require('../middleware/auth.validation');
const { loginLimiter, registerLimiter, otpLimiter } = require('../middleware/rateLimiter');

// B5: Rate limiting + B1: Input validation on every auth endpoint
router.post('/register', registerLimiter, validateRegister, registerUser);
router.post('/login',    loginLimiter,    validateLogin,    loginUser);
router.post('/forgot-password', otpLimiter, forgotPassword);
router.post('/verify-otp', verifyOtp);
router.post('/reset-password', resetPassword);
router.get('/me', protect, getMe);

// GitHub OAuth Login/Signup
router.get('/github', githubLoginRedirect);
router.get('/github/callback', githubLoginCallback);

module.exports = router;