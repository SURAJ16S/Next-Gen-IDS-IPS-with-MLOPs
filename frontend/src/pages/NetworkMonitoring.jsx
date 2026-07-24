import { useEffect, useState } from 'react';
import StatusBadge from '../components/StatusBadge';
import EmptyState from '../components/EmptyState';
import { getNetworkEvents } from '../services/api';

function NetworkMonitoring() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchEvents = async () => {
      try {
        const res = await getNetworkEvents();
        setEvents(res.data);
      } catch (err) {
        setError('Failed to load network events.');
      } finally {
        setLoading(false);
      }
    };
    fetchEvents();
  }, []);

  if (loading) return <p style={{ color: 'var(--text-secondary)' }}>Loading network events...</p>;
  if (error) return <p style={{ color: 'var(--sev-critical)' }}>{error}</p>;

  return (
    <div>
      <h1 className="page-title">Network Monitoring</h1>
      <p className="page-subtitle">{events.length} events tracked</p>

      <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Source IP</th>
              <th>Destination IP</th>
              <th>Protocol</th>
              <th>Port</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr><td colSpan={5}><EmptyState message="No network events found" /></td></tr>
            ) : (
              events.map((e) => (
                <tr key={e._id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px' }}>{e.sourceIP}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px' }}>{e.destinationIP}</td>
                  <td>{e.protocol}</td>
                  <td>{e.port}</td>
                  <td><StatusBadge status={e.status} /></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default NetworkMonitoring;