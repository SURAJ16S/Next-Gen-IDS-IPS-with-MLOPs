import { useEffect, useState } from 'react';
import { getAdminThresholds, updateAdminThresholds, getAdminLogs, pruneAdminLogs } from '../services/api';
import {
  FileText, Settings, Trash2, RefreshCw, AlertCircle, Filter, Search, CheckCircle2, Info
} from 'lucide-react';

function AdminManageLogs() {
  const [thresholds, setThresholds] = useState({
    retentionDays: 30,
    maxLogEntries: 50000
  });

  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [saveSuccess, setSaveSuccess] = useState('');
  const [pruneSuccess, setPruneSuccess] = useState('');
  const [pruning, setPruning] = useState(false);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError('');
      const [thresholdsRes, logsRes] = await Promise.all([
        getAdminThresholds('logs'),
        getAdminLogs()
      ]);
      if (thresholdsRes.data) {
        setThresholds(thresholdsRes.data);
      }
      setLogs(logsRes.data || []);
    } catch (err) {
      setError('Failed to fetch platform configuration or logs.');
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
      await updateAdminThresholds('logs', thresholds);
      setSaveSuccess('Log audit parameters updated successfully.');
      setTimeout(() => setSaveSuccess(''), 4000);
    } catch (err) {
      setError('Failed to save log retention policies.');
    }
  };

  const handlePruneLogs = async () => {
    if (!window.confirm('Are you sure you want to prune logs? All entries older than the retention days threshold will be permanently deleted.')) return;
    setPruning(true);
    setPruneSuccess('');
    try {
      const res = await pruneAdminLogs();
      setPruneSuccess(res.data.message || 'Pruning run completed successfully.');
      // Refresh local logs
      const logsRes = await getAdminLogs();
      setLogs(logsRes.data || []);
      setTimeout(() => setPruneSuccess(''), 4000);
    } catch (err) {
      setError('Failed to prune logs.');
    } finally {
      setPruning(false);
    }
  };

  if (loading) {
    return (
      <div style={{ color: '#4b5563', padding: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <RefreshCw className="animate-spin" size={16} /> Loading log auditor...
      </div>
    );
  }

  const filteredLogs = logs.filter((log) => {
    const matchesSearch =
      log.message?.toLowerCase().includes(search.toLowerCase()) ||
      log.source?.toLowerCase().includes(search.toLowerCase());
    const matchesSeverity = severityFilter === 'all' || log.level === severityFilter;
    return matchesSearch && matchesSeverity;
  });

  return (
    <div style={{ color: '#1f2937' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, margin: 0, color: '#111827', letterSpacing: '-0.5px' }}>Log Auditor Settings</h1>
          <p style={{ fontSize: '13px', color: '#4b5563', marginTop: '4px' }}>Set storage limits, control database log retention, and execute pruning cleanup</p>
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
          <RefreshCw size={14} /> Refresh Logs
        </button>
      </div>

      {saveSuccess && (
        <div style={{ padding: '12px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '6px', color: '#10b981', marginBottom: '20px' }}>
          {saveSuccess}
        </div>
      )}

      {pruneSuccess && (
        <div style={{ padding: '12px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: '6px', color: '#2563eb', marginBottom: '20px' }}>
          {pruneSuccess}
        </div>
      )}

      {error && (
        <div style={{ padding: '12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '6px', color: '#ef4444', marginBottom: '20px' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: '20px', marginBottom: '24px' }}>
        {/* Settings Form */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
            <Settings size={18} color="#f59e0b" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Retention & Storage</h3>
          </div>

          <form onSubmit={handleSaveThresholds} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={labelStyle}>Log Retention Period (Days)</label>
              <input
                type="number"
                value={thresholds.retentionDays}
                onChange={(e) => setThresholds({ ...thresholds, retentionDays: parseInt(e.target.value, 10) })}
                style={inputStyle}
                required
              />
            </div>

            <div>
              <label style={labelStyle}>Max DB Log Entry Rows</label>
              <input
                type="number"
                value={thresholds.maxLogEntries}
                onChange={(e) => setThresholds({ ...thresholds, maxLogEntries: parseInt(e.target.value, 10) })}
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
              Update Log Limits
            </button>
          </form>
        </div>

        {/* Database cleanup trigger */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
            <Trash2 size={18} color="#ef4444" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Manual Log Pruning</h3>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <p style={{ fontSize: '13.5px', color: '#4b5563', margin: 0, lineHeight: '1.5' }}>
              Forcibly deletes old database log logs and indices that exceed your set retention day window ({thresholds.retentionDays} days). Useful to free up host disk space.
            </p>

            <button
              onClick={handlePruneLogs}
              disabled={pruning}
              style={{
                background: pruning ? '#e5e7eb' : '#ef4444',
                color: pruning ? '#9ca3af' : '#fff',
                border: 'none',
                padding: '10px 16px',
                borderRadius: '6px',
                fontWeight: 700,
                cursor: pruning ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                marginTop: '10px'
              }}
            >
              <Trash2 size={14} />
              Execute Clean Pruning Run
            </button>
          </div>
        </div>
      </div>

      {/* Audit table logs list */}
      <div style={panelStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px', flexWrap: 'wrap', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <FileText size={18} color="#f59e0b" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>System Audit Trail Diagnostic Logs</h3>
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <div style={{ position: 'relative', width: '200px' }}>
              <Search size={14} color="#4b5563" style={{ position: 'absolute', left: '10px', top: '10px' }} />
              <input
                type="text"
                placeholder="Search messages, sources..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  background: '#ffffff',
                  border: '1px solid #d1d5db',
                  borderRadius: '4px',
                  padding: '6px 8px 6px 30px',
                  color: '#1f2937',
                  fontSize: '12px',
                  width: '100%',
                  outline: 'none',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              style={{
                background: '#ffffff',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                padding: '6px 8px',
                color: '#1f2937',
                fontSize: '12px',
                outline: 'none'
              }}
            >
              <option value="all">All levels</option>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
              <option value="critical">Critical</option>
            </select>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb', background: '#f9fafb', textAlign: 'left' }}>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Level</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Source</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Log Diagnostic Message</th>
                <th style={{ padding: '8px 16px', color: '#4b5563', fontWeight: 600 }}>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.slice(0, 30).map((log) => {
                const color =
                  log.level === 'critical' || log.level === 'error'
                    ? '#ef4444'
                    : log.level === 'warning'
                    ? '#d97706'
                    : '#2563eb';
                return (
                  <tr key={log._id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        fontWeight: 800,
                        textTransform: 'uppercase',
                        background: color + '18',
                        color: color
                      }}>
                        {log.level || 'info'}
                      </span>
                    </td>
                    <td style={{ padding: '10px 16px', fontWeight: 600, color: '#1f2937' }}>{log.source || 'proxy'}</td>
                    <td style={{ padding: '10px 16px', color: '#1f2937' }}>{log.message}</td>
                    <td style={{ padding: '10px 16px', color: '#4b5563', whiteSpace: 'nowrap' }}>
                      {new Date(log.createdAt).toLocaleString()}
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

const labelStyle = {
  fontSize: '11px',
  fontWeight: 700,
  color: '#4b5563',
  textTransform: 'uppercase',
  letterSpacing: '0.06em'
};

export default AdminManageLogs;
