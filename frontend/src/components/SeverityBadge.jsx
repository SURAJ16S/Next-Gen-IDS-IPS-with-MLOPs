const severityMap = {
  critical: { color: 'var(--sev-critical)', bg: 'var(--sev-critical-bg)', label: 'Critical' },
  high: { color: 'var(--sev-high)', bg: 'var(--sev-high-bg)', label: 'High' },
  medium: { color: 'var(--sev-medium)', bg: 'var(--sev-medium-bg)', label: 'Medium' },
  low: { color: 'var(--sev-low)', bg: 'var(--sev-low-bg)', label: 'Low' },
  info: { color: 'var(--sev-info)', bg: 'var(--sev-info-bg)', label: 'Info' },
};

function SeverityBadge({ level = 'info' }) {
  const key = (level || 'info').toLowerCase();
  const conf = severityMap[key] || severityMap.info;

  return (
    <span className="badge" style={{ color: conf.color, background: conf.bg }}>
      <span className="badge-dot" />
      {conf.label}
    </span>
  );
}

export default SeverityBadge;