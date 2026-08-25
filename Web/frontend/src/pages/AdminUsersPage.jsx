import { useEffect, useState } from 'react';
import { getAdminUsers, updateAdminUserRole, updateAdminUserStatus } from '../services/api';
import {
  Users, UserCheck, ShieldAlert, CheckCircle, Search, RefreshCw,
  Ban, Shield, ArrowLeftRight, UserX, Calendar, Mail, Phone, Cpu
} from 'lucide-react';

function AdminUsersPage() {
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedUser, setSelectedUser] = useState(null);
  const [actionLoadingId, setActionLoadingId] = useState(null);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await getAdminUsers();
      setUsers(res.data || []);
    } catch (err) {
      setError('Failed to fetch platform users directory.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleRoleChange = async (userId, newRole) => {
    try {
      setActionLoadingId(userId);
      await updateAdminUserRole(userId, newRole);
      setUsers(prev => prev.map(u => u._id === userId ? { ...u, role: newRole } : u));
      if (selectedUser && selectedUser._id === userId) {
        setSelectedUser(prev => ({ ...prev, role: newRole }));
      }
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to update user role');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleStatusToggle = async (userId, currentStatus) => {
    const targetStatus = currentStatus === 'banned' ? 'active' : 'banned';
    try {
      setActionLoadingId(userId);
      await updateAdminUserStatus(userId, targetStatus);
      setUsers(prev => prev.map(u => u._id === userId ? { ...u, status: targetStatus } : u));
      if (selectedUser && selectedUser._id === userId) {
        setSelectedUser(prev => ({ ...prev, status: targetStatus }));
      }
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to toggle user status');
    } finally {
      setActionLoadingId(null);
    }
  };

  if (loading) {
    return (
      <div style={{ color: '#4b5563', padding: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <RefreshCw className="animate-spin" size={16} /> Loading user directory...
      </div>
    );
  }

  const filteredUsers = users.filter(u =>
    u.username?.toLowerCase().includes(search.toLowerCase()) ||
    u.email?.toLowerCase().includes(search.toLowerCase()) ||
    u.firstName?.toLowerCase().includes(search.toLowerCase()) ||
    u.lastName?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ color: '#1f2937', display: 'flex', gap: '20px', minHeight: '80vh' }}>
      {/* Directory Section */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <div>
            <h1 style={{ fontSize: '24px', fontWeight: 800, margin: 0, color: '#111827', letterSpacing: '-0.5px' }}>User Directory</h1>
            <p style={{ fontSize: '13px', color: '#4b5563', marginTop: '4px' }}>Update user authorization levels, manage credentials, or ban/active accounts</p>
          </div>
          <button
            onClick={fetchUsers}
            style={{
              background: '#ffffff',
              border: '1px solid #d1d5db',
              color: '#374151',
              padding: '8px 16px',
              borderRadius: '6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '13px',
              fontWeight: 600
            }}
          >
            <RefreshCw size={14} /> Refresh roster
          </button>
        </div>

        {error && (
          <div style={{ padding: '12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '6px', color: '#ef4444', marginBottom: '20px' }}>
            {error}
          </div>
        )}

        {/* Search */}
        <div style={{ position: 'relative', marginBottom: '18px' }}>
          <Search size={16} color="#4b5563" style={{ position: 'absolute', left: '12px', top: '12px' }} />
          <input
            type="text"
            placeholder="Search users by name, username, or email address..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              background: '#ffffff',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              padding: '10px 12px 10px 38px',
              color: '#1f2937',
              width: '100%',
              fontSize: '13px',
              outline: 'none',
              boxSizing: 'border-box'
            }}
          />
        </div>

        {/* Users Table */}
        <div style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb', background: '#f9fafb', textAlign: 'left' }}>
                <th style={{ padding: '12px 16px', color: '#4b5563', fontWeight: 600 }}>User Identity</th>
                <th style={{ padding: '12px 16px', color: '#4b5563', fontWeight: 600 }}>Platform Role</th>
                <th style={{ padding: '12px 16px', color: '#4b5563', fontWeight: 600 }}>Quota Status</th>
                <th style={{ padding: '12px 16px', color: '#4b5563', fontWeight: 600 }}>Account Status</th>
                <th style={{ padding: '12px 16px', color: '#4b5563', fontWeight: 600, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => (
                <tr
                  key={u._id}
                  onClick={() => setSelectedUser(u)}
                  style={{
                    borderBottom: '1px solid #f3f4f6',
                    cursor: 'pointer',
                    background: selectedUser?._id === u._id ? 'rgba(245,158,11,0.04)' : 'transparent',
                    transition: 'background 0.12s'
                  }}
                  onMouseEnter={(e) => { if (selectedUser?._id !== u._id) e.currentTarget.style.background = '#f9fafb'; }}
                  onMouseLeave={(e) => { if (selectedUser?._id !== u._id) e.currentTarget.style.background = 'transparent'; }}
                >
                  <td style={{ padding: '14px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{
                        width: '32px',
                        height: '32px',
                        borderRadius: '50%',
                        background: u.type === 'admin' ? '#f59e0b' : '#3b82f6',
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 700,
                        fontSize: '13px'
                      }}>
                        {(u.firstName || u.username || 'U')[0].toUpperCase()}
                      </div>
                      <div>
                        <div style={{ fontWeight: 700, color: '#111827' }}>{u.firstName} {u.lastName}</div>
                        <div style={{ fontSize: '11px', color: '#4b5563', marginTop: '2px' }}>@{u.username} • {u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <span style={{
                      padding: '3px 7px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 800,
                      textTransform: 'uppercase',
                      background: u.type === 'admin' ? 'rgba(245,158,11,0.1)' : 'rgba(59,130,246,0.1)',
                      color: u.type === 'admin' ? '#d97706' : '#2563eb'
                    }}>
                      {u.role}
                    </span>
                  </td>
                  <td style={{ padding: '14px 16px', color: '#1f2937' }}>
                    <div style={{ fontSize: '12.5px' }}>{u.buildCount} DevOps Builds</div>
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      fontSize: '11px',
                      fontWeight: 700,
                      color: u.status === 'banned' ? '#ef4444' : '#059669'
                    }}>
                      <span style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        background: u.status === 'banned' ? '#ef4444' : '#10b981'
                      }} />
                      {u.status === 'banned' ? 'Banned' : 'Active'}
                    </span>
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center' }}>
                      <select
                        value={u.role}
                        onChange={(e) => handleRoleChange(u._id, e.target.value)}
                        disabled={actionLoadingId === u._id || u.role === 'superadmin'}
                        style={{
                          background: '#ffffff',
                          border: '1px solid #d1d5db',
                          color: '#1f2937',
                          fontSize: '12px',
                          borderRadius: '4px',
                          padding: '4px 8px',
                          outline: 'none'
                        }}
                      >
                        <option value="user">DevOps Developer</option>
                        <option value="admin">System Administrator</option>
                        <option value="superadmin">Platform Owner</option>
                      </select>

                      <button
                        onClick={() => handleStatusToggle(u._id, u.status)}
                        disabled={actionLoadingId === u._id || u.role === 'superadmin'}
                        style={{
                          background: u.status === 'banned' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                          border: '1px solid ' + (u.status === 'banned' ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'),
                          color: u.status === 'banned' ? '#059669' : '#ef4444',
                          padding: '5px 10px',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontSize: '11.5px',
                          fontWeight: 600,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}
                      >
                        {u.status === 'banned' ? <UserCheck size={12} /> : <Ban size={12} />}
                        {u.status === 'banned' ? 'Activate' : 'Ban User'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Selected User Detail Side-drawer */}
      {selectedUser && (
        <div style={{
          width: '320px',
          background: '#ffffff',
          border: '1px solid #e5e7eb',
          borderRadius: '8px',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          alignSelf: 'flex-start',
          position: 'sticky',
          top: '20px',
          boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)'
        }}>
          <h3 style={{ fontSize: '15px', fontWeight: 700, margin: '0 0 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#111827' }}>
            <span>User Profile Details</span>
            <button
              onClick={() => setSelectedUser(null)}
              style={{ background: 'none', border: 'none', color: '#4b5563', cursor: 'pointer', fontSize: '11px', fontWeight: 600 }}
            >
              Close
            </button>
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', itemsAlign: 'center', textAlign: 'center', marginBottom: '20px' }}>
            <div style={{
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              background: selectedUser.type === 'admin' ? '#f59e0b' : '#3b82f6',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: '24px',
              margin: '0 auto 12px'
            }}>
              {(selectedUser.firstName || selectedUser.username || 'U')[0].toUpperCase()}
            </div>
            <h4 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 700, color: '#111827' }}>{selectedUser.firstName} {selectedUser.lastName}</h4>
            <div style={{ fontSize: '12px', color: '#4b5563' }}>@{selectedUser.username}</div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '12.5px', borderTop: '1px solid #e5e7eb', paddingTop: '16px' }}>
            <div style={detailRowStyle}>
              <Mail size={13} color="#4b5563" />
              <span style={{ color: '#4b5563' }}>Email:</span>
              <span style={{ fontWeight: 600, color: '#1f2937', marginLeft: 'auto', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: '160px' }} title={selectedUser.email}>{selectedUser.email}</span>
            </div>

            <div style={detailRowStyle}>
              <Phone size={13} color="#4b5563" />
              <span style={{ color: '#4b5563' }}>Mobile:</span>
              <span style={{ fontWeight: 600, color: '#1f2937', marginLeft: 'auto' }}>{selectedUser.mobile || 'N/A'}</span>
            </div>

            <div style={detailRowStyle}>
              <Calendar size={13} color="#4b5563" />
              <span style={{ color: '#4b5563' }}>Birthdate:</span>
              <span style={{ fontWeight: 600, color: '#1f2937', marginLeft: 'auto' }}>
                {selectedUser.dob ? new Date(selectedUser.dob).toLocaleDateString() : 'N/A'}
              </span>
            </div>

            <div style={detailRowStyle}>
              <Calendar size={13} color="#4b5563" />
              <span style={{ color: '#4b5563' }}>Created At:</span>
              <span style={{ fontWeight: 600, color: '#1f2937', marginLeft: 'auto' }}>
                {new Date(selectedUser.createdAt).toLocaleDateString()}
              </span>
            </div>

            <div style={detailRowStyle}>
              <Cpu size={13} color="#4b5563" />
              <span style={{ color: '#4b5563' }}>DevOps Builds:</span>
              <span style={{ fontWeight: 700, color: '#059669', marginLeft: 'auto' }}>{selectedUser.buildCount} active</span>
            </div>

            <div style={detailRowStyle}>
              <Shield size={13} color="#4b5563" />
              <span style={{ color: '#4b5563' }}>Access Status:</span>
              <span style={{
                fontWeight: 700,
                color: selectedUser.status === 'banned' ? '#ef4444' : '#059669',
                marginLeft: 'auto',
                textTransform: 'uppercase',
                fontSize: '11px'
              }}>
                {selectedUser.status === 'banned' ? 'Blocked / Banned' : 'Authorized'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const detailRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px'
};

export default AdminUsersPage;
