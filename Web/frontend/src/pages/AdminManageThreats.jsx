import { useEffect, useState } from 'react';
import { getAdminThresholds, updateAdminThresholds, getAdminThreats } from '../services/api';
import {
  ShieldAlert, Settings, Shield, Plus, Trash2, RefreshCw,
  AlertOctagon, CheckCircle2, Search, Skull
} from 'lucide-react';

function AdminManageThreats() {
  const [thresholds, setThresholds] = useState({
    autoBlockThreshold: 10,
    alertSensitivity: 'medium',
    criticalAlertEmail: 'admin@ngfw.io',
    ipBlocklist: ['192.168.1.150', '10.0.0.99', '45.227.254.12']
  });

  const [threats, setThreats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newIp, setNewIp] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');

  const fetchData = async () => {
    try {
      setLoading(true);
      setError('');
      const [thresholdsRes, threatsRes] = await Promise.all([
        getAdminThresholds('threats'),
        getAdminThreats()
      ]);
      if (thresholdsRes.data) {
        setThresholds({
          ...thresholdsRes.data,
          ipBlocklist: thresholdsRes.data.ipBlocklist || ['192.168.1.150', '10.0.0.99', '45.227.254.12']
        });
      }
      setThreats(threatsRes.data || []);
    } catch (err) {
      setError('Failed to fetch threat intelligence data');
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
      await updateAdminThresholds('threats', thresholds);
      setSaveSuccess('Intrusion detection parameters and policy rules saved.');
      setTimeout(() => setSaveSuccess(''), 4000);
    } catch (err) {
      setError('Failed to save threat policies.');
    }
  };

  const handleAddIp = (e) => {
    e.preventDefault();
    if (!newIp.trim()) return;
    if (thresholds.ipBlocklist.includes(newIp.trim())) {
      alert('IP address is already blocked.');
      return;
    }
    setThresholds(prev => ({
      ...prev,
      ipBlocklist: [...prev.ipBlocklist, newIp.trim()]
    }));
    setNewIp('');
  };

  const handleRemoveIp = (ipToRemove) => {
    setThresholds(prev => ({
      ...prev,
      ipBlocklist: prev.ipBlocklist.filter(ip => ip !== ipToRemove)
    }));
  };

  if (loading) {
    return (
      <div style={{ color: '#4b5563', padding: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <RefreshCw className="animate-spin" size={16} /> Loading threat management...
      </div>
    );
  }

  return (
    <div style={{ color: '#1f2937' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, margin: 0, color: '#111827', letterSpacing: '-0.5px' }}>Threat Policy Controls</h1>
          <p style={{ fontSize: '13px', color: '#4b5563', marginTop: '4px' }}>Establish intrusion block thresholds, manage blacklisted IPs, and view global logs</p>
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
          <RefreshCw size={14} /> Refresh Threat Feed
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>
        {/* Threat Config */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
            <Settings size={18} color="#f59e0b" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Intrusion Mitigation Parameters</h3>
          </div>

          <form onSubmit={handleSaveThresholds} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={labelStyle}>Auto Block Trigger Score Threshold</label>
              <input
                type="number"
                value={thresholds.autoBlockThreshold}
                onChange={(e) => setThresholds({ ...thresholds, autoBlockThreshold: parseInt(e.target.value, 10) })}
                style={inputStyle}
                required
              />
              <span style={{ fontSize: '10.5px', color: '#6b7280', marginTop: '4px', display: 'block' }}>
                Forcibly bans IP endpoints whose risk score reaches this limit.
              </span>
            </div>

            <div>
              <label style={labelStyle}>Alert Detection Sensitivity</label>
              <select
                value={thresholds.alertSensitivity}
                onChange={(e) => setThresholds({ ...thresholds, alertSensitivity: e.target.value })}
                style={selectStyle}
              >
                <option value="low">Low (Fewer alerts, lowest false positives)</option>
                <option value="medium">Medium (Standard baseline)</option>
                <option value="high">High (Maximum enforcement, high alert rate)</option>
              </select>
            </div>

            <div>
              <label style={labelStyle}>Emergency Administrator Alert Email</label>
              <input
                type="email"
                value={thresholds.criticalAlertEmail}
                onChange={(e) => setThresholds({ ...thresholds, criticalAlertEmail: e.target.value })}
                style={inputStyle}
                required
              />
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
              Update Intrusion Policies
            </button>
          </form>
        </div>

        {/* IP Blocklist */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
            <Skull size={18} color="#ef4444" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Permanently Blocked Endpoints (IP Blacklist)</h3>
          </div>

          <form onSubmit={handleAddIp} style={{ display: 'flex', gap: '10px', marginBottom: '14px' }}>
            <input
              type="text"
              placeholder="e.g. 185.220.101.5"
              value={newIp}
              onChange={(e) => setNewIp(e.target.value)}
              style={{ ...inputStyle, marginTop: 0, flex: 1 }}
              required
            />
            <button
              type="submit"
              style={{
                background: '#ef4444',
                color: '#fff',
                border: 'none',
                padding: '0 16px',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '13px'
              }}
            >
              Block Endpoint
            </button>
          </form>

          <div style={{ maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {thresholds.ipBlocklist.map((ip) => (
              <div
                key={ip}
                style={{
                  background: '#f9fafb',
                  border: '1px solid #e5e7eb',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '13px'
                }}
              >
                <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#1f2937' }}>{ip}</span>
                <button
                  onClick={() => handleRemoveIp(ip)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#6b7280',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = '#ef4444'}
                  onMouseLeave={(e) => e.currentTarget.style.color = '#6b7280'}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Threat log feed */}
      <div style={panelStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
          <AlertOctagon size={18} color="#ef4444" />
          <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Global Platform Threat Intelligence Feed</h3>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb', background: '#f9fafb', textAlign: 'left' }}>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Type</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Source Address</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Severity</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Risk Score</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {threats.slice(0, 15).map((t) => {
                const isHigh = t.riskScore >= 70;
                return (
                  <tr key={t._id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 16px', fontWeight: 700, color: '#1f2937' }}>{t.threatType}</td>
                    <td style={{ padding: '10px 16px', fontFamily: 'monospace', color: '#1f2937' }}>{t.sourceIP}</td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        fontWeight: 700,
                        background: isHigh ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
                        color: isHigh ? '#ef4444' : '#d97706'
                      }}>
                        {isHigh ? 'Critical' : 'Medium'}
                      </span>
                    </td>
                    <td style={{ padding: '10px 16px', fontWeight: 700, color: '#1f2937' }}>{t.riskScore}</td>
                    <td style={{ padding: '10px 16px', color: '#4b5563' }}>
                      {new Date(t.createdAt).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
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

export default AdminManageThreats;
