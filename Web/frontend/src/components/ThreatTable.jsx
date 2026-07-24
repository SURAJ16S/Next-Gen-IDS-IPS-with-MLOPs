import SeverityBadge from './SeverityBadge';
import StatusBadge from './StatusBadge';
import EmptyState from './EmptyState';

function riskToSeverity(score) {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

function ThreatTable({ threats = [] }) {
  return (
    <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
      <table>
        <thead>
          <tr>
            <th>Threat Type</th>
            <th>Source IP</th>
            <th>Severity</th>
            <th>Risk Score</th>
            <th>Status</th>
            <th>Detected</th>
          </tr>
        </thead>
        <tbody>
          {threats.length === 0 ? (
            <tr>
              <td colSpan={6}>
                <EmptyState message="No threats detected" />
              </td>
            </tr>
          ) : (
            threats.map((t) => (
              <tr key={t._id}>
                <td style={{ fontWeight: 600 }}>{t.threatType || t.attackType || '—'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px' }}>{t.sourceIP}</td>
                <td><SeverityBadge level={riskToSeverity(t.riskScore || 0)} /></td>
                <td>{t.riskScore ?? 0}</td>
                <td><StatusBadge status={t.status || t.action} /></td>
                <td style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                  {t.createdAt ? new Date(t.createdAt).toLocaleString() : '—'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default ThreatTable;