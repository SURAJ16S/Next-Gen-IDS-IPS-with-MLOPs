import { Link, useLocation } from 'react-router-dom';

const LABELS = {
  admin: 'Admin',
  dashboard: 'Dashboard',
  'manage-devops': 'Manage DevOps',
  users: 'Users',
  'manage-agent': 'Manage Agent',
  'manage-threats': 'Manage Threats',
  'manage-network': 'Manage Network',
  'manage-logs': 'Manage Logs',
  'manage-nodes': 'Manage Nodes',
  blocklist: 'Blocklist',
};

function Breadcrumbs() {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);

  return (
    <nav aria-label="Breadcrumb" style={{ fontSize: '12px', marginBottom: '12px', color: '#6b7280' }}>
      {parts.map((part, i) => {
        const to = '/' + parts.slice(0, i + 1).join('/');
        const label = LABELS[part] || part;
        const isLast = i === parts.length - 1;
        return (
          <span key={to}>
            {i > 0 && ' / '}
            {isLast ? (
              <span aria-current="page" style={{ color: '#111827', fontWeight: 600 }}>{label}</span>
            ) : (
              <Link to={to} style={{ color: '#374151' }}>{label}</Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export default Breadcrumbs;