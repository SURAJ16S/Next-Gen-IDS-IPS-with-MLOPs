import { useEffect, useState } from 'react';
import { ShieldAlert, Network, Server, AlertTriangle } from 'lucide-react';
import StatCard from '../components/StatCard';
import ThreatTable from '../components/ThreatTable';
import EmptyState from '../components/EmptyState';
import { getDashboardStats, getRecentRequests } from '../services/api';
import { io } from 'socket.io-client';

function Dashboard() {
  const [stats, setStats] = useState(null);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [statsRes, reqRes] = await Promise.all([getDashboardStats(), getRecentRequests()]);
        setStats(statsRes.data);
        setRequests(reqRes.data);
      } catch (err) {
        setError('Failed to load dashboard data.');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();

    const socket = io('http://localhost:5000');
    
    socket.on('new_detection', (det) => {
      setStats(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          totalThreats: prev.totalThreats + 1,
          openThreats: prev.openThreats + 1,
          recentEvents: [det, ...prev.recentEvents].slice(0, 10)
        };
      });
    });

    socket.on('new_connection', (conn) => {
      setStats(prev => {
        if (!prev) return prev;
        return { ...prev, totalNetworkEvents: prev.totalNetworkEvents + 1 };
      });
      
      setRequests(prev => {
        const newReq = {
          _id: Math.random().toString(),
          message: `${conn.protocol || 'TCP'} Flow: ${conn.sourceIP} -> ${conn.destinationIP}`,
          meta: { ip: conn.sourceIP, userAgent: 'Agent Sensor' },
          createdAt: conn.timestamp || new Date()
        };
        return [newReq, ...prev].slice(0, 15);
      });
    });

    return () => socket.disconnect();
  }, []);

  if (loading) return <p style={{ color: 'var(--text-secondary)' }}>Loading dashboard...</p>;
  if (error) return <p style={{ color: 'var(--sev-critical)' }}>{error}</p>;

  return (
    <div>
      <h1 className="page-title">Security Overview</h1>
      <p className="page-subtitle">Real-time threat and network status</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' }}>
        <StatCard title="Total Threats" value={stats?.totalThreats ?? 0} icon={ShieldAlert} color="var(--sev-critical)" />
        <StatCard title="Open Threats" value={stats?.openThreats ?? 0} icon={AlertTriangle} color="var(--sev-high)" />
        <StatCard title="Network Events" value={stats?.totalNetworkEvents ?? 0} icon={Network} color="var(--accent-blue)" />
        <StatCard title="Active Deployments" value={stats?.activeDeployments ?? 0} icon={Server} color="var(--sev-low)" />
      </div>

      <div className="section-heading">Recent Requests (IP Tracking)</div>
      <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Method + URL</th>
              <th>IP Address</th>
              <th>User Agent</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {requests.length === 0 ? (
              <tr><td colSpan={4}><EmptyState message="No requests logged yet" /></td></tr>
            ) : (
              requests.map((r) => (
                <tr key={r._id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px' }}>{r.message}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px' }}>{r.meta?.ip}</td>
                  <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{r.meta?.userAgent?.slice(0, 40)}...</td>
                  <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{new Date(r.createdAt).toLocaleTimeString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="section-heading">Recent Security Events</div>
      <ThreatTable threats={stats?.recentEvents ?? []} />
    </div>
  );
}

export default Dashboard;