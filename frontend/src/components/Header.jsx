import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Bell, LogOut, User } from 'lucide-react';
import { getThreats } from '../services/api';

function Header() {
  const navigate = useNavigate();
  const user = JSON.parse(localStorage.getItem('user') || '{}');

  const [searchValue, setSearchValue] = useState('');
  const [showNotifications, setShowNotifications] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [notifications, setNotifications] = useState([]);

  const notifRef = useRef(null);
  const profileRef = useRef(null);

  useEffect(() => {
    const fetchNotifications = async () => {
      try {
        const res = await getThreats();
        const critical = res.data.filter((t) => (t.riskScore || 0) >= 50).slice(0, 6);
        setNotifications(critical);
      } catch (err) {
        setNotifications([]);
      }
    };
    fetchNotifications();
  }, []);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (notifRef.current && !notifRef.current.contains(e.target)) setShowNotifications(false);
      if (profileRef.current && !profileRef.current.contains(e.target)) setShowProfile(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    if (searchValue.trim()) {
      navigate(`/threats?search=${encodeURIComponent(searchValue.trim())}`);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/login');
  };

  return (
    <header
      style={{
        height: '58px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-subtle)',
        position: 'relative',
      }}
    >
      <form onSubmit={handleSearchSubmit} style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, maxWidth: '360px' }}>
        <Search size={16} color="var(--text-secondary)" />
        <input
          type="text"
          placeholder="Search threats by IP, type..."
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          style={{
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--text-primary)',
            fontSize: '13px',
            width: '100%',
          }}
        />
      </form>

      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--sev-low)' }}>
          <span className="badge-dot" style={{ background: 'var(--sev-low)' }} />
          Live Monitoring
        </div>

        <div ref={notifRef} style={{ position: 'relative' }}>
          <Bell
            size={17}
            color="var(--text-secondary)"
            style={{ cursor: 'pointer' }}
            onClick={() => setShowNotifications((s) => !s)}
          />
          {notifications.length > 0 && (
            <span
              style={{
                position: 'absolute',
                top: '-4px',
                right: '-4px',
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: 'var(--sev-critical)',
              }}
            />
          )}

          {showNotifications && (
            <div
              style={{
                position: 'absolute',
                top: '30px',
                right: 0,
                width: '300px',
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
                zIndex: 50,
                maxHeight: '320px',
                overflowY: 'auto',
              }}
            >
              <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-subtle)', fontSize: '12px', fontWeight: 600 }}>
                High Risk Alerts
              </div>
              {notifications.length === 0 ? (
                <div style={{ padding: '16px', fontSize: '12px', color: 'var(--text-muted)' }}>No active alerts</div>
              ) : (
                notifications.map((n) => (
                  <div key={n._id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', fontSize: '12px' }}>
                    <div style={{ fontWeight: 600 }}>{n.threatType || 'Unknown Threat'}</div>
                    <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>{n.sourceIP}</div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div ref={profileRef} style={{ position: 'relative' }}>
          <div
            onClick={() => setShowProfile((s) => !s)}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
          >
            <div
              style={{
                width: '30px',
                height: '30px',
                borderRadius: '50%',
                background: 'var(--accent-blue)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '12px',
                fontWeight: 700,
                color: '#fff',
              }}
            >
              {(user.username || 'A')[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: '12.5px', fontWeight: 600 }}>{user.username || 'Admin'}</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'capitalize' }}>{user.role || 'admin'}</div>
            </div>
          </div>

          {showProfile && (
            <div
              style={{
                position: 'absolute',
                top: '42px',
                right: 0,
                width: '180px',
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
                zIndex: 50,
                overflow: 'hidden',
              }}
            >
              <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)' }}>
                <User size={14} />
                {user.email || 'user@idps.com'}
              </div>
              <div
                onClick={handleLogout}
                style={{
                  padding: '10px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '12.5px',
                  color: 'var(--sev-critical)',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <LogOut size={14} />
                Logout
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export default Header;