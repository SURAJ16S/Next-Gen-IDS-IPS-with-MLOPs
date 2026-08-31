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
  linkGithubAccount,
} = require('../controllers/auth.controller');
const { protect, checkGithubEnabled } = require('../middleware/auth.middleware');
const { validateLogin, validateRegister } = require('../middleware/auth.validation');
const { loginLimiter, registerLimiter, otpLimiter } = require('../middleware/rateLimiter');
const { requireCaptchaIfSuspicious } = require('../middleware/captcha.middleware');

// B5: Rate limiting + B1: Input validation + Adaptive CAPTCHA on auth endpoints
router.post('/register', requireCaptchaIfSuspicious('register'), registerLimiter, validateRegister, registerUser);
router.post('/login',    requireCaptchaIfSuspicious('login'),    loginLimiter,    validateLogin,    loginUser);
router.post('/forgot-password', otpLimiter, forgotPassword);
router.post('/verify-otp', verifyOtp);
router.post('/reset-password', resetPassword);
router.get('/me', protect, getMe);

// Custom Captcha Refresh
const { generateCaptchaChallenge } = require('../middleware/captcha.middleware');
router.get('/captcha/refresh', async (req, res) => {
  try {
    const challenge = await generateCaptchaChallenge();
    res.json(challenge);
  } catch (err) {
    res.status(500).json({ message: 'Error generating captcha' });
  }
});

// GitHub OAuth Login/Signup
router.get('/github', checkGithubEnabled, githubLoginRedirect);
router.get('/github/callback', checkGithubEnabled, githubLoginCallback);
router.post('/github/link', checkGithubEnabled, linkGithubAccount);

module.exports = router;