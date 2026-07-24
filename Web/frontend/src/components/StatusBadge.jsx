const statusColors = {
  open: '#f97316',
  investigating: '#3b82f6',
  resolved: '#22c55e',
  blocked: '#ef4444',
  allow: '#22c55e',
  alert: '#eab308',
  block: '#ef4444',
  tarpit: '#8b5cf6',
  pending: '#8b93a7',
  building: '#3b82f6',
  scanning: '#eab308',
  deployed: '#22c55e',
  failed: '#ef4444',
  normal: '#22c55e',
  suspicious: '#eab308',
};

function StatusBadge({ status = '' }) {
  const key = (status || '').toLowerCase();
  const color = statusColors[key] || '#8b93a7';

  return (
    <span className="badge" style={{ color, background: `${color}20` }}>
      <span className="badge-dot" />
      {status}
    </span>
  );
}

export default StatusBadge;