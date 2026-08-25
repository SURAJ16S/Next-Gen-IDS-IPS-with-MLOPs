const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      let userDoc = await User.findById(decoded.id).select('-password');
      if (!userDoc) {
        const Admin = require('../models/Admin');
        userDoc = await Admin.findById(decoded.id).select('-password');
      }
      if (userDoc && userDoc.status === 'banned') {
        return res.status(403).json({ message: 'Your account has been banned. Access denied.' });
      }
      req.user = userDoc;
      next();
    } catch (error) {
      res.status(401).json({ message: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    res.status(401).json({ message: 'Not authorized, no token' });
  }
};

/** Restrict route to superadmin or admin roles only. Must be used after `protect`. */
const adminOnly = (req, res, next) => {
  if (req.user && (req.user.role === 'superadmin' || req.user.role === 'admin')) {
    return next();
  }
  return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
};

const checkGithubEnabled = async (req, res, next) => {
  try {
    const { getThresholds } = require('../utils/thresholds');
    const threshold = await getThresholds('devops');
    if (threshold && threshold.githubEnabled === false) {
      // Check if it is a redirect request (browser page request)
      if (req.accepts('html') && req.method === 'GET' && !req.xhr) {
        return res.send('<h3>GitHub Integration has been disabled by the administrator.</h3>');
      }
      return res.status(403).json({ message: 'GitHub Integration has been disabled by the administrator.' });
    }
  } catch (err) {
    console.error('Error in checkGithubEnabled middleware:', err);
  }
  next();
};

module.exports = { protect, adminOnly, checkGithubEnabled };