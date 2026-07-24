function StatCard({ title, value, icon: Icon, color = '#3b82f6', trend }) {
  return (
    <div className="card" style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
      {Icon && (
        <div
          style={{
            width: '42px',
            height: '42px',
            borderRadius: 'var(--radius-sm)',
            background: `${color}18`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Icon size={20} color={color} />
        </div>
      )}
      <div>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 500 }}>{title}</p>
        <h2 style={{ margin: '2px 0 0', fontSize: '22px', fontWeight: 700, color: 'var(--text-primary)' }}>{value}</h2>
        {trend && <p style={{ margin: '4px 0 0', fontSize: '11px', color: 'var(--text-muted)' }}>{trend}</p>}
      </div>
    </div>
  );
}

export default StatCard;