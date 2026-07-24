import { useEffect, useState } from 'react';
import { ShieldAlert, Ban, Clock, Activity } from 'lucide-react';
import StatCard from '../components/StatCard';
import { getAnalyticsSummary } from '../services/api';

function Analytics() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchSummary = async () => {
      try {
        const res = await getAnalyticsSummary();
        setSummary(res.data);
      } catch (err) {
        setError('Failed to load analytics.');
      } finally {
        setLoading(false);
      }
    };
    fetchSummary();
  }, []);

  if (loading) return <p style={{ color: 'var(--text-secondary)' }}>Loading analytics...</p>;
  if (error) return <p style={{ color: 'var(--sev-critical)' }}>{error}</p>;

  return (
    <div>
      <h1 className="page-title">Security Analytics</h1>
      <p className="page-subtitle">Aggregated detection and response metrics</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' }}>
        <StatCard title="Total Events" value={summary?.totalEvents ?? 0} icon={Activity} color="var(--accent-blue)" />
        <StatCard title="Blocked" value={summary?.blocked ?? 0} icon={Ban} color="var(--sev-critical)" />
        <StatCard title="Tarpitted" value={summary?.tarpitted ?? 0} icon={ShieldAlert} color="var(--sev-high)" />
        <StatCard title="Avg Risk Score" value={(summary?.avgRiskScore ?? 0).toFixed(1)} icon={Clock} color="var(--sev-low)" />
      </div>
    </div>
  );
}

export default Analytics;