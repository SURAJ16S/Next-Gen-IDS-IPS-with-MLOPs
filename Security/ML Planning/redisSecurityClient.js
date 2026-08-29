// Web/backend/src/services/redisSecurityClient.js
//
// A SECOND, separate ioredis connection dedicated to IDS/IPS security data
// (reputation, rolling per-IP counters, CAPTCHA gate state) — deliberately
// isolated from any Redis usage the DevOps/agent module has (see
// agent-memory.service.js), so an issue in one never takes down the other.
//
// Env var: REDIS_SECURITY_URL, e.g. redis://localhost:6379
// Uses three logical DBs on the same instance (see master plan section 2.2):
//   DB 0 = reputation, DB 1 = rolling counters, DB 2 = CAPTCHA/rate gate

const Redis = require('ioredis');

const REDIS_SECURITY_URL = process.env.REDIS_SECURITY_URL || 'redis://localhost:6379';

function makeClient(db) {
  const client = new Redis(REDIS_SECURITY_URL, {
    db,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    maxRetriesPerRequest: 2,
  });
  client.on('error', (err) => {
    // Fail open, never crash the process on a Redis hiccup — security
    // features degrade to Mongo-only in that window, they don't take the
    // API down. Log loudly so it's visible in ops.
    console.error(`[redisSecurityClient][db=${db}] error:`, err.message);
  });
  return client;
}

const repClient = makeClient(0); // reputation
const rollClient = makeClient(1); // rolling per-IP counters
const gateClient = makeClient(2); // captcha / rate gate

// ---------------------------------------------------------------------------
// Reputation helpers (mirror redis_reputation.py — keep both in sync)
// ---------------------------------------------------------------------------

async function getReputation(ip) {
  const data = await repClient.hgetall(`rep:ip:${ip}`);
  if (!data || Object.keys(data).length === 0) {
    return { ip, score: 0, knownBad: false, found: false };
  }
  const score = parseInt(data.score || '0', 10);
  return { ip, score, knownBad: score >= 80, source: data.source, found: true };
}

async function isKnownBadFeedIp(ip, feedNames = ['abuseipdb', 'spamhaus_drop', 'firehol', 'cins_army']) {
  for (const feed of feedNames) {
    // eslint-disable-next-line no-await-in-loop
    const isMember = await repClient.sismember(`rep:feed:${feed}`, ip);
    if (isMember) return feed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block cache (fast-path only — BlockedEntity in Mongo is the source of truth)
// ---------------------------------------------------------------------------

async function cacheBlock(ip, ttlSeconds) {
  const key = `gate:blocked:${ip}`;
  if (ttlSeconds) {
    await gateClient.set(key, '1', 'EX', ttlSeconds);
  } else {
    await gateClient.set(key, '1');
  }
}

async function clearBlockCache(ip) {
  await gateClient.del(`gate:blocked:${ip}`);
}

async function isBlockedCache(ip) {
  const exists = await gateClient.exists(`gate:blocked:${ip}`);
  return exists === 1;
}

// ---------------------------------------------------------------------------
// CAPTCHA / request-rate gate (see captcha.middleware.js for usage)
// ---------------------------------------------------------------------------

async function bumpRequestRate(ip, windowSeconds = 10) {
  const key = `gate:reqrate:${ip}`;
  const count = await gateClient.incr(key);
  if (count === 1) {
    await gateClient.expire(key, windowSeconds);
  }
  return count;
}

async function setChallengeState(key, status, ttlSeconds = 900) {
  await gateClient.hset(`gate:challenge:${key}`, {
    status,
    issued_at: Date.now(),
  });
  await gateClient.expire(`gate:challenge:${key}`, ttlSeconds);
}

async function getChallengeState(key) {
  return gateClient.hgetall(`gate:challenge:${key}`);
}

module.exports = {
  repClient,
  rollClient,
  gateClient,
  getReputation,
  isKnownBadFeedIp,
  cacheBlock,
  clearBlockCache,
  isBlockedCache,
  bumpRequestRate,
  setChallengeState,
  getChallengeState,
};
