import { useEffect, useState } from 'react';
import { getAdminBlockedEntities, unblockAdminEntity, createAdminBlock, getAdminThresholds, updateAdminThresholds } from '../services/api';
import { ShieldAlert, Settings, RefreshCw, XCircle, Shield, AlertTriangle } from 'lucide-react';
import io from 'socket.io-client';

const panelStyle = {
  background: '#ffffff',
  borderRadius: '8px',
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  border: '1px solid #e5e7eb',
  padding: '24px'
};

const labelStyle = {
  display: 'block',
  fontSize: '13px',
  fontWeight: 600,
  color: '#4b5563',
  marginBottom: '4px'
};

const inputStyle = {
  width: '100%',
  padding: '8px 12px',
  borderRadius: '6px',
  border: '1px solid #d1d5db',
  fontSize: '14px',
  boxSizing: 'border-box'
};

function AdminManageBlocklist() {
  const [blockedEntities, setBlockedEntities] = useState([]);
  const [thresholds, setThresholds] = useState({
    autoBlockEnabled: true,
    autoBlockThreshold: 80,
    autoAlertThreshold: 50
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');
  
  const [filter, setFilter] = useState('All');
  
  // Form State
  const [newBlock, setNewBlock] = useState({ ip: '', action: 'block', reason: '' });

  const fetchData = async () => {
    try {
      setLoading(true);
      setError('');
      const [blockedRes, thresholdsRes] = await Promise.all([
        getAdminBlockedEntities(),
        getAdminThresholds('autoBlock')
      ]);
      setBlockedEntities(blockedRes.data || []);
      if (thresholdsRes.data) {
        setThresholds(thresholdsRes.data);
      }
    } catch (err) {
      setError('Failed to fetch blocklist data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    
    // Socket.io for live updates
    const socket = io('http://localhost:5000', { path: '/socket.io' });
    socket.on('block:new', (record) => {
      setBlockedEntities(prev => [record, ...prev]);
    });
    return () => socket.disconnect();
  }, []);

  const handleSaveThresholds = async (e) => {
    e.preventDefault();
    try {
      setSaveSuccess('');
      await updateAdminThresholds('autoBlock', thresholds);
      setSaveSuccess('Auto-block settings saved.');
      setTimeout(() => setSaveSuccess(''), 4000);
    } catch (err) {
      setError('Failed to save configuration.');
    }
  };

  const handleManualBlock = async (e) => {
    e.preventDefault();
    try {
      await createAdminBlock(newBlock);
      setNewBlock({ ip: '', action: 'block', reason: '' });
      fetchData(); // Refresh list
    } catch (err) {
      setError('Failed to block entity.');
    }
  };

  const handleUnblock = async (id) => {
    try {
      await unblockAdminEntity(id);
      fetchData();
    } catch (err) {
      setError('Failed to unblock entity.');
    }
  };

  if (loading) {
    return (
      <div style={{ color: '#4b5563', padding: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <RefreshCw className="animate-spin" size={16} /> Loading blocklist...
      </div>
    );
  }

  const filteredEntities = blockedEntities.filter(entity => {
    if (filter === 'All') return true;
    if (filter === 'Active') return entity.status === 'active';
    if (filter === 'Unblocked') return entity.status === 'unblocked';
    if (filter === 'Manual') return entity.mode === 'manual';
    if (filter === 'Automatic') return entity.mode === 'auto';
    return true;
  });

  return (
    <div style={{ color: '#1f2937' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, margin: 0, color: '#111827', letterSpacing: '-0.5px' }}>Blocklist Management</h1>
          <p style={{ fontSize: '13px', color: '#4b5563', marginTop: '4px' }}>Manage IP blocks, auto-blocking thresholds, and threat mitigation</p>
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
          <RefreshCw size={14} /> Refresh List
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
        {/* Manual Block Form */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
            <ShieldAlert size={18} color="#ef4444" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Manual Block</h3>
          </div>
          <form onSubmit={handleManualBlock} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={labelStyle}>IP Address or Target</label>
              <input
                type="text"
                value={newBlock.ip}
                onChange={(e) => setNewBlock({ ...newBlock, ip: e.target.value })}
                style={inputStyle}
                placeholder="e.g. 192.168.1.50"
                required
              />
            </div>
            <div>
              <label style={labelStyle}>Action Type</label>
              <select
                value={newBlock.action}
                onChange={(e) => setNewBlock({ ...newBlock, action: e.target.value })}
                style={inputStyle}
              >
                <option value="block">Hard Block</option>
                <option value="tarpit">Tarpit (Delay)</option>
                <option value="rate_limit">Rate Limit</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>Reason</label>
              <input
                type="text"
                value={newBlock.reason}
                onChange={(e) => setNewBlock({ ...newBlock, reason: e.target.value })}
                style={inputStyle}
                placeholder="Observed malicious behavior..."
                required
              />
            </div>
            <button
              type="submit"
              style={{
                background: '#ef4444',
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
              Apply Block
            </button>
          </form>
        </div>

        {/* Threshold Settings */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
            <Settings size={18} color="#f59e0b" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Auto-Block Policy</h3>
          </div>
          <form onSubmit={handleSaveThresholds} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                id="autoBlockEnabled"
                checked={thresholds.autoBlockEnabled}
                onChange={(e) => setThresholds({ ...thresholds, autoBlockEnabled: e.target.checked })}
              />
              <label htmlFor="autoBlockEnabled" style={{ fontSize: '14px', fontWeight: 600 }}>Enable Automatic Blocking</label>
            </div>
            <div>
              <label style={labelStyle}>Auto-Block Threshold (Risk Score)</label>
              <input
                type="number"
                value={thresholds.autoBlockThreshold}
                onChange={(e) => setThresholds({ ...thresholds, autoBlockThreshold: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min="1"
                max="100"
                required
              />
              <p style={{ fontSize: '12px', color: '#6b7280', margin: '4px 0 0 0' }}>Entities reaching this risk score will be blocked automatically.</p>
            </div>
            <div>
              <label style={labelStyle}>Alert Threshold (Risk Score)</label>
              <input
                type="number"
                value={thresholds.autoAlertThreshold}
                onChange={(e) => setThresholds({ ...thresholds, autoAlertThreshold: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min="1"
                max="100"
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
              Update Policy
            </button>
          </form>
        </div>
      </div>

      {/* Blocklist Table */}
      <div style={panelStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Shield size={18} color="#3b82f6" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Blocked Entities</h3>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {['All', 'Active', 'Unblocked', 'Manual', 'Automatic'].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  padding: '4px 10px',
                  borderRadius: '16px',
                  fontSize: '12px',
                  fontWeight: 600,
                  border: filter === f ? 'none' : '1px solid #d1d5db',
                  background: filter === f ? '#e0e7ff' : '#fff',
                  color: filter === f ? '#4338ca' : '#4b5563',
                  cursor: 'pointer'
                }}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb', background: '#f9fafb', textAlign: 'left' }}>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>IP / Target</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Reason</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Action</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Mode</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Score</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Status</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Unblock</th>
              </tr>
            </thead>
            <tbody>
              {filteredEntities.length === 0 ? (
                <tr>
                  <td colSpan="7" style={{ textAlign: 'center', padding: '20px', color: '#6b7280' }}>
                    No records match the current filter.
                  </td>
                </tr>
              ) : (
                filteredEntities.map((entity) => (
                  <tr key={entity._id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 16px', fontFamily: 'monospace', fontWeight: 700, color: '#111827' }}>{entity.ip}</td>
                    <td style={{ padding: '10px 16px', color: '#4b5563' }}>{entity.reason}</td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ 
                        background: entity.action === 'block' ? '#fee2e2' : '#fef3c7',
                        color: entity.action === 'block' ? '#991b1b' : '#92400e',
                        padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase'
                      }}>
                        {entity.action}
                      </span>
                    </td>
                    <td style={{ padding: '10px 16px', textTransform: 'capitalize' }}>{entity.mode}</td>
                    <td style={{ padding: '10px 16px', color: entity.riskScore > 80 ? '#ef4444' : '#1f2937', fontWeight: 600 }}>
                      {entity.riskScore || '-'}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {entity.status === 'active' ? (
                        <span style={{ color: '#ef4444', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <XCircle size={14} /> Active
                        </span>
                      ) : (
                        <span style={{ color: '#10b981', fontWeight: 600 }}>Unblocked</span>
                      )}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {entity.status === 'active' && (
                        <button
                          onClick={() => handleUnblock(entity._id)}
                          style={{
                            background: 'transparent',
                            border: '1px solid #d1d5db',
                            color: '#374151',
                            padding: '4px 8px',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '11px',
                            fontWeight: 600
                          }}
                        >
                          Unblock
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default AdminManageBlocklist;
