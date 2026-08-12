import { useEffect, useState, useRef } from 'react';
import StatusBadge from '../components/StatusBadge';
import EmptyState from '../components/EmptyState';
import {
  getDeployments,
  uploadDeploymentZip,
  downloadDeploymentArtifact,
  downloadDeploymentPdfReport,
  suggestDeploymentPort,
  stopDeploymentPreview,
  startDeploymentPreview,
  deleteDeployment,
} from '../services/api';
import { io } from 'socket.io-client';
import {
  Terminal, Upload, Download, CheckCircle, AlertOctagon, Cpu,
  Plus, Trash2, ExternalLink, Square, FileText, Globe,
} from 'lucide-react';

// ─── Small UI helpers ─────────────────────────────────────────────────────────

const inputStyle = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  padding: '10px',
  color: 'var(--text-primary)',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

const labelStyle = {
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

const sectionStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

// ─── Component ────────────────────────────────────────────────────────────────

function DevOps() {
  const [deployments, setDeployments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Upload form state
  const [projectName, setProjectName] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  // Custom port
  const [previewPort, setPreviewPort] = useState('');
  const [portLoading, setPortLoading] = useState(false);

  // Target subfolder (e.g. backend)
  const [targetSubfolder, setTargetSubfolder] = useState('');

  // Dynamic .env entries: [{ path: string, content: string }]
  const [envFiles, setEnvFiles] = useState([{ path: '', content: '' }]);

  // Active build job
  const [activeJobId, setActiveJobId] = useState(null);
  const [activeDeploymentId, setActiveDeploymentId] = useState(null);
  const [activeJobStatus, setActiveJobStatus] = useState(null);
  const [activeJobTech, setActiveJobTech] = useState('');
  const [activeJobVulns, setActiveJobVulns] = useState(0);
  const [activeJobLogs, setActiveJobLogs] = useState([]);
  const [activeJobArtifactUrl, setActiveJobArtifactUrl] = useState(null);

  // Live preview state
  const [previewReady, setPreviewReady] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewRunning, setPreviewRunning] = useState(false);
  const [stoppingPreview, setStoppingPreview] = useState(false);

  const logsEndRef = useRef(null);
  const socketRef = useRef(null);

  // ── Fetch deployments ──────────────────────────────────────────────────────
  const fetchDeployments = async () => {
    try {
      const res = await getDeployments();
      setDeployments(res.data);
    } catch {
      setError('Failed to load deployments.');
    } finally {
      setLoading(false);
    }
  };

  // ── Fetch suggested port on mount ──────────────────────────────────────────
  const fetchSuggestedPort = async () => {
    setPortLoading(true);
    try {
      const res = await suggestDeploymentPort();
      setPreviewPort(String(res.data.port));
    } catch {
      setPreviewPort('3001');
    } finally {
      setPortLoading(false);
    }
  };

  // ── WebSocket setup ────────────────────────────────────────────────────────
  useEffect(() => {
    fetchDeployments();
    fetchSuggestedPort();

    socketRef.current = io('http://localhost:5000');

    socketRef.current.on('pipeline:log', (data) => {
      setActiveJobLogs((prev) => [...prev, data.log]);
      // Detect framework from log line
      const match = data.log.match(/Detected Tech Stack \/ Framework: (\S+)/i);
      if (match) setActiveJobTech(match[1]);
    });

    socketRef.current.on('pipeline:complete', (data) => {
      setActiveJobStatus(data.status);
      setActiveJobVulns(data.vulnerabilitiesFound);
      setActiveJobArtifactUrl(data.artifactUrl);
      setUploading(false);
      fetchDeployments();
      if (data.status === 'deployed' && data.isGuiApp) {
        alert("🖥️ Desktop GUI App Detected!\n\nThis application does not run on a port and cannot be previewed in the browser. Please use the Download button under Actions to download the zip, extract it, and run the executable locally.");
      }
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

  // ── Autoscroll logs ────────────────────────────────────────────────────────
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeJobLogs]);

  // ── File change ────────────────────────────────────────────────────────────
  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setSelectedFile(file);
      if (!projectName) {
        setProjectName(file.name.substring(0, file.name.lastIndexOf('.')) || file.name);
      }
    }
  };

  // ── .env row helpers ───────────────────────────────────────────────────────
  const addEnvRow = () => setEnvFiles((prev) => [...prev, { path: '', content: '' }]);

  const removeEnvRow = (idx) =>
    setEnvFiles((prev) => prev.filter((_, i) => i !== idx));

  const updateEnvRow = (idx, field, value) =>
    setEnvFiles((prev) => prev.map((row, i) => (i === idx ? { ...row, [field]: value } : row)));

  // ── Upload submit ──────────────────────────────────────────────────────────
  const handleUploadSubmit = async (e) => {
    e.preventDefault();
    if (!selectedFile) {
      setUploadError('Please select a ZIP file to upload.');
      return;
    }

    setUploading(true);
    setUploadError('');
    setActiveJobLogs([]);
    setActiveJobArtifactUrl(null);
    setActiveJobStatus('building');
    setActiveJobVulns(0);
    setActiveJobTech('');
    setPreviewReady(false);
    setPreviewRunning(false);
    setPreviewUrl('');

    // Filter out empty env rows
    const filteredEnvFiles = envFiles.filter(
      (row) => row.path.trim() && row.content.trim()
    );

    const formData = new FormData();
    formData.append('zipFile', selectedFile);
    formData.append('projectName', projectName);
    formData.append('sessionId', socketRef.current.id);
    formData.append('previewPort', previewPort || '3001');
    formData.append('envFiles', JSON.stringify(filteredEnvFiles));
    formData.append('targetSubfolder', targetSubfolder);

    try {
      const res = await uploadDeploymentZip(formData);
      const { jobId, deploymentId } = res.data;
      setActiveJobId(jobId);
      setActiveDeploymentId(deploymentId);

      socketRef.current.emit('subscribe:pipeline', { jobId });

      setSelectedFile(null);
      setProjectName('');
      setTargetSubfolder('');
      e.target.reset();
      // Refresh the port suggestion for next time
      fetchSuggestedPort();
    } catch (err) {
      const errMsg = err.response?.data?.message || 'Failed to upload deployment zip.';
      setUploadError(errMsg);
      setActiveJobStatus('failed');
      setUploading(false);
    }
  };

  // ── Stop live preview ──────────────────────────────────────────────────────
  const handleStopPreview = async () => {
    if (!activeDeploymentId) return;
    setStoppingPreview(true);
    try {
      await stopDeploymentPreview(activeDeploymentId);
      setPreviewRunning(false);
      setPreviewReady(false);
    } catch {
      alert('Could not stop preview. It may have already exited.');
    } finally {
      setStoppingPreview(false);
    }
  };

  // ── History Start Preview ──────────────────────────────────────────────────
  const handleHistoryStart = async (deploymentId, jobId, port) => {
    try {
      setActiveJobId(jobId);
      setActiveDeploymentId(deploymentId);
      setActiveJobLogs([]);
      setActiveJobStatus('deployed');
      setActiveJobTech('');
      socketRef.current.emit('subscribe:pipeline', { jobId });

      await startDeploymentPreview(deploymentId);
      setPreviewReady(true);
      setPreviewRunning(true);
      setPreviewUrl(`http://localhost:${port}`);
      fetchDeployments();
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to start preview.');
    }
  };

  // ── History Stop Preview ───────────────────────────────────────────────────
  const handleHistoryStop = async (deploymentId) => {
    try {
      await stopDeploymentPreview(deploymentId);
      setPreviewRunning(false);
      setPreviewReady(false);
      fetchDeployments();
    } catch {
      alert('Could not stop preview.');
    }
  };

  // ── Delete Deployment ──────────────────────────────────────────────────────
  const handleDeleteDeployment = async (deploymentId, projectName) => {
    if (!window.confirm(`Are you sure you want to delete "${projectName}" and clean up all files on disk?`)) {
      return;
    }
    try {
      await deleteDeployment(deploymentId);
      fetchDeployments();
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to delete deployment.');
    }
  };

  // ── Download artifact ──────────────────────────────────────────────────────
  const handleDownload = async (deploymentId, projName) => {
    try {
      const res = await downloadDeploymentArtifact(deploymentId);
      const blob = new Blob([res.data], { type: 'application/zip' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${projName}-build.zip`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      alert('Error downloading artifact.');
    }
  };

  const handleDownloadPdfReport = async (deploymentId, projName) => {
    try {
      const res = await downloadDeploymentPdfReport(deploymentId);
      const blob = new Blob([res.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${projName.replace(/\s+/g, '_')}-security-report.pdf`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      alert('Error downloading PDF report.');
    }
  };

  if (loading) return <p style={{ color: 'var(--text-secondary)' }}>Loading deployments...</p>;
  if (error) return <p style={{ color: 'var(--sev-critical)' }}>{error}</p>;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div>
        <h1 className="page-title">DevOps Sandbox Deployments</h1>
        <p className="page-subtitle">Compile, secure-gate, and run application source containers dynamically — no Docker Desktop required</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', alignItems: 'start' }}>

        {/* ── Upload Card ──────────────────────────────────────────────── */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Upload size={20} style={{ color: 'var(--accent-blue)' }} />
            <h2 style={{ fontSize: '15px' }}>Upload & Configure Project</h2>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
            Upload a <code>.zip</code> file. Specify a custom preview port and any <code>.env</code> files
            to inject before the build runs. Folders like <code>node_modules</code>, <code>target</code>, <code>.git</code> are stripped automatically.
          </p>

          <form onSubmit={handleUploadSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

            {/* Project name + port side-by-side */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px' }}>
              <div style={sectionStyle}>
                <label style={labelStyle}>Project Name</label>
                <input
                  type="text"
                  placeholder="e.g. my-mern-app"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div style={sectionStyle}>
                <label style={labelStyle}>Preview Port</label>
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  placeholder={portLoading ? '...' : '3001'}
                  value={previewPort}
                  onChange={(e) => setPreviewPort(e.target.value)}
                  id="preview-port-input"
                  style={{ ...inputStyle, width: '90px', textAlign: 'center' }}
                />
              </div>
            </div>

            {/* ZIP file */}
            <div style={sectionStyle}>
              <label style={labelStyle}>ZIP Package</label>
              <input
                type="file"
                accept=".zip"
                onChange={handleFileChange}
                required
                style={{ ...inputStyle, cursor: 'pointer' }}
              />
            </div>

            {/* Build subdirectory path (Vercel/Railway logic) */}
            <div style={sectionStyle}>
              <label style={labelStyle}>Build Subdirectory (Optional)</label>
              <input
                type="text"
                placeholder="e.g. backend or server (leave empty to auto-detect)"
                value={targetSubfolder}
                onChange={(e) => setTargetSubfolder(e.target.value)}
                style={inputStyle}
              />
            </div>

            {/* .env files section */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <FileText size={13} style={{ color: 'var(--accent-cyan)' }} />
                  <label style={labelStyle}>Environment Files (.env)</label>
                </div>
                <button
                  type="button"
                  onClick={addEnvRow}
                  style={{
                    background: 'rgba(34,211,238,0.1)',
                    border: '1px solid rgba(34,211,238,0.3)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--accent-cyan)',
                    padding: '3px 8px',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  <Plus size={11} /> Add .env
                </button>
              </div>

              <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
                Specify paths relative to your ZIP root, e.g. <code>backend/.env</code> or <code>.env</code>. Leave empty to skip.
              </p>

              {envFiles.map((row, idx) => (
                <div key={idx} style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="text"
                      placeholder="Path inside ZIP (e.g. backend/.env)"
                      value={row.path}
                      onChange={(e) => updateEnvRow(idx, 'path', e.target.value)}
                      style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: '12px' }}
                    />
                    {envFiles.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeEnvRow(idx)}
                        title="Remove this .env entry"
                        style={{
                          background: 'rgba(239,68,68,0.1)',
                          border: '1px solid rgba(239,68,68,0.3)',
                          borderRadius: 'var(--radius-sm)',
                          color: 'var(--sev-critical)',
                          padding: '6px',
                          cursor: 'pointer',
                          flexShrink: 0,
                          display: 'flex',
                          alignItems: 'center',
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                  <textarea
                    rows={3}
                    placeholder={'PORT=3001\nMONGO_URI=mongodb://localhost:27017/mydb\nJWT_SECRET=my_secret'}
                    value={row.content}
                    onChange={(e) => updateEnvRow(idx, 'content', e.target.value)}
                    style={{
                      ...inputStyle,
                      fontFamily: 'var(--font-mono)',
                      fontSize: '11px',
                      resize: 'vertical',
                      minHeight: '64px',
                    }}
                  />
                </div>
              ))}
            </div>

            {uploadError && <p style={{ color: 'var(--sev-critical)', fontSize: '12px', margin: 0 }}>{uploadError}</p>}

            <button
              type="submit"
              disabled={uploading && activeJobStatus === 'building'}
              style={{
                background: 'var(--grad-brand)',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                color: '#fff',
                padding: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                opacity: (uploading && activeJobStatus === 'building') ? 0.6 : 1,
                transition: 'opacity 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
            >
              {uploading && activeJobStatus === 'building'
                ? 'Compiling & Scanning...'
                : 'Start Pipeline Execution'}
            </button>
          </form>
        </div>

        {/* ── Live Pipeline Console ──────────────────────────────────────── */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '16px', minHeight: '420px', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Terminal size={20} style={{ color: 'var(--accent-cyan)' }} />
              <h2 style={{ fontSize: '15px' }}>Pipeline Log Stream</h2>
            </div>
            {activeJobStatus && <StatusBadge status={activeJobStatus} />}
          </div>

          {!activeJobStatus ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              No active pipeline running. Upload a project to view console.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>

              {/* Build metadata row */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', background: 'rgba(255,255,255,0.02)', padding: '10px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', fontSize: '12px' }}>
                <div><span style={{ color: 'var(--text-muted)' }}>Status:</span> <span style={{ fontWeight: 600 }}>{activeJobStatus.toUpperCase()}</span></div>
                {activeJobTech && <div><span style={{ color: 'var(--text-muted)' }}>Stack:</span> <span style={{ fontWeight: 600, color: 'var(--accent-purple)' }}>{activeJobTech.toUpperCase()}</span></div>}
                <div><span style={{ color: 'var(--text-muted)' }}>Alerts:</span> <span style={{ fontWeight: 600, color: activeJobVulns > 0 ? 'var(--sev-critical)' : 'var(--sev-low)' }}>{activeJobVulns}</span></div>
                {previewRunning && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Globe size={11} style={{ color: 'var(--sev-low)' }} />
                    <span style={{ color: 'var(--text-muted)' }}>Preview:</span>
                    <span style={{ fontWeight: 600, color: 'var(--sev-low)' }}>:{previewPort}</span>
                  </div>
                )}
              </div>

              {/* Console log window */}
              <div style={{
                background: '#020617',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 'var(--radius-md)',
                padding: '14px',
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                color: '#34d399',
                height: '220px',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.8)',
              }}>
                {activeJobLogs.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)' }}>Awaiting log outputs...</p>
                ) : (
                  activeJobLogs.map((log, index) => {
                    const isError = log.includes('ERROR') || log.includes('FAILED') || log.includes('[-]');
                    const isWarn  = log.includes('[!]') || log.includes('WARN');
                    const isEnv   = log.includes('[ENV]');
                    const isPreview = log.includes('[PREVIEW]') || log.includes('[APP]');
                    let color = '#34d399';
                    if (isError) color = '#f87171';
                    else if (isWarn) color = '#fbbf24';
                    else if (isEnv) color = '#22d3ee';
                    else if (isPreview) color = '#a78bfa';
                    return (
                      <div key={index} style={{ marginBottom: '3px', lineBreak: 'anywhere', color }}>{log}</div>
                    );
                  })
                )}
                <div ref={logsEndRef} />
              </div>

              {/* ── Success + Live Preview panel ── */}
              {activeJobStatus === 'deployed' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {/* Success bar */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(34,197,94,0.08)', padding: '10px', borderRadius: 'var(--radius-md)', border: '1px solid rgba(34,197,94,0.2)' }}>
                    <CheckCircle size={18} style={{ color: 'var(--sev-low)', flexShrink: 0 }} />
                    <div style={{ flex: 1, fontSize: '12px' }}>
                      <span style={{ fontWeight: 600 }}>Build successful!</span> Artifact packaged and live preview launched.
                    </div>
                    {activeJobArtifactUrl && (
                      <>
                        <button
                          onClick={() => handleDownload(activeDeploymentId, projectName || 'build')}
                          style={{
                            background: 'var(--sev-low)', border: 'none', borderRadius: 'var(--radius-sm)',
                            color: '#fff', padding: '6px 12px', fontSize: '11px', fontWeight: 600,
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                          }}
                        >
                          <Download size={12} /> Get ZIP
                        </button>
                        
                        <button
                          onClick={() => handleDownloadPdfReport(activeDeploymentId, projectName || 'build')}
                          style={{
                            background: 'rgba(239,68,68,0.2)', border: '1px solid rgba(239,68,68,0.4)',
                            borderRadius: 'var(--radius-sm)', color: '#f87171',
                            padding: '6px 12px', fontSize: '11px', fontWeight: 600,
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                          }}
                        >
                          <FileText size={12} /> Get PDF Report
                        </button>
                      </>
                    )}
                  </div>

                  {/* Live preview panel */}
                  {previewReady && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '10px',
                      background: 'rgba(167,139,250,0.08)', padding: '10px',
                      borderRadius: 'var(--radius-md)', border: '1px solid rgba(167,139,250,0.25)',
                    }}>
                      <Globe size={18} style={{ color: '#a78bfa', flexShrink: 0 }} />
                      <div style={{ flex: 1, fontSize: '12px' }}>
                        <span style={{ fontWeight: 600 }}>Live Preview: </span>
                        <a
                          href={previewUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#a78bfa', textDecoration: 'underline' }}
                        >
                          {previewUrl}
                        </a>
                      </div>
                      <button
                        onClick={() => window.open(previewUrl, '_blank')}
                        style={{
                          background: 'rgba(167,139,250,0.2)', border: '1px solid rgba(167,139,250,0.4)',
                          borderRadius: 'var(--radius-sm)', color: '#a78bfa',
                          padding: '5px 10px', fontSize: '11px', fontWeight: 600,
                          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                        }}
                      >
                        <ExternalLink size={11} /> Open
                      </button>
                      <button
                        onClick={handleStopPreview}
                        disabled={stoppingPreview}
                        title="Stop the live preview process"
                        style={{
                          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                          borderRadius: 'var(--radius-sm)', color: 'var(--sev-critical)',
                          padding: '5px 10px', fontSize: '11px', fontWeight: 600,
                          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                          opacity: stoppingPreview ? 0.6 : 1,
                        }}
                      >
                        <Square size={10} fill="currentColor" /> {stoppingPreview ? 'Stopping…' : 'Stop'}
                      </button>
                    </div>
                  )}

                  {/* Preview stopped notice */}
                  {activeJobStatus === 'deployed' && !previewRunning && previewUrl && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '6px 10px' }}>
                      Preview process was stopped. Port {previewPort} is now free.
                    </div>
                  )}
                </div>
              )}

              {/* ── Failed panel ── */}
              {activeJobStatus === 'failed' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(239,68,68,0.08)', padding: '10px', borderRadius: 'var(--radius-md)', border: '1px solid rgba(239,68,68,0.2)' }}>
                  <AlertOctagon size={18} style={{ color: 'var(--sev-critical)', flexShrink: 0 }} />
                  <div style={{ fontSize: '12px' }}>
                    <span style={{ fontWeight: 600 }}>Pipeline Failed.</span> Check the logs above for compiler or scanner errors.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Deployment History Table ────────────────────────────────────────── */}
      <div>
        <h3 className="section-heading" style={{ margin: '12px 0 14px' }}>Deployment History</h3>
        <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
          <table>
            <thead>
              <tr>
                <th>Project Name</th>
                <th>Tech Stack</th>
                <th>Status</th>
                <th>Vulnerabilities</th>
                <th>Preview Port</th>
                <th>Date</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {deployments.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <EmptyState message="No sandbox builds tracked in registry." />
                  </td>
                </tr>
              ) : (
                deployments.map((d) => (
                  <tr key={d._id}>
                    <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{d.projectName}</td>
                    <td>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px',
                        fontSize: '11px', textTransform: 'uppercase', fontWeight: 600,
                        color: d.techStackDetected ? 'var(--accent-purple)' : 'var(--text-muted)',
                      }}>
                        {d.techStackDetected && <Cpu size={12} />}
                        {d.techStackDetected || 'unknown'}
                      </span>
                    </td>
                    <td><StatusBadge status={d.status} /></td>
                    <td style={{ fontWeight: 600, color: d.vulnerabilitiesFound > 0 ? 'var(--sev-critical)' : 'var(--sev-low)' }}>
                      {d.vulnerabilitiesFound} findings
                    </td>
                    <td style={{ fontSize: '12px', color: d.previewPort ? 'var(--accent-cyan)' : 'var(--text-muted)' }}>
                      {d.previewPort ? (
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>:{d.previewPort}</span>
                      ) : '—'}
                    </td>
                    <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      {new Date(d.createdAt).toLocaleString()}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '8px', justifyContent: 'flex-end', width: '100%' }}>
                        {d.status === 'deployed' && (
                          <>
                            {d.isGuiApp ? (
                              <span style={{ padding: '4px 8px', fontSize: '11px', color: 'var(--text-muted)', border: '1px dashed var(--border-active)', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.02)', fontWeight: 500, display: 'inline-flex', alignItems: 'center' }}>
                                🖥️ Desktop GUI (No Preview)
                              </span>
                            ) : (
                              <>
                                {d.previewStatus === 'running' ? (
                                  <>
                                    <a
                                      href={`http://localhost:${d.previewPort}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{
                                        background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)',
                                        borderRadius: 'var(--radius-sm)', color: '#a78bfa',
                                        padding: '4px 8px', fontSize: '11px', fontWeight: 600,
                                        textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px'
                                      }}
                                    >
                                      <ExternalLink size={11} /> Open
                                    </a>
                                    <button
                                      onClick={() => handleHistoryStop(d._id)}
                                      style={{
                                        background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                                        borderRadius: 'var(--radius-sm)', color: 'var(--sev-critical)',
                                        padding: '4px 8px', fontSize: '11px', fontWeight: 600,
                                        cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px'
                                      }}
                                    >
                                      <Square size={10} fill="currentColor" /> Stop
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    onClick={() => handleHistoryStart(d._id, d.jobId, d.previewPort || 3001)}
                                    style={{
                                      background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)',
                                      borderRadius: 'var(--radius-sm)', color: 'var(--sev-low)',
                                      padding: '4px 8px', fontSize: '11px', fontWeight: 600,
                                      cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px'
                                    }}
                                  >
                                    <Globe size={11} /> Start Preview
                                  </button>
                                )}
                              </>
                            )}
                            
                            {d.artifactPath && (
                              <button
                                onClick={() => handleDownload(d._id, d.projectName)}
                                style={{
                                  background: 'transparent', border: '1px solid var(--border-active)',
                                  borderRadius: 'var(--radius-sm)', color: 'var(--accent-blue)',
                                  padding: '4px 8px', fontSize: '11px', fontWeight: 600,
                                  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px'
                                }}
                              >
                                <Download size={11} /> Download
                              </button>
                            )}
                            
                            <button
                              onClick={() => handleDownloadPdfReport(d._id, d.projectName)}
                              style={{
                                background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                                borderRadius: 'var(--radius-sm)', color: '#f43f5e',
                                padding: '4px 8px', fontSize: '11px', fontWeight: 600,
                                cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px'
                              }}
                            >
                              <FileText size={11} /> PDF Report
                            </button>
                          </>
                        )}
                        
                        <button
                          onClick={() => handleDeleteDeployment(d._id, d.projectName)}
                          title="Delete deployment record and clean up files"
                          style={{
                            background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)',
                            borderRadius: 'var(--radius-sm)', color: 'var(--sev-critical)',
                            padding: '4px 8px', fontSize: '11px', fontWeight: 600,
                            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px'
                          }}
                        >
                          <Trash2 size={11} /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default DevOps;