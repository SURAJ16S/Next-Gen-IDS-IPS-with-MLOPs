import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import EmptyState from '../components/EmptyState';
import SearchFilterBar from '../components/SearchFilterBar';
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
  const [search, setSearch] = useState('');

  const fetchLogs = async () => {
    try {
      setLoading(true);
      const res = await getLogs();
      setLogs(res.data);
    } catch (err) {
      setError('Failed to load logs.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchLogs(); }, []);

  if (loading) return <p style={{ color: 'var(--text-secondary)' }}>Loading logs...</p>;
  if (error) return <p style={{ color: 'var(--sev-critical)' }}>{error}</p>;

  const filteredLogs = logs.filter((log) =>
    !search.trim() ||
    log.message?.toLowerCase().includes(search.toLowerCase()) ||
    log.source?.toLowerCase().includes(search.toLowerCase()) ||
    log.level?.toLowerCase().includes(search.toLowerCase())
  );

  const countsByMinute = filteredLogs.reduce((acc, log) => {
    const d = new Date(log.createdAt || Date.now());
    const key = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const histData = Object.entries(countsByMinute).map(([time, count]) => ({ time, count }));

  return (
    <div>
      <h1 className="page-title">System Logs</h1>
      <p className="page-subtitle">{filteredLogs.length} log entries</p>

      <SearchFilterBar onRefresh={fetchLogs} />

      <input
        type="text"
        placeholder="Filter by message, source or level..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{
          width: '100%',
          padding: '8px 12px',
          marginBottom: '14px',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-card)',
          color: 'var(--text-primary)',
          fontSize: '13px',
        }}
      />

      <div className="card" style={{ marginBottom: '18px' }}>
        <div className="section-heading" style={{ margin: '0 0 4px' }}>
          {filteredLogs.length} hits
        </div>
        {histData.length === 0 ? (
          <EmptyState message="No log data yet" />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={histData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
              <XAxis dataKey="time" tick={{ fontSize: 11 }} stroke="var(--text-muted)" />
              <YAxis tick={{ fontSize: 11 }} stroke="var(--text-muted)" allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="count" fill="var(--accent-blue)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Level</th>
              <th>Source</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {filteredLogs.length === 0 ? (
              <tr><td colSpan={4}><EmptyState message="No logs found" /></td></tr>
            ) : (
              filteredLogs.map((log) => (
                <tr key={log._id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', whiteSpace: 'nowrap' }}>
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                  <td>
                    <span style={{
                      color: levelColor[log.level] || 'var(--text-primary)',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      fontSize: '11px',
                    }}>
                      {log.level}
                    </span>
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px' }}>{log.source}</td>
                  <td style={{ fontSize: '13px' }}>{log.message}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default Logs;