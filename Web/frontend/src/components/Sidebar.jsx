import { NavLink } from 'react-router-dom';
import { LayoutDashboard, ShieldAlert, Network, BarChart3, FileText, Server, ShieldCheck, Settings } from 'lucide-react';

const navItems = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/threats', label: 'Threat Monitoring', icon: ShieldAlert },
  { to: '/network', label: 'Network Monitoring', icon: Network },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/logs', label: 'Logs', icon: FileText },
  { to: '/devops', label: 'DevOps', icon: Server },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function Sidebar() {
  return (
    <aside
      style={{
        width: '230px',
        background: 'var(--bg-secondary)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 0',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '0 20px', marginBottom: '32px' }}>
        <ShieldCheck size={22} color="var(--accent-blue)" />
        <div>
          <div style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '0.5px' }}>IDPS</div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Security Platform
          </div>
        </div>
      </div>

      <div style={{ padding: '0 20px', marginBottom: '8px', fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>
        Security Operations
      </div>

      <nav>
        {navItems.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: '11px',
              padding: '10px 20px',
              margin: '2px 10px',
              borderRadius: 'var(--radius-sm)',
              color: isActive ? '#fff' : 'var(--text-secondary)',
              textDecoration: 'none',
              background: isActive ? 'var(--accent-blue)' : 'transparent',
              fontSize: '13.5px',
              fontWeight: isActive ? 600 : 500,
              transition: 'background 0.12s, color 0.12s',
            })}
          >
            <Icon size={17} />
            {label}
          </NavLink>
        ))}
      </nav>

     <div style={{ marginTop: 'auto', padding: '14px 20px', borderTop: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--sev-low)' }}>
          <span className="badge-dot" style={{ background: 'var(--sev-low)' }} />
          System Operational
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;