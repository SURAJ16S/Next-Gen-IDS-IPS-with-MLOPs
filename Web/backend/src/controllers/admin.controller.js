const User = require('../models/User');
const Admin = require('../models/Admin');
const Deployment = require('../models/Deployment');
const Threat = require('../models/Threat');
const NetworkEvent = require('../models/NetworkEvent');
const SystemLog = require('../models/SystemLog');
const AgentTokenUsage = require('../models/AgentTokenUsage');
const AdminThreshold = require('../models/AdminThreshold');
const { getThresholds } = require('../utils/thresholds');

// ─── Dashboard Stats ─────────────────────────────────────────────────────────
exports.getAdminDashboardStats = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalAdmins = await Admin.countDocuments();
    const totalBuilds = await Deployment.countDocuments();
    const totalThreats = await Threat.countDocuments();
    const totalNetworkEvents = await NetworkEvent.countDocuments();
    
    // Today's stats
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const buildsToday = await Deployment.countDocuments({ createdAt: { $gte: startOfToday } });
    const threatsToday = await Threat.countDocuments({ createdAt: { $gte: startOfToday } });

    // Sum total tokens
    const tokenDocs = await AgentTokenUsage.find();
    let totalTokens = 0;
    tokenDocs.forEach(d => { totalTokens += d.totalTokens || 0; });

    // Simulated system load for premium Cloudflare/Hostinger feel
    const systemHealth = {
      cpuUsage: Math.floor(15 + Math.random() * 30),
      memoryUsage: Math.floor(40 + Math.random() * 25),
      diskUsage: 54,
      uptimeDays: 12
    };

    // Activity trend: group last 7 days of threats and builds
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentBuilds = await Deployment.find({ createdAt: { $gte: sevenDaysAgo } }).select('createdAt status');
    const recentThreats = await Threat.find({ createdAt: { $gte: sevenDaysAgo } }).select('createdAt');

    // Simple day builder
    const dayCounts = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toLocaleDateString('en-US', { weekday: 'short' });
      dayCounts[dateStr] = { date: dateStr, builds: 0, threats: 0 };
    }

    recentBuilds.forEach(b => {
      const dateStr = new Date(b.createdAt).toLocaleDateString('en-US', { weekday: 'short' });
      if (dayCounts[dateStr]) dayCounts[dateStr].builds++;
    });

    recentThreats.forEach(t => {
      const dateStr = new Date(t.createdAt).toLocaleDateString('en-US', { weekday: 'short' });
      if (dayCounts[dateStr]) dayCounts[dateStr].threats++;
    });

    res.json({
      totalUsers,
      totalAdmins,
      totalBuilds,
      totalThreats,
      totalNetworkEvents,
      buildsToday,
      threatsToday,
      totalTokens,
      systemHealth,
      activityTrend: Object.values(dayCounts)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Users Management ────────────────────────────────────────────────────────
exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find().select('-password').lean();
    const admins = await Admin.find().select('-password').lean();

    // Map build count per user
    const userIds = users.map(u => u._id);
    const builds = await Deployment.aggregate([
      { $match: { deployedBy: { $in: userIds } } },
      { $group: { _id: '$deployedBy', count: { $sum: 1 } } }
    ]);

    const buildCountMap = {};
    builds.forEach(b => {
      if (b._id) buildCountMap[b._id.toString()] = b.count;
    });

    const enrichedUsers = users.map(u => ({
      ...u,
      type: 'user',
      buildCount: buildCountMap[u._id.toString()] || 0
    }));

    const enrichedAdmins = admins.map(a => ({
      ...a,
      type: 'admin',
      buildCount: 0
    }));

    // Combine list
    res.json([...enrichedAdmins, ...enrichedUsers]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    let user = await User.findById(id);
    let source = 'user';
    if (!user) {
      user = await Admin.findById(id);
      source = 'admin';
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if migration is needed
    const targetIsAdmin = (role === 'admin' || role === 'superadmin');

    if (source === 'user' && targetIsAdmin) {
      // Migrate from User (users) to Admin (admins)
      const userData = user.toObject();
      userData.role = role;

      // Delete from User
      await User.findByIdAndDelete(id);

      // Create in Admin (retaining same ObjectId _id)
      const newAdmin = await Admin.create(userData);
      return res.json({ message: `User promoted and migrated to Admin collection successfully.`, user: newAdmin });
    } else if (source === 'admin' && !targetIsAdmin) {
      // Migrate from Admin (admins) to User (users)
      const adminData = user.toObject();
      adminData.role = 'user'; // Standard User role

      // Delete from Admin
      await Admin.findByIdAndDelete(id);

      // Create in User (retaining same ObjectId _id)
      const newUser = await User.create(adminData);
      return res.json({ message: `Admin demoted and migrated to User collection successfully.`, user: newUser });
    } else {
      // No collection migration needed (e.g. admin -> superadmin, or user -> user)
      user.role = role;
      await user.save();
      return res.json({ message: `Role updated to ${role} successfully.`, user });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'active' or 'banned'

    let user = await User.findById(id);
    let Model = User;
    if (!user) {
      user = await Admin.findById(id);
      Model = Admin;
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Protect superadmin from being self-banned/banned
    if (user.role === 'superadmin') {
      return res.status(400).json({ message: 'Superadmin status cannot be modified' });
    }

    user.status = status;
    await user.save();

    res.json({ message: `User status updated to ${status} successfully.`, user });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Thresholds Management ──────────────────────────────────────────────────
exports.getFeatureThresholds = async (req, res) => {
  try {
    const { feature } = req.params;
    const config = await getThresholds(feature);
    res.json(config);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateFeatureThresholds = async (req, res) => {
  try {
    const { feature } = req.params;
    const { config } = req.body;

    const doc = await AdminThreshold.findOneAndUpdate(
      { feature },
      { config, updatedBy: req.user._id },
      { new: true, upsert: true }
    );

    res.json(doc.config);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Live Platform Mirror Lists (God view) ──────────────────────────────────
exports.getAllDeployments = async (req, res) => {
  try {
    const deployments = await Deployment.find()
      .populate('deployedBy', 'firstName lastName email username')
      .sort({ createdAt: -1 });
    res.json(deployments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAllThreats = async (req, res) => {
  try {
    const threats = await Threat.find().sort({ createdAt: -1 });
    res.json(threats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAllNetworkEvents = async (req, res) => {
  try {
    const events = await NetworkEvent.find().sort({ createdAt: -1 }).limit(100);
    res.json(events);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAllSystemLogs = async (req, res) => {
  try {
    const logs = await SystemLog.find().sort({ createdAt: -1 }).limit(200);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.purgeLogs = async (req, res) => {
  try {
    const { beforeDate } = req.body; // ISO String
    const cutoff = new Date(beforeDate);
    const result = await SystemLog.deleteMany({ createdAt: { $lt: cutoff } });
    res.json({ message: `Purged ${result.deletedCount} log entries before ${cutoff.toLocaleDateString()}` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
