import { useEffect, useState } from 'react';
import { getAdminThresholds, updateAdminThresholds, getAdminDeployments, stopDeploymentPreview } from '../services/api';
import {
  Server, Shield, ToggleLeft, ToggleRight, Settings, CheckSquare, Square,
  Play, Square as StopIcon, RefreshCw, AlertCircle, Ban, Trash2, Cpu,
  Database, Activity, Search, Filter, ExternalLink
} from 'lucide-react';

function AdminManageDevOps() {
  const [thresholds, setThresholds] = useState({
    maxBuildsPerUser: 5,
    maxConcurrentContainers: 3,
    allowedPortRangeMin: 3000,
    allowedPortRangeMax: 4000,
    buildTimeoutSeconds: 600,
    sandboxTTLSeconds: 3600,
    pipelineSteps: { extract: true, techDetect: true, install: true, sast: true, build: true },
    githubEnabled: true
  });

  const [deployments, setDeployments] = useState([]);
  const [filterQuery, setFilterQuery] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState('');
  const [actionLoadingId, setActionLoadingId] = useState(null);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError('');
      const [thresholdsRes, deploymentsRes] = await Promise.all([
        getAdminThresholds('devops'),
        getAdminDeployments()
      ]);
      if (thresholdsRes.data) {
        setThresholds(thresholdsRes.data);
      }
      setDeployments(deploymentsRes.data || []);
    } catch (err) {
      setError('Failed to fetch DevOps management data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleSaveThresholds = async (e) => {
    e.preventDefault();
    try {
      setSaveSuccess('');
      setError('');
      await updateAdminThresholds('devops', thresholds);
      setSaveSuccess('DevOps limits and threshold policies updated successfully.');
      setTimeout(() => setSaveSuccess(''), 4000);
    } catch (err) {
      setError('Failed to update thresholds configuration.');
    }
  };

  const handleStopPreview = async (id) => {
    try {
      setActionLoadingId(id);
      await stopDeploymentPreview(id);
      // Reload deployments
      const deploymentsRes = await getAdminDeployments();
      setDeployments(deploymentsRes.data || []);
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to stop container preview');
    } finally {
      setActionLoadingId(null);
    }
  };

  const togglePipelineStep = (step) => {
    setThresholds(prev => ({
      ...prev,
      pipelineSteps: {
        ...prev.pipelineSteps,
        [step]: !prev.pipelineSteps[step]
      }
    }));
  };

  if (loading) {
    return (
      <div style={{ color: '#9ca3af', padding: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <RefreshCw className="animate-spin" size={16} /> Loading DevOps control panel...
      </div>
    );
  }

  const runningPreviews = deployments.filter(d => d.previewStatus === 'running');

  const filteredDeployments = deployments.filter(d => {
    if (!filterQuery) return true;
    const query = filterQuery.toLowerCase();
    if (filterType === 'all') {
      return (d.projectName?.toLowerCase().includes(query) || 
              d.deployedBy?.username?.toLowerCase().includes(query) ||
              d.deployedBy?.email?.toLowerCase().includes(query) ||
              d.status?.toLowerCase().includes(query));
    }
    if (filterType === 'username') return d.deployedBy?.username?.toLowerCase().includes(query);
    if (filterType === 'email') return d.deployedBy?.email?.toLowerCase().includes(query);
    if (filterType === 'projectName') return d.projectName?.toLowerCase().includes(query);
    if (filterType === 'status') return d.status?.toLowerCase().includes(query);
    return true;
  });

  return (
    <div style={{ color: '#1f2937' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, margin: 0, color: '#111827', letterSpacing: '-0.5px' }}>Manage DevOps Limits</h1>
          <p style={{ fontSize: '13px', color: '#4b5563', marginTop: '4px' }}>Hostinger-style build limits, allowed ports, and pipeline control</p>
        </div>
        <button
          onClick={fetchData}
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
          <RefreshCw size={14} /> Reload deployments
        </button>
      </div>

      {saveSuccess && (
        <div style={{ padding: '12px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '6px', color: '#10b981', marginBottom: '20px', fontSize: '13px' }}>
          {saveSuccess}
        </div>
      )}

      {error && (
        <div style={{ padding: '12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '6px', color: '#ef4444', marginBottom: '20px', fontSize: '13px' }}>
          {error}
        </div>
      )}

      {/* Platform Monitoring Cards */}
      <div style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 700, margin: '0 0 14px', color: '#111827' }}>Platform Monitoring</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
          {/* Card 1: Prometheus */}
          <a href="http://localhost:9090" target="_blank" rel="noreferrer" style={{ textDecoration: 'none', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px', transition: 'all 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }} onMouseEnter={e => e.currentTarget.style.borderColor = '#3b82f6'} onMouseLeave={e => e.currentTarget.style.borderColor = '#e5e7eb'}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ background: 'rgba(59,130,246,0.1)', padding: '8px', borderRadius: '8px', color: '#3b82f6' }}>
                <Activity size={20} />
              </div>
              <ExternalLink size={14} color="#9ca3af" />
            </div>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#111827' }}>Prometheus</div>
              <div style={{ fontSize: '12px', color: '#6b7280' }}>Metrics & Alerting</div>
            </div>
          </a>

          {/* Card 2: Grafana */}
          <a href="http://localhost:3000" target="_blank" rel="noreferrer" style={{ textDecoration: 'none', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px', transition: 'all 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }} onMouseEnter={e => e.currentTarget.style.borderColor = '#f59e0b'} onMouseLeave={e => e.currentTarget.style.borderColor = '#e5e7eb'}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ background: 'rgba(245,158,11,0.1)', padding: '8px', borderRadius: '8px', color: '#f59e0b' }}>
                <Activity size={20} />
              </div>
              <ExternalLink size={14} color="#9ca3af" />
            </div>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#111827' }}>Grafana</div>
              <div style={{ fontSize: '12px', color: '#6b7280' }}>Dashboard Visualizations</div>
            </div>
          </a>

          {/* Card 3: Minikube Dashboard */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ background: 'rgba(16,185,129,0.1)', padding: '8px', borderRadius: '8px', color: '#10b981' }}>
                <Server size={20} />
              </div>
            </div>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#111827' }}>Minikube Dashboard</div>
              <div style={{ fontSize: '12px', color: '#6b7280' }}>Run <code>minikube dashboard</code> in terminal</div>
            </div>
          </div>

          {/* Card 4: PgVector DB */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ background: 'rgba(99,102,241,0.1)', padding: '8px', borderRadius: '8px', color: '#6366f1' }}>
                <Database size={20} />
              </div>
            </div>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#111827' }}>PgVector DB</div>
              <div style={{ fontSize: '11px', color: '#6b7280', fontFamily: 'monospace', marginTop: '4px', background: '#f3f4f6', padding: '4px', borderRadius: '4px', overflowX: 'auto', whiteSpace: 'nowrap' }}>postgres://postgres:postgres@localhost:5433/agent_memory</div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: '20px' }}>
        {/* Limits configuration form */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
            <Settings size={18} color="#f59e0b" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0 }}>Sandbox Quotas & Limits</h3>
          </div>

          <form onSubmit={handleSaveThresholds} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={labelStyle}>Max Builds Per User</label>
              <input
                type="number"
                value={thresholds.maxBuildsPerUser}
                onChange={(e) => setThresholds({ ...thresholds, maxBuildsPerUser: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min={1}
                required
              />
            </div>

            <div>
              <label style={labelStyle}>Max Concurrent Previews ({thresholds.maxConcurrentContainers})</label>
              <input
                type="range"
                min="1"
                max="10"
                value={thresholds.maxConcurrentContainers}
                onChange={(e) => setThresholds({ ...thresholds, maxConcurrentContainers: parseInt(e.target.value, 10) })}
                style={{ width: '100%', accentColor: '#f59e0b' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={labelStyle}>Min Port</label>
                <input
                  type="number"
                  value={thresholds.allowedPortRangeMin}
                  onChange={(e) => setThresholds({ ...thresholds, allowedPortRangeMin: parseInt(e.target.value, 10) })}
                  style={inputStyle}
                  required
                />
              </div>
              <div>
                <label style={labelStyle}>Max Port</label>
                <input
                  type="number"
                  value={thresholds.allowedPortRangeMax}
                  onChange={(e) => setThresholds({ ...thresholds, allowedPortRangeMax: parseInt(e.target.value, 10) })}
                  style={inputStyle}
                  required
                />
              </div>
            </div>

            <div>
              <label style={labelStyle}>Build Timeout (seconds)</label>
              <input
                type="number"
                value={thresholds.buildTimeoutSeconds}
                onChange={(e) => setThresholds({ ...thresholds, buildTimeoutSeconds: parseInt(e.target.value, 10) })}
                style={inputStyle}
                required
              />
            </div>

            <div>
              <label style={labelStyle}>Sandbox TTL (seconds)</label>
              <input
                type="number"
                value={thresholds.sandboxTTLSeconds || 3600}
                onChange={(e) => setThresholds({ ...thresholds, sandboxTTLSeconds: parseInt(e.target.value, 10) })}
                style={inputStyle}
                min={60}
                required
              />
            </div>

            {/* Checkboxes: Pipeline Steps */}
            <div>
              <label style={labelStyle}>Pipeline Stage Toggles</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
                {Object.keys(thresholds.pipelineSteps).map((step) => (
                  <div
                    key={step}
                    onClick={() => togglePipelineStep(step)}
                    style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', cursor: 'pointer' }}
                  >
                    {thresholds.pipelineSteps[step] ? (
                      <CheckSquare size={16} color="#f59e0b" />
                    ) : (
                      <Square size={16} color="#6b7280" />
                    )}
                    <span style={{ textTransform: 'capitalize' }}>
                      {step === 'techDetect' ? 'Technology Detection' : step === 'sast' ? 'SAST Code Scan' : step} Stage
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Global GitHub Switch */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #e5e7eb', paddingTop: '14px', marginTop: '6px' }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#111827' }}>Enable GitHub Integrations</div>
                <div style={{ fontSize: '11px', color: '#4b5563' }}>Enables linking accounts and imports</div>
              </div>
              <button
                type="button"
                onClick={() => setThresholds({ ...thresholds, githubEnabled: !thresholds.githubEnabled })}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                {thresholds.githubEnabled ? (
                  <ToggleRight size={38} color="#f59e0b" />
                ) : (
                  <ToggleLeft size={38} color="#4b5563" />
                )}
              </button>
            </div>

            <button
              type="submit"
              style={{
                background: '#f59e0b',
                color: '#fff',
                border: 'none',
                padding: '10px 16px',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 700,
                fontSize: '13.5px',
                marginTop: '10px'
              }}
            >
              Save Platform Policies
            </button>
          </form>
        </div>

        {/* Live containers/processes list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Running list */}
          <div style={panelStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
              <Cpu size={18} color="#10b981" />
              <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>
                Live Active Preview Containers ({runningPreviews.length})
              </h3>
            </div>

            {runningPreviews.length === 0 ? (
              <div style={{ color: '#4b5563', fontSize: '13px', textAlign: 'center', padding: '30px' }}>
                No active container sandbox previews currently running.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {runningPreviews.map((d) => (
                  <div
                    key={d._id}
                    style={{
                      background: '#f9fafb',
                      border: '1px solid #e5e7eb',
                      borderRadius: '6px',
                      padding: '12px 16px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}
                  >
                    <div style={{ color: '#1f2937' }}>
                      <div style={{ fontSize: '13.5px', fontWeight: 700, color: '#111827' }}>{d.projectName}</div>
                      <div style={{ fontSize: '11px', color: '#4b5563', marginTop: '2px' }}>
                        Port: <span style={{ fontFamily: 'monospace', color: '#059669', fontWeight: 700 }}>{d.previewPort}</span> | User:{' '}
                        <span style={{ fontWeight: 600, color: '#111827' }}>{d.deployedBy?.username || 'System'}</span>
                      </div>
                    </div>

                    <button
                      onClick={() => handleStopPreview(d._id)}
                      disabled={actionLoadingId === d._id}
                      style={{
                        background: 'rgba(239,68,68,0.1)',
                        border: '1px solid rgba(239,68,68,0.2)',
                        color: '#ef4444',
                        padding: '6px 12px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px'
                      }}
                    >
                      <Ban size={12} />
                      {actionLoadingId === d._id ? 'Stopping...' : 'Kill Process'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Leaderboard or general deployments */}
          <div style={panelStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>All Build Sandbox Registry</h3>
              
              {/* Filter Controls */}
              <div style={{ display: 'flex', gap: '8px' }}>
                <div style={{ position: 'relative' }}>
                  <Search size={14} color="#9ca3af" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
                  <input
                    type="text"
                    placeholder="Search deployments..."
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    style={{
                      padding: '6px 10px 6px 30px',
                      borderRadius: '6px',
                      border: '1px solid #d1d5db',
                      fontSize: '12px',
                      width: '200px',
                      outline: 'none',
                      background: '#fff',
                      color: '#1f2937'
                    }}
                  />
                </div>
                <div style={{ position: 'relative' }}>
                  <Filter size={14} color="#9ca3af" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
                  <select
                    value={filterType}
                    onChange={(e) => setFilterType(e.target.value)}
                    style={{
                      padding: '6px 10px 6px 30px',
                      borderRadius: '6px',
                      border: '1px solid #d1d5db',
                      fontSize: '12px',
                      background: '#fff',
                      color: '#1f2937',
                      outline: 'none',
                      cursor: 'pointer',
                      appearance: 'none',
                      paddingRight: '24px'
                    }}
                  >
                    <option value="all">All Fields</option>
                    <option value="projectName">Project</option>
                    <option value="username">Username</option>
                    <option value="email">Email</option>
                    <option value="status">Status</option>
                  </select>
                  <div style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', fontSize: '10px', color: '#6b7280' }}>▼</div>
                </div>
              </div>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left' }}>
                    <th style={{ padding: '8px 0', color: '#4b5563' }}>Project</th>
                    <th style={{ padding: '8px 0', color: '#4b5563' }}>User</th>
                    <th style={{ padding: '8px 0', color: '#4b5563' }}>Email</th>
                    <th style={{ padding: '8px 0', color: '#4b5563' }}>Stack</th>
                    <th style={{ padding: '8px 0', color: '#4b5563' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDeployments.length === 0 ? (
                    <tr>
                      <td colSpan="5" style={{ padding: '20px', textAlign: 'center', color: '#6b7280' }}>
                        No deployments found matching your filters.
                      </td>
                    </tr>
                  ) : (
                    filteredDeployments.map((d) => (
                      <tr key={d._id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '10px 0', fontWeight: 600, color: '#1f2937' }}>{d.projectName}</td>
                        <td style={{ padding: '10px 0', color: '#1f2937' }}>{d.deployedBy?.username || 'Unknown'}</td>
                        <td style={{ padding: '10px 0', color: '#6b7280' }}>{d.deployedBy?.email || '-'}</td>
                        <td style={{ padding: '10px 0', color: '#4b5563' }}>{d.techStackDetected || 'Pending'}</td>
                        <td style={{ padding: '10px 0' }}>
                          <span
                            style={{
                              padding: '2px 6px',
                              borderRadius: '4px',
                              fontSize: '11px',
                              fontWeight: 700,
                              background:
                                d.status === 'deployed'
                                  ? 'rgba(16,185,129,0.1)'
                                  : d.status === 'failed'
                                  ? 'rgba(239,68,68,0.1)'
                                  : 'rgba(245,158,11,0.1)',
                              color: d.status === 'deployed' ? '#059669' : d.status === 'failed' ? '#ef4444' : '#d97706'
                            }}
                          >
                            {d.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Inline Styles
const panelStyle = {
  background: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  padding: '20px',
  boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
};

const inputStyle = {
  background: '#ffffff',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  padding: '8px 12px',
  color: '#1f2937',
  width: '100%',
  outline: 'none',
  boxSizing: 'border-box',
  marginTop: '4px'
};

const labelStyle = {
  fontSize: '11px',
  fontWeight: 700,
  color: '#4b5563',
  textTransform: 'uppercase',
  letterSpacing: '0.06em'
};

export default AdminManageDevOps;
