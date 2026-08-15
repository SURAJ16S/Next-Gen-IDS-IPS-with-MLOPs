// Plain stat number — small label above, big colored number below.
function StatPlain({ label, value, color = 'var(--text-primary)' }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)' }}>{label}</p>
      <h2 style={{ margin: '4px 0 0', fontSize: '26px', fontWeight: 600, color }}>{value}</h2>
    </div>
  );
}

export default StatPlain;