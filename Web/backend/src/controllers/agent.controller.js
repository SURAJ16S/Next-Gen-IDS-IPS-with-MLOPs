const SecurityEvent = require('../models/SecurityEvent');
const NetworkEvent = require('../models/NetworkEvent');
const SystemLog = require('../models/SystemLog');
const { getIO } = require('../websocket/socket');

const normalizeProtocol = (p) => {
  if (!p) return 'HTTP';
  const u = String(p).toUpperCase();
  if (['HTTP', 'HTTPS', 'SSH', 'FTP', 'DNS'].includes(u)) return u;
  if (u === 'TELNET') return 'Telnet';
  return 'HTTP';
};

const normalizeSeverity = (s) => {
  if (!s) return 'low';
  const str = String(s).toLowerCase();
  if (str === 'info') return 'low';
  if (['low', 'medium', 'high', 'critical'].includes(str)) return str;
  return 'low';
};

const calculateRiskScore = (d, sevStr) => {
  if (typeof d.ml_risk_score === 'number') return d.ml_risk_score;
  if (typeof d.MLRiskScore === 'number') return d.MLRiskScore;
  if (typeof d.riskScore === 'number') return d.riskScore;
  const upper = String(sevStr).toUpperCase();
  if (upper === 'CRITICAL') return 95;
  if (upper === 'HIGH') return 80;
  if (upper === 'MEDIUM') return 50;
  return 20;
};

const ingestDetections = async (req, res) => {
  try {
    const rawList = req.body.detections || (Array.isArray(req.body) ? req.body : [req.body]);
    if (!rawList.length || !rawList[0]) {
      return res.status(200).json({ message: 'No detections to ingest', count: 0 });
    }

    const nodeId = req.node?.nodeId || null;
    const nodeOwner = req.node?.owner || null;

    const events = rawList.map(d => {
      const sevStr = d.severity_str || d.SeverityStr || d.severity || 'low';
      const normSev = normalizeSeverity(sevStr);
      const normProto = normalizeProtocol(d.protocol || d.Protocol);

      return {
        protocol: normProto,
        sourceIP: d.source_ip || d.SrcIP || d.sourceIP || '127.0.0.1',
        destinationIP: d.dest_ip || d.DstIP || d.destinationIP || '',
        attackType: d.category || d.Category || d.id || d.ID || 'anomaly',
        severity: normSev,
        action: normSev === 'critical' ? 'block' : 'alert',
        payload: d.raw_evidence || d.RawEvidence || d.summary || d.Summary || '',
        riskScore: calculateRiskScore(d, sevStr),
        nodeId: nodeId,
        nodeOwner: nodeOwner,
        createdAt: d.timestamp || d.Timestamp ? new Date(d.timestamp || d.Timestamp) : new Date(),
      };
    });

    const saved = await SecurityEvent.insertMany(events, { ordered: false });

    const io = getIO();
    saved.forEach(e => {
      if (nodeOwner) {
        io.to(`owner:${nodeOwner}`).emit('new_detection', e);
      }
      io.emit('new_detection', e);
    });

    res.status(201).json({ message: 'Ingested', count: saved.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const ingestConnections = async (req, res) => {
  try {
    const connections = req.body.connections || (Array.isArray(req.body) ? req.body : [req.body]);
    if (!connections.length || !connections[0]) {
      return res.status(200).json({ message: 'No connections to ingest', count: 0 });
    }

    const nodeId = req.node?.nodeId || null;
    const nodeOwner = req.node?.owner || null;

    const events = connections.map(c => ({
      eventType: 'Connection',
      source: req.node?.hostname || 'agent',
      sourceIP: c.client_ip || c.SrcIP || c.sourceIP || '127.0.0.1',
      destinationIP: c.backend_addr || c.DstIP || c.destinationIP || '',
      protocol: normalizeProtocol(c.detected_protocol || c.Protocol),
      bytesTransferred: (c.bytes_from_client || 0) + (c.bytes_to_client || 0) || c.TotalBytes || 0,
      timestamp: c.end_time || c.EndTime || new Date(),
      nodeId: nodeId,
      nodeOwner: nodeOwner,
    }));

    const saved = await NetworkEvent.insertMany(events, { ordered: false });

    const io = getIO();
    saved.forEach(e => {
      if (nodeOwner) {
        io.to(`owner:${nodeOwner}`).emit('new_connection', e);
      }
      io.emit('new_connection', e);
    });

    res.status(201).json({ message: 'Ingested', count: saved.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const ingestFlows = async (req, res) => {
  try {
    const flows = req.body.flows || (Array.isArray(req.body) ? req.body : [req.body]);

    const logs = flows.map(f => ({
      level: 'INFO',
      source: req.node?.hostname || 'agent',
      message: `Flow: ${f.SrcIP || f.source_ip}:${f.SrcPort || f.source_port} -> ${f.DstIP || f.dest_ip}:${f.DstPort || f.dest_port}`,
      meta: f,
      timestamp: f.Timestamp || f.timestamp || new Date(),
    }));

    await SystemLog.insertMany(logs);

    res.status(201).json({ message: 'Ingested' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { ingestDetections, ingestConnections, ingestFlows };
