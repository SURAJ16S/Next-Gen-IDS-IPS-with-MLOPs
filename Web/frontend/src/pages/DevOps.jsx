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
  Plus, Trash2, ExternalLink, Square, FileText, Globe, Eye, EyeOff
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

// ─── Pipeline stages config & parsing helper ──────────────────────────────────
const PIPELINE_STAGES = [
  { id: 'extract', label: '📦 Extract & Clean' },
  { id: 'techDetect', label: '🔍 Tech Detection' },
  { id: 'install', label: '⚙️ Resolve Deps' },
  { id: 'sast', label: '🛡️ SAST Security' },
  { id: 'osv', label: '🔬 Supply Chain Scan' },
  { id: 'trivy', label: '🐳 Container Sec' },
  { id: 'package', label: '📦 Package Build' },
  { id: 'preview', label: '🚀 Deploy Sandbox' },
];

const computeStagesFromLogs = (logs, currentStatus) => {
  const statuses = {
    extract: 'pending',
    techDetect: 'pending',
    install: 'pending',
    sast: 'pending',
    osv: 'pending',
    trivy: 'pending',
    package: 'pending',
    preview: 'pending',
  };

  if (!currentStatus) return statuses;

  if (!logs || logs.length === 0) {
    if (['building', 'pending', 'scanning'].includes(currentStatus)) {
      statuses.extract = 'running';
    }
    return statuses;
  }

  let hasSetupStarted = false;
  let hasExtractDone = false;
  let hasTechDone = false;
  let hasAuditDone = false;
  let hasSastStarted = false;
  let hasSastDone = false;
  let hasOsvStarted = false;
  let hasOsvDone = false;
  let hasTrivyStarted = false;
  let hasTrivyDone = false;
  let hasPackStarted = false;
  let hasPackDone = false;
  let hasPreviewStarted = false;
  let hasPreviewDone = false;

  for (const log of logs) {
    const uppercaseLog = log.toUpperCase();
    
    if (uppercaseLog.includes('INITIALIZING DEVOPS PIPELINE') || uppercaseLog.includes('EXTRACTING SOURCE')) {
      hasSetupStarted = true;
    }
    if (uppercaseLog.includes('ZIP EXTRACTION COMPLETED') || uppercaseLog.includes('EXTRACTION COMPLETED')) {
      hasExtractDone = true;
    }
    if (uppercaseLog.includes('DETECTED TECH STACK') || uppercaseLog.includes('DETECTED ARCHITECTURE')) {
      hasTechDone = true;
    }
    if (uppercaseLog.includes('AUDITING PACKAGE DEPENDENCIES') || uppercaseLog.includes('DEPENDENCY-AUDIT') || uppercaseLog.includes('RESOLVING DEPENDENCIES')) {
      hasAuditDone = true;
    }
    if (uppercaseLog.includes('STARTING STEP: SEMGREP') || uppercaseLog.includes('RUNNING SEMGREP') || uppercaseLog.includes('SEMGREP-SAST')) {
      hasSastStarted = true;
      hasAuditDone = true;
    }
    if (uppercaseLog.includes('STEP COMPLETED: SEMGREP') || uppercaseLog.includes('SEMGREP SAST: PASSED') || uppercaseLog.includes('ALERT(S) FOUND')) {
      hasSastDone = true;
    }
    if (uppercaseLog.includes('STARTING STEP: OSV') || uppercaseLog.includes('RUNNING OSV') || uppercaseLog.includes('OSV-SCAN')) {
      hasOsvStarted = true;
      hasSastDone = true;
    }
    if (uppercaseLog.includes('STEP COMPLETED: OSV') || uppercaseLog.includes('OSV COMPLETED') || uppercaseLog.includes('OSV-SCANNER: PASSED') || uppercaseLog.includes('DEPENDENCY SCAN:')) {
      hasOsvDone = true;
    }
    if (uppercaseLog.includes('STARTING STEP: TRIVY') || uppercaseLog.includes('RUNNING TRIVY') || uppercaseLog.includes('TRIVY-SEC-SCAN')) {
      hasTrivyStarted = true;
      hasOsvDone = true;
    }
    if (uppercaseLog.includes('STEP COMPLETED: TRIVY') || uppercaseLog.includes('TRIVY COMPLETED') || uppercaseLog.includes('TRIVY SCAN: PASSED') || uppercaseLog.includes('TRIVY:')) {
      hasTrivyDone = true;
    }
    if (uppercaseLog.includes('PACKAGING BUILD ARTIFACT')) {
      hasPackStarted = true;
      hasTrivyDone = true;
    }
    if (uppercaseLog.includes('ARTIFACT READY AT') || uppercaseLog.includes('PIPELINE COMPLETED SUCCESSFULLY') || uppercaseLog.includes('BUILD PIPELINE COMPLETED')) {
      hasPackDone = true;
    }
    if (uppercaseLog.includes('LAUNCHING LIVE PREVIEW') || uppercaseLog.includes('SPAWNING LIVE PREVIEW') || uppercaseLog.includes('[PREVIEW]')) {
      hasPreviewStarted = true;
      hasPackDone = true;
    }
    if (uppercaseLog.includes('LIVE APP READY') || uppercaseLog.includes('SERVER RUNNING ON PORT') || uppercaseLog.includes('LIVE PREVIEW PROCESS READY') || uppercaseLog.includes('SERVER RUNNING')) {
      hasPreviewDone = true;
    }
  }

  // Derive statuses
  if (hasExtractDone) statuses.extract = 'done';
  else if (hasSetupStarted || ['building', 'scanning'].includes(currentStatus)) statuses.extract = 'running';

  if (hasTechDone) statuses.techDetect = 'done';
  else if (statuses.extract === 'done') statuses.techDetect = 'running';

  if (hasSastStarted || hasOsvStarted || hasTrivyStarted || hasPackStarted) statuses.install = 'done';
  else if (hasTechDone || hasAuditDone) statuses.install = 'running';

  if (hasSastDone) statuses.sast = 'done';
  else if (hasSastStarted) statuses.sast = 'running';
  else if (statuses.install === 'done') statuses.sast = 'running';

  if (hasOsvDone) statuses.osv = 'done';
  else if (hasOsvStarted) statuses.osv = 'running';
  else if (statuses.sast === 'done') statuses.osv = 'running';

  if (hasTrivyDone) statuses.trivy = 'done';
  else if (hasTrivyStarted) statuses.trivy = 'running';
  else if (statuses.osv === 'done') statuses.trivy = 'running';

  if (hasPackDone) statuses.package = 'done';
  else if (hasPackStarted) statuses.package = 'running';
  else if (statuses.trivy === 'done') statuses.package = 'running';

  if (currentStatus === 'deployed' || hasPreviewDone) statuses.preview = 'done';
  else if (hasPreviewStarted || statuses.package === 'done') statuses.preview = 'running';

  // Override stages on failure
  if (currentStatus === 'failed') {
    const order = ['extract', 'techDetect', 'install', 'sast', 'osv', 'trivy', 'package', 'preview'];
    let foundActive = false;
    for (const key of order) {
      if (statuses[key] === 'running') {
        statuses[key] = 'failed';
        foundActive = true;
        break;
      }
    }
    if (!foundActive) {
      for (const key of order) {
        if (statuses[key] === 'pending') {
          statuses[key] = 'failed';
          break;
        }
      }
    }
  }

  return statuses;
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

  // Drag & drop upload state
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef(null);

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragActive(true);
    } else if (e.type === "dragleave") {
      setIsDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.name.toLowerCase().endsWith('.zip')) {
        setSelectedFile(file);
        if (!projectName) {
          setProjectName(file.name.substring(0, file.name.lastIndexOf('.')) || file.name);
        }
      } else {
        alert('Please drop a valid .zip file.');
      }
    }
  };

  const triggerFileInput = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  // Target subfolder (e.g. backend)
  const [targetSubfolder, setTargetSubfolder] = useState('');

  // Dynamic .env entries: [{ path: string, content: string }]
  const [envFiles, setEnvFiles] = useState([{ path: '', content: '' }]);

  // Active build job
  const [activeJobId, setActiveJobId] = useState(null);
  const [activeDeploymentId, setActiveDeploymentId] = useState(null);
  const [activeJobStatus, setActiveJobStatus] = useState(null);
  const [activeJobTech, setActiveJobTech] = useState('');
  const [activeJobArch, setActiveJobArch] = useState('');
  const [activeJobVulns, setActiveJobVulns] = useState(0);
  const [activeJobLogs, setActiveJobLogs] = useState([]);
  const [activeJobArtifactUrl, setActiveJobArtifactUrl] = useState(null);

  // Live preview state
  const [previewReady, setPreviewReady] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewRunning, setPreviewRunning] = useState(false);
  const [stoppingPreview, setStoppingPreview] = useState(false);

  const logsEndRef = useRef(null);
  const consoleContainerRef = useRef(null);
  const socketRef = useRef(null);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [showEnvContent, setShowEnvContent] = useState({});
  const [activeJobUpgrades, setActiveJobUpgrades] = useState([]);

  // Interactive dependency upgrades states
  const [upgradeMode, setUpgradeMode] = useState('automatic');
  const [showInteractiveModal, setShowInteractiveModal] = useState(false);
  const [interactiveUpgrades, setInteractiveUpgrades] = useState([]);
  const [selectedUpgrades, setSelectedUpgrades] = useState([]);
  const [countdownTime, setCountdownTime] = useState(10);
  const [interactiveJobId, setInteractiveJobId] = useState(null);

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
    const socket = io('http://localhost:5000');
    socketRef.current = socket;

    const init = async () => {
      await fetchSuggestedPort();
      
      // Fetch deployments to check if there is an active running job
      try {
        const res = await getDeployments();
        const list = res.data;
        setDeployments(list);
        
        const active = list.find(d => ['pending', 'building', 'scanning'].includes(d.status));
        if (active) {
          setActiveDeploymentId(active._id);
          setActiveJobId(active.jobId);
          setActiveJobStatus(active.status);
          setActiveJobVulns(active.vulnerabilitiesFound || 0);
          setActiveJobTech(active.techStackDetected || '');
          setActiveJobArch(active.architectureDetected || '');
          setActiveJobLogs(active.buildLogs || []);
          setActiveJobUpgrades(active.recommendedUpgrades || []);
          
          socket.emit('subscribe:pipeline', { jobId: active.jobId });
        }
      } catch (err) {
        setError('Failed to load deployments.');
      } finally {
        setLoading(false);
      }
    };
    init();

    socket.on('pipeline:log', (data) => {
      setActiveJobLogs((prev) => [...prev, data.log]);
      const match = data.log.match(/Detected Tech Stack \/ Framework: (\S+)/i);
      if (match) setActiveJobTech(match[1]);
      const archMatch = data.log.match(/Detected Architecture: (\S+)/i);
      if (archMatch) setActiveJobArch(archMatch[1]);
    });

    socket.on('pipeline:complete', (data) => {
      setActiveJobStatus(data.status);
      setActiveJobVulns(data.vulnerabilitiesFound);
      setActiveJobArtifactUrl(data.artifactUrl);
      setActiveJobUpgrades(data.recommendedUpgrades || []);
      setUploading(false);
      fetchDeployments();
      if (data.status === 'deployed' && data.isGuiApp) {
        alert("🖥️ Desktop GUI App Detected!\n\nThis application does not run on a port and cannot be previewed in the browser. Please use the Download button under Actions to download the zip, extract it, and run the executable locally.");
      }
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

    socket.on('pipeline:interactive-upgrades', (data) => {
      console.log('[Socket] Interactive upgrades required for job:', data.jobId);
      setInteractiveJobId(data.jobId);
      setInteractiveUpgrades(data.upgrades || []);
      setSelectedUpgrades(data.upgrades || []);
      setCountdownTime(10);
      setShowInteractiveModal(true);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  // Countdown timer for interactive dependency upgrade choices
  useEffect(() => {
    if (!showInteractiveModal || countdownTime <= 0) {
      if (showInteractiveModal && countdownTime === 0) {
        handleApplyUpgrades(interactiveUpgrades);
      }
      return;
    }
    const timer = setInterval(() => {
      setCountdownTime(prev => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [showInteractiveModal, countdownTime, interactiveUpgrades]);

  const handleApplyUpgrades = (chosenUpgrades) => {
    if (socketRef.current && interactiveJobId) {
      socketRef.current.emit('pipeline:submit-upgrades', {
        jobId: interactiveJobId,
        selectedUpgrades: chosenUpgrades
      });
    }
    setShowInteractiveModal(false);
    setInteractiveJobId(null);
    setInteractiveUpgrades([]);
  };

  // ── Autoscroll logs container only ──────────────────────────────────────────
  useEffect(() => {
    if (consoleContainerRef.current) {
      const container = consoleContainerRef.current;
      container.scrollTop = container.scrollHeight;
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

  // ── History details selector ──────────────────────────────────────────────
  const handleSelectDeployment = (d) => {
    setActiveDeploymentId(d._id);
    setActiveJobId(d.jobId);
    setActiveJobStatus(d.status);
    setActiveJobVulns(d.vulnerabilitiesFound || 0);
    setActiveJobTech(d.techStackDetected || '');
    setActiveJobArch(d.architectureDetected || '');
    setActiveJobLogs(d.buildLogs || []);
    setActiveJobUpgrades(d.recommendedUpgrades || []);
    setPreviewPort(d.previewPort || '');
    setPreviewUrl(d.previewPort ? `http://localhost:${d.previewPort}` : '');
    setPreviewRunning(d.previewStatus === 'running');
    setPreviewReady(d.previewStatus === 'running');
  };

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
    setActiveJobUpgrades([]);
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
    formData.append('upgradeMode', upgradeMode);

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

  const currentStages = computeStagesFromLogs(activeJobLogs, activeJobStatus);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div>
        <h1 className="page-title">DevOps Sandbox Deployments</h1>
        <p className="page-subtitle">Compile, secure-gate, and run application source containers dynamically — no Docker Desktop required</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', alignItems: 'start' }}>

        {/* ── Upload Card ──────────────────────────────────────────────── */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '18px', height: '620px', overflowY: 'auto', paddingRight: '12px' }}>
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

            {/* ZIP file Drag & Drop Upload Zone */}
            <div style={sectionStyle}>
              <label style={labelStyle}>ZIP Package</label>
              <div 
                className={`upload-zone ${isDragActive ? 'active' : ''}`}
                onDragEnter={handleDrag}
                onDragOver={handleDrag}
                onDragLeave={handleDrag}
                onDrop={handleDrop}
                onClick={triggerFileInput}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip"
                  onChange={handleFileChange}
                  style={{ display: 'none' }}
                  required={!selectedFile}
                />
                <Upload size={28} style={{ color: selectedFile ? 'var(--accent-emerald)' : 'var(--text-muted)', marginBottom: '4px' }} />
                {selectedFile ? (
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>
                      {selectedFile.name}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
                    </div>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>
                      Drag and drop your project ZIP here
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      or click to browse local files (max size 100MB)
                    </div>
                  </div>
                )}
              </div>
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
                    <button
                      type="button"
                      onClick={() => setShowEnvContent(prev => ({ ...prev, [idx]: !prev[idx] }))}
                      title={showEnvContent[idx] ? "Mask secrets" : "Show secrets"}
                      style={{
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-sm)',
                        color: 'var(--text-muted)',
                        padding: '8px',
                        cursor: 'pointer',
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                      }}
                    >
                      {showEnvContent[idx] ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
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
                          padding: '8px',
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
                      WebkitTextSecurity: showEnvContent[idx] ? 'none' : 'disc'
                    }}
                  />
                </div>
              ))}
            </div>

            {/* Dependency Upgrade Mode Toggle */}
            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>Dependency Upgrade Mode</label>
              <div style={{ display: 'flex', gap: '20px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', cursor: 'pointer', color: 'var(--text-primary)' }}>
                  <input 
                    type="radio" 
                    name="upgradeMode" 
                    value="automatic" 
                    checked={upgradeMode === 'automatic'}
                    onChange={() => setUpgradeMode('automatic')}
                    style={{ accentColor: 'var(--accent-cyan)' }}
                  />
                  Automatic
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', cursor: 'pointer', color: 'var(--text-primary)' }}>
                  <input 
                    type="radio" 
                    name="upgradeMode" 
                    value="semi-automatic" 
                    checked={upgradeMode === 'semi-automatic'}
                    onChange={() => setUpgradeMode('semi-automatic')}
                    style={{ accentColor: 'var(--accent-cyan)' }}
                  />
                  Semi-Automatic (Interactive)
                </label>
              </div>
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
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '620px', overflowY: 'auto', paddingRight: '12px', position: 'relative' }}>
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
                {activeJobArch && <div><span style={{ color: 'var(--text-muted)' }}>Architecture:</span> <span style={{ fontWeight: 600, color: 'var(--accent-cyan)' }}>{activeJobArch.toUpperCase()}</span></div>}
                <div><span style={{ color: 'var(--text-muted)' }}>Alerts:</span> <span style={{ fontWeight: 600, color: activeJobVulns > 0 ? 'var(--sev-critical)' : 'var(--sev-low)' }}>{activeJobVulns}</span></div>
                {previewRunning && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Globe size={11} style={{ color: 'var(--sev-low)' }} />
                    <span style={{ color: 'var(--text-muted)' }}>Preview:</span>
                    <span style={{ fontWeight: 600, color: 'var(--sev-low)' }}>:{previewPort}</span>
                  </div>
                )}
              </div>

              {/* Stepper checklist stages */}
              <div className="pipeline-stages-container">
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Pipeline Stages Completion Tracker
                </div>
                <div className="pipeline-stages-grid">
                  {PIPELINE_STAGES.map((stage) => {
                    const status = currentStages[stage.id];
                    let icon = null;
                    let classSuffix = 'pending';
                    
                    if (status === 'running') {
                      icon = <div className="stage-icon-spinner" />;
                      classSuffix = 'running';
                    } else if (status === 'done') {
                      icon = <CheckCircle size={14} style={{ color: 'var(--accent-emerald)' }} />;
                      classSuffix = 'done';
                    } else if (status === 'failed') {
                      icon = <AlertOctagon size={14} style={{ color: 'var(--sev-critical)' }} />;
                      classSuffix = 'failed';
                    } else {
                      icon = <div style={{ width: 14, height: 14, borderRadius: '50%', border: '1px solid var(--text-muted)' }} />;
                      classSuffix = 'pending';
                    }

                    return (
                      <div key={stage.id} className={`pipeline-stage-item ${classSuffix}`}>
                        {icon}
                        <span style={{ fontSize: '11.5px', fontWeight: status === 'running' ? 'bold' : '500', color: status === 'running' ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                          {stage.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Toolbar with Log Title and Expand/Collapse Button */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Build & Scan Log Output</span>
                <button
                  type="button"
                  onClick={() => setLogsExpanded(prev => !prev)}
                  style={{
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-primary)',
                    padding: '4px 10px',
                    fontSize: '11px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                >
                  {logsExpanded ? 'Collapse Console' : 'Expand Console'}
                </button>
              </div>

              {/* Console log window */}
              <div
                ref={consoleContainerRef}
                style={{
                  background: '#020617',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 'var(--radius-md)',
                  padding: '14px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  color: '#34d399',
                  height: logsExpanded ? '380px' : '220px',
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                  boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.8)',
                  transition: 'height 0.2s ease-in-out'
                }}
              >
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
                      display: 'flex', flexDirection: 'column', gap: '10px',
                      background: 'rgba(0, 194, 168, 0.06)', padding: '14px',
                      borderRadius: 'var(--radius-md)', border: '1px solid rgba(0, 194, 168, 0.25)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <Globe size={18} style={{ color: 'var(--accent-teal)', flexShrink: 0 }} />
                        <div style={{ flex: 1, fontSize: '12.5px', color: 'var(--text-primary)' }}>
                          <span style={{ fontWeight: 600 }}>Docker Sandbox Active (Port: {previewPort})</span>
                        </div>
                        <button
                          onClick={handleStopPreview}
                          disabled={stoppingPreview}
                          title="Stop the isolated sandbox"
                          style={{
                            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                            borderRadius: 'var(--radius-sm)', color: 'var(--sev-critical)',
                            padding: '5px 10px', fontSize: '11px', fontWeight: 600,
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                            opacity: stoppingPreview ? 0.6 : 1,
                          }}
                        >
                          <Square size={10} fill="currentColor" /> {stoppingPreview ? 'Stopping…' : 'Stop Sandbox'}
                        </button>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.4', background: 'rgba(0,0,0,0.02)', padding: '10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                        ⚠️ <strong>Network Isolation Note:</strong> The preview runs in an isolated container sandbox on the server. The port <code>{previewPort}</code> is internal to the container host and is not directly exposable to your local browser via localhost. Please use the <strong>Get ZIP</strong> button above to download the compiled build and run it locally.
                      </div>
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

      {/* ── Smart Stable Upgrades Alert Card (Full Width) ── */}
      {activeJobUpgrades && activeJobUpgrades.length > 0 && (
        <div className="card" style={{
          background: 'rgba(0, 194, 168, 0.05)',
          border: '1px solid rgba(0, 194, 168, 0.2)',
          borderRadius: 'var(--radius-md)',
          padding: '16px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          marginTop: '0px',
          marginBottom: '10px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, color: 'var(--accent-teal)', fontSize: '14px' }}>
            <Cpu size={16} /> Smart Stable Dependency Upgrades
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            We detected the following upgradable packages in your project workspace. Audited for deprecations and API compatibility:
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px', marginTop: '4px' }}>
            {activeJobUpgrades.map((upgrade, idx) => (
              <div key={idx} style={{
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px'
              }}>
                <div style={{ fontWeight: 700, fontSize: '12px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={upgrade.package}>
                  {upgrade.package}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                  Manager: <span style={{ textTransform: 'uppercase' }}>{upgrade.manager}</span>
                </div>
                <div style={{ fontSize: '11px', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ color: 'var(--sev-high)', fontWeight: '500' }}>{upgrade.current}</span>
                  <span style={{ color: 'var(--text-muted)' }}>➔</span>
                  <span style={{ color: 'var(--sev-low)', fontWeight: 'bold' }}>{upgrade.latest}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Deployment History Table ────────────────────────────────────────── */}
      <div>
        <h3 className="section-heading" style={{ margin: '12px 0 14px' }}>Deployment History</h3>
        <div className="card" style={{ padding: '0', height: '400px', overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Project Name</th>
                <th>Tech Stack</th>
                <th>Architecture</th>
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
                  <td colSpan={8}>
                    <EmptyState message="No sandbox builds tracked in registry." />
                  </td>
                </tr>
              ) : (
                deployments.map((d) => {
                  const isCurrentActive = d._id === activeDeploymentId;
                  return (
                    <tr 
                      key={d._id}
                      onClick={() => handleSelectDeployment(d)}
                      style={{ 
                        cursor: 'pointer',
                        background: isCurrentActive ? 'rgba(6,182,212,0.04)' : 'transparent',
                        borderLeft: isCurrentActive ? '3px solid var(--accent-cyan)' : 'none',
                        transition: 'background 0.2s'
                      }}
                      onMouseEnter={(e) => { if (!isCurrentActive) e.currentTarget.style.background = 'rgba(255,255,255,0.01)'; }}
                      onMouseLeave={(e) => { if (!isCurrentActive) e.currentTarget.style.background = 'transparent'; }}
                    >
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
                    <td>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '5px',
                        fontSize: '11px', textTransform: 'uppercase', fontWeight: 600,
                        color: d.architectureDetected === 'microservice' ? 'var(--accent-cyan)' : 'var(--text-muted)',
                      }}>
                        {d.architectureDetected || 'monolithic'}
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
                                    <span
                                      style={{
                                        background: 'rgba(0, 194, 168, 0.1)', border: '1px solid rgba(0, 194, 168, 0.3)',
                                        borderRadius: 'var(--radius-sm)', color: 'var(--accent-teal)',
                                        padding: '4px 8px', fontSize: '11px', fontWeight: 600,
                                        display: 'inline-flex', alignItems: 'center', gap: '4px'
                                      }}
                                    >
                                      <Globe size={11} /> Sandbox Active
                                    </span>
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
                                      background: 'rgba(0, 194, 168, 0.1)', border: '1px solid rgba(0, 194, 168, 0.3)',
                                      borderRadius: 'var(--radius-sm)', color: 'var(--accent-teal)',
                                      padding: '4px 8px', fontSize: '11px', fontWeight: 600,
                                      cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px'
                                    }}
                                  >
                                    <Globe size={11} /> Start Sandbox
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
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Interactive Dependency Upgrades Modal Overlay ── */}
      {showInteractiveModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(2, 6, 23, 0.85)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000, padding: '20px'
        }}>
          <div className="card" style={{
            maxWidth: '500px', width: '100%', padding: '24px',
            background: 'var(--bg-secondary)', border: '1px solid rgba(6, 182, 212, 0.3)',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)', borderRadius: 'var(--radius-lg)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <h3 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Cpu size={18} color="var(--accent-cyan)" /> Semi-Automatic Upgrades
              </h3>
              <span style={{
                background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#f87171', fontSize: '12px', fontWeight: 'bold', padding: '2px 8px', borderRadius: '99px'
              }}>
                Resuming in {countdownTime}s
              </span>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: '1.5' }}>
              Select which package versions you want to upgrade in your source files. Leaving versions unchecked keeps the current version.
            </p>
            
            <div style={{ maxHeight: '200px', overflowY: 'auto', marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {interactiveUpgrades.map((upgrade, index) => {
                const isChecked = selectedUpgrades.some(u => u.package === upgrade.package);
                return (
                  <label key={index} style={{
                    display: 'flex', alignItems: 'center', gap: '12px',
                    background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-sm)', padding: '10px 12px', cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}>
                    <input 
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {
                        if (isChecked) {
                          setSelectedUpgrades(prev => prev.filter(u => u.package !== upgrade.package));
                        } else {
                          setSelectedUpgrades(prev => [...prev, upgrade]);
                        }
                      }}
                      style={{ accentColor: 'var(--accent-cyan)' }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '12.5px', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={upgrade.package}>
                        {upgrade.package}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {upgrade.current} ➔ <span style={{ color: 'var(--sev-low)', fontWeight: 'bold' }}>{upgrade.latest}</span>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
            
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => handleApplyUpgrades([])}
                style={{
                  background: 'transparent', border: '1px solid var(--border-active)',
                  color: 'var(--text-muted)', borderRadius: 'var(--radius-sm)',
                  padding: '8px 16px', fontSize: '13px', cursor: 'pointer'
                }}
              >
                Skip Upgrades
              </button>
              <button
                onClick={() => handleApplyUpgrades(selectedUpgrades)}
                style={{
                  background: 'var(--accent-cyan)', border: 'none',
                  color: '#000', fontWeight: 'bold', borderRadius: 'var(--radius-sm)',
                  padding: '8px 16px', fontSize: '13px', cursor: 'pointer'
                }}
              >
                Apply Upgrades
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DevOps;