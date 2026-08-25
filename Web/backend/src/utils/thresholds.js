const AdminThreshold = require('../models/AdminThreshold');

const DEFAULTS = {
  devops: {
    maxBuildsPerUser: 5,
    maxConcurrentContainers: 3,
    allowedPortRangeMin: 3000,
    allowedPortRangeMax: 4000,
    buildTimeoutSeconds: 600,
    pipelineSteps: { extract: true, techDetect: true, install: true, sast: true, build: true },
    githubEnabled: true
  },
  agent: {
    maxTokensPerUser: 100000,
    maxSessionsPerUser: 5,
    modelName: 'llama3',
    rateLimitPerMinute: 60
  },
  threats: {
    autoBlockThreshold: 10,
    alertSensitivity: 'medium',
    criticalAlertEmail: 'admin@ngfw.io'
  },
  network: {
    bandwidthAlertMbps: 100,
    alertSensitivity: 'medium',
    monitoredProtocols: { tcp: true, udp: true, icmp: true, http: true }
  },
  logs: {
    retentionDays: 30,
    maxLogEntries: 10000,
    defaultSeverityFilter: 'all'
  },
  nodes: {
    maxNodesPerUser: 5,
    cpuAlertPercent: 80,
    memAlertPercent: 85
  }
};

const getThresholds = async (feature) => {
  try {
    const doc = await AdminThreshold.findOne({ feature });
    if (doc && doc.config) {
      // Merge with defaults to ensure all fields are present
      return { ...DEFAULTS[feature], ...doc.config };
    }
  } catch (err) {
    console.error(`Error getting thresholds for ${feature}:`, err);
  }
  return DEFAULTS[feature];
};

module.exports = { getThresholds, DEFAULTS };
