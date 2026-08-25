import { useEffect, useState } from 'react';
import { getAdminThresholds, updateAdminThresholds, getNodes, revokeNode } from '../services/api';
import {
  Cpu, Settings, RefreshCw, AlertCircle, Ban, Server,
  CheckCircle2, PlusCircle
} from 'lucide-react';

function AdminManageNodes() {
  const [thresholds, setThresholds] = useState({
    maxNodesPerUser: 5,
    cpuAlertPercent: 80,
    memAlertPercent: 85
  });

  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');
  const [actionLoadingId, setActionLoadingId] = useState(null);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError('');
      const [thresholdsRes, nodesRes] = await Promise.all([
        getAdminThresholds('nodes'),
        getNodes()
      ]);
      if (thresholdsRes.data) {
        setThresholds(thresholdsRes.data);
      }
      setNodes(nodesRes.data || []);
    } catch (err) {
      setError('Failed to fetch platform cluster nodes.');
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
      await updateAdminThresholds('nodes', thresholds);
      setSaveSuccess('Cluster nodes and telemetry alerts configuration updated.');
      setTimeout(() => setSaveSuccess(''), 4000);
    } catch (err) {
      setError('Failed to save node policies.');
    }
  };

  const handleRevokeNode = async (nodeId) => {
    if (!window.confirm('Are you sure you want to revoke this node? This will immediately terminate its access credentials.')) return;
    try {
      setActionLoadingId(nodeId);
      await revokeNode(nodeId);
      setNodes(prev => prev.filter(n => n._id !== nodeId));
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to revoke cluster node.');
    } finally {
      setActionLoadingId(null);
    }
  };

  if (loading) {
    return (
      <div style={{ color: '#4b5563', padding: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <RefreshCw className="animate-spin" size={16} /> Loading cluster nodes...
      </div>
    );
  }

  return (
    <div style={{ color: '#1f2937' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, margin: 0, color: '#111827', letterSpacing: '-0.5px' }}>Cluster Node Controls</h1>
          <p style={{ fontSize: '13px', color: '#4b5563', marginTop: '4px' }}>Set cluster CPU/Memory alerts, manage enrollment limits, and revoke node keys</p>
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
          <RefreshCw size={14} /> Refresh Cluster
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: '20px' }}>
        {/* Nodes threshold settings */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
            <Settings size={18} color="#f59e0b" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Cluster Guard Limits</h3>
          </div>

          <form onSubmit={handleSaveThresholds} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={labelStyle}>Max Enrolled Nodes Per User</label>
              <input
                type="number"
                value={thresholds.maxNodesPerUser}
                onChange={(e) => setThresholds({ ...thresholds, maxNodesPerUser: parseInt(e.target.value, 10) })}
                style={inputStyle}
                required
              />
            </div>

            <div>
              <label style={labelStyle}>Telemetry CPU Alert Level (%)</label>
              <input
                type="number"
                value={thresholds.cpuAlertPercent}
                onChange={(e) => setThresholds({ ...thresholds, cpuAlertPercent: parseInt(e.target.value, 10) })}
                style={inputStyle}
                required
              />
            </div>

            <div>
              <label style={labelStyle}>Telemetry Memory Alert Level (%)</label>
              <input
                type="number"
                value={thresholds.memAlertPercent}
                onChange={(e) => setThresholds({ ...thresholds, memAlertPercent: parseInt(e.target.value, 10) })}
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
              Update Cluster Rules
            </button>
          </form>
        </div>

        {/* Live cluster nodes registry table */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
            <Server size={18} color="#10b981" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Live Cluster Nodes Registry ({nodes.length})</h3>
          </div>

          {nodes.length === 0 ? (
            <div style={{ color: '#4b5563', fontSize: '13px', textAlign: 'center', padding: '30px' }}>
              No platform cluster nodes currently enrolled.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #e5e7eb', background: '#f9fafb', textAlign: 'left' }}>
                    <th style={{ padding: '8px 12px', color: '#4b5563', fontWeight: 600 }}>Node Name</th>
                    <th style={{ padding: '8px 12px', color: '#4b5563', fontWeight: 600 }}>Host Address</th>
                    <th style={{ padding: '8px 12px', color: '#4b5563', fontWeight: 600 }}>CPU/Mem</th>
                    <th style={{ padding: '8px 12px', color: '#4b5563', fontWeight: 600 }}>Status</th>
                    <th style={{ padding: '8px 12px', color: '#4b5563', fontWeight: 600, textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((n) => {
                    const isCpuHigh = n.cpuUsage >= thresholds.cpuAlertPercent;
                    const isMemHigh = n.memUsage >= thresholds.memAlertPercent;
                    return (
                      <tr key={n._id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '10px 12px', fontWeight: 700, color: '#1f2937' }}>{n.name}</td>
                        <td style={{ padding: '10px 12px', fontFamily: 'monospace', color: '#1f2937' }}>{n.ipAddress || '127.0.0.1'}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <span style={{ color: isCpuHigh ? '#ef4444' : '#059669', fontWeight: 600 }}>{n.cpuUsage || 0}% CPU</span> |{' '}
                          <span style={{ color: isMemHigh ? '#ef4444' : '#059669', fontWeight: 600 }}>{n.memUsage || 0}% Mem</span>
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <span style={{
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontSize: '11px',
                            fontWeight: 700,
                            background: n.status === 'online' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                            color: n.status === 'online' ? '#059669' : '#ef4444'
                          }}>
                            {n.status}
                          </span>
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                          <button
                            onClick={() => handleRevokeNode(n._id)}
                            disabled={actionLoadingId === n._id}
                            style={{
                              background: 'rgba(239,68,68,0.1)',
                              border: '1px solid rgba(239,68,68,0.2)',
                              color: '#ef4444',
                              padding: '4px 8px',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontSize: '11px',
                              fontWeight: 600
                            }}
                          >
                            Revoke Key
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
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

const labelStyle = {
  fontSize: '11px',
  fontWeight: 700,
  color: '#4b5563',
  textTransform: 'uppercase',
  letterSpacing: '0.06em'
};

export default AdminManageNodes;
