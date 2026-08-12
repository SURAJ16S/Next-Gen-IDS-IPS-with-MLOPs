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

  const logsEndRef = useRef(null);
  const socketRef = useRef(null);

  // Fetch available fixtures
  useEffect(() => {
    const fetchFixtures = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await axios.get(`${API_BASE_URL}/devops/fixtures`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        setFixtures(res.data);
      } catch (err) {
        setError('Failed to fetch test fixtures.');
      } finally {
        setLoading(false);
      }
    };
    fetchFixtures();

    // Setup socket
    socketRef.current = io('http://localhost:5000');

    socketRef.current.on('pipeline:log', (data) => {
      setActiveJobLogs((prev) => [...prev, data.log]);
    });

    socketRef.current.on('pipeline:complete', (data) => {
      setActiveJobStatus(data.status);
      setActiveJobVulns(data.vulnerabilitiesFound);
      setActiveJobArtifactUrl(data.artifactUrl);
      setIsGuiApp(data.isGuiApp);
    });

    socketRef.current.on('preview:ready', (data) => {
      setPreviewReady(true);
      setPreviewRunning(true);
      setPreviewUrl(data.url);
      setActiveJobLogs((prev) => [
        ...prev,
        `[PREVIEW] 🚀 Live app ready at ${data.url}`,
      ]);
    });

    socketRef.current.on('preview:stopped', () => {
      setPreviewRunning(false);
      setPreviewReady(false);
    });

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
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
      static: '#6b7280'
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
          Instantly generate and deploy 16 complex pre-configured framework templates inside local isolated sandboxes.
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
        <div style={{ flex: 1.2, display: 'flex', flexDirection: 'column', gap: '30px' }}>
          
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
                    style={{
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)',
                      padding: '20px',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: '16px',
                      transition: 'transform 0.15s, border-color 0.15s',
                      cursor: 'pointer'
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.borderColor = getTechColor(f.id);
                      e.currentTarget.style.transform = 'translateY(-2px)';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.borderColor = 'var(--border-subtle)';
                      e.currentTarget.style.transform = 'none';
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 700, color: '#fff', fontSize: '15px' }}>{f.name}</span>
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
                    </div>

                    <button
                      onClick={() => launchFixture(f.id)}
                      disabled={activeJobStatus === 'pending' || activeJobStatus === 'building' || activeJobStatus === 'scanning'}
                      style={{
                        background: 'var(--bg-hover)',
                        border: '1px solid var(--border-subtle)',
                        color: '#fff',
                        borderRadius: 'var(--radius-sm)',
                        padding: '10px',
                        fontWeight: 600,
                        fontSize: '13px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        cursor: 'pointer',
                        transition: 'background 0.12s'
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-hover)'}
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
                    style={{
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)',
                      padding: '20px',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: '16px',
                      transition: 'transform 0.15s, border-color 0.15s',
                      cursor: 'pointer'
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.borderColor = getTechColor(f.id);
                      e.currentTarget.style.transform = 'translateY(-2px)';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.borderColor = 'var(--border-subtle)';
                      e.currentTarget.style.transform = 'none';
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 700, color: '#fff', fontSize: '15px' }}>{f.name}</span>
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
                    </div>

                    <button
                      onClick={() => launchFixture(f.id)}
                      disabled={activeJobStatus === 'pending' || activeJobStatus === 'building' || activeJobStatus === 'scanning'}
                      style={{
                        background: 'var(--bg-hover)',
                        border: '1px solid var(--border-subtle)',
                        color: '#fff',
                        borderRadius: 'var(--radius-sm)',
                        padding: '10px',
                        fontWeight: 600,
                        fontSize: '13px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        cursor: 'pointer',
                        transition: 'background 0.12s'
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-hover)'}
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
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          <div style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: '24px',
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: '20px'
          }}>
            
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
                    <span style={{ fontSize: '18px', fontWeight: 'bold', color: activeJobVulns > 0 ? 'var(--sev-critical)' : '#fff' }}>{activeJobVulns}</span>
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
                flex: 1,
                background: 'rgba(0,0,0,0.4)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                padding: '16px',
                fontFamily: 'var(--font-mono)',
                fontSize: '12px',
                lineHeight: '1.6',
                overflowY: 'auto',
                height: '350px',
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

          </div>

        </div>
      </div>
    </div>
  );
}

export default Fixtures;
