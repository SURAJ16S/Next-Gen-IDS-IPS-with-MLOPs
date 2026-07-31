const SecurityEvent = require('../models/SecurityEvent');
const NetworkEvent = require('../models/NetworkEvent');
const SystemLog = require('../models/SystemLog');
const { getIO } = require('../websocket/socket');

const ingestDetections = async (req, res) => {
  try {
    const detections = req.body.detections || [req.body];
    
    const events = detections.map(d => ({
      eventType: 'Threat',
      severity: d.Confidence > 80 ? 'CRITICAL' : 'HIGH',
      source: req.node.hostname,
      description: d.RuleName || 'Anomaly detected',
      details: d,
      timestamp: d.Timestamp || new Date()
    }));
    
    const saved = await SecurityEvent.insertMany(events);
    saved.forEach(e => getIO().emit('new_detection', e));
    
    res.status(201).json({ message: 'Ingested', count: saved.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const ingestConnections = async (req, res) => {
  try {
    const connections = req.body.connections || [req.body];
    
    const events = connections.map(c => ({
      eventType: 'Connection',
      source: req.node.hostname,
      sourceIP: c.SrcIP,
      destinationIP: c.DstIP,
      protocol: c.Protocol,
      bytesTransferred: c.TotalBytes,
      timestamp: c.EndTime || new Date()
    }));
    
    const saved = await NetworkEvent.insertMany(events);
    saved.forEach(e => getIO().emit('new_connection', e));
    
    res.status(201).json({ message: 'Ingested', count: saved.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const ingestFlows = async (req, res) => {
  try {
    const flows = req.body.flows || [req.body];
    
    const logs = flows.map(f => ({
      level: 'INFO',
      source: req.node.hostname,
      message: `Flow: ${f.SrcIP}:${f.SrcPort} -> ${f.DstIP}:${f.DstPort}`,
      meta: f,
      timestamp: f.Timestamp || new Date()
    }));
    
    await SystemLog.insertMany(logs);
    
    res.status(201).json({ message: 'Ingested' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { ingestDetections, ingestConnections, ingestFlows };
