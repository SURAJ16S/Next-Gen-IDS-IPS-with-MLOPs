import { useEffect, useState } from 'react';
import EmptyState from '../components/EmptyState';
import { getLogs } from '../services/api';

const levelColor = {
  info: 'var(--sev-info)',
  warning: 'var(--sev-medium)',
  error: 'var(--sev-high)',
  critical: 'var(--sev-critical)',
};

function Logs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res = await getLogs();
        setLogs(res.data);
      } catch (err) {
        setError('Failed to load logs.');
      } finally {
        setLoading(false);
      }
    };
    fetchLogs();
  }, []);

  if (loading) return <p style={{ color: 'var(--text-secondary)' }}>Loading logs...</p>;
  if (error) return <p style={{ color: 'var(--sev-critical)' }}>{error}</p>;

  return (
    <div>
      <h1 className="page-title">System Logs</h1>
      <p className="page-subtitle">{logs.length} log entries</p>

      <div className="card">
        {logs.length === 0 ? (
          <EmptyState message="No logs found" />
        ) : (
          logs.map((log) => (
            <div
              key={log._id}
              style={{
                padding: '10px 0',
                borderBottom: '1px solid var(--border-subtle)',
                display: 'flex',
                gap: '12px',
                fontSize: '13px',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <span style={{ color: levelColor[log.level] || 'var(--text-primary)', fontWeight: 700, minWidth: '70px', textTransform: 'uppercase', fontSize: '11px' }}>
                {log.level}
              </span>
              <span style={{ color: 'var(--text-secondary)', minWidth: '110px' }}>{log.source}</span>
              <span style={{ color: 'var(--text-primary)' }}>{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default Logs;