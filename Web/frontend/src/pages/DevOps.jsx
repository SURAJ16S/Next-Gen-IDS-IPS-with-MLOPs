import { useEffect, useState } from 'react';
import StatusBadge from '../components/StatusBadge';
import EmptyState from '../components/EmptyState';
import { getDeployments } from '../services/api';

function DevOps() {
  const [deployments, setDeployments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchDeployments = async () => {
      try {
        const res = await getDeployments();
        setDeployments(res.data);
      } catch (err) {
        setError('Failed to load deployments.');
      } finally {
        setLoading(false);
      }
    };
    fetchDeployments();
  }, []);

  if (loading) return <p style={{ color: 'var(--text-secondary)' }}>Loading deployments...</p>;
  if (error) return <p style={{ color: 'var(--sev-critical)' }}>{error}</p>;

  return (
    <div>
      <h1 className="page-title">DevOps Deployments</h1>
      <p className="page-subtitle">{deployments.length} deployments tracked</p>

      <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Tech Stack</th>
              <th>Status</th>
              <th>Vulnerabilities</th>
            </tr>
          </thead>
          <tbody>
            {deployments.length === 0 ? (
              <tr><td colSpan={4}><EmptyState message="No deployments found" /></td></tr>
            ) : (
              deployments.map((d) => (
                <tr key={d._id}>
                  <td style={{ fontWeight: 600 }}>{d.projectName}</td>
                  <td>{d.techStackDetected}</td>
                  <td><StatusBadge status={d.status} /></td>
                  <td>{d.vulnerabilitiesFound}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default DevOps;