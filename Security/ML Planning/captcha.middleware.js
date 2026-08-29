// Web/backend/src/middleware/captcha.middleware.js
//
// Decides WHEN a request needs a human-verification challenge (using our own
// Redis-backed rate signal — see master plan section 4.1-4.3) and verifies
// the provider token (Cloudflare Turnstile shown here; swap the verify URL
// for hCaptcha's if you choose that instead — same flow otherwise).
//
// Usage in a route file:
//   const { requireCaptchaIfSuspicious, verifyCaptchaToken } = require('../middleware/captcha.middleware');
//   router.post('/login', requireCaptchaIfSuspicious('login'), loginLimiter, login);

const axios = require('axios');
const { bumpRequestRate, getChallengeState } = require('../services/redisSecurityClient');

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;

// Requests-per-window threshold above which we start requiring a challenge.
// Tune this per endpoint — form/login endpoints should be much stricter than
// general browsing endpoints. Do NOT apply this middleware to static assets.
const DEFAULT_RATE_WINDOW_SECONDS = 10;
const DEFAULT_RATE_THRESHOLD = 6; // >6 requests to this endpoint in 10s from one IP looks scripted

function requireCaptchaIfSuspicious(endpointLabel, {
  windowSeconds = DEFAULT_RATE_WINDOW_SECONDS,
  threshold = DEFAULT_RATE_THRESHOLD,
} = {}) {
  return async (req, res, next) => {
    try {
      const ip = req.ip;
      const count = await bumpRequestRate(`${endpointLabel}:${ip}`, windowSeconds);

      if (count <= threshold) {
        return next(); // normal traffic, no challenge needed
      }

      // Over threshold — check if this request already carries a passed
      // challenge token from a prior CAPTCHA completion in this session.
      const challengeState = await getChallengeState(`${endpointLabel}:${ip}`);
      if (challengeState && challengeState.status === 'passed') {
        return next();
      }

      // Also accept a fresh token submitted with THIS request (first time
      // completing the challenge) — verify it inline rather than requiring
      // a second round trip.
      const token = req.body?.captchaToken;
      if (token) {
        const verified = await verifyCaptchaToken(token, ip);
        if (verified) {
          const { setChallengeState } = require('../services/redisSecurityClient');
          await setChallengeState(`${endpointLabel}:${ip}`, 'passed', 900); // 15 min grace
          return next();
        }
      }

      return res.status(403).json({
        captcha_required: true,
        sitekey: process.env.TURNSTILE_SITE_KEY,
        message: 'Unusual request rate detected. Please complete the human-verification check to continue.',
      });
    } catch (err) {
      // Fail OPEN on middleware errors — a broken CAPTCHA gate should never
      // itself become a denial-of-service against legitimate users. Log it,
      // let the request through, and let the normal detection layers (Tier
      // 1/2/3) still evaluate it.
      console.error('[captcha.middleware] error, failing open:', err.message);
      return next();
    }
  };
}

async function verifyCaptchaToken(token, remoteIp) {
  if (!TURNSTILE_SECRET_KEY) {
    console.warn('[captcha.middleware] TURNSTILE_SECRET_KEY not set — cannot verify tokens.');
    return false;
  }
  try {
    const { data } = await axios.post(
      TURNSTILE_VERIFY_URL,
      new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token, remoteip: remoteIp }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 5000 }
    );
    return !!data.success;
  } catch (err) {
    console.error('[captcha.middleware] verify request failed:', err.message);
    return false;
  }
}

module.exports = { requireCaptchaIfSuspicious, verifyCaptchaToken };
