import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, ShieldAlert, Network, BarChart3, FileText, Server, ShieldCheck, Settings, Cpu, Play, ChevronLeft, ChevronRight } from 'lucide-react';

const navItems = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/threats', label: 'Threat Monitoring', icon: ShieldAlert },
  { to: '/network', label: 'Network Monitoring', icon: Network },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/logs', label: 'Logs', icon: FileText },
  { to: '/devops', label: 'DevOps', icon: Server },
  { to: '/fixtures', label: 'Test Fixtures', icon: Play },
  { to: '/nodes', label: 'Agent Nodes', icon: Cpu },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function Sidebar() {
  const [isCollapsed, setIsCollapsed] = useState(() => {
    return localStorage.getItem('sidebar-collapsed') === 'true';
  });

  const toggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('sidebar-collapsed', String(next));
      return next;
    });
  };

  return (
    <aside
      style={{
        width: isCollapsed ? '68px' : '230px',
        background: 'var(--bg-secondary)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 0',
        transition: 'width 0.2s ease-in-out',
        overflowX: 'hidden',
        flexShrink: 0,
      }}
    >
      {/* Sidebar Header / Logo */}
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: isCollapsed ? 'center' : 'space-between', 
        padding: isCollapsed ? '0' : '0 20px', 
        marginBottom: '32px',
        minHeight: '36px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <ShieldCheck size={22} color="var(--accent-blue)" style={{ flexShrink: 0 }} />
          {!isCollapsed && (
            <div>
              <div style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '0.5px' }}>NGFW</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: '2px', whiteSpace: 'nowrap' }}>
                MLOps Intrusion
              </div>
            </div>
          )}
        </div>
        {!isCollapsed && (
          <button
            onClick={toggleCollapse}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--radius-sm)',
              transition: 'background 0.12s',
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
            title="Collapse Sidebar"
          >
            <ChevronLeft size={16} />
          </button>
        )}
      </div>

      {/* Collapse Trigger for Collapsed Mode */}
      {isCollapsed && (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
          <button
            onClick={toggleCollapse}
            style={{
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              padding: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--radius-sm)',
            }}
            title="Expand Sidebar"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}

      {!isCollapsed && (
        <div style={{ padding: '0 20px', marginBottom: '8px', fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>
          Security Operations
        </div>
      )}

      {/* Navigation */}
      <nav style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {navItems.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className="sidebar-nav-link"  
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              justifyContent: isCollapsed ? 'center' : 'flex-start',
              gap: isCollapsed ? '0' : '11px',
              padding: '10px 20px',
              margin: '2px 10px',
              borderRadius: 'var(--radius-sm)',
              color: isActive ? '#fff' : 'var(--text-secondary)',
              textDecoration: 'none',
              background: isActive ? 'var(--accent-blue)' : undefined,
              fontSize: '13.5px',
              fontWeight: isActive ? 600 : 500,
              transition: 'background 0.12s, color 0.12s',
              whiteSpace: 'nowrap',
            })}
            title={isCollapsed ? label : undefined}
          >
            <Icon size={17} style={{ flexShrink: 0 }} />
            {!isCollapsed && <span>{label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* Footer Operational Status */}
      <div style={{ 
        marginTop: 'auto', 
        padding: '14px 20px', 
        borderTop: '1px solid var(--border-subtle)',
        display: 'flex',
        justifyContent: isCollapsed ? 'center' : 'flex-start'
      }}>
        {isCollapsed ? (
          <span 
            className="badge-dot" 
            style={{ 
              background: 'var(--sev-low)', 
              width: '8px', 
              height: '8px', 
              borderRadius: '50%',
              display: 'inline-block'
            }} 
            title="System Operational"
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--sev-low)', whiteSpace: 'nowrap' }}>
            <span className="badge-dot" style={{ background: 'var(--sev-low)' }} />
            System Operational
          </div>
        )}
      </div>
    </aside>
  );
}

export default Sidebar;