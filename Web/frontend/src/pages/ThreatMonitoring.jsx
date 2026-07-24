import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ThreatTable from '../components/ThreatTable';
import { getThreats } from '../services/api';

function ThreatMonitoring() {
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get('search') || '';

  const [threats, setThreats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchThreats = async () => {
      try {
        const res = await getThreats();
        setThreats(res.data);
      } catch (err) {
        setError('Failed to load threats.');
      } finally {
        setLoading(false);
      }
    };
    fetchThreats();
  }, []);

  if (loading) return <p style={{ color: 'var(--text-secondary)' }}>Loading threats...</p>;
  if (error) return <p style={{ color: 'var(--sev-critical)' }}>{error}</p>;

  const filtered = searchQuery
    ? threats.filter(
        (t) =>
          t.sourceIP?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          t.threatType?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : threats;

  return (
    <div>
      <h1 className="page-title">Threat Monitoring</h1>
      <p className="page-subtitle">
        {filtered.length} threats {searchQuery && `matching "${searchQuery}"`}
      </p>
      <ThreatTable threats={filtered} />
    </div>
  );
}

export default ThreatMonitoring;