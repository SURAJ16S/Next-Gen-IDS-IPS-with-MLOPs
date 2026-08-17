import { useEffect, useState, useRef, useCallback } from 'react';
import StatusBadge from '../components/StatusBadge';
import EmptyState from '../components/EmptyState';
import {
  getDeployments,
  uploadDeploymentZip,
  downloadDeploymentArtifact,
  downloadDeploymentPdfReport,
  suggestDeploymentPort,
  changeDeploymentPort,
  stopDeploymentPreview,
  startDeploymentPreview,
  deleteDeployment,
  getGithubAuthUrl,
  getGithubStatus,
  getGithubRepos,
  importGithubRepo,
  unlinkGithub,
  getGithubBranches,
  executeDeploymentDbQuery,
  getDeploymentStatus
} from '../services/api';
import { io } from 'socket.io-client';
import {
  Terminal, Upload, Download, CheckCircle, AlertOctagon, Cpu, Check, Database,
  Plus, Trash2, ExternalLink, Square, FileText, Globe, Eye, EyeOff,
  RefreshCw, Search, Lock, Unlock, GitBranch, Star, Settings,
  Bird, Maximize2, Minimize2, Bot, Send, AlertCircle
} from 'lucide-react';
import api from '../services/api';

const Github = (props) => (
  <img
    src="https://cdn-icons-png.flaticon.com/512/25/25231.png"
    alt="GitHub Logo"
    style={{
      width: props.size || 20,
      height: props.size || 20,
      filter: 'invert(1)', // Invert black mark to white for dark theme
      display: 'inline-block',
      verticalAlign: 'middle',
      ...props.style
    }}
  />
);

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
  let hasPreviewFailed = false;

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
    if (uppercaseLog.includes('LIVE APP READY') || uppercaseLog.includes('SERVER RUNNING ON PORT') || uppercaseLog.includes('LIVE PREVIEW PROCESS READY') || uppercaseLog.includes('SERVER RUNNING') || uppercaseLog.includes('[HEALTH] ✅') || uppercaseLog.includes('[HEALTH] APP RESPONDED')) {
      hasPreviewDone = true;
    }
    if (uppercaseLog.includes('[HEALTH] ❌') || uppercaseLog.includes('APP FAILED HEALTH CHECK') || uppercaseLog.includes('FAILED HEALTH CHECK')) {
      hasPreviewFailed = true;
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

  if (hasPreviewFailed) statuses.preview = 'failed';
  else if (currentStatus === 'deployed' || hasPreviewDone) statuses.preview = 'done';
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

const MAX_FILE_SIZE = 300 * 1024 * 1024; // 300 MB

const highlightCode = (code, type) => {
  if (!code) return '';
  
  // Tokenize using regex to extract strings, comments, words, numbers, and whitespaces
  const tokenRegex = /(\/\*[\s\S]*?\*\/|\/\/.*|--.*|"[^"]*"|'[^']*'|[a-zA-Z_]+|[0-9]+|[\s]+|[^\s\w])/g;
  const tokens = code.match(tokenRegex) || [code];

  const sqlKeywords = new Set([
    'CREATE', 'TABLE', 'IF', 'NOT', 'EXISTS', 'PRIMARY', 'KEY', 'AUTO_INCREMENT',
    'INSERT', 'INTO', 'VALUES', 'SELECT', 'UPDATE', 'DELETE', 'VARCHAR', 'INT',
    'NULL', 'DEFAULT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'ON', 'AS', 'DATABASE',
    'USE', 'SHOW', 'TABLES', 'DATABASES'
  ]);

  const mongoKeywords = new Set([
    'db', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne',
    'deleteMany', 'find', 'aggregate', 'users', 'threats'
  ]);

  return tokens.map(token => {
    // Escape HTML
    let escaped = token
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    if (type === 'mongodb') {
      if (mongoKeywords.has(token)) {
        if (token === 'db') {
          return `<span style="color: #60a5fa; font-weight: bold;">${escaped}</span>`;
        }
        return `<span style="color: #f43f5e; font-weight: 600;">${escaped}</span>`;
      }
      if (token.startsWith('//')) {
        return `<span style="color: #64748b; font-style: italic;">${escaped}</span>`;
      }
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        return `<span style="color: #34d399;">${escaped}</span>`;
      }
      if (/^\d+$/.test(token)) {
        return `<span style="color: #fbbf24;">${escaped}</span>`;
      }
    } else {
      // SQL Mode
      if (sqlKeywords.has(token.toUpperCase())) {
        return `<span style="color: #60a5fa; font-weight: bold;">${escaped}</span>`;
      }
      if (token.startsWith('/*') && token.endsWith('*/')) {
        return `<span style="color: #64748b; font-style: italic;">${escaped}</span>`;
      }
      if (token.startsWith('--')) {
        return `<span style="color: #64748b; font-style: italic;">${escaped}</span>`;
      }
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        return `<span style="color: #34d399;">${escaped}</span>`;
      }
    }
    return escaped;
  }).join('');
};

const handleTextareaScroll = (e) => {
  const preElement = e.target.nextSibling;
  if (preElement) {
    preElement.scrollTop = e.target.scrollTop;
    preElement.scrollLeft = e.target.scrollLeft;
  }
};

// ─── Component ────────────────────────────────────────────────────────────────

function DevOps() {
  const [deployments, setDeployments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [currentUser, setCurrentUser] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);

  // ── Tab state: 'zip' | 'github' ──────────────────────────────────────────
  const [uploadTab, setUploadTab] = useState('zip');

  // ── GitHub OAuth state ───────────────────────────────────────────────────
  const [githubLinked, setGithubLinked] = useState(false);
  const [githubUsername, setGithubUsername] = useState(null);
  const [githubRepos, setGithubRepos] = useState([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [repoSearch, setRepoSearch] = useState('');
  const [selectedRepo, setSelectedRepo] = useState(null);
  const [repoBranch, setRepoBranch] = useState('main');
  const [repoBranches, setRepoBranches] = useState([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [githubImporting, setGithubImporting] = useState(false);
  const [githubError, setGithubError] = useState('');

  // Upload form state
  const [projectName, setProjectName] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  // Custom port
  const [previewPort, setPreviewPort] = useState('');
  const [portLoading, setPortLoading] = useState(false);
  const [useTempDb, setUseTempDb] = useState(true);
  const [enableSmartSeeding, setEnableSmartSeeding] = useState(false);
  const [enableDbInit, setEnableDbInit] = useState(false);
  const [dbInitType, setDbInitType] = useState('mysql');
  const [dbInitScript, setDbInitScript] = useState('');
  const [isPipelineLogCollapsed, setIsPipelineLogCollapsed] = useState(false);
  const [isLogExpanded, setIsLogExpanded] = useState(false);
  const [showBirdAgent, setShowBirdAgent] = useState(false);
  const [birdMessage, setBirdMessage] = useState('');
  const [isAgentOpen, setIsAgentOpen] = useState(false);
  const [terminalQuery, setTerminalQuery] = useState('');
  const [terminalOutput, setTerminalOutput] = useState('');
  const [runningQuery, setRunningQuery] = useState(false);

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
      const isZip = file.name.toLowerCase().endsWith('.zip') || 
                    file.type === 'application/zip' || 
                    file.type === 'application/x-zip-compressed';
      if (!isZip) {
        alert('Only ZIP files are allowed!');
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        alert(`File is too large! Maximum allowed size is 300MB. Your file is ${(file.size / (1024 * 1024)).toFixed(2)}MB.`);
        return;
      }
      setSelectedFile(file);
      if (!projectName) {
        setProjectName(file.name.substring(0, file.name.lastIndexOf('.')) || file.name);
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

  // Edit port states
  const [isEditingPort, setIsEditingPort] = useState(false);
  const [editPortValue, setEditPortValue] = useState('');
  const [isRebuildingPort, setIsRebuildingPort] = useState(false);

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

  // Real-time environmental validation to detect preview port mismatches
  const getEnvWarnings = () => {
    const warnings = [];
    const port = previewPort || '3001';

    envFiles.forEach((file, fileIdx) => {
      if (!file.content) return;
      const lines = file.content.split('\n');
      lines.forEach((line) => {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('#') || !trimmedLine) return;
        
        const parts = trimmedLine.split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join('=').trim();

          if (val.includes('localhost:') || val.includes('127.0.0.1:')) {
            const match = val.match(/(?:localhost|127\.0\.0\.1):(\d+)/);
            if (match && String(match[1]) !== String(port)) {
              warnings.push(
                `"${key}" in "${file.path || `File #${fileIdx + 1}`}" points to port ${match[1]}, which does not match your preview port (${port}).`
              );
            }
          }
        }
      });
    });
    return warnings;
  };

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
      // Get current user from localStorage
      const userStr = localStorage.getItem('user');
      if (userStr) {
        try {
          setCurrentUser(JSON.parse(userStr));
        } catch (e) {
          console.error("Failed to parse user from local storage", e);
        }
      }

      // Check if GitHub is already linked
      try {
        const ghRes = await getGithubStatus();
        setGithubLinked(ghRes.data.linked);
        setGithubUsername(ghRes.data.githubUsername);
      } catch (_) {}

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
      if (data.log.includes('[SELF-HEALING]')) {
        setShowBirdAgent(true);
        if (data.log.includes('Querying LLM')) setBirdMessage('Analyzing compilation errors and querying the self-healing LLM...');
        else if (data.log.includes('Applying patches')) setBirdMessage('Applying the proposed source code patches dynamically...');
        else if (data.log.includes('Successfully patched')) setBirdMessage('Successfully patched the files! Re-running the compilation...');
        else setBirdMessage('Guess I have to continue from here... Safely scanning your code to fix the build issues!');
      }
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
      setUploadProgress(0);
      
      if (data.status === 'failed') {
        setShowBirdAgent(true);
        setBirdMessage("I did my best to dynamically patch your code, but the compiler errors require manual intervention! Please review my diagnostic hints above and update your files.");
      } else {
        setShowBirdAgent(false);
      }

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

  // ── Detect ?github=linked after OAuth popup redirect ─────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gh = params.get('github');
    if (gh === 'linked') {
      // Clean URL
      window.history.replaceState({}, '', '/devops');
      // Re-check status and load repos
      getGithubStatus().then(r => {
        setGithubLinked(r.data.linked);
        setGithubUsername(r.data.githubUsername);
        if (r.data.linked) loadGithubRepos();
      }).catch(() => {});
      setUploadTab('github');
    } else if (gh === 'denied' || gh === 'error') {
      window.history.replaceState({}, '', '/devops');
      setGithubError('GitHub authorization failed or was denied. Please try again.');
    }
  }, []); // eslint-disable-line

  const loadGithubRepos = useCallback(async () => {
    setReposLoading(true);
    setGithubError('');
    try {
      const res = await getGithubRepos();
      setGithubRepos(res.data);
    } catch (err) {
      setGithubError(err.response?.data?.message || 'Failed to load repositories.');
      if (err.response?.status === 401) { setGithubLinked(false); setGithubUsername(null); }
    } finally {
      setReposLoading(false);
    }
  }, []);

  const loadGithubBranches = useCallback(async (repo) => {
    if (!repo) return;
    setBranchesLoading(true);
    setGithubError('');
    try {
      const [owner, repoName] = repo.fullName.split('/');
      const res = await getGithubBranches(owner, repoName);
      setRepoBranches(res.data);
      setRepoBranch(repo.defaultBranch || 'main');
    } catch (err) {
      setGithubError(err.response?.data?.message || 'Failed to fetch repository branches.');
    } finally {
      setBranchesLoading(false);
    }
  }, []);

  // Fetch branches when selected repo changes
  useEffect(() => {
    if (selectedRepo) {
      loadGithubBranches(selectedRepo);
    } else {
      setRepoBranches([]);
    }
  }, [selectedRepo, loadGithubBranches]);

  const handleConnectGithub = async () => {
    setGithubError('');
    try {
      const res = await getGithubAuthUrl();
      // Open a small popup — GitHub login happens there
      const popup = window.open(res.data.url, 'github-oauth', 'width=600,height=700,scrollbars=yes');
      // Poll until popup closes or redirects back
      const poll = setInterval(() => {
        try {
          if (!popup || popup.closed) {
            clearInterval(poll);
            // Re-check status
            getGithubStatus().then(r => {
              setGithubLinked(r.data.linked);
              setGithubUsername(r.data.githubUsername);
              if (r.data.linked) loadGithubRepos();
            }).catch(() => {});
          }
        } catch (_) {}
      }, 500);
    } catch (err) {
      setGithubError('Failed to initiate GitHub OAuth.');
    }
  };

  const handleUnlinkGithub = async () => {
    if (!window.confirm('Unlink your GitHub account from this platform?')) return;
    try {
      await unlinkGithub();
      setGithubLinked(false);
      setGithubUsername(null);
      setGithubRepos([]);
      setSelectedRepo(null);
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to unlink GitHub.');
    }
  };

  const handleGithubImport = async () => {
    if (!selectedRepo) return;
    setGithubImporting(true);
    setGithubError('');
    setActiveJobLogs([]);
    setActiveJobArtifactUrl(null);
    setActiveJobStatus('building');
    setActiveJobVulns(0);
    setActiveJobTech('');
    setActiveJobUpgrades([]);
    setPreviewReady(false);
    setPreviewRunning(false);
    setPreviewUrl('');
    try {
      const res = await importGithubRepo({
        repoFullName:   selectedRepo.fullName,
        branch:         repoBranch || selectedRepo.defaultBranch || 'main',
        projectName:    selectedRepo.name,
        previewPort:    previewPort || '3001',
        sessionId:      socketRef.current?.id || '',
        envFiles:       JSON.stringify(envFiles.filter(r => r.path.trim() && r.content.trim())),
        targetSubfolder,
        upgradeMode,
        useTempDb,
        enableSmartSeeding,
        dbInitScript: enableDbInit ? dbInitScript : '',
        dbInitType: enableDbInit ? dbInitType : 'none',
      });
      const { jobId, deploymentId } = res.data;
      setActiveJobId(jobId);
      setActiveDeploymentId(deploymentId);
      socketRef.current?.emit('subscribe:pipeline', { jobId });
      fetchSuggestedPort();
      setUploadTab('zip'); // Switch back so logs panel is prominent
    } catch (err) {
      setGithubError(err.response?.data?.message || 'GitHub import failed.');
      setActiveJobStatus('failed');
    } finally {
      setGithubImporting(false);
    }
  };

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
      const isZip = file.name.toLowerCase().endsWith('.zip') || 
                    file.type === 'application/zip' || 
                    file.type === 'application/x-zip-compressed';
      if (!isZip) {
        alert('Only ZIP files are allowed!');
        e.target.value = ''; // Reset input
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        alert(`File is too large! Maximum allowed size is 300MB. Your file is ${(file.size / (1024 * 1024)).toFixed(2)}MB.`);
        e.target.value = ''; // Reset input
        return;
      }
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
  const handleSelectDeployment = async (d) => {
    setActiveDeploymentId(d._id);
    setActiveJobId(d.jobId);
    setActiveJobStatus(d.status);
    setActiveJobVulns(d.vulnerabilitiesFound || 0);
    setActiveJobTech(d.techStackDetected || '');
    setActiveJobArch(d.architectureDetected || '');
    setActiveJobLogs([]);
    setActiveJobUpgrades(d.recommendedUpgrades || []);
    setPreviewPort(d.previewPort || '');
    setPreviewUrl(d.previewPort ? `http://localhost:${d.previewPort}` : '');
    setPreviewRunning(d.previewStatus === 'running');
    setPreviewReady(d.previewStatus === 'running');

    try {
      const res = await getDeploymentStatus(d._id);
      setActiveJobLogs(res.data.buildLogs || []);
    } catch (_) {
      setActiveJobLogs(d.buildLogs || []);
    }
  };

  // ── Upload submit ──────────────────────────────────────────────────────────
  const handleUploadSubmit = async (e) => {
    e.preventDefault();
    if (!selectedFile) {
      setUploadError('Please select a ZIP file to upload.');
      return;
    }

    setUploading(true);
    setUploadProgress(0);
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
    formData.append('useTempDb', String(useTempDb));
    formData.append('enableSmartSeeding', String(enableSmartSeeding));
    formData.append('dbInitScript', enableDbInit ? dbInitScript : '');
    formData.append('dbInitType', enableDbInit ? dbInitType : 'none');

    try {
      const res = await uploadDeploymentZip(formData, (progressEvent) => {
        const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
        setUploadProgress(percentCompleted);
      });
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
      setUploadProgress(0);
    }
  };

  // ── Stop live preview ──────────────────────────────────────────────────────
  
  const handleRunTerminalQuery = async (activeDbVal) => {
    if (!terminalQuery.trim() || !activeDeploymentId) return;
    setRunningQuery(true);
    setTerminalOutput('Executing query inside database container...');
    
    try {
      const res = await executeDeploymentDbQuery(activeDeploymentId, terminalQuery, activeDbVal || 'mysql');
      setTerminalOutput(res.data.output || '(No output returned. Query ran successfully.)');
    } catch (err) {
      setTerminalOutput(`Error: ${err.response?.data?.message || err.message}`);
    } finally {
      setRunningQuery(false);
    }
  };
  
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

  // ── Update Port & Rebuild Sandbox ──────────────────────────────────────────
  const handleUpdatePort = async (e) => {
    if (e) e.preventDefault();
    if (!activeDeploymentId) return;
    if (!editPortValue || isNaN(editPortValue)) {
      alert('Please enter a valid port number.');
      return;
    }
    
    setIsRebuildingPort(true);
    setPreviewReady(false);
    setPreviewRunning(false);
    setActiveJobStatus('building');
    setActiveJobLogs([
      '[PREVIEW] Port change requested.',
      `[PREVIEW] New target port: ${editPortValue}`,
      '[PREVIEW] Updating environment variables and config files...',
      '[PREVIEW] Rebuilding isolated container sandbox in background...'
    ]);

    try {
      await changeDeploymentPort(activeDeploymentId, Number(editPortValue));
      setIsEditingPort(false);
      setPreviewPort(String(editPortValue));
      
      if (activeJobId && socketRef.current) {
        socketRef.current.emit('subscribe:pipeline', { jobId: activeJobId });
      }
      
      fetchDeployments();
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to update preview port.');
      setActiveJobStatus('failed');
    } finally {
      setIsRebuildingPort(false);
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

      <div style={{ display: 'grid', gridTemplateColumns: isLogExpanded ? '5fr 5fr' : '7fr 3fr', gap: '24px', alignItems: 'start', transition: 'grid-template-columns 0.3s ease' }}>

        {/* ── Upload Card ──────────────────────────────────────────────── */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '18px', height: '1250px', overflowY: 'auto', paddingRight: '12px' }}>

          {/* ── Card title row ─────────────────────────────────────────── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {uploadTab === 'zip' ? <Upload size={20} style={{ color: 'var(--accent-blue)' }} /> : <Github size={20} style={{ color: '#fff' }} />}
            <h2 style={{ fontSize: '15px' }}>{uploadTab === 'zip' ? 'Upload & Configure Project' : 'Import from GitHub'}</h2>
          </div>

          {/* ── Tab Switcher ─────────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: '4px', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-md)', padding: '4px', border: '1px solid var(--border-subtle)' }}>
            {[
              { id: 'zip', label: 'ZIP Upload', icon: <Upload size={14} style={{ marginRight: '6px', display: 'inline-block', verticalAlign: 'middle' }} /> },
              { id: 'github', label: 'GitHub Import', icon: <Github size={14} style={{ marginRight: '6px', display: 'inline-block', verticalAlign: 'middle' }} /> },
            ].map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setUploadTab(tab.id)}
                style={{
                  flex: 1, padding: '8px 12px', border: 'none', borderRadius: 'var(--radius-sm)',
                  fontWeight: 600, fontSize: '12.5px', cursor: 'pointer', transition: 'all 0.15s',
                  background: uploadTab === tab.id ? 'var(--grad-brand)' : 'transparent',
                  color: uploadTab === tab.id ? '#fff' : 'var(--text-muted)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {/* ── User identity chip (always visible) ──────────────────────── */}
          {currentUser && (
            <div style={{
              background: 'rgba(59, 130, 246, 0.06)',
              border: '1px solid rgba(59, 130, 246, 0.15)',
              borderRadius: 'var(--radius-md)',
              padding: '10px 14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
              marginTop: '-4px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{
                  width: '28px', height: '28px', borderRadius: '50%',
                  background: 'var(--grad-brand)', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 'bold', fontSize: '12px', textTransform: 'uppercase'
                }}>
                  {currentUser.firstName?.[0] || currentUser.username?.[0] || '?'}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {currentUser.firstName} {currentUser.lastName || ''}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{currentUser.email}</span>
                </div>
              </div>
              <span style={{
                fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
                background: 'rgba(255,255,255,0.06)', padding: '2px 8px', borderRadius: '10px',
                color: 'var(--accent-blue)', border: '1px solid rgba(255,255,255,0.1)'
              }}>
                {currentUser.role}
              </span>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════════════ */}
          {/* ── GITHUB IMPORT PANEL ──────────────────────────────────────── */}
          {/* ═══════════════════════════════════════════════════════════════ */}
          {uploadTab === 'github' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

              {githubError && (
                <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', fontSize: '12.5px', color: 'var(--sev-critical)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <AlertOctagon size={14} /> {githubError}
                </div>
              )}

              {/* Not linked ─── show connect button */}
              {!githubLinked ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', padding: '32px 0', textAlign: 'center' }}>
                  <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Github size={32} style={{ color: 'var(--text-secondary)' }} />
                  </div>
                  <div>
                    <p style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)', margin: '0 0 4px' }}>Connect your GitHub Account</p>
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>Authorize this platform to list and import your repositories. Only granted once.</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleConnectGithub}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '8px',
                      background: '#24292f', border: '1px solid rgba(255,255,255,0.15)',
                      borderRadius: 'var(--radius-md)', color: '#fff',
                      padding: '10px 20px', fontWeight: 600, fontSize: '13px', cursor: 'pointer',
                      transition: 'opacity 0.15s'
                    }}
                    onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
                    onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                  >
                    <Github size={16} /> Connect GitHub
                  </button>
                </div>
              ) : (
                /* Linked ─── show repo browser */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {/* GitHub account badge */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(36,41,47,0.6)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 'var(--radius-md)', padding: '10px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Github size={16} style={{ color: '#fff' }} />
                      <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>@{githubUsername}</span>
                      <span style={{ fontSize: '10px', background: 'rgba(34,211,238,0.12)', color: 'var(--accent-cyan)', border: '1px solid rgba(34,211,238,0.25)', borderRadius: '8px', padding: '1px 7px', fontWeight: 600 }}>Linked</span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button type="button" onClick={loadGithubRepos} title="Refresh repositories" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)', padding: '5px', cursor: 'pointer', display: 'flex' }}>
                        <RefreshCw size={13} />
                      </button>
                      <button type="button" onClick={handleUnlinkGithub} title="Unlink GitHub" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 'var(--radius-sm)', color: 'var(--sev-critical)', padding: '5px', cursor: 'pointer', display: 'flex' }}>
                        <Unlock size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Search */}
                  <div style={{ position: 'relative' }}>
                    <Search size={13} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
                    <input
                      type="text"
                      placeholder="Filter repositories..."
                      value={repoSearch}
                      onChange={e => setRepoSearch(e.target.value)}
                      style={{ ...inputStyle, paddingLeft: '30px', fontSize: '12px' }}
                    />
                  </div>

                  {/* Repo list */}
                  <div style={{ maxHeight: '260px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', paddingRight: '4px' }}>
                    {reposLoading ? (
                      <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: '13px' }}>Loading repositories...</div>
                    ) : githubRepos.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: '13px' }}>
                        No repositories found.{' '}
                        <button type="button" onClick={loadGithubRepos} style={{ background: 'none', border: 'none', color: 'var(--accent-cyan)', cursor: 'pointer', textDecoration: 'underline', fontSize: '13px' }}>Load repos</button>
                      </div>
                    ) : (
                      githubRepos
                        .filter(r => r.name.toLowerCase().includes(repoSearch.toLowerCase()) || (r.description || '').toLowerCase().includes(repoSearch.toLowerCase()))
                        .map(repo => {
                          const isSelected = selectedRepo?.id === repo.id;
                          return (
                            <div
                              key={repo.id}
                              onClick={() => { setSelectedRepo(repo); setRepoBranch(repo.defaultBranch || 'main'); }}
                              style={{
                                padding: '10px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                                border: isSelected ? '1px solid var(--accent-cyan)' : '1px solid var(--border-subtle)',
                                background: isSelected ? 'rgba(6,182,212,0.06)' : 'rgba(255,255,255,0.02)',
                                transition: 'all 0.15s',
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                                  {isSelected && <CheckCircle size={13} style={{ color: 'var(--accent-cyan)', flexShrink: 0 }} />}
                                  <span style={{ fontWeight: 600, fontSize: '12.5px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repo.name}</span>
                                  {repo.private && <Lock size={11} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                                  {repo.language && <span style={{ fontSize: '10px', color: 'var(--accent-purple)', fontWeight: 600, background: 'rgba(168,85,247,0.1)', padding: '1px 6px', borderRadius: '8px' }}>{repo.language}</span>}
                                  {repo.stars > 0 && <span style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '2px' }}><Star size={10} />{repo.stars}</span>}
                                </div>
                              </div>
                              {repo.description && <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repo.description}</p>}
                            </div>
                          );
                        })
                    )}
                  </div>

                  {/* Branch + import */}
                  {selectedRepo && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
                        <div style={{ ...sectionStyle, flex: 1 }}>
                          <label style={labelStyle}><GitBranch size={10} style={{ marginRight: '4px' }} />Branch</label>
                          {branchesLoading ? (
                            <select disabled style={{ ...inputStyle, fontSize: '12px' }}>
                              <option>Loading branches...</option>
                            </select>
                          ) : (
                            <select
                              value={repoBranch}
                              onChange={e => setRepoBranch(e.target.value)}
                              style={{ ...inputStyle, fontSize: '12px', cursor: 'pointer' }}
                            >
                              {repoBranches.length === 0 ? (
                                <option value="main">main</option>
                              ) : (
                                repoBranches.map(b => (
                                  <option key={b.name} value={b.name}>
                                    {b.name}
                                  </option>
                                ))
                              )}
                            </select>
                          )}
                        </div>
                        <div style={{ ...sectionStyle }}>
                          <label style={labelStyle}>Port</label>
                          <input type="number" min="1024" max="65535" value={previewPort} onChange={e => setPreviewPort(e.target.value)} style={{ ...inputStyle, width: '80px', textAlign: 'center' }} />
                        </div>
                      </div>

                      {/* Build subdirectory path (Optional) */}
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
{/* Temporary DB Container Provisioning Toggle for GitHub */}
                      <div style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '10px',
                        background: 'rgba(6, 182, 212, 0.03)',
                        border: '1px solid rgba(6, 182, 212, 0.12)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '10px',
                        marginTop: '10px',
                        marginBottom: '8px'
                      }}>
                        <input
                          type="checkbox"
                          id="useTempDbGit"
                          checked={useTempDb}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setUseTempDb(checked);
                            if (!checked) {
                              setEnableDbInit(false);
                              setEnableSmartSeeding(false);
                            }
                          }}
                          style={{ cursor: 'pointer', width: '15px', height: '15px', accentColor: 'var(--accent-cyan)', marginTop: '2px' }}
                        />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <label htmlFor="useTempDbGit" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>
                            Provision Temporary Database Containers
                          </label>
                          <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', lineHeight: '1.3' }}>
                            Automatically spin up isolated database containers. Uncheck if you connect directly to a cloud database or external service.
                          </span>
                        </div>
                      </div>

                      {/* Custom Database Seeding Script Accordion for GitHub */}
                      <div style={{
                        background: 'rgba(255, 255, 255, 0.02)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-md)',
                        padding: '12px',
                        marginTop: '5px',
                        marginBottom: '10px'
                      }}>
                        <div 
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: useTempDb ? 'pointer' : 'not-allowed' }} 
                          onClick={() => {
                            if (useTempDb) {
                              const newVal = !enableDbInit;
                              setEnableDbInit(newVal);
                              if (!newVal) {
                                setEnableSmartSeeding(false);
                              } else {
                                setUseTempDb(true);
                              }
                            }
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                              type="checkbox"
                              checked={enableDbInit}
                              disabled={!useTempDb}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setEnableDbInit(checked);
                                if (!checked) {
                                  setEnableSmartSeeding(false);
                                } else {
                                  setUseTempDb(true);
                                }
                              }}
                              onClick={(e) => e.stopPropagation()}
                              style={{ width: '14px', height: '14px', accentColor: 'var(--accent-cyan)', cursor: useTempDb ? 'pointer' : 'not-allowed' }}
                            />
                            <span style={{ fontSize: '12px', fontWeight: 600, color: useTempDb ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                              Enable Custom Database Initialization Script
                            </span>
                          </div>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{enableDbInit ? '▼' : '▶'}</span>
                        </div>

                        {enableDbInit && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.06)', paddingTop: '10px' }}>
                            
                            {/* Database Type select + Preset Buttons row */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Database Type:</span>
                                <select
                                  value={dbInitType}
                                  onChange={(e) => setDbInitType(e.target.value)}
                                  style={{
                                    background: '#040815',
                                    border: '1px solid var(--border-subtle)',
                                    borderRadius: 'var(--radius-sm)',
                                    color: '#ffffff',
                                    fontSize: '11.5px',
                                    padding: '4px 10px',
                                    outline: 'none'
                                  }}
                                >
                                  <option value="mysql" style={{ background: '#040815', color: '#ffffff' }}>MySQL (SQL)</option>
                                  <option value="postgres" style={{ background: '#040815', color: '#ffffff' }}>PostgreSQL (SQL)</option>
                                  <option value="mongodb" style={{ background: '#040815', color: '#ffffff' }}>MongoDB (NoSQL)</option>
                                  <option value="sqlite" style={{ background: '#040815', color: '#ffffff' }}>SQLite (SQL)</option>
                                  <option value="mariadb" style={{ background: '#040815', color: '#ffffff' }}>MariaDB (SQL)</option>
                                  <option value="mssql" style={{ background: '#040815', color: '#ffffff' }}>SQL Server (SQL)</option>
                                  <option value="oracle" style={{ background: '#040815', color: '#ffffff' }}>Oracle Database (SQL)</option>
                                  <option value="cassandra" style={{ background: '#040815', color: '#ffffff' }}>Cassandra (NoSQL)</option>
                                  <option value="redis" style={{ background: '#040815', color: '#ffffff' }}>Redis (NoSQL)</option>
                                </select>
                              </div>

                              <div style={{ display: 'flex', gap: '6px' }}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (dbInitType === 'mongodb') {
                                      setDbInitScript(`db.users.insertOne({ username: "admin", password: "admin123" });\ndb.threats.insertMany([\n  { id: "ALT-101", type: "SQL Injection", severity: "High" },\n  { id: "ALT-102", type: "Brute Force SSH", severity: "Critical" }\n]);`);
                                    } else if (dbInitType === 'redis') {
                                      setDbInitScript(`HMSET user:admin username admin password admin123 role admin\nSADD users admin`);
                                    } else if (dbInitType === 'cassandra') {
                                      setDbInitScript(`CREATE KEYSPACE IF NOT EXISTS preview_keyspace WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};\nUSE preview_keyspace;\nCREATE TABLE IF NOT EXISTS users (username text PRIMARY KEY, password text);\nINSERT INTO users (username, password) VALUES ('admin', 'admin123');`);
                                    } else if (dbInitType === 'sqlite') {
                                      setDbInitScript(`CREATE TABLE IF NOT EXISTS users (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  username TEXT NOT NULL UNIQUE,\n  password TEXT NOT NULL\n);\nINSERT OR IGNORE INTO users (username, password) VALUES ('admin', 'admin123');`);
                                    } else if (dbInitType === 'mssql') {
                                      setDbInitScript(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='users' AND xtype='U')\nBEGIN\n  CREATE TABLE users (id INT IDENTITY(1,1) PRIMARY KEY, username NVARCHAR(255) UNIQUE, password NVARCHAR(255));\n  INSERT INTO users (username, password) VALUES ('admin', 'admin123');\nEND;`);
                                    } else if (dbInitType === 'oracle') {
                                      setDbInitScript(`DECLARE\n  c INT;\nBEGIN\n  SELECT COUNT(*) INTO c FROM user_tables WHERE table_name = 'USERS';\n  IF c = 0 THEN\n    EXECUTE IMMEDIATE 'CREATE TABLE users (username VARCHAR2(255) PRIMARY KEY, password VARCHAR2(255))';\n  END IF;\n  EXECUTE IMMEDIATE 'INSERT INTO users (username, password) VALUES (''admin'', ''admin123'')';\nEND;\n/`);
                                    } else {
                                      setDbInitScript(`CREATE TABLE IF NOT EXISTS users (\n  id INT AUTO_INCREMENT PRIMARY KEY,\n  username VARCHAR(255) NOT NULL UNIQUE,\n  password VARCHAR(255) NOT NULL\n);\n\nINSERT INTO users (username, password) VALUES ('admin', 'admin123') ON DUPLICATE KEY UPDATE password=VALUES(password);`);
                                    }
                                  }}
                                  style={{ background: 'rgba(6, 182, 212, 0.1)', border: '1px solid rgba(6, 182, 212, 0.25)', borderRadius: 'var(--radius-sm)', color: 'var(--accent-cyan)', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                >
                                  💡 Load Preset
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDbInitScript('')}
                                  style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: 'var(--radius-sm)', color: '#f87171', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                                >
                                  Clear
                                </button>
                              </div>
                            </div>

                            {/* Smart Seeding Checkbox (Grandchild on its own separate block row) */}
                            <div style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: '8px',
                              background: 'rgba(34, 211, 238, 0.02)',
                              border: '1px solid rgba(34, 211, 238, 0.1)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '8px 10px',
                              marginTop: '4px',
                              marginBottom: '4px'
                            }}>
                              <input
                                type="checkbox"
                                id="enableSmartSeedingCheckboxGit"
                                checked={enableSmartSeeding}
                                disabled={!useTempDb || !enableDbInit}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setEnableSmartSeeding(checked);
                                  if (checked) {
                                    setEnableDbInit(true);
                                    setUseTempDb(true);
                                  }
                                }}
                                style={{ width: '13px', height: '13px', accentColor: 'var(--accent-cyan)', marginTop: '2px', cursor: (useTempDb && enableDbInit) ? 'pointer' : 'not-allowed' }}
                              />
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                <label htmlFor="enableSmartSeedingCheckboxGit" style={{ fontSize: '11px', fontWeight: 600, color: (useTempDb && enableDbInit) ? 'var(--text-primary)' : 'var(--text-muted)', cursor: (useTempDb && enableDbInit) ? 'pointer' : 'not-allowed' }}>
                                  Enable Smart Table/Collection Detection & Seeding
                                </label>
                                <span style={{ fontSize: '10px', color: 'var(--text-muted)', lineHeight: '1.3' }}>
                                  Automatically scans files during deployment to discover tables and generate init seeds.
                                </span>
                              </div>
                            </div>

                            {/* Initialization Script Input Area */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                Initialization Script / Commands:
                              </label>
                              <div style={{ position: 'relative', width: '100%', minHeight: '130px' }}>
                                <textarea
                                  value={dbInitScript}
                                  onChange={(e) => setDbInitScript(e.target.value)}
                                  onScroll={handleTextareaScroll}
                                  placeholder={
                                    dbInitType === 'mongodb'
                                      ? '// Enter MongoDB query sequence:\ndb.users.insertOne({ username: "admin", password: "admin123" });'
                                      : '/* Enter SQL command sequence: */\nCREATE TABLE IF NOT EXISTS users (...);\nINSERT INTO users ...;'
                                  }
                                  rows={6}
                                  style={{
                                    width: '100%',
                                    height: '130px',
                                    background: 'transparent',
                                    border: '1px solid var(--border-subtle)',
                                    borderRadius: 'var(--radius-sm)',
                                    color: 'transparent',
                                    caretColor: '#ffffff',
                                    fontFamily: 'var(--font-mono), monospace',
                                    fontSize: '11.5px',
                                    padding: '10px',
                                    outline: 'none',
                                    resize: 'vertical',
                                    position: 'relative',
                                    zIndex: 2,
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all',
                                    lineHeight: '1.5',
                                    boxSizing: 'border-box'
                                  }}
                                />
                                <pre
                                  dangerouslySetInnerHTML={{ __html: highlightCode(dbInitScript, dbInitType) || `<span style="color: var(--text-muted); font-style: italic;">\${dbInitType === 'mongodb' ? '// Enter MongoDB queries...' : '/* Enter SQL commands... */'}</span>` }}
                                  style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    height: '100%',
                                    background: '#020617',
                                    border: '1px solid transparent',
                                    borderRadius: 'var(--radius-sm)',
                                    fontFamily: 'var(--font-mono), monospace',
                                    fontSize: '11.5px',
                                    padding: '10px',
                                    margin: 0,
                                    pointerEvents: 'none',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all',
                                    overflow: 'hidden',
                                    zIndex: 1,
                                    lineHeight: '1.5',
                                    boxSizing: 'border-box',
                                    textAlign: 'left',
                                    color: '#ffffff'
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
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
                          Specify paths relative to repo root, e.g. <code>backend/.env</code> or <code>.env</code>. Leave empty to skip.
                        </p>
                        {/* Preset Buttons for env configuration */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginTop: '6px', marginBottom: '4px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Load Config Presets:</span>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# React / Node Config\nPORT=3001\nMONGODB_URI=mongodb://localhost:27017/preview_db\nJWT_SECRET=supersecret' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            ⚡ JS / MERN
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# Node.js + MySQL Config\nPORT=3001\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_DATABASE=preview_db\nDB_USERNAME=root\nDB_PASSWORD=\nJWT_SECRET=supersecret' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            ⚛️ Node.js + MySQL
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# PHP / Laravel Config\nDB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_DATABASE=preview_db\nDB_USERNAME=root\nDB_PASSWORD=\n# PHP serves on port 8000 internally' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            🐘 PHP / Laravel
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# Java Spring Boot Config\nSPRING_DATASOURCE_URL=jdbc:mysql://localhost:3306/preview_db\nSPRING_DATASOURCE_USERNAME=root\nSPRING_DATASOURCE_PASSWORD=\nSPRING_JPA_HIBERNATE_DDL_AUTO=update\n# Spring Boot serves on port 8080 internally' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            ☕ Java Spring Boot
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# Python Django / Flask Config\nDB_HOST=127.0.0.1\nDB_PORT=5432\nDB_NAME=preview_db\nDB_USER=postgres\nDB_PASSWORD=' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            🐍 Python (Django)
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# SQLite Config\nPORT=3001\nSQLITE_DB=preview_db.sqlite\nJWT_SECRET=supersecret' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            💾 SQLite
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# MariaDB Config\nPORT=3001\nMARIADB_HOST=127.0.0.1\nMARIADB_PORT=3306\nMARIADB_USER=root\nMARIADB_PASSWORD=\nMARIADB_DB=preview_db\nJWT_SECRET=supersecret' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            💠 MariaDB
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# SQL Server Config\nPORT=3001\nMSSQL_HOST=127.0.0.1\nMSSQL_PORT=1433\nMSSQL_USER=sa\nMSSQL_PASSWORD=YourStrongPassword123\nMSSQL_DB=preview_db\nJWT_SECRET=supersecret' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            🖲️ SQL Server
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# Oracle Config\nPORT=3001\nORACLE_HOST=127.0.0.1\nORACLE_PORT=1521\nORACLE_USER=system\nORACLE_PASSWORD=oracle\nORACLE_SERVICE=ORCL\nJWT_SECRET=supersecret' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            🅾️ Oracle DB
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# Cassandra Config\nPORT=3001\nCASSANDRA_HOST=127.0.0.1\nCASSANDRA_PORT=9042\nCASSANDRA_KEYSPACE=preview_keyspace\nJWT_SECRET=supersecret' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            🌌 Cassandra
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvFiles([{ path: '.env', content: '# Redis Config\nPORT=3001\nREDIS_HOST=127.0.0.1\nREDIS_PORT=6379\nREDIS_PASSWORD=\nJWT_SECRET=supersecret' }])}
                            style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                          >
                            ❤️ Redis
                          </button>
                        </div>
                        <div style={{ fontSize: '11.5px', color: 'var(--accent-cyan)', background: 'rgba(6,182,212,0.04)', border: '1px solid rgba(6,182,212,0.15)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', marginTop: '4px', lineHeight: '1.4' }}>
                          💡 <strong>Deployment Hint:</strong> Client/CORS variables (e.g. <code>VITE_API_URL</code>, <code>CLIENT_URL</code>) must point to your exposed Preview Port (currently <code>{previewPort || '3001'}</code>). Set them to <code>http://localhost:{previewPort || '3001'}</code> to match the sandbox environment.
                        </div>

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
                                placeholder="Path inside repo (e.g. backend/.env)"
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
                              rows={8}
                              placeholder={'PORT=3001\nMONGO_URI=mongodb://localhost:27017/mydb\nJWT_SECRET=my_secret'}
                              value={row.content}
                              onChange={(e) => updateEnvRow(idx, 'content', e.target.value)}
                              style={{
                                ...inputStyle,
                                fontFamily: 'var(--font-mono)',
                                fontSize: '11px',
                                resize: 'vertical',
                                minHeight: '160px',
                                WebkitTextSecurity: showEnvContent[idx] ? 'none' : 'disc'
                              }}
                            />
                          </div>
                        ))}

                        {/* Environment Mismatch Warnings (Personal validation) */}
                        {getEnvWarnings().length > 0 && (
                          <div style={{
                            background: 'rgba(234, 179, 8, 0.08)',
                            border: '1px solid rgba(234, 179, 8, 0.25)',
                            borderRadius: 'var(--radius-md)',
                            padding: '12px 14px',
                            fontSize: '12px',
                            color: '#eab308',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px',
                            marginTop: '10px'
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700 }}>
                              <span>⚠️</span> Port Mismatch Detected
                            </div>
                            <ul style={{ margin: 0, paddingLeft: '18px', listStyleType: 'disc', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                              {getEnvWarnings().map((w, idx) => (
                                <li key={idx}>{w}</li>
                              ))}
                            </ul>
                            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                              <strong>Recommendation:</strong> In monorepo/sandbox deployments, backend servers listen on your preview port (<code>{previewPort || '3001'}</code>). Update client/CORS environment variables to target <code>http://localhost:{previewPort || '3001'}</code> to prevent connection failures.
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Dependency Upgrade Mode Toggle */}
                      <div style={{ marginBottom: '14px' }}>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>Dependency Upgrade Mode</label>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12.5px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                            <input
                              type="radio"
                              name="gh-upgrade-mode"
                              value="automatic"
                              checked={upgradeMode === 'automatic'}
                              onChange={() => setUpgradeMode('automatic')}
                              style={{ cursor: 'pointer', marginTop: '3px' }}
                            />
                            <div>
                              <strong style={{ color: 'var(--accent-cyan)' }}>Automatic (Recommended)</strong>
                              <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>Audits and upgrades outdated dependencies to latest stable versions to resolve security vulnerabilities automatically.</span>
                            </div>
                          </label>
                          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12.5px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                            <input
                              type="radio"
                              name="gh-upgrade-mode"
                              value="semi-automatic"
                              checked={upgradeMode === 'semi-automatic'}
                              onChange={() => setUpgradeMode('semi-automatic')}
                              style={{ cursor: 'pointer', marginTop: '3px' }}
                            />
                            <div>
                              <strong>Semi-Automatic (Interactive)</strong>
                              <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>Pauses compilation for 10 seconds to prompt you for version selection.</span>
                            </div>
                          </label>
                          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12.5px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                            <input
                              type="radio"
                              name="gh-upgrade-mode"
                              value="disabled"
                              checked={upgradeMode === 'disabled'}
                              onChange={() => setUpgradeMode('disabled')}
                              style={{ cursor: 'pointer', marginTop: '3px' }}
                            />
                            <div>
                              <strong>Disabled (Troubleshoot)</strong>
                              <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>Bypasses security patching. Select this fallback if auto-remediation upgrades trigger TypeScript compiler errors.</span>
                            </div>
                          </label>
                        </div>
                      </div>

                      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                        Importing: <strong style={{ color: 'var(--text-primary)' }}>{selectedRepo.fullName}</strong> @ <code>{repoBranch}</code>
                      </div>
                      <button
                        type="button"
                        onClick={handleGithubImport}
                        disabled={githubImporting}
                        style={{
                          background: 'var(--grad-brand)', border: 'none', borderRadius: 'var(--radius-md)',
                          color: '#fff', padding: '12px', fontWeight: 600, fontSize: '13px',
                          cursor: githubImporting ? 'not-allowed' : 'pointer',
                          opacity: githubImporting ? 0.6 : 1, transition: 'opacity 0.2s',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
                        }}
                      >
                        <Github size={15} />
                        {githubImporting ? 'Cloning & Starting Pipeline...' : 'Import & Run Pipeline'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════════════ */}
          {/* ── ZIP UPLOAD FORM (only shown when tab === 'zip') ──────────── */}
          {/* ═══════════════════════════════════════════════════════════════ */}
          {uploadTab === 'zip' && (
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
               {/* Temporary DB Container Provisioning Toggle */}
               <div style={{
                 display: 'flex',
                 alignItems: 'flex-start',
                 gap: '10px',
                 background: 'rgba(6, 182, 212, 0.03)',
                 border: '1px solid rgba(6, 182, 212, 0.12)',
                 borderRadius: 'var(--radius-sm)',
                 padding: '10px',
                 marginTop: '5px',
                 marginBottom: '8px'
               }}>
                 <input
                   type="checkbox"
                   id="useTempDbZip"
                   checked={useTempDb}
                   onChange={(e) => {
                     const checked = e.target.checked;
                     setUseTempDb(checked);
                     if (!checked) {
                       setEnableDbInit(false);
                       setEnableSmartSeeding(false);
                     }
                   }}
                   style={{ cursor: 'pointer', width: '15px', height: '15px', accentColor: 'var(--accent-cyan)', marginTop: '2px' }}
                 />
                 <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                   <label htmlFor="useTempDbZip" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>
                     Provision Temporary Database Containers
                   </label>
                   <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', lineHeight: '1.3' }}>
                     Automatically spin up isolated database containers. Uncheck if you connect directly to a cloud database or external service.
                   </span>
                 </div>
               </div>

               {/* Custom Database Seeding Script Accordion */}
               <div style={{
                 background: 'rgba(255, 255, 255, 0.02)',
                 border: '1px solid var(--border-subtle)',
                 borderRadius: 'var(--radius-md)',
                 padding: '12px',
                 marginTop: '5px',
                 marginBottom: '10px'
               }}>
                 <div 
                   style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: useTempDb ? 'pointer' : 'not-allowed' }} 
                   onClick={() => {
                     if (useTempDb) {
                       const newVal = !enableDbInit;
                       setEnableDbInit(newVal);
                       if (!newVal) {
                         setEnableSmartSeeding(false);
                       } else {
                         setUseTempDb(true);
                       }
                     }
                   }}
                 >
                   <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                     <input
                       type="checkbox"
                       checked={enableDbInit}
                       disabled={!useTempDb}
                       onChange={(e) => {
                         const checked = e.target.checked;
                         setEnableDbInit(checked);
                         if (!checked) {
                           setEnableSmartSeeding(false);
                         } else {
                           setUseTempDb(true);
                         }
                       }}
                       onClick={(e) => e.stopPropagation()}
                       style={{ width: '14px', height: '14px', accentColor: 'var(--accent-cyan)', cursor: useTempDb ? 'pointer' : 'not-allowed' }}
                     />
                     <span style={{ fontSize: '12px', fontWeight: 600, color: useTempDb ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                       Enable Custom Database Initialization Script
                     </span>
                   </div>
                   <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{enableDbInit ? '▼' : '▶'}</span>
                 </div>

                 {enableDbInit && (
                   <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.06)', paddingTop: '10px' }}>
                     
                     {/* Database Type select + Preset Buttons row */}
                     <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
                       <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                         <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Database Type:</span>
                         <select
                           value={dbInitType}
                           onChange={(e) => setDbInitType(e.target.value)}
                           style={{
                             background: '#040815',
                             border: '1px solid var(--border-subtle)',
                             borderRadius: 'var(--radius-sm)',
                             color: '#ffffff',
                             fontSize: '11.5px',
                             padding: '4px 10px',
                             outline: 'none'
                           }}
                         >
                           <option value="mysql" style={{ background: '#040815', color: '#ffffff' }}>MySQL (SQL)</option>
                           <option value="postgres" style={{ background: '#040815', color: '#ffffff' }}>PostgreSQL (SQL)</option>
                           <option value="mongodb" style={{ background: '#040815', color: '#ffffff' }}>MongoDB (NoSQL)</option>
                           <option value="sqlite" style={{ background: '#040815', color: '#ffffff' }}>SQLite (SQL)</option>
                           <option value="mariadb" style={{ background: '#040815', color: '#ffffff' }}>MariaDB (SQL)</option>
                           <option value="mssql" style={{ background: '#040815', color: '#ffffff' }}>SQL Server (SQL)</option>
                           <option value="oracle" style={{ background: '#040815', color: '#ffffff' }}>Oracle Database (SQL)</option>
                           <option value="cassandra" style={{ background: '#040815', color: '#ffffff' }}>Cassandra (NoSQL)</option>
                           <option value="redis" style={{ background: '#040815', color: '#ffffff' }}>Redis (NoSQL)</option>
                         </select>
                       </div>

                       <div style={{ display: 'flex', gap: '6px' }}>
                         <button
                           type="button"
                           onClick={() => {
                             if (dbInitType === 'mongodb') {
                               setDbInitScript(`db.users.insertOne({ username: "admin", password: "admin123" });\ndb.threats.insertMany([\n  { id: "ALT-101", type: "SQL Injection", severity: "High" },\n  { id: "ALT-102", type: "Brute Force SSH", severity: "Critical" }\n]);`);
                             } else if (dbInitType === 'redis') {
                               setDbInitScript(`HMSET user:admin username admin password admin123 role admin\nSADD users admin`);
                             } else if (dbInitType === 'cassandra') {
                               setDbInitScript(`CREATE KEYSPACE IF NOT EXISTS preview_keyspace WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};\nUSE preview_keyspace;\nCREATE TABLE IF NOT EXISTS users (username text PRIMARY KEY, password text);\nINSERT INTO users (username, password) VALUES ('admin', 'admin123');`);
                             } else if (dbInitType === 'sqlite') {
                               setDbInitScript(`CREATE TABLE IF NOT EXISTS users (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  username TEXT NOT NULL UNIQUE,\n  password TEXT NOT NULL\n);\nINSERT OR IGNORE INTO users (username, password) VALUES ('admin', 'admin123');`);
                             } else if (dbInitType === 'mssql') {
                               setDbInitScript(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='users' AND xtype='U')\nBEGIN\n  CREATE TABLE users (id INT IDENTITY(1,1) PRIMARY KEY, username NVARCHAR(255) UNIQUE, password NVARCHAR(255));\n  INSERT INTO users (username, password) VALUES ('admin', 'admin123');\nEND;`);
                             } else if (dbInitType === 'oracle') {
                               setDbInitScript(`DECLARE\n  c INT;\nBEGIN\n  SELECT COUNT(*) INTO c FROM user_tables WHERE table_name = 'USERS';\n  IF c = 0 THEN\n    EXECUTE IMMEDIATE 'CREATE TABLE users (username VARCHAR2(255) PRIMARY KEY, password VARCHAR2(255))';\n  END IF;\n  EXECUTE IMMEDIATE 'INSERT INTO users (username, password) VALUES (''admin'', ''admin123'')';\nEND;\n/`);
                             } else {
                               setDbInitScript(`CREATE TABLE IF NOT EXISTS users (\n  id INT AUTO_INCREMENT PRIMARY KEY,\n  username VARCHAR(255) NOT NULL UNIQUE,\n  password VARCHAR(255) NOT NULL\n);\n\nINSERT INTO users (username, password) VALUES ('admin', 'admin123') ON DUPLICATE KEY UPDATE password=VALUES(password);`);
                             }
                           }}
                           style={{ background: 'rgba(6, 182, 212, 0.1)', border: '1px solid rgba(6, 182, 212, 0.25)', borderRadius: 'var(--radius-sm)', color: 'var(--accent-cyan)', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                         >
                           💡 Load Preset
                         </button>
                         <button
                           type="button"
                           onClick={() => setDbInitScript('')}
                           style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: 'var(--radius-sm)', color: '#f87171', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                         >
                           Clear
                         </button>
                       </div>
                     </div>

                     {/* Smart Seeding Checkbox (Grandchild on its own separate block row) */}
                     <div style={{
                       display: 'flex',
                       alignItems: 'flex-start',
                       gap: '8px',
                       background: 'rgba(34, 211, 238, 0.02)',
                       border: '1px solid rgba(34, 211, 238, 0.1)',
                       borderRadius: 'var(--radius-sm)',
                       padding: '8px 10px',
                       marginTop: '4px',
                       marginBottom: '4px'
                     }}>
                       <input
                         type="checkbox"
                         id="enableSmartSeedingCheckboxZip"
                         checked={enableSmartSeeding}
                         disabled={!useTempDb || !enableDbInit}
                         onChange={(e) => {
                           const checked = e.target.checked;
                           setEnableSmartSeeding(checked);
                           if (checked) {
                             setEnableDbInit(true);
                             setUseTempDb(true);
                           }
                         }}
                         style={{ width: '13px', height: '13px', accentColor: 'var(--accent-cyan)', marginTop: '2px', cursor: (useTempDb && enableDbInit) ? 'pointer' : 'not-allowed' }}
                       />
                       <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                         <label htmlFor="enableSmartSeedingCheckboxZip" style={{ fontSize: '11px', fontWeight: 600, color: (useTempDb && enableDbInit) ? 'var(--text-primary)' : 'var(--text-muted)', cursor: (useTempDb && enableDbInit) ? 'pointer' : 'not-allowed' }}>
                           Enable Smart Table/Collection Detection & Seeding
                         </label>
                         <span style={{ fontSize: '10px', color: 'var(--text-muted)', lineHeight: '1.3' }}>
                           Automatically scans your files during deployment to discover tables, find the user credentials structure, and draft optimal initialization queries.
                         </span>
                       </div>
                     </div>

                     {/* Initialization Script Input Area */}
                     <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                       <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                         Initialization Script / Commands:
                       </label>
                       <div style={{ position: 'relative', width: '100%', minHeight: '130px' }}>
                         <textarea
                           value={dbInitScript}
                           onChange={(e) => setDbInitScript(e.target.value)}
                           onScroll={handleTextareaScroll}
                           placeholder={
                             dbInitType === 'mongodb'
                               ? '// Enter MongoDB query sequence:\ndb.users.insertOne({ username: "admin", password: "admin123" });'
                               : '/* Enter SQL command sequence: */\nCREATE TABLE IF NOT EXISTS users (...);\nINSERT INTO users ...;'
                           }
                           rows={6}
                           style={{
                             width: '100%',
                             height: '130px',
                             background: 'transparent',
                             border: '1px solid var(--border-subtle)',
                             borderRadius: 'var(--radius-sm)',
                             color: 'transparent',
                             caretColor: '#ffffff',
                             fontFamily: 'var(--font-mono), monospace',
                             fontSize: '11.5px',
                             padding: '10px',
                             outline: 'none',
                             resize: 'vertical',
                             position: 'relative',
                             zIndex: 2,
                             whiteSpace: 'pre-wrap',
                             wordBreak: 'break-all',
                             lineHeight: '1.5',
                             boxSizing: 'border-box'
                           }}
                         />
                         <pre
                           dangerouslySetInnerHTML={{ __html: highlightCode(dbInitScript, dbInitType) || `<span style="color: var(--text-muted); font-style: italic;">\${dbInitType === 'mongodb' ? '// Enter MongoDB queries...' : '/* Enter SQL commands... */'}</span>` }}
                           style={{
                             position: 'absolute',
                             top: 0,
                             left: 0,
                             width: '100%',
                             height: '100%',
                             background: '#020617',
                             border: '1px solid transparent',
                             borderRadius: 'var(--radius-sm)',
                             fontFamily: 'var(--font-mono), monospace',
                             fontSize: '11.5px',
                             padding: '10px',
                             margin: 0,
                             pointerEvents: 'none',
                             whiteSpace: 'pre-wrap',
                             wordBreak: 'break-all',
                             overflow: 'hidden',
                             zIndex: 1,
                             lineHeight: '1.5',
                             boxSizing: 'border-box',
                             textAlign: 'left',
                             color: '#ffffff'
                           }}
                         />
                       </div>
                     </div>
                   </div>
                 )}
               </div>

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
              {/* Preset Buttons for env configuration */}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginTop: '6px', marginBottom: '4px' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Load Config Presets:</span>
                <button
                  type="button"
                  onClick={() => setEnvFiles([{ path: '.env', content: '# React / Node Config\nPORT=3001\nMONGODB_URI=mongodb://localhost:27017/preview_db\nJWT_SECRET=supersecret' }])}
                  style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                >
                  ⚡ JS / MERN
                </button>
                <button
                  type="button"
                  onClick={() => setEnvFiles([{ path: '.env', content: '# Node.js + MySQL Config\nPORT=3001\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_DATABASE=preview_db\nDB_USERNAME=root\nDB_PASSWORD=\nJWT_SECRET=supersecret' }])}
                  style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                >
                  ⚛️ Node.js + MySQL
                </button>
                <button
                  type="button"
                  onClick={() => setEnvFiles([{ path: '.env', content: '# PHP / Laravel Config\nDB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_DATABASE=preview_db\nDB_USERNAME=root\nDB_PASSWORD=\n# PHP serves on port 8000 internally' }])}
                  style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                >
                  🐘 PHP / Laravel
                </button>
                <button
                  type="button"
                  onClick={() => setEnvFiles([{ path: '.env', content: '# Java Spring Boot Config\nSPRING_DATASOURCE_URL=jdbc:mysql://localhost:3306/preview_db\nSPRING_DATASOURCE_USERNAME=root\nSPRING_DATASOURCE_PASSWORD=\nSPRING_JPA_HIBERNATE_DDL_AUTO=update\n# Spring Boot serves on port 8080 internally' }])}
                  style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                >
                  ☕ Java Spring Boot
                </button>
                <button
                  type="button"
                  onClick={() => setEnvFiles([{ path: '.env', content: '# Python Django / Flask Config\nDB_HOST=127.0.0.1\nDB_PORT=5432\nDB_NAME=preview_db\nDB_USER=postgres\nDB_PASSWORD=' }])}
                  style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', transition: 'background 0.2s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
                >
                  🐍 Python (Django)
                </button>
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--accent-cyan)', background: 'rgba(6,182,212,0.04)', border: '1px solid rgba(6,182,212,0.15)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', marginTop: '4px', lineHeight: '1.4' }}>
                💡 <strong>Deployment Hint:</strong> Client/CORS variables (e.g. <code>VITE_API_URL</code>, <code>CLIENT_URL</code>) must point to your exposed Preview Port (currently <code>{previewPort || '3001'}</code>). Set them to <code>http://localhost:{previewPort || '3001'}</code> to match the sandbox environment.
              </div>

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
                      minHeight: '160px',
                      WebkitTextSecurity: showEnvContent[idx] ? 'none' : 'disc'
                    }}
                  />
                </div>
              ))}

              {/* Environment Mismatch Warnings (Personal validation) */}
              {getEnvWarnings().length > 0 && (
                <div style={{
                  background: 'rgba(234, 179, 8, 0.08)',
                  border: '1px solid rgba(234, 179, 8, 0.25)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px 14px',
                  fontSize: '12px',
                  color: '#eab308',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  marginTop: '10px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700 }}>
                    <span>⚠️</span> Port Mismatch Detected
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '18px', listStyleType: 'disc', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    {getEnvWarnings().map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    <strong>Recommendation:</strong> In monorepo/sandbox deployments, backend servers listen on your preview port (<code>{previewPort || '3001'}</code>). Update client/CORS environment variables to target <code>http://localhost:{previewPort || '3001'}</code> to prevent connection failures.
                  </div>
                </div>
              )}
            </div>

            {/* Dependency Upgrade Mode Toggle */}
            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>Dependency Upgrade Mode</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12.5px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                  <input 
                    type="radio" 
                    name="upgradeMode" 
                    value="automatic" 
                    checked={upgradeMode === 'automatic'}
                    onChange={() => setUpgradeMode('automatic')}
                    style={{ accentColor: 'var(--accent-cyan)', marginTop: '3px' }}
                  />
                  <div>
                    <strong style={{ color: 'var(--accent-cyan)' }}>Automatic (Recommended)</strong>
                    <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>Audits and upgrades outdated dependencies to latest stable versions to resolve security vulnerabilities automatically.</span>
                  </div>
                </label>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12.5px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                  <input 
                    type="radio" 
                    name="upgradeMode" 
                    value="semi-automatic" 
                    checked={upgradeMode === 'semi-automatic'}
                    onChange={() => setUpgradeMode('semi-automatic')}
                    style={{ accentColor: 'var(--accent-cyan)', marginTop: '3px' }}
                  />
                  <div>
                    <strong>Semi-Automatic (Interactive)</strong>
                    <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>Pauses compilation for 10 seconds to prompt you for version selection.</span>
                  </div>
                </label>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12.5px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                  <input 
                    type="radio" 
                    name="upgradeMode" 
                    value="disabled" 
                    checked={upgradeMode === 'disabled'}
                    onChange={() => setUpgradeMode('disabled')}
                    style={{ accentColor: 'var(--accent-cyan)', marginTop: '3px' }}
                  />
                  <div>
                    <strong>Disabled (Troubleshoot)</strong>
                    <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>Bypasses security patching. Select this fallback if auto-remediation upgrades trigger TypeScript compiler errors.</span>
                  </div>
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

            {uploading && uploadProgress > 0 && (
              <div style={{ marginTop: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  <span>{uploadProgress === 100 ? 'Processing ZIP package...' : 'Uploading repository...'}</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div style={{ width: '100%', height: '5px', background: 'rgba(255,255,255,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
                  <div 
                    style={{ 
                      width: `${uploadProgress}%`, 
                      height: '100%', 
                      background: 'var(--grad-brand)', 
                      borderRadius: '3px',
                      transition: 'width 0.1s ease-out' 
                    }} 
                  />
                </div>
              </div>
            )}
          </form>
          )}
        </div>

        {/* ── Live Pipeline Console ──────────────────────────────────────── */}
        <div className="card" style={{
          display: 'flex',
          flexDirection: 'column',
          gap: isPipelineLogCollapsed ? '0' : '16px',
          height: isPipelineLogCollapsed ? 'auto' : '1250px',
          overflowY: isPipelineLogCollapsed ? 'visible' : 'auto',
          paddingRight: '12px',
          position: 'relative',
          transition: 'height 0.2s ease-in-out'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isPipelineLogCollapsed ? '0' : '4px' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
              onClick={() => setIsPipelineLogCollapsed(!isPipelineLogCollapsed)}
              title={isPipelineLogCollapsed ? "Expand Console" : "Collapse Console"}
            >
              <Terminal size={20} style={{ color: 'var(--accent-cyan)' }} />
              <h2 style={{ fontSize: '15px' }}>Pipeline Log Stream</h2>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '4px' }}>
                {isPipelineLogCollapsed ? '▶' : '▼'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {activeJobStatus && <StatusBadge status={activeJobStatus} />}
              <button
                type="button"
                onClick={() => setIsPipelineLogCollapsed(!isPipelineLogCollapsed)}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '3px 8px',
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
              >
                {isPipelineLogCollapsed ? 'Expand' : 'Collapse'}
              </button>
              <button
                type="button"
                onClick={() => setIsLogExpanded(!isLogExpanded)}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '3px 8px',
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; }}
              >
                {isLogExpanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                {isLogExpanded ? 'Normal' : 'Expand Width'}
              </button>
            </div>
          </div>{!isPipelineLogCollapsed && (
            <>
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
                        
                        {!isEditingPort && !isRebuildingPort && (
                          <button
                            onClick={() => {
                              setEditPortValue(String(previewPort));
                              setIsEditingPort(true);
                            }}
                            title="Change sandbox preview port"
                            style={{
                              background: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.3)',
                              borderRadius: 'var(--radius-sm)', color: 'var(--accent-cyan)',
                              padding: '5px 10px', fontSize: '11px', fontWeight: 600,
                              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                            }}
                          >
                            <Settings size={11} /> Edit Port
                          </button>
                        )}

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

                      {isEditingPort && (
                        <form onSubmit={handleUpdatePort} style={{
                          background: 'rgba(251, 191, 36, 0.03)',
                          border: '1px solid rgba(251, 191, 36, 0.2)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '12px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '10px',
                          marginTop: '6px'
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <label style={{ fontSize: '12.5px', color: 'var(--text-primary)', fontWeight: 600 }}>New Port:</label>
                            <input
                              type="number"
                              min="1024"
                              max="65535"
                              value={editPortValue}
                              onChange={e => setEditPortValue(e.target.value)}
                              style={{
                                background: 'var(--bg-base)',
                                border: '1px solid var(--border-subtle)',
                                borderRadius: 'var(--radius-sm)',
                                color: 'var(--text-primary)',
                                padding: '4px 8px',
                                width: '90px',
                                fontSize: '13px',
                                textAlign: 'center',
                                fontFamily: 'var(--font-mono)'
                              }}
                            />
                            <button
                              type="submit"
                              disabled={isRebuildingPort}
                              style={{
                                background: 'var(--accent-cyan)',
                                border: 'none',
                                color: '#000',
                                fontWeight: 'bold',
                                borderRadius: 'var(--radius-sm)',
                                padding: '6px 12px',
                                fontSize: '12px',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '5px'
                              }}
                            >
                              {isRebuildingPort ? 'Saving...' : 'Save & Rebuild'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setIsEditingPort(false)}
                              style={{
                                background: 'transparent',
                                border: '1px solid var(--border-subtle)',
                                borderRadius: 'var(--radius-sm)',
                                color: 'var(--text-secondary)',
                                padding: '6px 12px',
                                fontSize: '12px',
                                cursor: 'pointer'
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                          <div style={{
                            fontSize: '11px',
                            color: '#fbbf24',
                            lineHeight: '1.4',
                            background: 'rgba(251, 191, 36, 0.05)',
                            padding: '8px 10px',
                            borderRadius: 'var(--radius-sm)'
                          }}>
                            ⚠️ <strong>Please Note:</strong> Changing the port requires stopping the active sandbox container, updating all environment files (.env) in the workspace directory, and fully rebuilding the container. <strong>This process will take a few minutes to re-compile.</strong>
                          </div>
                        </form>
                      )}

                      {isRebuildingPort && (
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          background: 'rgba(6, 182, 212, 0.06)',
                          border: '1px solid rgba(6, 182, 212, 0.2)',
                          padding: '12px 14px',
                          borderRadius: 'var(--radius-md)',
                          marginTop: '6px'
                        }}>
                          <style>{`
                            @keyframes rotate-clock {
                              0% { transform: rotate(0deg); }
                              100% { transform: rotate(360deg); }
                            }
                            .clock-hand-anim {
                              animation: rotate-clock 2s linear infinite;
                              transform-origin: 12px 12px;
                            }
                          `}</style>
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="12" x2="12" y2="7" className="clock-hand-anim" />
                            <line x1="12" y1="12" x2="16" y2="12" className="clock-hand-anim" style={{ animationDuration: '8s' }} />
                          </svg>
                          <div style={{ fontSize: '12px', color: 'var(--text-primary)', lineHeight: '1.4' }}>
                            <span style={{ fontWeight: 600, color: 'var(--accent-cyan)', display: 'block' }}>Rebuilding Sandbox Container...</span>
                            Updating environment variables and re-compiling client assets in the background.
                          </div>
                        </div>
                      )}

                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.4', background: 'rgba(0,0,0,0.02)', padding: '10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                        ⚠️ <strong>Network Isolation Note:</strong> The preview runs in an isolated container sandbox on the server. The port <code>{previewPort}</code> is internal to the container host and is not directly exposable to your local browser via localhost. Please use the <strong>Get ZIP</strong> button above to download the compiled build and run it locally.
                      </div>
                    </div>
                  )}
                  {/* Sandbox Database Terminal Panel */}
                  {previewReady && activeDeploymentId && (() => {
                    const activeDep = deployments.find(d => d._id === activeDeploymentId);
                    if (!activeDep || !activeDep.dbInitType || activeDep.dbInitType === 'none') return null;
                    const dbLabel = activeDep.dbInitType === 'mysql' ? 'MySQL (SQL)' : activeDep.dbInitType === 'postgres' ? 'PostgreSQL (SQL)' : 'MongoDB (NoSQL)';
                    return (
                      <div style={{
                        display: 'flex', flexDirection: 'column', gap: '12px',
                        background: 'rgba(6, 182, 212, 0.02)', padding: '14px',
                        borderRadius: 'var(--radius-md)', border: '1px solid rgba(6, 182, 212, 0.25)',
                        marginTop: '12px'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <Database size={18} style={{ color: 'var(--accent-cyan)', flexShrink: 0 }} />
                          <div style={{ flex: 1, fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>
                            🗄️ Sandbox Database Query Terminal ({dbLabel})
                          </div>
                          
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              type="button"
                              onClick={() => {
                                if (activeDep.dbInitType === 'mongodb') {
                                  setTerminalQuery('db.users.find().toArray();');
                                } else {
                                  setTerminalQuery('SELECT * FROM users;');
                                }
                              }}
                              style={{ background: 'rgba(255, 255, 255, 0.05)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                            >
                              🔍 View Users
                            </button>
                            <button
                              type="button"
                              onClick={() => setTerminalQuery('')}
                              style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: 'var(--radius-sm)', color: '#f87171', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}
                            >
                              Clear
                            </button>
                          </div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <div style={{ position: 'relative', width: '100%', minHeight: '180px' }}>
                            <textarea
                              value={terminalQuery}
                              onChange={(e) => setTerminalQuery(e.target.value)}
                              onScroll={handleTextareaScroll}
                              placeholder={
                                activeDep.dbInitType === 'mongodb'
                                  ? '// Enter MongoDB queries (e.g. db.users.find())\\ndb.users.find().toArray();'
                                  : '/* Enter SQL queries (e.g. SELECT * FROM users;) */\\nSELECT * FROM users;'
                              }
                              rows={4}
                              style={{
                                width: '100%',
                                height: '180px',
                                background: 'transparent',
                                border: '1px solid var(--border-subtle)',
                                borderRadius: 'var(--radius-sm)',
                                color: 'transparent',
                                caretColor: '#ffffff',
                                fontFamily: 'var(--font-mono), monospace',
                                fontSize: '11.5px',
                                padding: '10px',
                                outline: 'none',
                                resize: 'vertical',
                                position: 'relative',
                                zIndex: 2,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                                lineHeight: '1.5',
                                boxSizing: 'border-box'
                              }}
                            />
                            <pre
                              dangerouslySetInnerHTML={{ __html: highlightCode(terminalQuery, activeDep.dbInitType) || `<span style="color: var(--text-muted); font-style: italic;">${activeDep.dbInitType === 'mongodb' ? '// Enter MongoDB queries...' : '/* Enter SQL queries... */'}</span>` }}
                              style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: '100%',
                                background: '#020617',
                                border: '1px solid transparent',
                                borderRadius: 'var(--radius-sm)',
                                fontFamily: 'var(--font-mono), monospace',
                                fontSize: '11.5px',
                                padding: '10px',
                                margin: 0,
                                pointerEvents: 'none',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                                overflow: 'hidden',
                                zIndex: 1,
                                lineHeight: '1.5',
                                boxSizing: 'border-box',
                                textAlign: 'left',
                                color: '#ffffff'
                              }}
                            />
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: '10px' }}>
                          <button
                            type="button"
                            onClick={() => handleRunTerminalQuery(activeDep.dbInitType)}
                            disabled={runningQuery || !terminalQuery.trim()}
                            style={{
                              background: 'var(--accent-cyan)',
                              border: 'none',
                              borderRadius: 'var(--radius-sm)',
                              color: '#000000',
                              padding: '6px 16px',
                              fontWeight: 700,
                              fontSize: '12px',
                              cursor: (runningQuery || !terminalQuery.trim()) ? 'not-allowed' : 'pointer',
                              opacity: (runningQuery || !terminalQuery.trim()) ? 0.6 : 1,
                              marginLeft: 'auto'
                            }}
                          >
                            {runningQuery ? 'Running...' : 'Run Query'}
                          </button>
                        </div>

                        {terminalOutput && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
                            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Execution Output:</span>
                            <pre style={{
                              background: '#020617',
                              border: '1px solid var(--border-subtle)',
                              borderRadius: 'var(--radius-sm)',
                              color: '#34d399',
                              fontFamily: 'var(--font-mono), monospace',
                              fontSize: '11.5px',
                              padding: '10px',
                              margin: 0,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-all',
                              maxHeight: '180px',
                              overflowY: 'auto',
                              textAlign: 'left'
                            }}>
                              {terminalOutput}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  })()}
  

                  {/* Preview stopped notice */}
                  {activeJobStatus === 'deployed' && !previewRunning && previewUrl && (
                    <div style={{
                      display: 'flex', flexDirection: 'column', gap: '10px',
                      background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)', padding: '12px 14px'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ flex: 1, fontSize: '12px', color: 'var(--text-muted)' }}>
                          Preview process is stopped. Allocated port: <strong>{previewPort}</strong>.
                        </div>
                        
                        {!isEditingPort && !isRebuildingPort && (
                          <button
                            onClick={() => {
                              setEditPortValue(String(previewPort));
                              setIsEditingPort(true);
                            }}
                            style={{
                              background: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.3)',
                              borderRadius: 'var(--radius-sm)', color: 'var(--accent-cyan)',
                              padding: '4px 8px', fontSize: '11px', fontWeight: 600,
                              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px'
                            }}
                          >
                            <Settings size={11} /> Change Port
                          </button>
                        )}
                      </div>

                      {isEditingPort && (
                        <form onSubmit={handleUpdatePort} style={{
                          background: 'rgba(251, 191, 36, 0.03)',
                          border: '1px solid rgba(251, 191, 36, 0.2)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '12px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '10px',
                          marginTop: '4px'
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <label style={{ fontSize: '12.5px', color: 'var(--text-primary)', fontWeight: 600 }}>New Port:</label>
                            <input
                              type="number"
                              min="1024"
                              max="65535"
                              value={editPortValue}
                              onChange={e => setEditPortValue(e.target.value)}
                              style={{
                                background: 'var(--bg-base)',
                                border: '1px solid var(--border-subtle)',
                                borderRadius: 'var(--radius-sm)',
                                color: 'var(--text-primary)',
                                padding: '4px 8px',
                                width: '90px',
                                fontSize: '13px',
                                textAlign: 'center',
                                fontFamily: 'var(--font-mono)'
                              }}
                            />
                            <button
                              type="submit"
                              disabled={isRebuildingPort}
                              style={{
                                background: 'var(--accent-cyan)',
                                border: 'none',
                                color: '#000',
                                fontWeight: 'bold',
                                borderRadius: 'var(--radius-sm)',
                                padding: '6px 12px',
                                fontSize: '12px',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '5px'
                              }}
                            >
                              {isRebuildingPort ? 'Saving...' : 'Save & Rebuild'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setIsEditingPort(false)}
                              style={{
                                background: 'transparent',
                                border: '1px solid var(--border-subtle)',
                                borderRadius: 'var(--radius-sm)',
                                color: 'var(--text-secondary)',
                                padding: '6px 12px',
                                fontSize: '12px',
                                cursor: 'pointer'
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                          <div style={{
                            fontSize: '11px',
                            color: '#fbbf24',
                            lineHeight: '1.4',
                            background: 'rgba(251, 191, 36, 0.05)',
                            padding: '8px 10px',
                            borderRadius: 'var(--radius-sm)'
                          }}>
                            ⚠️ <strong>Please Note:</strong> Changing the port requires stopping the active sandbox container, updating all environment files (.env) in the workspace directory, and fully rebuilding the container. <strong>This process will take a few minutes to re-compile.</strong>
                          </div>
                        </form>
                      )}

                      {isRebuildingPort && (
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          background: 'rgba(6, 182, 212, 0.06)',
                          border: '1px solid rgba(6, 182, 212, 0.2)',
                          padding: '12px 14px',
                          borderRadius: 'var(--radius-md)',
                          marginTop: '4px'
                        }}>
                          <style>{`
                            @keyframes rotate-clock {
                              0% { transform: rotate(0deg); }
                              100% { transform: rotate(360deg); }
                            }
                            .clock-hand-anim {
                              animation: rotate-clock 2s linear infinite;
                              transform-origin: 12px 12px;
                            }
                          `}</style>
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="12" x2="12" y2="7" className="clock-hand-anim" />
                            <line x1="12" y1="12" x2="16" y2="12" className="clock-hand-anim" style={{ animationDuration: '8s' }} />
                          </svg>
                          <div style={{ fontSize: '12px', color: 'var(--text-primary)', lineHeight: '1.4' }}>
                            <span style={{ fontWeight: 600, color: 'var(--accent-cyan)', display: 'block' }}>Rebuilding Sandbox Container...</span>
                            Updating environment variables and re-compiling client assets in the background.
                          </div>
                        </div>
                      )}
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
            </>
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
                <th>Type</th>
                <th>Deployed By</th>
                <th>Vulnerabilities</th>
                <th>Preview Port</th>
                <th>Date</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {deployments.length === 0 ? (
                <tr>
                  <td colSpan={10}>
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
                    <td>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '11px',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        padding: '3px 8px',
                        borderRadius: '12px',
                        background: d.deploymentType === 'github' ? 'rgba(255,255,255,0.06)' : 'rgba(59,130,246,0.08)',
                        color: d.deploymentType === 'github' ? 'var(--text-primary)' : 'var(--accent-blue)',
                        border: d.deploymentType === 'github' ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(59,130,246,0.15)',
                      }}>
                        {d.deploymentType === 'github' ? (
                          <>
                            <Github size={11} style={{ filter: 'invert(1)' }} /> GitHub
                          </>
                        ) : (
                          <>
                            <Upload size={11} /> ZIP
                          </>
                        )}
                      </span>
                    </td>
                    <td style={{ fontSize: '12.5px', color: 'var(--text-primary)' }}>
                      {d.deployedBy ? (
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontWeight: 500 }}>
                            {d.deployedBy.firstName} {d.deployedBy.lastName || ''}
                          </span>
                          <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                            {d.deployedBy.role}
                          </span>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>system</span>
                      )}
                    </td>
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

      {/* Floating Bot Chat Widget */}
      <div 
        onClick={() => setIsAgentOpen(!isAgentOpen)}
        style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          width: '56px',
          height: '56px',
          borderRadius: '50%',
          background: 'var(--accent-blue)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          zIndex: 1000,
          border: '2px solid rgba(255,255,255,0.1)',
          transition: 'all 0.3s ease'
        }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.08)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
      >
        <Bot size={24} color="#fff" />
        {showBirdAgent && (
          <div style={{
            position: 'absolute',
            top: '-2px',
            right: '-2px',
            width: '14px',
            height: '14px',
            borderRadius: '50%',
            background: '#ef4444',
            border: '2px solid var(--bg-primary)'
          }} />
        )}
      </div>

      {isAgentOpen && (
        <div style={{
          position: 'fixed',
          bottom: '90px',
          right: '24px',
          width: '380px',
          height: '520px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '12px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 1000,
          overflow: 'hidden'
        }}>
          {/* Header */}
          <div style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'rgba(0,0,0,0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Bot size={16} color="var(--accent-blue)" />
              <span style={{ fontSize: '13.5px', fontWeight: 600 }}>DevOps Workspace Agent</span>
            </div>
            <button 
              onClick={() => setIsAgentOpen(false)}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '18px', fontWeight: 700 }}
            >
              &times;
            </button>
          </div>

          {/* Content panel */}
          {!activeDeploymentId ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', padding: '24px', textAlign: 'center', gap: '10px' }}>
              <Bot size={36} color="var(--border-subtle)" />
              <span style={{ fontSize: '12.5px' }}>Please select a deployment from the dashboard list to start chatting with the DevOps AI Agent.</span>
            </div>
          ) : (
            <FloatingAgentChatPanel 
              deploymentId={activeDeploymentId} 
              jobId={activeJobId} 
              birdMessage={showBirdAgent ? birdMessage : null} 
            />
          )}
        </div>
      )}
    </div>
  );
}

function FloatingAgentChatPanel({ deploymentId, jobId, birdMessage }) {
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState('');
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => {
    if (deploymentId) {
      fetchChats();
    }
  }, [deploymentId]);

  useEffect(() => {
    if (activeChatId) {
      fetchMessages(activeChatId);
    } else {
      setChatMessages([]);
    }
  }, [activeChatId]);

  useEffect(() => {
    if (birdMessage) {
      setChatMessages(prev => {
        const exists = prev.some(m => m.text === birdMessage);
        if (exists) return prev;
        return [...prev, { role: 'agent', text: `✨ [Self-Healing Log]: ${birdMessage}` }];
      });
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  }, [birdMessage]);

  const fetchChats = async () => {
    try {
      const res = await api.get(`/devops/${deploymentId}/agent/chats`);
      setChats(res.data);
      if (res.data.length > 0) {
        setActiveChatId(res.data[0]._id);
      } else {
        handleCreateChat('Default Session');
      }
    } catch (_) {}
  };

  const handleCreateChat = async (title = 'New Session') => {
    try {
      const res = await api.post(`/devops/${deploymentId}/agent/chats`, { title });
      setChats(prev => [res.data, ...prev]);
      setActiveChatId(res.data._id);
    } catch (_) {}
  };

  const fetchMessages = async (chatId) => {
    try {
      const res = await api.get(`/devops/${deploymentId}/agent/chats/${chatId}`);
      setChatMessages(res.data.messages || []);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (_) {}
  };

  const handleSendChat = async () => {
    if (!chatInput.trim() || isAgentTyping) return;
    const text = chatInput;
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text }]);
    setIsAgentTyping(true);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);

    try {
      const res = await api.post(`/devops/${deploymentId}/agent/chat`, { message: text, chatId: activeChatId });
      setChatMessages(prev => [...prev, { role: 'agent', text: res.data.message, pendingAction: res.data.pendingExec ? { commands: res.data.commands } : null }]);
    } catch (err) {
      setChatMessages(prev => [...prev, { role: 'agent', text: `Error: ${err.response?.data?.message || err.message}` }]);
    } finally {
      setIsAgentTyping(false);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  };

  const handlePermissionAllow = async (idx, commands) => {
    setChatMessages(prev => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], pendingAction: null };
      return copy;
    });
    try {
      const res = await api.post(`/devops/${deploymentId}/agent/exec-pending`, { commands, chatId: activeChatId });
      setChatMessages(prev => [...prev, { role: 'agent', text: res.data.message }]);
    } catch (err) {
      setChatMessages(prev => [...prev, { role: 'agent', text: `Execution failed: ${err.message}` }]);
    }
  };

  const handlePermissionNever = (idx) => {
    setChatMessages(prev => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], pendingAction: null };
      return copy;
    });
    setChatMessages(prev => [...prev, { role: 'agent', text: 'Execution rejected by user.' }]);
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Session selector */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', background: 'rgba(0,0,0,0.15)', display: 'flex', gap: '6px', alignItems: 'center' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Session:</span>
        <select
          value={activeChatId}
          onChange={(e) => setActiveChatId(e.target.value)}
          style={{ flex: 1, background: '#1e293b', color: '#fff', border: '1px solid var(--border-subtle)', borderRadius: '4px', fontSize: '11px', padding: '2px 4px', outline: 'none' }}
        >
          {chats.map(chat => (
            <option key={chat._id} value={chat._id}>{chat.title || 'Untitled Thread'}</option>
          ))}
        </select>
        <button
          onClick={() => handleCreateChat(`Session #${chats.length + 1}`)}
          style={{ background: 'var(--accent-blue)', color: '#fff', border: 'none', borderRadius: '4px', padding: '2px 6px', fontSize: '11px', cursor: 'pointer' }}
        >
          + New
        </button>
      </div>

      {/* Messages bubble list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px', background: 'rgba(0,0,0,0.1)' }}>
        {chatMessages.map((msg, idx) => (
          <div 
            key={idx} 
            style={{ 
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              background: msg.role === 'user' ? 'var(--accent-blue)' : 'rgba(255,255,255,0.05)',
              padding: '8px 10px',
              borderRadius: '8px',
              fontSize: '12.5px',
              lineHeight: '1.4',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}
          >
            {(() => {
              if (!msg.text) return null;
              const thoughtRegex = /<(thought|thinking)>([\s\S]*?)<\/\1>/gi;
              const match = thoughtRegex.exec(msg.text);
              if (match) {
                const thoughtContent = match[2].trim();
                const cleanText = msg.text.replace(thoughtRegex, '').trim();
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <details style={{
                      background: 'rgba(0,0,0,0.15)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '4px',
                      padding: '4px 8px',
                      fontSize: '11px'
                    }}>
                      <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontWeight: 500, outline: 'none' }}>
                        Thinking Process...
                      </summary>
                      <div style={{ marginTop: '4px', whiteSpace: 'pre-wrap', color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: '10px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '4px' }}>
                        {thoughtContent}
                      </div>
                    </details>
                    {cleanText && <div style={{ whiteSpace: 'pre-wrap' }}>{cleanText}</div>}
                  </div>
                );
              }
              return <div style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>;
            })()}

            {/* Permission pending command block */}
            {msg.pendingAction && (
              <div style={{
                marginTop: '6px',
                padding: '8px',
                background: 'rgba(0,0,0,0.2)',
                borderRadius: '6px',
                border: '1px solid rgba(234, 179, 8, 0.3)',
                fontSize: '11.5px',
                color: '#fef08a'
              }}>
                <div style={{ fontWeight: 600, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <AlertCircle size={12} color="#facc15" /> Confirm Execution Command
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '6px' }}>
                  {msg.pendingAction.commands.map((cmd, cIdx) => (
                    <div key={cIdx} style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(0,0,0,0.3)', padding: '2px 4px', borderRadius: '4px' }}>
                      <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>$</span>
                      <input
                        type="text"
                        value={cmd}
                        onChange={(e) => {
                          const updatedCmds = [...msg.pendingAction.commands];
                          updatedCmds[cIdx] = e.target.value;
                          setChatMessages(prev => {
                            const copy = [...prev];
                            copy[idx] = {
                              ...copy[idx],
                              pendingAction: { ...copy[idx].pendingAction, commands: updatedCmds }
                            };
                            return copy;
                          });
                        }}
                        style={{ flex: 1, background: 'transparent', color: '#fff', border: 'none', outline: 'none', fontFamily: 'monospace', fontSize: '11px' }}
                      />
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button 
                    onClick={() => handlePermissionAllow(idx, msg.pendingAction.commands)}
                    style={{ background: 'var(--accent-blue)', color: '#fff', border: 'none', padding: '2px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 500, cursor: 'pointer' }}
                  >
                    Allow
                  </button>
                  <button 
                    onClick={() => handlePermissionNever(idx)}
                    style={{ background: '#ef4444', color: '#fff', border: 'none', padding: '2px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 500, cursor: 'pointer' }}
                  >
                    Never
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {isAgentTyping && (
          <div style={{ alignSelf: 'flex-start', color: 'var(--text-muted)', fontSize: '11.5px', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Bot size={12} /> DevOps Agent is writing...
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Chat input form */}
      <div style={{ padding: '8px', borderTop: '1px solid var(--border-subtle)', background: 'rgba(0,0,0,0.15)', display: 'flex', gap: '6px' }}>
        <textarea
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          placeholder="Ask agent to check file or fix errors..."
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSendChat();
            }
          }}
          rows={2}
          style={{ flex: 1, background: '#fff', color: 'black', border: '1px solid var(--border-subtle)', borderRadius: '4px', padding: '6px 8px', fontSize: '12px', outline: 'none', resize: 'none', fontFamily: 'inherit', lineHeight: '1.3' }}
        />
        <button
          onClick={handleSendChat}
          disabled={isAgentTyping}
          style={{ background: 'var(--accent-blue)', color: '#fff', border: 'none', borderRadius: '4px', width: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        >
          <Send size={12} />
        </button>
      </div>
    </div>
  );
}

export default DevOps;