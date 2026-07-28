const SystemLog = require('../models/SystemLog');

const requestLogger = async (req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

  // Only log state-changing operations to the database (avoid flooding with GET requests)
  if (req.method === 'GET' || req.method === 'OPTIONS') {
    return next();
  }

  try {
    await SystemLog.create({
      level: 'info',
      source: 'audit-logger',
      message: `${req.method} ${req.originalUrl}`,
      meta: { ip, userAgent: req.headers['user-agent'] },
    });
  } catch (err) {
    console.error('Request log failed:', err.message);
  }

  next();
};

module.exports = requestLogger;