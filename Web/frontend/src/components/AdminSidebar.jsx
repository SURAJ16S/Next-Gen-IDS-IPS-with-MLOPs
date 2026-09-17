import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Server, Users, Bot, ShieldAlert, Network,
  FileText, Cpu, ChevronLeft, ChevronRight, ShieldAlert as ShieldIcon, ShieldOff
} from 'lucide-react';

const adminNavItems = [
  { to: '/admin/dashboard', label: 'Admin Overview', icon: LayoutDashboard, end: true },
  { to: '/admin/manage-devops', label: 'Manage DevOps', icon: Server },
  { to: '/admin/users', label: 'User Directory', icon: Users },
  { to: '/admin/manage-agent', label: 'Ollama Analytics', icon: Bot },
  { to: '/admin/manage-threats', label: 'Threat Control', icon: ShieldAlert },
  { to: '/admin/manage-network', label: 'Network Policies', icon: Network },
  { to: '/admin/manage-logs', label: 'Log Auditor', icon: FileText },
  { to: '/admin/manage-nodes', label: 'Cluster Nodes', icon: Cpu },
  { to: '/admin/blocklist', label: 'IP Blocklist', icon: ShieldOff },
];

function AdminSidebar() {
  const [isCollapsed, setIsCollapsed] = useState(() => {
    return localStorage.getItem('admin-sidebar-collapsed') === 'true';
  });

  const toggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('admin-sidebar-collapsed', String(next));
      return next;
    });
  };

  return (
    <aside
      style={{
        width: isCollapsed ? '68px' : '240px',
        background: '#ffffff',
        borderRight: '1px solid #e5e7eb',
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 0',
        transition: 'width 0.2s ease-in-out',
        overflowX: 'hidden',
        flexShrink: 0,
      }}
    >
      {/* Admin Branding Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: isCollapsed ? 'center' : 'space-between',
        padding: isCollapsed ? '0' : '0 20px',
        marginBottom: '32px',
        minHeight: '36px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <ShieldIcon size={24} color="#f59e0b" style={{ flexShrink: 0 }} />
          {!isCollapsed && (
            <div>
              <div style={{ fontWeight: 800, fontSize: '15px', color: '#111827', letterSpacing: '-0.2px' }}>
                NGFW <span style={{ color: '#fff', fontSize: '9px', fontWeight: 900, background: '#f59e0b', padding: '2px 5px', borderRadius: '3px', marginLeft: '4px', verticalAlign: 'middle' }}>ADMIN</span>
              </div>
              <div style={{ fontSize: '9px', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: '2px', whiteSpace: 'nowrap' }}>
                Control Console
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
              color: '#4b5563',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '4px',
              transition: 'background 0.12s',
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
            title="Collapse Sidebar"
          >
            <ChevronLeft size={16} />
          </button>
        )}
      </div>

      {isCollapsed && (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
          <button
            onClick={toggleCollapse}
            style={{
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
              color: '#4b5563',
              cursor: 'pointer',
              padding: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '4px',
            }}
            title="Expand Sidebar"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}

      {!isCollapsed && (
        <div style={{ padding: '0 20px', marginBottom: '10px', fontSize: '10px', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.8px', fontWeight: 700 }}>
          God Mode Control
        </div>
      )}

      {/* Navigation Links */}
      <nav style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {adminNavItems.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              justifyContent: isCollapsed ? 'center' : 'flex-start',
              gap: isCollapsed ? '0' : '12px',
              padding: '11px 20px',
              margin: '0 12px',
              borderRadius: '6px',
              color: isActive ? '#fff' : '#374151',
              textDecoration: 'none',
              background: isActive ? '#f59e0b' : 'transparent',
              fontSize: '13.5px',
              fontWeight: isActive ? 700 : 500,
              transition: 'background 0.12s, color 0.12s',
              whiteSpace: 'nowrap',
            })}
            title={isCollapsed ? label : undefined}
            onMouseEnter={(e) => {
              if (!e.currentTarget.style.background || e.currentTarget.style.background === 'transparent') {
                e.currentTarget.style.background = 'rgba(245, 158, 11, 0.08)';
                e.currentTarget.style.color = '#f59e0b';
              }
            }}
            onMouseLeave={(e) => {
              if (window.location.pathname !== to && !to.includes(window.location.pathname)) {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = '#374151';
              }
            }}
          >
            <Icon size={18} style={{ flexShrink: 0 }} />
            {!isCollapsed && <span>{label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* Footer Info */}
      <div style={{
        marginTop: 'auto',
        padding: '14px 20px',
        borderTop: '1px solid #e5e7eb',
        display: 'flex',
        justifyContent: isCollapsed ? 'center' : 'flex-start'
      }}>
        {!isCollapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: '#059669', whiteSpace: 'nowrap' }}>
            <span className="badge-dot" style={{ background: '#10b981', width: '8px', height: '8px', borderRadius: '50%' }} />
            Secure Admin Shell
          </div>
        )}
      </div>
    </aside>
  );
}

export default AdminSidebar;
