import { useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';
import axios from 'axios';
import {
  Terminal, ShieldAlert, Rocket, Play, RefreshCw, Cpu, Layers, ExternalLink,
  Square, ShieldCheck, HardDrive, Download, AlertOctagon, HelpCircle
} from 'lucide-react';

const API_BASE_URL = 'http://localhost:5000/api';

function Fixtures() {
  const [fixtures, setFixtures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Active generation/pipeline build state
  const [activeJobId, setActiveJobId] = useState(null);
  const [activeDeploymentId, setActiveDeploymentId] = useState(null);
  const [activeJobStatus, setActiveJobStatus] = useState(null);
  const [activeJobVulns, setActiveJobVulns] = useState(0);
  const [activeJobLogs, setActiveJobLogs] = useState([]);
  const [activeJobArtifactUrl, setActiveJobArtifactUrl] = useState(null);

  // Live preview state
  const [previewReady, setPreviewReady] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewRunning, setPreviewRunning] = useState(false);
  const [stoppingPreview, setStoppingPreview] = useState(false);
  const [isGuiApp, setIsGuiApp] = useState(false);

  // Teammates review / testing environment states
  const [selectedFixtureId, setSelectedFixtureId] = useState('');
  const [activeTab, setActiveTab] = useState('logs');
  const [reviews, setReviews] = useState([]);
  const [loadingReviews, setLoadingReviews] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [newReview, setNewReview] = useState({
    reviewerName: '',
    status: 'Works',
    rating: 5,
    comment: ''
  });

  const logsEndRef = useRef(null);
  const socketRef = useRef(null);

  const fetchFixtures = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`${API_BASE_URL}/devops/fixtures`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setFixtures(res.data);
      return res.data;
    } catch (err) {
      setError('Failed to fetch test fixtures.');
      return [];
    }
  };

  const fetchReviews = async (frameworkId) => {
    if (!frameworkId) return;
    setLoadingReviews(true);
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`${API_BASE_URL}/devops/fixtures/${frameworkId}/reviews`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setReviews(res.data);
    } catch (err) {
      console.error('Failed to fetch reviews:', err);
    } finally {
      setLoadingReviews(false);
    }
  };

  const handleAddReview = async (e) => {
    e.preventDefault();
    if (!selectedFixtureId) return;
    setSubmittingReview(true);
    try {
      const token = localStorage.getItem('token');
      await axios.post(
        `${API_BASE_URL}/devops/fixtures/${selectedFixtureId}/reviews`,
        newReview,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setNewReview({ reviewerName: '', status: 'Works', rating: 5, comment: '' });
      fetchReviews(selectedFixtureId);
      fetchFixtures();
    } catch (err) {
      alert('Failed to submit review.');
    } finally {
      setSubmittingReview(false);
    }
  };

  useEffect(() => {
    if (selectedFixtureId) {
      fetchReviews(selectedFixtureId);
    }
  }, [selectedFixtureId]);

  // Fetch available fixtures and restore active job status if present
  useEffect(() => {
    const socket = io('http://localhost:5000');
    socketRef.current = socket;

    const init = async () => {
      const token = localStorage.getItem('token');
      
      // 1. Fetch available fixtures
      const list = await fetchFixtures();
      if (list.length > 0) {
        setSelectedFixtureId(list[0].id);
      }
      
      // 2. Fetch deployments to check if there is an active running job
      try {
        const res = await axios.get(`${API_BASE_URL}/devops`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const list = res.data;
        const active = list.find(d => ['pending', 'building', 'scanning'].includes(d.status));
        if (active) {
          setActiveDeploymentId(active._id);
          setActiveJobId(active.jobId);
          setActiveJobStatus(active.status);
          setActiveJobVulns(active.vulnerabilitiesFound || 0);
          setActiveJobLogs(active.buildLogs || []);
          setIsGuiApp(!!active.isGuiApp);
          
          socket.emit('subscribe:pipeline', { jobId: active.jobId });
        }
      } catch (err) {
        console.error('Failed to restore active build state:', err);
      } finally {
        setLoading(false);
      }
    };
    init();

    socket.on('pipeline:log', (data) => {
      setActiveJobLogs((prev) => [...prev, data.log]);
    });

    socket.on('pipeline:complete', (data) => {
      setActiveJobStatus(data.status);
      setActiveJobVulns(data.vulnerabilitiesFound);
      setActiveJobArtifactUrl(data.artifactUrl);
      setIsGuiApp(data.isGuiApp);
    });

    socket.on('preview:ready', (data) => {
      setPreviewReady(true);
      setPreviewRunning(true);
      setPreviewUrl(data.url);
      setActiveJobLogs((prev) => [
        ...prev,
        `[PREVIEW] 🚀 Live app ready at ${data.url}`,
      ]);
    });

    socket.on('preview:stopped', () => {
      setPreviewRunning(false);
      setPreviewReady(false);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // Autoscroll logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeJobLogs]);

  // Launch fixture build
  const launchFixture = async (frameworkId) => {
    setSelectedFixtureId(frameworkId);
    setActiveJobId(null);
    setActiveDeploymentId(null);
    setActiveJobStatus('pending');
    setActiveJobVulns(0);
    setActiveJobLogs([`[SYSTEM] Initializing generation for fixture: ${frameworkId.toUpperCase()}...`]);
    setPreviewReady(false);
    setPreviewRunning(false);
    setPreviewUrl('');
    setIsGuiApp(false);

    try {
      const token = localStorage.getItem('token');
      const res = await axios.post(`${API_BASE_URL}/devops/fixtures/generate`, {
        frameworkId
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const { jobId, deploymentId } = res.data;
      setActiveJobId(jobId);
      setActiveDeploymentId(deploymentId);

      socketRef.current.emit('subscribe:pipeline', { jobId });
    } catch (err) {
      const errMsg = err.response?.data?.message || 'Failed to start fixture pipeline.';
      setActiveJobLogs((prev) => [...prev, `[ERROR] ${errMsg}`]);
      setActiveJobStatus('failed');
    }
  };

  // Stop preview
  const handleStopPreview = async () => {
    if (!activeDeploymentId) return;
    setStoppingPreview(true);
    try {
      const token = localStorage.getItem('token');
      await axios.post(`${API_BASE_URL}/devops/${activeDeploymentId}/stop-preview`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setPreviewRunning(false);
      setPreviewReady(false);
    } catch {
      alert('Could not stop preview.');
    } finally {
      setStoppingPreview(false);
    }
  };

  const downloadPdfReport = async (deploymentId) => {
    if (!deploymentId) return;
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`${API_BASE_URL}/devops/${deploymentId}/pdf-report`, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'blob'
      });
      const blob = new Blob([res.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `security-report-${deploymentId}.pdf`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert('Failed to download PDF report.');
    }
  };

  const getStatusBadgeColor = (status) => {
    switch (status) {
      case 'deployed': return 'var(--sev-low)';
      case 'building': return 'var(--accent-blue)';
      case 'scanning': return 'var(--accent-purple)';
      case 'failed': return 'var(--sev-critical)';
      default: return 'var(--text-muted)';
    }
  };

  const getTechColor = (id) => {
    const colors = {
      express: '#3b82f6',
      fastify: '#06b6d4',
      elysia: '#f43f5e',
      h3: '#8b5cf6',
      hono: '#eab308',
      fastapi: '#10b981',
      flask: '#c084fc',
      koa: '#38bdf8',
      static: '#6b7280',
      gin: '#00add8',
      fiber: '#00add8',
      'echo-go': '#00add8',
      rails: '#cc0000',
      sinatra: '#cc0000',
      dotnet: '#512bd4',
      blazor: '#512bd4',
      phoenix: '#ff6f61',
      'deno-fresh': '#eab308',
      deno: '#a3a3a3',
      'tanstack-start': '#ff5a5f',
      analog: '#e03131',
      symfony: '#a3a3a3',
      quarkus: '#4695eb',
      'bun-native': '#fcd34d',
      svelte: '#ff3e00'
    };
    return colors[id] || '#3b82f6';
  };

  return (
    <div style={{ padding: '30px', display: 'flex', flexDirection: 'column', gap: '30px' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Cpu size={24} color="var(--accent-blue)" />
          <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700 }}>DevOps Test Fixtures</h1>
        </div>
        <p style={{ color: 'var(--text-secondary)', marginTop: '6px', fontSize: '14px' }}>
          Instantly generate and deploy 38 complex pre-configured framework templates inside local isolated sandboxes.
        </p>
      </div>

      {error && (
        <div style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid var(--sev-critical)', padding: '16px', borderRadius: 'var(--radius-md)', color: 'var(--sev-critical)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <AlertOctagon size={18} />
          {error}
        </div>
      )}

      {/* Main Split Layout */}
      <div style={{ display: 'flex', gap: '30px', minHeight: '600px' }}>
        {/* Left Side: Cards list */}
        <div style={{ flex: 1.2, display: 'flex', flexDirection: 'column', gap: '30px', height: '680px', overflowY: 'auto', paddingRight: '16px' }}>
          
          {/* Backend Stack */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <Layers size={16} color="var(--accent-blue)" />
              <h2 style={{ fontSize: '16px', fontWeight: 600, margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>Backend Frameworks</h2>
            </div>
            {loading ? (
              <div style={{ color: 'var(--text-secondary)' }}>Loading templates...</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
                {fixtures.filter(f => f.type === 'Backend').map(f => (
                  <div
                    key={f.id}
                    onClick={() => setSelectedFixtureId(f.id)}
                    style={{
                      background: 'var(--bg-card)',
                      border: selectedFixtureId === f.id
                        ? `1px solid ${getTechColor(f.id)}`
                        : '1px solid var(--border-subtle)',
                      boxShadow: selectedFixtureId === f.id
                        ? `0 0 10px ${getTechColor(f.id)}30`
                        : 'none',
                      borderRadius: 'var(--radius-md)',
                      padding: '20px',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: '16px',
                      transition: 'transform 0.15s, border-color 0.15s, box-shadow 0.15s',
                      cursor: 'pointer'
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.borderColor = getTechColor(f.id);
                      e.currentTarget.style.transform = 'translateY(-2px)';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.borderColor = selectedFixtureId === f.id
                        ? getTechColor(f.id)
                        : 'var(--border-subtle)';
                      e.currentTarget.style.transform = 'none';
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '15px' }}>{f.name}</span>
                        <span style={{
                          background: `${getTechColor(f.id)}20`,
                          color: getTechColor(f.id),
                          border: `1px solid ${getTechColor(f.id)}`,
                          fontSize: '10px',
                          fontWeight: 'bold',
                          padding: '2px 8px',
                          borderRadius: '99px',
                          textTransform: 'uppercase'
                        }}>{f.id}</span>
                      </div>
                      <p style={{ color: 'var(--text-secondary)', fontSize: '12.5px', marginTop: '10px', lineHeight: '1.5' }}>{f.description}</p>
                      
                      {/* Reviews Summary Badge */}
                      {f.reviewCount > 0 ? (
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' }}>
                          <span style={{ fontSize: '11.5px', color: '#f59e0b', fontWeight: 'bold' }}>
                            ★ {f.averageRating.toFixed(1)}
                          </span>
                          <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                            ({f.reviewCount} {f.reviewCount === 1 ? 'review' : 'reviews'})
                          </span>
                        </div>
                      ) : (
                        <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '10px', fontStyle: 'italic' }}>
                          No reviews yet
                        </div>
                      )}
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        launchFixture(f.id);
                      }}
                      disabled={activeJobStatus === 'pending' || activeJobStatus === 'building' || activeJobStatus === 'scanning'}
                      style={{
                        background: 'var(--grad-brand)',
                        border: 'none',
                        color: '#ffffff',
                        borderRadius: 'var(--radius-sm)',
                        padding: '10px 16px',
                        fontWeight: 600,
                        fontSize: '13px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        cursor: 'pointer',
                        transition: 'opacity 0.15s'
                      }}
                      onMouseEnter={e => e.currentTarget.style.opacity = '0.9'}
                      onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                    >
                      <Play size={13} fill="currentColor" /> Generate & Deploy
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Emerging Stack */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <Layers size={16} color="var(--accent-purple)" />
              <h2 style={{ fontSize: '16px', fontWeight: 600, margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)' }}>Emerging & Other Frameworks</h2>
            </div>
            {loading ? (
              <div style={{ color: 'var(--text-secondary)' }}>Loading templates...</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
                {fixtures.filter(f => f.type === 'Emerging').map(f => (
                  <div
                    key={f.id}
                    onClick={() => setSelectedFixtureId(f.id)}
                    style={{
                      background: 'var(--bg-card)',
                      border: selectedFixtureId === f.id
                        ? `1px solid ${getTechColor(f.id)}`
                        : '1px solid var(--border-subtle)',
                      boxShadow: selectedFixtureId === f.id
                        ? `0 0 10px ${getTechColor(f.id)}30`
                        : 'none',
                      borderRadius: 'var(--radius-md)',
                      padding: '20px',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: '16px',
                      transition: 'transform 0.15s, border-color 0.15s, box-shadow 0.15s',
                      cursor: 'pointer'
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.borderColor = getTechColor(f.id);
                      e.currentTarget.style.transform = 'translateY(-2px)';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.borderColor = selectedFixtureId === f.id
                        ? getTechColor(f.id)
                        : 'var(--border-subtle)';
                      e.currentTarget.style.transform = 'none';
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '15px' }}>{f.name}</span>
                        <span style={{
                          background: `${getTechColor(f.id)}20`,
                          color: getTechColor(f.id),
                          border: `1px solid ${getTechColor(f.id)}`,
                          fontSize: '10px',
                          fontWeight: 'bold',
                          padding: '2px 8px',
                          borderRadius: '99px',
                          textTransform: 'uppercase'
                        }}>{f.id}</span>
                      </div>
                      <p style={{ color: 'var(--text-secondary)', fontSize: '12.5px', marginTop: '10px', lineHeight: '1.5' }}>{f.description}</p>
                      
                      {/* Reviews Summary Badge */}
                      {f.reviewCount > 0 ? (
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' }}>
                          <span style={{ fontSize: '11.5px', color: '#f59e0b', fontWeight: 'bold' }}>
                            ★ {f.averageRating.toFixed(1)}
                          </span>
                          <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                            ({f.reviewCount} {f.reviewCount === 1 ? 'review' : 'reviews'})
                          </span>
                        </div>
                      ) : (
                        <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '10px', fontStyle: 'italic' }}>
                          No reviews yet
                        </div>
                      )}
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        launchFixture(f.id);
                      }}
                      disabled={activeJobStatus === 'pending' || activeJobStatus === 'building' || activeJobStatus === 'scanning'}
                      style={{
                        background: 'var(--grad-brand)',
                        border: 'none',
                        color: '#ffffff',
                        borderRadius: 'var(--radius-sm)',
                        padding: '10px 16px',
                        fontWeight: 600,
                        fontSize: '13px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        cursor: 'pointer',
                        transition: 'opacity 0.15s'
                      }}
                      onMouseEnter={e => e.currentTarget.style.opacity = '0.9'}
                      onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                    >
                      <Play size={13} fill="currentColor" /> Generate & Deploy
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>

        {/* Right Side: Deployment Sandbox Logs & Preview */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '20px', height: '680px' }}>
          
          <div style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: '24px',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            overflowY: 'auto'
          }}>
            
            {/* Tab Bar */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', marginBottom: '10px' }}>
              <button
                onClick={() => setActiveTab('logs')}
                style={{
                  flex: 1,
                  padding: '12px',
                  background: 'none',
                  border: 'none',
                  borderBottom: activeTab === 'logs' ? '2px solid var(--accent-blue)' : 'none',
                  color: activeTab === 'logs' ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                Sandbox Execution Logs
              </button>
              <button
                onClick={() => setActiveTab('reviews')}
                style={{
                  flex: 1,
                  padding: '12px',
                  background: 'none',
                  border: 'none',
                  borderBottom: activeTab === 'reviews' ? '2px solid var(--accent-blue)' : 'none',
                  color: activeTab === 'reviews' ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  fontSize: '14px',
                  position: 'relative'
                }}
              >
                Teammate Reviews & Test Status
                {reviews.length > 0 && (
                  <span style={{
                    marginLeft: '8px',
                    background: 'var(--accent-blue)',
                    color: '#fff',
                    borderRadius: '99px',
                    fontSize: '10px',
                    padding: '2px 6px',
                    fontWeight: 'bold'
                  }}>{reviews.length}</span>
                )}
              </button>
            </div>

            {activeTab === 'logs' ? (
              <>
                {/* Header info */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>Active Sandbox Execution</h3>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Job ID: {activeJobId || 'No active job'}</span>
                  </div>
                  {activeJobStatus && (
                    <div style={{
                      background: `${getStatusBadgeColor(activeJobStatus)}20`,
                      color: getStatusBadgeColor(activeJobStatus),
                      border: `1px solid ${getStatusBadgeColor(activeJobStatus)}`,
                      borderRadius: '99px',
                      padding: '4px 12px',
                      fontSize: '12px',
                      fontWeight: 'bold',
                      textTransform: 'uppercase',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}>
                      {activeJobStatus === 'building' || activeJobStatus === 'scanning' ? (
                        <RefreshCw size={12} className="spin" />
                      ) : null}
                      {activeJobStatus}
                    </div>
                  )}
                </div>

                {/* Metrics cards if building / running */}
                {activeJobStatus && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
                    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', padding: '12px', borderRadius: 'var(--radius-sm)' }}>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Audited Vulns</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
                        <ShieldAlert size={16} color={activeJobVulns > 0 ? 'var(--sev-critical)' : 'var(--sev-low)'} />
                        <span style={{ fontSize: '18px', fontWeight: 'bold', color: activeJobVulns > 0 ? 'var(--sev-critical)' : 'var(--text-primary)' }}>{activeJobVulns}</span>
                      </div>
                    </div>
                    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', padding: '12px', borderRadius: 'var(--radius-sm)' }}>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Preview Port</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
                        <HardDrive size={16} color="var(--accent-blue)" />
                        <span style={{ fontSize: '18px', fontWeight: 'bold' }}>{previewUrl ? previewUrl.split(':').pop() : '—'}</span>
                      </div>
                    </div>
                    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', padding: '12px', borderRadius: 'var(--radius-sm)' }}>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Isolated Mode</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
                        <ShieldCheck size={16} color="var(--sev-low)" />
                        <span style={{ fontSize: '14px', fontWeight: 'bold', color: 'var(--sev-low)' }}>Docker Container</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Console Log stream */}
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: '300px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <Terminal size={14} color="var(--text-muted)" />
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Console Outputs</span>
                  </div>
                  <div style={{
                    background: 'rgba(0,0,0,0.4)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '16px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '12px',
                    lineHeight: '1.6',
                    overflowY: 'auto',
                    height: '350px',
                    maxHeight: '350px',
                    color: '#34d399'
                  }}>
                    {activeJobLogs.length === 0 ? (
                      <div style={{ color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center', marginTop: '120px' }}>
                        Select any framework on the left and click "Generate & Deploy" to boot up sandbox environment.
                      </div>
                    ) : (
                      activeJobLogs.map((log, idx) => (
                        <div key={idx} style={{ whiteSpace: 'pre-wrap', marginBottom: '4px' }}>{log}</div>
                      ))
                    )}
                    <div ref={logsEndRef} />
                  </div>
                </div>

                {/* Quick Actions / Previews */}
                {activeJobStatus === 'deployed' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px', width: '100%' }}>
                    
                    {/* Download PDF button */}
                    <button
                      onClick={() => downloadPdfReport(activeDeploymentId)}
                      style={{
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        color: '#f87171',
                        borderRadius: 'var(--radius-sm)',
                        padding: '12px',
                        fontWeight: 'bold',
                        fontSize: '13px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        cursor: 'pointer',
                        width: '100%'
                      }}
                    >
                      <ShieldAlert size={14} /> Download Vulnerability Report (PDF)
                    </button>
                    
                    <div style={{ display: 'flex', gap: '10px', width: '100%' }}>
                      {isGuiApp ? (
                        <div style={{
                          background: 'rgba(249, 115, 22, 0.1)',
                          border: '1px solid var(--sev-high)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '12px',
                          color: 'var(--sev-high)',
                          width: '100%',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px'
                        }}>
                          <div style={{ fontWeight: 'bold', fontSize: '13px' }}>🖥️ Desktop GUI Application Built</div>
                          <div style={{ fontSize: '12px', opacity: 0.9 }}>This project does not run on a web port. Download the ZIP file to extract and run the executable locally.</div>
                          {activeJobArtifactUrl && (
                            <a
                              href={`http://localhost:5000${activeJobArtifactUrl}`}
                              download
                              style={{
                                background: 'var(--sev-high)',
                                color: '#fff',
                                border: 'none',
                                padding: '6px 12px',
                                borderRadius: '4px',
                                textDecoration: 'none',
                                fontSize: '12px',
                                fontWeight: 'bold',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '6px',
                                width: 'fit-content',
                                marginTop: '4px'
                              }}
                            >
                              <Download size={12} /> Download ZIP
                            </a>
                          )}
                        </div>
                      ) : (
                        <>
                          {previewReady && previewRunning ? (
                            <>
                              <a
                                href={previewUrl}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  flex: 1.5,
                                  background: 'var(--grad-success)',
                                  color: '#fff',
                                  border: 'none',
                                  borderRadius: 'var(--radius-sm)',
                                  padding: '12px',
                                  fontWeight: 'bold',
                                  fontSize: '13px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: '8px',
                                  textDecoration: 'none',
                                  boxShadow: '0 4px 12px rgba(34, 197, 94, 0.2)'
                                }}
                              >
                                <Rocket size={14} /> Open Live Preview <ExternalLink size={12} />
                              </a>
                              <button
                                onClick={handleStopPreview}
                                disabled={stoppingPreview}
                                style={{
                                  flex: 1,
                                  background: 'rgba(239, 68, 68, 0.1)',
                                  border: '1px solid var(--sev-critical)',
                                  color: 'var(--sev-critical)',
                                  borderRadius: 'var(--radius-sm)',
                                  padding: '12px',
                                  fontWeight: 'bold',
                                  fontSize: '13px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: '8px',
                                  cursor: 'pointer'
                                }}
                              >
                                <Square size={13} fill="currentColor" /> Stop Preview
                              </button>
                            </>
                          ) : (
                            <div style={{ color: 'var(--text-muted)', fontSize: '13px', fontStyle: 'italic' }}>
                              Preview stopped or terminating.
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              // Teammate reviews tab
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', flex: 1 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                    Reviews: {selectedFixtureId ? (fixtures.find(f => f.id === selectedFixtureId)?.name || selectedFixtureId) : 'No template selected'}
                  </h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12.5px', marginTop: '4px' }}>
                    Teammate reviews and test environment status checks stored in DB.
                  </p>
                </div>

                {/* Review metrics */}
                <div style={{ display: 'flex', gap: '10px', background: 'var(--bg-card)', padding: '12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', justifyContent: 'space-around', alignItems: 'center' }}>
                  <div>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase', display: 'block', fontWeight: 600 }}>Avg Rating</span>
                    <span style={{ fontSize: '16px', fontWeight: 'bold', color: '#f59e0b' }}>
                      {reviews.length > 0
                        ? (reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length).toFixed(1) + ' ★'
                        : 'No reviews'}
                    </span>
                  </div>
                  <div style={{ height: '30px', width: '1px', background: 'var(--border-subtle)' }} />
                  <div>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase', display: 'block', fontWeight: 600 }}>Works</span>
                    <span style={{ fontSize: '16px', fontWeight: 'bold', color: 'var(--sev-low)' }}>
                      {reviews.filter(r => r.status === 'Works').length}
                    </span>
                  </div>
                  <div style={{ height: '30px', width: '1px', background: 'var(--border-subtle)' }} />
                  <div>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase', display: 'block', fontWeight: 600 }}>Buggy</span>
                    <span style={{ fontSize: '16px', fontWeight: 'bold', color: '#f97316' }}>
                      {reviews.filter(r => r.status === 'Buggy').length}
                    </span>
                  </div>
                  <div style={{ height: '30px', width: '1px', background: 'var(--border-subtle)' }} />
                  <div>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase', display: 'block', fontWeight: 600 }}>Broken</span>
                    <span style={{ fontSize: '16px', fontWeight: 'bold', color: 'var(--sev-critical)' }}>
                      {reviews.filter(r => r.status === 'Broken').length}
                    </span>
                  </div>
                </div>

                {/* Reviews List */}
                <div style={{
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '16px',
                  height: '240px',
                  maxHeight: '240px',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px'
                }}>
                  {loadingReviews ? (
                    <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: '80px' }}>Loading reviews...</div>
                  ) : reviews.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center', marginTop: '80px', fontSize: '13px' }}>
                      No reviews submitted for this framework template yet. Be the first to leave a feedback review!
                    </div>
                  ) : (
                    reviews.map((r) => (
                      <div
                        key={r._id}
                        style={{
                          background: 'var(--bg-card)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '12px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px'
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontWeight: 'bold', color: 'var(--text-primary)', fontSize: '13px' }}>{r.reviewerName}</span>
                          <span style={{
                            fontSize: '10px',
                            fontWeight: 'bold',
                            padding: '2px 8px',
                            borderRadius: '99px',
                            background: r.status === 'Works' ? 'rgba(34,197,94,0.1)' : r.status === 'Buggy' ? 'rgba(249,115,22,0.1)' : 'rgba(239,68,68,0.1)',
                            color: r.status === 'Works' ? 'var(--sev-low)' : r.status === 'Buggy' ? '#f97316' : 'var(--sev-critical)',
                            border: `1px solid ${r.status === 'Works' ? 'var(--sev-low)' : r.status === 'Buggy' ? '#f97316' : 'var(--sev-critical)'}`
                          }}>{r.status}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
                          <span>Rating: <span style={{ color: '#f59e0b', fontWeight: 'bold' }}>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span></span>
                          <span>{new Date(r.createdAt).toLocaleDateString()}</span>
                        </div>
                        {r.comment && (
                          <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>{r.comment}</p>
                        )}
                      </div>
                    ))
                  )}
                </div>

                {/* Review Form */}
                <form onSubmit={handleAddReview} style={{ display: 'flex', flexDirection: 'column', gap: '10px', background: 'var(--bg-card)', padding: '16px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                  <div style={{ fontSize: '13px', fontWeight: 'bold', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '6px', color: 'var(--text-primary)' }}>Submit Test Review & Feedback</div>
                  
                  <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr', gap: '8px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600 }}>Teammate Name</label>
                      <input
                        type="text"
                        required
                        value={newReview.reviewerName}
                        onChange={(e) => setNewReview({ ...newReview, reviewerName: e.target.value })}
                        placeholder="e.g. Yash"
                        style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', padding: '8px', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '12px', outline: 'none' }}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600 }}>Test Status</label>
                      <select
                        value={newReview.status}
                        onChange={(e) => setNewReview({ ...newReview, status: e.target.value })}
                        style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', padding: '8px', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '12px', outline: 'none' }}
                      >
                        <option value="Works">Works</option>
                        <option value="Buggy">Buggy</option>
                        <option value="Broken">Broken</option>
                      </select>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600 }}>Rating</label>
                      <select
                        value={newReview.rating}
                        onChange={(e) => setNewReview({ ...newReview, rating: parseInt(e.target.value) })}
                        style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', padding: '8px', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '12px', outline: 'none' }}
                      >
                        <option value="5">5 Stars</option>
                        <option value="4">4 Stars</option>
                        <option value="3">3 Stars</option>
                        <option value="2">2 Stars</option>
                        <option value="1">1 Star</option>
                      </select>
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600 }}>Comments / Review Notes</label>
                    <textarea
                      value={newReview.comment}
                      onChange={(e) => setNewReview({ ...newReview, comment: e.target.value })}
                      placeholder="Comment on package dependencies, compile times, or running issues..."
                      rows="2"
                      style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', padding: '8px', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '12px', outline: 'none', resize: 'none' }}
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={submittingReview || !selectedFixtureId}
                    style={{
                      background: 'var(--grad-brand)',
                      color: '#fff',
                      border: 'none',
                      padding: '10px',
                      borderRadius: '4px',
                      fontWeight: 'bold',
                      fontSize: '13px',
                      cursor: 'pointer',
                      transition: 'opacity 0.15s'
                    }}
                    onMouseEnter={e => e.currentTarget.style.opacity = '0.9'}
                    onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                  >
                    {submittingReview ? 'Submitting...' : 'Submit Test Review'}
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Fixtures;
