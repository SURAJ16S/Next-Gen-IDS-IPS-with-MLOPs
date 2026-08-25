import { useEffect, useState } from 'react';
import { getAdminThresholds, updateAdminThresholds, getAdminNetworkLogs } from '../services/api';
import {
  Network, Settings, CheckSquare, Square, RefreshCw,
  BarChart3, Globe, AlertTriangle, ArrowRightLeft
} from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

function AdminManageNetwork() {
  const [thresholds, setThresholds] = useState({
    bandwidthLimitMbps: 1000,
    ddosPacketThreshold: 10000,
    monitoredProtocols: { tcp: true, udp: true, icmp: false }
  });

  const [networkLogs, setNetworkLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');

  // Local simulated bandwidth trend
  const bandwidthData = [
    { time: '00:00', ingress: 240, egress: 180 },
    { time: '04:00', ingress: 320, egress: 210 },
    { time: '08:00', ingress: 580, egress: 420 },
    { time: '12:00', ingress: 750, egress: 610 },
    { time: '16:00', ingress: 910, egress: 780 },
    { time: '20:00', ingress: 430, egress: 310 }
  ];

  const fetchData = async () => {
    try {
      setLoading(true);
      setError('');
      const [thresholdsRes, logsRes] = await Promise.all([
        getAdminThresholds('network'),
        getAdminNetworkLogs()
      ]);
      if (thresholdsRes.data) {
        setThresholds(thresholdsRes.data);
      }
      setNetworkLogs(logsRes.data || []);
    } catch (err) {
      setError('Failed to fetch platform bandwidth and socket logs.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleSaveThresholds = async (e) => {
    e.preventDefault();
    try {
      setSaveSuccess('');
      await updateAdminThresholds('network', thresholds);
      setSaveSuccess('Network traffic alarms and protocol rules saved.');
      setTimeout(() => setSaveSuccess(''), 4000);
    } catch (err) {
      setError('Failed to save network configuration.');
    }
  };

  const toggleProtocol = (proto) => {
    setThresholds(prev => ({
      ...prev,
      monitoredProtocols: {
        ...prev.monitoredProtocols,
        [proto]: !prev.monitoredProtocols[proto]
      }
    }));
  };

  if (loading) {
    return (
      <div style={{ color: '#4b5563', padding: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <RefreshCw className="animate-spin" size={16} /> Loading network policies...
      </div>
    );
  }

  return (
    <div style={{ color: '#1f2937' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, margin: 0, color: '#111827', letterSpacing: '-0.5px' }}>Network Policy Settings</h1>
          <p style={{ fontSize: '13px', color: '#4b5563', marginTop: '4px' }}>Manage bandwidth alarms, select monitored network protocols, and inspect socket flow</p>
        </div>
        <button
          onClick={fetchData}
          style={{
            background: '#ffffff',
            border: '1px solid #d1d5db',
            color: '#374151',
            padding: '8px 16px',
            borderRadius: '6px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '13px',
            fontWeight: 600
          }}
        >
          <RefreshCw size={14} /> Refresh Netflow
        </button>
      </div>

      {saveSuccess && (
        <div style={{ padding: '12px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '6px', color: '#10b981', marginBottom: '20px' }}>
          {saveSuccess}
        </div>
      )}

      {error && (
        <div style={{ padding: '12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '6px', color: '#ef4444', marginBottom: '20px' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: '20px', marginBottom: '24px' }}>
        {/* Network configuration form */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
            <Settings size={18} color="#f59e0b" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Bandwidth & DDoS Alarms</h3>
          </div>

          <form onSubmit={handleSaveThresholds} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={labelStyle}>Bandwidth Limit Alert (Mbps)</label>
              <input
                type="number"
                value={thresholds.bandwidthLimitMbps}
                onChange={(e) => setThresholds({ ...thresholds, bandwidthLimitMbps: parseInt(e.target.value, 10) })}
                style={inputStyle}
                required
              />
            </div>

            <div>
              <label style={labelStyle}>DDoS Trigger Threshold (Packets/s)</label>
              <input
                type="number"
                value={thresholds.ddosPacketThreshold}
                onChange={(e) => setThresholds({ ...thresholds, ddosPacketThreshold: parseInt(e.target.value, 10) })}
                style={inputStyle}
                required
              />
            </div>

            <div>
              <label style={labelStyle}>Monitored Packet Protocols</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
                {Object.keys(thresholds.monitoredProtocols).map((proto) => (
                  <div
                    key={proto}
                    onClick={() => toggleProtocol(proto)}
                    style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', cursor: 'pointer', color: '#1f2937' }}
                  >
                    {thresholds.monitoredProtocols[proto] ? (
                      <CheckSquare size={16} color="#f59e0b" />
                    ) : (
                      <Square size={16} color="#6b7280" />
                    )}
                    <span style={{ textTransform: 'uppercase', fontWeight: 600 }}>{proto} Protocol</span>
                  </div>
                ))}
              </div>
            </div>

            <button
              type="submit"
              style={{
                background: '#f59e0b',
                color: '#fff',
                border: 'none',
                padding: '10px 16px',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 700,
                fontSize: '13.5px',
                marginTop: '10px'
              }}
            >
              Update Network Rules
            </button>
          </form>
        </div>

        {/* Live bandwidth charts */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
            <BarChart3 size={18} color="#10b981" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Platform Bandwidth Chart (Mbps)</h3>
          </div>

          <div style={{ height: '240px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={bandwidthData}>
                <defs>
                  <linearGradient id="ingressGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="egressGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="time" stroke="#4b5563" tick={{ fontSize: 11 }} />
                <YAxis stroke="#4b5563" tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '6px', color: '#1f2937' }} />
                <Area type="monotone" dataKey="ingress" stroke="#3b82f6" fillOpacity={1} fill="url(#ingressGrad)" name="Ingress Bandwidth" />
                <Area type="monotone" dataKey="egress" stroke="#10b981" fillOpacity={1} fill="url(#egressGrad)" name="Egress Bandwidth" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Sockets table */}
      <div style={panelStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
          <ArrowRightLeft size={18} color="#f59e0b" />
          <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Active Socket Connections (Global Netflow)</h3>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb', background: '#f9fafb', textAlign: 'left' }}>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Source Endpoint</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Destination Endpoint</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Protocol</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Port</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Packet Size</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {networkLogs.slice(0, 15).map((log) => (
                <tr key={log._id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px 16px', fontFamily: 'monospace', color: '#1f2937' }}>{log.sourceIP}</td>
                  <td style={{ padding: '10px 16px', fontFamily: 'monospace', color: '#1f2937' }}>{log.destinationIP || 'N/A'}</td>
                  <td style={{ padding: '10px 16px', textTransform: 'uppercase', fontWeight: 700, color: '#1f2937' }}>{log.protocol || 'TCP'}</td>
                  <td style={{ padding: '10px 16px', fontFamily: 'monospace', color: '#1f2937' }}>{log.port || '80'}</td>
                  <td style={{ padding: '10px 16px', color: '#1f2937' }}>{log.packetSize ? `${log.packetSize} B` : '124 B'}</td>
                  <td style={{ padding: '10px 16px' }}>
                    <span style={{
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 700,
                      background: log.status === 'blocked' ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)',
                      color: log.status === 'blocked' ? '#ef4444' : '#059669'
                    }}>
                      {log.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const panelStyle = {
  background: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  padding: '20px',
  boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
};

const inputStyle = {
  background: '#ffffff',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  padding: '8px 12px',
  color: '#1f2937',
  width: '100%',
  outline: 'none',
  boxSizing: 'border-box',
  marginTop: '4px'
};

const selectStyle = {
  background: '#ffffff',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  padding: '8px 12px',
  color: '#1f2937',
  width: '100%',
  outline: 'none',
  boxSizing: 'border-box',
  marginTop: '4px'
};

const labelStyle = {
  fontSize: '11px',
  fontWeight: 700,
  color: '#4b5563',
  textTransform: 'uppercase',
  letterSpacing: '0.06em'
};

export default AdminManageNetwork;
