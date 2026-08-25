import { useEffect, useState } from 'react';
import { getAdminStats } from '../services/api';
import {
  Users, Server, ShieldAlert, Cpu, Activity, LogOut, CheckCircle2,
  HardDrive, AlertCircle, RefreshCw, Bot
} from 'lucide-react';
import { BarChart, Bar, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

function AdminOverviewPage() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchStats = async () => {
    try {
      setLoading(true);
      const res = await getAdminStats();
      setStats(res.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to fetch admin stats');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  if (loading) {
    return (
      <div style={{ color: '#4b5563', padding: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <RefreshCw className="animate-spin" size={16} /> Loading admin console...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ color: '#ef4444', padding: '20px', background: 'rgba(239,68,68,0.1)', borderRadius: '6px', border: '1px solid rgba(239,68,68,0.2)' }}>
        <AlertCircle size={20} style={{ display: 'inline', marginRight: '8px', verticalAlign: 'middle' }} />
        {error}
      </div>
    );
  }

  return (
    <div style={{ color: '#1f2937' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, margin: 0, color: '#111827', letterSpacing: '-0.5px' }}>Platform Overview</h1>
          <p style={{ fontSize: '13px', color: '#4b5563', marginTop: '4px' }}>System god-view control panel and resource logs</p>
        </div>
        <button
          onClick={fetchStats}
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
          <RefreshCw size={14} /> Refresh metrics
        </button>
      </div>

      {/* Stats Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <div style={cardStyle}>
          <div style={cardHeaderStyle}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#4b5563' }}>Standard Users</span>
            <Users size={18} color="#f59e0b" />
          </div>
          <div style={cardValueStyle}>{stats.totalUsers}</div>
          <div style={{ fontSize: '11px', color: '#059669', marginTop: '4px', fontWeight: 500 }}>+ {stats.totalAdmins} Administrators</div>
        </div>

        <div style={cardStyle}>
          <div style={cardHeaderStyle}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#4b5563' }}>Total Builds</span>
            <Server size={18} color="#10b981" />
          </div>
          <div style={cardValueStyle}>{stats.totalBuilds}</div>
          <div style={{ fontSize: '11px', color: '#4b5563', marginTop: '4px' }}>{stats.buildsToday} compiled today</div>
        </div>

        <div style={cardStyle}>
          <div style={cardHeaderStyle}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#4b5563' }}>Threat Events</span>
            <ShieldAlert size={18} color="#ef4444" />
          </div>
          <div style={cardValueStyle}>{stats.totalThreats}</div>
          <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '4px', fontWeight: 500 }}>{stats.threatsToday} active alerts today</div>
        </div>

        <div style={cardStyle}>
          <div style={cardHeaderStyle}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#4b5563' }}>Agent Tokens Used</span>
            <Bot size={18} color="#3b82f6" />
          </div>
          <div style={cardValueStyle}>{stats.totalTokens.toLocaleString()}</div>
          <div style={{ fontSize: '11px', color: '#4b5563', marginTop: '4px' }}>Total across active chats</div>
        </div>
      </div>

      {/* System Health + Trend Section */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '20px', marginBottom: '24px' }}>
        {/* Activity Chart */}
        <div style={panelStyle}>
          <h3 style={{ fontSize: '15px', fontWeight: 700, margin: '0 0 16px', color: '#111827' }}>Telemetry Activity Trend (Last 7 Days)</h3>
          <div style={{ height: '220px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.activityTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" stroke="#4b5563" tick={{ fontSize: 11 }} />
                <YAxis stroke="#4b5563" tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '6px', color: '#1f2937' }} />
                <Bar dataKey="builds" name="DevOps Builds" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Bar dataKey="threats" name="Threats Checked" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* System Load */}
        <div style={panelStyle}>
          <h3 style={{ fontSize: '15px', fontWeight: 700, margin: '0 0 16px', color: '#111827' }}>Host Sandbox Server Status</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <div style={telemetryRow}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#374151', fontWeight: 500 }}><Cpu size={15} color="#3b82f6" /> CPU Load</span>
                <span style={{ fontSize: '13px', fontWeight: 700, color: '#111827' }}>{stats.systemHealth.cpuUsage}%</span>
              </div>
              <div style={progressOuter}><div style={{ ...progressInner, width: `${stats.systemHealth.cpuUsage}%`, background: '#3b82f6' }} /></div>
            </div>

            <div>
              <div style={telemetryRow}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#374151', fontWeight: 500 }}><Activity size={15} color="#10b981" /> Memory Allocations</span>
                <span style={{ fontSize: '13px', fontWeight: 700, color: '#111827' }}>{stats.systemHealth.memoryUsage}%</span>
              </div>
              <div style={progressOuter}><div style={{ ...progressInner, width: `${stats.systemHealth.memoryUsage}%`, background: '#10b981' }} /></div>
            </div>

            <div>
              <div style={telemetryRow}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#374151', fontWeight: 500 }}><HardDrive size={15} color="#f59e0b" /> Local NVMe Disk Storage</span>
                <span style={{ fontSize: '13px', fontWeight: 700, color: '#111827' }}>{stats.systemHealth.diskUsage}%</span>
              </div>
              <div style={progressOuter}><div style={{ ...progressInner, width: `${stats.systemHealth.diskUsage}%`, background: '#f59e0b' }} /></div>
            </div>

            <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: '12px', display: 'flex', justifyContent: 'space-between', fontSize: '12.5px', color: '#4b5563' }}>
              <span>Platform Uptime:</span>
              <span style={{ fontWeight: 600, color: '#111827' }}>{stats.systemHealth.uptimeDays} days, 4 hours</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Styling Constants
const cardStyle = {
  background: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  padding: '20px',
  boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
};

const cardHeaderStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const cardValueStyle = {
  fontSize: '28px',
  fontWeight: 800,
  marginTop: '8px',
  color: '#111827',
  letterSpacing: '-1px'
};

const panelStyle = {
  background: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  padding: '20px',
  boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
};

const telemetryRow = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '6px'
};

const progressOuter = {
  width: '100%',
  height: '6px',
  background: '#e5e7eb',
  borderRadius: '3px',
  overflow: 'hidden'
};

const progressInner = {
  height: '100%',
  borderRadius: '3px',
  transition: 'width 0.4s ease-out'
};

export default AdminOverviewPage;
