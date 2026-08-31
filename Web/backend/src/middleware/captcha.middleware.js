// Web/backend/src/middleware/captcha.middleware.js
//
// Decides WHEN a request needs a human-verification challenge (using our own
// Redis-backed rate signal) and generates/verifies a custom distorted text CAPTCHA.
//
// Usage in a route file:
//   const { requireCaptchaIfSuspicious, verifyCaptchaToken } = require('../middleware/captcha.middleware');
//   router.post('/login', requireCaptchaIfSuspicious('login'), loginLimiter, login);

const svgCaptcha = require('svg-captcha');
const crypto = require('crypto');
const { bumpRequestRate, getChallengeState, gateClient } = require('../services/redisSecurityClient');

const DEFAULT_RATE_WINDOW_SECONDS = 10;
const DEFAULT_RATE_THRESHOLD = 6; 

async function generateCaptchaChallenge() {
  const captcha = svgCaptcha.create({
    size: 5,
    ignoreChars: '0o1i',
    noise: 7, // More cut lines
    color: false, // Grey/black text
    background: '#ffffff' // Standard white background
  });
  
  const challenge_id = crypto.randomUUID();
  
  // Store expected text in Redis (DB 2) with a 5 minute expiration
  await gateClient.set(`gate:captcha_text:${challenge_id}`, captcha.text.toLowerCase(), 'EX', 300);
  
  return {
    challenge_id,
    image_svg: captcha.data
  };
}

function requireCaptchaIfSuspicious(endpointLabel, {
  windowSeconds = DEFAULT_RATE_WINDOW_SECONDS,
  threshold = DEFAULT_RATE_THRESHOLD,
} = {}) {
  return async (req, res, next) => {
    try {
      const ip = req.ip;
      const count = await bumpRequestRate(`${endpointLabel}:${ip}`, windowSeconds);

      if (count <= threshold) {
        return next(); 
      }

      const challengeState = await getChallengeState(`${endpointLabel}:${ip}`);
      if (challengeState && challengeState.status === 'passed') {
        return next();
      }

      // Check for submitted answer
      const captchaToken = req.body?.captchaToken;
      if (captchaToken && captchaToken.challenge_id && captchaToken.answer) {
        const verified = await verifyCaptchaToken(captchaToken);
        if (verified) {
          const { setChallengeState } = require('../services/redisSecurityClient');
          await setChallengeState(`${endpointLabel}:${ip}`, 'passed', 900); // 15 min grace
          return next();
        }
      }

      // Generate a new CAPTCHA if none was submitted or if it was wrong
      const challenge = await generateCaptchaChallenge();

      return res.status(403).json({
        captcha_required: true,
        challenge_id: challenge.challenge_id,
        image_svg: challenge.image_svg,
        message: 'Unusual request rate detected. Please complete the human-verification check to continue.',
      });
    } catch (err) {
      console.error('[captcha.middleware] error, failing open:', err.message);
      return next();
    }
  };
}

async function verifyCaptchaToken(tokenData) {
  if (!tokenData || !tokenData.challenge_id || !tokenData.answer) return false;
  
  try {
    const expectedText = await gateClient.get(`gate:captcha_text:${tokenData.challenge_id}`);
    if (!expectedText) return false; // Expired or invalid
    
    // Once used, delete it so it can't be re-used (replay attack prevention)
    await gateClient.del(`gate:captcha_text:${tokenData.challenge_id}`);
    
    return tokenData.answer.toLowerCase().trim() === expectedText;
  } catch (err) {
    console.error('[captcha.middleware] verify request failed:', err.message);
    return false;
  }
}

module.exports = { requireCaptchaIfSuspicious, verifyCaptchaToken, generateCaptchaChallenge };
