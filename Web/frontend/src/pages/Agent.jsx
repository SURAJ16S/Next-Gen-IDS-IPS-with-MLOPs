import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { marked } from 'marked';
import { 
  getDeployments, 
  getWorkspaceFiles, 
  getWorkspaceFileContent, 
  saveWorkspaceFile, 
  getDbCollections, 
  getDbCollectionData, 
  insertDbRecord, 
  updateDbRecord,
  deleteDbRecord,
  executeAgentChat,
  rollbackAgentPatches,
  undoChatMessages,
  updateAgentPermission,
  startDeploymentPreview,
  executePendingCommands,
  getChatsList,
  createChatThread,
  getChatMessages,
  executeDeploymentDbQuery
} from '../services/api';
import { 
  Folder, File, Database, Play, Save, Send, Bot, RefreshCw, Plus, Eye,
  Terminal, ShieldCheck, Code, ListFilter, AlertCircle, Trash2, RotateCcw, GripVertical, Scissors, Copy, FolderOpen, Pencil,
  LayoutDashboard, ShieldAlert, Network, BarChart3, FileText, Server, Settings, Cpu,
  Coffee, Hash, Globe, Braces
} from 'lucide-react';
import Editor from '@monaco-editor/react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { io } from 'socket.io-client';

const getLanguageFromPath = (filePath) => {
  if (!filePath) return 'javascript';
  const ext = filePath.split('.').pop().toLowerCase();
  switch (ext) {
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'py':
      return 'python';
    case 'json':
      return 'json';
    case 'html':
      return 'html';
    case 'css':
      return 'css';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'md':
      return 'markdown';
    default:
      return 'text';
  }
};

const registerMonacoThemes = (monaco) => {
  const themes = {
    abyss: {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#001224',
        'editor.foreground': '#88aacc',
      }
    },
    'tokyo-night': {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#16161e',
        'editor.foreground': '#a9b1d6',
      }
    },
    'solarized-dark': {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#073642',
        'editor.foreground': '#839496',
      }
    },
    'solarized-light': {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#eee8d5',
        'editor.foreground': '#657b83',
      }
    },
    synthwave84: {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#241b2f',
        'editor.foreground': '#f0efe7',
      }
    },
    monokai: {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#1e1f1c',
        'editor.foreground': '#f8f8f2',
      }
    },
    'powershell-ise': {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0000a0',
        'editor.foreground': '#ffffff',
      }
    },
    'quiet-light': {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#333333',
      }
    },
    red: {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#2a0000',
        'editor.foreground': '#ffcccc',
      }
    }
  };

  Object.entries(themes).forEach(([name, data]) => {
    monaco.editor.defineTheme(name, data);
  });
};

function getFileIcon(name, isDir) {
  if (isDir) {
    return <Folder size={14} color="#eab308" style={{ flexShrink: 0 }} />;
  }
  
  const lowerName = name.toLowerCase();
  
  // Specific file names check
  if (lowerName === 'dockerfile' || lowerName.startsWith('dockerfile.')) {
    return <Server size={14} color="#0db7ed" style={{ flexShrink: 0 }} />;
  }
  if (lowerName === 'pom.xml') {
    return <Cpu size={14} color="#e24a1f" style={{ flexShrink: 0 }} />;
  }
  if (lowerName === '.env' || lowerName.endsWith('.env') || lowerName.startsWith('.env.')) {
    return <Settings size={14} color="#eab308" style={{ flexShrink: 0 }} />;
  }
  if (lowerName === '.gitignore' || lowerName === '.gitattributes') {
    return <ShieldAlert size={14} color="#f87171" style={{ flexShrink: 0 }} />;
  }
  if (lowerName === 'package.json') {
    return <Braces size={14} color="#22c55e" style={{ flexShrink: 0 }} />;
  }

  const ext = name.split('.').pop().toLowerCase();
  switch (ext) {
    case 'js':
    case 'jsx':
      return <Code size={14} color="#f59e0b" style={{ flexShrink: 0 }} />;
    case 'ts':
    case 'tsx':
      return <Code size={14} color="#3b82f6" style={{ flexShrink: 0 }} />;
    case 'json':
      return <Braces size={14} color="#a8a29e" style={{ flexShrink: 0 }} />;
    case 'java':
      return <Coffee size={14} color="#ef4444" style={{ flexShrink: 0 }} />;
    case 'css':
      return <Hash size={14} color="#06b6d4" style={{ flexShrink: 0 }} />;
    case 'html':
      return <Globe size={14} color="#f97316" style={{ flexShrink: 0 }} />;
    case 'md':
    case 'markdown':
      return <FileText size={14} color="#6366f1" style={{ flexShrink: 0 }} />;
    case 'yml':
    case 'yaml':
      return <ListFilter size={14} color="#ec4899" style={{ flexShrink: 0 }} />;
    case 'tf':
    case 'tfvars':
      return <Network size={14} color="#845ef7" style={{ flexShrink: 0 }} />;
    case 'sql':
      return <Database size={14} color="#33b1ff" style={{ flexShrink: 0 }} />;
    case 'xml':
      return <Code size={14} color="#a855f7" style={{ flexShrink: 0 }} />;
    case 'properties':
    case 'ini':
    case 'conf':
    case 'config':
      return <Settings size={14} color="#64748b" style={{ flexShrink: 0 }} />;
    default:
      return <File size={14} color="#94a3b8" style={{ flexShrink: 0 }} />;
  }
}


function cleanTerminalAnsi(text) {
  if (typeof text !== 'string') return '';
  // Strip ANSI escape codes
  let cleaned = text.replace(/[\u001b\u009b]\[[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
  // Remove non-printable control characters, preserving newlines and tabs
  cleaned = cleaned.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  // Clean carriage returns
  cleaned = cleaned.replace(/\r/g, '');
  return cleaned;
}

function TerminalView({ jobId, filesTree = [], deployments = [], dbCollections = [], selectedDep = null, fontSize = 13, themeStyles = {} }) {
  const [terminalsList, setTerminalsList] = useState([
    {
      id: 1,
      name: 'Terminal 1',
      logs: [
        { type: 'sys', text: 'Welcome to Sandboxed Terminal 1' },
        { type: 'sys', text: 'Type "help" to view all available commands.' },
        { type: 'sys', text: '' }
      ]
    }
  ]);
  const [activeTerminalId, setActiveTerminalId] = useState(1);
  const [terminalInputVal, setTerminalInputVal] = useState('');
  const [inputFlash, setInputFlash] = useState(false);
  const terminalEndRef = useRef(null);
  const inputRef = useRef(null);
  const socketRef = useRef(null);

  const handleAddTerminal = () => {
    const nextId = terminalsList.length > 0 ? Math.max(...terminalsList.map(t => t.id)) + 1 : 1;
    const newTerm = {
      id: nextId,
      name: `Terminal ${nextId}`,
      logs: [
        { type: 'sys', text: `Welcome to Sandboxed Terminal ${nextId}` },
        { type: 'sys', text: 'Type "help" to view all available commands.' },
        { type: 'sys', text: '' }
      ]
    };
    setTerminalsList(prev => [...prev, newTerm]);
    setActiveTerminalId(nextId);
  };

  const handleCloseTerminal = (id, e) => {
    e.stopPropagation();
    if (terminalsList.length === 1) return;
    const remaining = terminalsList.filter(t => t.id !== id);
    setTerminalsList(remaining);
    if (activeTerminalId === id) {
      setActiveTerminalId(remaining[0].id);
    }
  };

  useEffect(() => {
    if (!jobId) return;

    const socket = io('http://localhost:5000');
    socketRef.current = socket;

    socket.on('connect', () => {
      setTerminalsList(prev => prev.map(t => {
        if (t.id === activeTerminalId) {
          return {
            ...t,
            logs: [...t.logs, { type: 'sys', text: '*** Connected to container shell stream ***' }]
          };
        }
        return t;
      }));
      socket.emit('terminal:init', { jobId });
      socket.emit('subscribe:pipeline', { jobId });
    });

    socket.on('terminal:data', (data) => {
      setTerminalsList(prev => prev.map(t => {
        if (t.id === activeTerminalId) {
          return {
            ...t,
            logs: [...t.logs, { type: 'res', text: cleanTerminalAnsi(data) }]
          };
        }
        return t;
      }));
    });

    socket.on('pipeline:log', ({ log }) => {
      setTerminalsList(prev => prev.map(t => {
        if (t.id === activeTerminalId) {
          return {
            ...t,
            logs: [...t.logs, { type: 'sys', text: cleanTerminalAnsi(log) }]
          };
        }
        return t;
      }));
    });

    return () => {
      socket.emit('unsubscribe:pipeline', { jobId });
      socket.disconnect();
    };
  }, [jobId, activeTerminalId]);

  const handleTerminalCommand = (e) => {
    if (e.key !== 'Enter') return;
    const cmd = terminalInputVal.trim();
    if (!cmd) return;

    setTerminalsList(prev => prev.map(t => {
      if (t.id === activeTerminalId) {
        return {
          ...t,
          logs: [...t.logs, { type: 'cmd', text: `user@sandbox:~$ ${cmd}` }]
        };
      }
      return t;
    }));
    setTerminalInputVal('');

    const lower = cmd.toLowerCase();

    if (lower === 'help') {
      const response = 'Available sandboxed commands:\n  help        - Display this menu\n  clear       - Clear terminal window\n  ls          - List workspace files locally\n  pwd         - Print local sandbox path\n  date        - Print sandbox time\n  whoami      - Print active session user\n  techstack   - Show tech stack info\n  workspace   - Display project stats\n\n* Or type any bash command to run it live in the preview container!';
      setTimeout(() => {
        setTerminalsList(prev => prev.map(t => {
          if (t.id === activeTerminalId) {
            return { ...t, logs: [...t.logs, { type: 'res', text: response }] };
          }
          return t;
        }));
      }, 50);
      return;
    }

    if (lower === 'clear') {
      setTerminalsList(prev => prev.map(t => {
        if (t.id === activeTerminalId) {
          return { ...t, logs: [] };
        }
        return t;
      }));
      return;
    }

    if (lower === 'ls') {
      const response = filesTree.map(f => f.name + (f.isDir ? '/' : '')).join('\n') || '(empty)';
      setTimeout(() => {
        setTerminalsList(prev => prev.map(t => {
          if (t.id === activeTerminalId) {
            return { ...t, logs: [...t.logs, { type: 'res', text: response }] };
          }
          return t;
        }));
      }, 50);
      return;
    }

    if (lower === 'pwd') {
      const response = `/workspace/${selectedDep?.projectName || 'sandbox'}`;
      setTimeout(() => {
        setTerminalsList(prev => prev.map(t => {
          if (t.id === activeTerminalId) {
            return { ...t, logs: [...t.logs, { type: 'res', text: response }] };
          }
          return t;
        }));
      }, 50);
      return;
    }

    if (lower === 'date') {
      const response = new Date().toString();
      setTimeout(() => {
        setTerminalsList(prev => prev.map(t => {
          if (t.id === activeTerminalId) {
            return { ...t, logs: [...t.logs, { type: 'res', text: response }] };
          }
          return t;
        }));
      }, 50);
      return;
    }

    if (lower === 'whoami') {
      const response = 'sandbox-dev-developer';
      setTimeout(() => {
        setTerminalsList(prev => prev.map(t => {
          if (t.id === activeTerminalId) {
            return { ...t, logs: [...t.logs, { type: 'res', text: response }] };
          }
          return t;
        }));
      }, 50);
      return;
    }

    if (lower === 'techstack') {
      const response = `Detected Tech Stack: ${selectedDep?.techStackDetected || 'MERN'}\nDatabase type: ${selectedDep?.dbInitType || 'mongodb'}`;
      setTimeout(() => {
        setTerminalsList(prev => prev.map(t => {
          if (t.id === activeTerminalId) {
            return { ...t, logs: [...t.logs, { type: 'res', text: response }] };
          }
          return t;
        }));
      }, 50);
      return;
    }

    if (lower === 'workspace') {
      const response = `Workspace Status:\n  Total deployments: ${deployments.length}\n  Current project: ${selectedDep?.projectName}\n  Database collections: ${dbCollections.join(', ') || 'none'}`;
      setTimeout(() => {
        setTerminalsList(prev => prev.map(t => {
          if (t.id === activeTerminalId) {
            return { ...t, logs: [...t.logs, { type: 'res', text: response }] };
          }
          return t;
        }));
      }, 50);
      return;
    }

    // Run live command inside container
    if (socketRef.current) {
      socketRef.current.emit('terminal:input', cmd + '\n');
    }
  };

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [terminalsList, activeTerminalId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, background: '#0d1117', fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace', fontSize: `${fontSize}px`, color: '#e2e8f0', minHeight: 0, height: '100%', borderRadius: '6px', overflow: 'hidden', border: themeStyles.border ? `1px solid ${themeStyles.border}` : 'none' }}>
      {/* Terminal Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', background: '#161b22', borderBottom: '1px solid #30363d', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, overflowX: 'auto' }}>
          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ff5f56', flexShrink: 0 }} />
          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ffbd2e', flexShrink: 0 }} />
          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#27c93f', flexShrink: 0 }} />
          
          <div style={{ display: 'flex', gap: '4px', marginLeft: '12px', overflowX: 'auto', flex: 1 }}>
            {terminalsList.map(t => {
              const isActive = t.id === activeTerminalId;
              return (
                <div
                  key={t.id}
                  onClick={() => setActiveTerminalId(t.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    background: isActive ? '#0d1117' : 'transparent',
                    border: '1px solid',
                    borderColor: isActive ? '#30363d' : 'transparent',
                    borderRadius: '4px 4px 0 0',
                    padding: '2px 10px',
                    fontSize: '11px',
                    color: isActive ? '#58a6ff' : '#8b949e',
                    cursor: 'pointer',
                    height: '24px',
                    whiteSpace: 'nowrap'
                  }}
                >
                  <span>{t.name}</span>
                  {terminalsList.length > 1 && (
                    <span
                      onClick={(e) => handleCloseTerminal(t.id, e)}
                      style={{
                        fontSize: '10px',
                        color: '#8b949e',
                        borderRadius: '50%',
                        width: '12px',
                        height: '12px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                      onMouseEnter={ev => { ev.currentTarget.style.background = '#30363d'; ev.currentTarget.style.color = '#f0f6fc'; }}
                      onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent'; ev.currentTarget.style.color = '#8b949e'; }}
                    >
                      ×
                    </span>
                  )}
                </div>
              );
            })}
            <button
              onClick={handleAddTerminal}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#8b949e',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '14px',
                fontWeight: 600,
                padding: '0 8px',
                height: '24px'
              }}
              onMouseEnter={ev => ev.currentTarget.style.color = '#f0f6fc'}
              onMouseLeave={ev => ev.currentTarget.style.color = '#8b949e'}
              title="New Terminal"
            >
              +
            </button>
          </div>
        </div>
        <button
          onClick={() => {
            setTerminalsList(prev => prev.map(t => {
              if (t.id === activeTerminalId) {
                return { ...t, logs: [{ type: 'sys', text: 'Terminal cleared.' }] };
              }
              return t;
            }));
          }}
          style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: '11px', padding: '2px 6px' }}
          title="Clear terminal"
        >
          clear
        </button>
      </div>
      {/* Terminal Log Output */}
      <div 
        onClick={() => {
          inputRef.current?.focus();
          setInputFlash(true);
          setTimeout(() => setInputFlash(false), 800);
        }}
        style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '2px', minHeight: 0, cursor: 'text' }}
      >
        {(terminalsList.find(t => t.id === activeTerminalId)?.logs || []).map((log, i) => (
          <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: '1.5', fontSize: `${fontSize}px`, color: log.type === 'cmd' ? '#79c0ff' : log.type === 'sys' ? '#8b949e' : '#e2e8f0' }}>
            {log.text}
          </div>
        ))}
        <div ref={terminalEndRef} />
      </div>
      {/* Terminal Input Row */}
      <div 
        style={{ 
          display: 'flex', 
          alignItems: 'center', 
          padding: '6px 14px', 
          borderTop: '1px solid',
          borderColor: inputFlash ? '#22c55e' : '#30363d',
          background: '#161b22', 
          flexShrink: 0, 
          gap: '6px',
          boxShadow: inputFlash ? '0 0 12px rgba(34, 197, 94, 0.25)' : 'none',
          transition: 'border-color 0.4s ease, box-shadow 0.4s ease'
        }}
      >
        <span style={{ color: '#22c55e', fontWeight: 700, userSelect: 'none', fontSize: `${fontSize}px` }}>user@sandbox:~$</span>
        <input
          ref={inputRef}
          value={terminalInputVal}
          onChange={e => setTerminalInputVal(e.target.value)}
          onKeyDown={handleTerminalCommand}
          placeholder="type a command and press enter..."
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#f0f6fc', fontSize: `${fontSize}px`, fontFamily: 'inherit', caretColor: '#22c55e' }}
        />
      </div>
    </div>
  );
}

function DbTerminalView({ selectedId, dbType = 'mongodb', deployments = [], fontSize = 13, themeStyles = {} }) {
  const [terminalsList, setTerminalsList] = useState([
    {
      id: 1,
      name: 'Session 1',
      logs: [
        { type: 'sys', text: `Welcome to Interactive Database Shell (${dbType.toUpperCase()})` },
        { type: 'sys', text: 'Type a query or command and press Enter.' },
        { type: 'sys', text: '' }
      ]
    }
  ]);
  const [activeTerminalId, setActiveTerminalId] = useState(1);
  const [terminalInputVal, setTerminalInputVal] = useState('');
  const [inputFlash, setInputFlash] = useState(false);
  const terminalEndRef = useRef(null);
  const inputRef = useRef(null);

  const handleAddTerminal = () => {
    const nextId = terminalsList.length > 0 ? Math.max(...terminalsList.map(t => t.id)) + 1 : 1;
    const newTerm = {
      id: nextId,
      name: `Session ${nextId}`,
      logs: [
        { type: 'sys', text: `Welcome to Database Shell Session ${nextId}` },
        { type: 'sys', text: 'Type a query or command and press Enter.' },
        { type: 'sys', text: '' }
      ]
    };
    setTerminalsList(prev => [...prev, newTerm]);
    setActiveTerminalId(nextId);
  };

  const handleCloseTerminal = (id, e) => {
    e.stopPropagation();
    if (terminalsList.length === 1) return;
    const remaining = terminalsList.filter(t => t.id !== id);
    setTerminalsList(remaining);
    if (activeTerminalId === id) {
      setActiveTerminalId(remaining[0].id);
    }
  };

  const handleTerminalCommand = async (e) => {
    if (e.key !== 'Enter') return;
    const cmd = terminalInputVal.trim();
    if (!cmd) return;

    const isSql = ['postgres', 'mysql', 'mariadb', 'sqlite', 'mssql', 'oracle'].includes(dbType);
    const dbPrompt = isSql ? 'postgres=#' : 'mongodb>';

    setTerminalsList(prev => prev.map(t => {
      if (t.id === activeTerminalId) {
        return {
          ...t,
          logs: [...t.logs, { type: 'cmd', text: `${dbPrompt} ${cmd}` }]
        };
      }
      return t;
    }));
    setTerminalInputVal('');

    const lower = cmd.toLowerCase();
    if (lower === 'clear') {
      setTerminalsList(prev => prev.map(t => {
        if (t.id === activeTerminalId) {
          return { ...t, logs: [] };
        }
        return t;
      }));
      return;
    }

    try {
      const res = await executeDeploymentDbQuery(selectedId, cmd, dbType);
      const output = res.data.output || '(Query successfully completed with empty output.)';
      setTerminalsList(prev => prev.map(t => {
        if (t.id === activeTerminalId) {
          return {
            ...t,
            logs: [...t.logs, { type: 'res', text: cleanTerminalAnsi(output) }]
          };
        }
        return t;
      }));
    } catch (err) {
      const errMsg = `Error: ${err.response?.data?.message || err.message}`;
      setTerminalsList(prev => prev.map(t => {
        if (t.id === activeTerminalId) {
          return {
            ...t,
            logs: [...t.logs, { type: 'sys', text: cleanTerminalAnsi(errMsg) }]
          };
        }
        return t;
      }));
    }
  };

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [terminalsList, activeTerminalId]);

  const isSql = ['postgres', 'mysql', 'mariadb', 'sqlite', 'mssql', 'oracle'].includes(dbType);
  const dbPrompt = isSql ? 'postgres=#' : 'mongodb>';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, background: '#0d1117', fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace', fontSize: `${fontSize}px`, color: '#e2e8f0', minHeight: 0, height: '100%', borderRadius: '6px', overflow: 'hidden', border: themeStyles.border ? `1px solid ${themeStyles.border}` : 'none' }}>
      {/* Terminal Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', background: '#161b22', borderBottom: '1px solid #30363d', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, overflowX: 'auto' }}>
          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ff5f56', flexShrink: 0 }} />
          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ffbd2e', flexShrink: 0 }} />
          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#27c93f', flexShrink: 0 }} />
          
          <div style={{ display: 'flex', gap: '4px', marginLeft: '12px', overflowX: 'auto', flex: 1 }}>
            {terminalsList.map(t => {
              const isActive = t.id === activeTerminalId;
              return (
                <div
                  key={t.id}
                  onClick={() => setActiveTerminalId(t.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    background: isActive ? '#0d1117' : 'transparent',
                    border: '1px solid',
                    borderColor: isActive ? '#30363d' : 'transparent',
                    borderRadius: '4px 4px 0 0',
                    padding: '2px 10px',
                    fontSize: '11px',
                    color: isActive ? '#58a6ff' : '#8b949e',
                    cursor: 'pointer',
                    height: '24px',
                    whiteSpace: 'nowrap'
                  }}
                >
                  <span>{t.name}</span>
                  {terminalsList.length > 1 && (
                    <span
                      onClick={(e) => handleCloseTerminal(t.id, e)}
                      style={{
                        fontSize: '10px',
                        color: '#8b949e',
                        borderRadius: '50%',
                        width: '12px',
                        height: '12px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                      onMouseEnter={ev => { ev.currentTarget.style.background = '#30363d'; ev.currentTarget.style.color = '#f0f6fc'; }}
                      onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent'; ev.currentTarget.style.color = '#8b949e'; }}
                    >
                      ×
                    </span>
                  )}
                </div>
              );
            })}
            <button
              onClick={handleAddTerminal}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#8b949e',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '14px',
                fontWeight: 600,
                padding: '0 8px',
                height: '24px'
              }}
              onMouseEnter={ev => ev.currentTarget.style.color = '#f0f6fc'}
              onMouseLeave={ev => ev.currentTarget.style.color = '#8b949e'}
              title="New Session"
            >
              +
            </button>
          </div>
        </div>
        <button
          onClick={() => {
            setTerminalsList(prev => prev.map(t => {
              if (t.id === activeTerminalId) {
                return { ...t, logs: [{ type: 'sys', text: 'Terminal cleared.' }] };
              }
              return t;
            }));
          }}
          style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: '11px', padding: '2px 6px' }}
          title="Clear terminal"
        >
          clear
        </button>
      </div>
      {/* Terminal Log Output */}
      <div 
        onClick={() => {
          inputRef.current?.focus();
          setInputFlash(true);
          setTimeout(() => setInputFlash(false), 800);
        }}
        style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '2px', minHeight: 0, cursor: 'text' }}
      >
        {(terminalsList.find(t => t.id === activeTerminalId)?.logs || []).map((log, i) => (
          <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: '1.5', fontSize: `${fontSize}px`, color: log.type === 'cmd' ? '#79c0ff' : log.type === 'sys' ? '#8b949e' : '#e2e8f0' }}>
            {log.text}
          </div>
        ))}
        <div ref={terminalEndRef} />
      </div>
      {/* Terminal Input Row */}
      <div 
        style={{ 
          display: 'flex', 
          alignItems: 'center', 
          padding: '6px 14px', 
          borderTop: '1px solid',
          borderColor: inputFlash ? '#22c55e' : '#30363d',
          background: '#161b22', 
          flexShrink: 0, 
          gap: '6px',
          boxShadow: inputFlash ? '0 0 12px rgba(34, 197, 94, 0.25)' : 'none',
          transition: 'border-color 0.4s ease, box-shadow 0.4s ease'
        }}
      >
        <span style={{ color: '#22c55e', fontWeight: 700, userSelect: 'none', fontSize: `${fontSize}px` }}>{dbPrompt}</span>
        <input
          ref={inputRef}
          value={terminalInputVal}
          onChange={e => setTerminalInputVal(e.target.value)}
          onKeyDown={handleTerminalCommand}
          placeholder="type a database query and press enter..."
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#f0f6fc', fontSize: `${fontSize}px`, fontFamily: 'inherit', caretColor: '#22c55e' }}
        />
      </div>
    </div>
  );
}


// ─── Flatten nested file tree to a flat list for Ctrl+P search ───────────────
function flattenTree(nodes, result = []) {
  if (!Array.isArray(nodes)) return result;
  for (const node of nodes) {
    if (!node.isDir) result.push(node);
    if (node.isDir && node.children) flattenTree(node.children, result);
  }
  return result;
}

// ─── Command Palette (Ctrl+P) ─────────────────────────────────────────────────
function CommandPalette({ files, onOpen, onClose }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const lower = q.toLowerCase();
  const filtered = q ? files.filter(f => f.path.toLowerCase().includes(lower) || f.name.toLowerCase().includes(lower)) : files.slice(0, 30);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '80px' }} onClick={onClose}>
      <div style={{ background: '#1e2330', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '12px', width: '540px', boxShadow: '0 24px 64px rgba(0,0,0,0.8)', overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: '420px' }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <File size={15} color="#6b7280" />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search files by name or path..."
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#f3f4f6', fontSize: '14px', fontFamily: 'inherit' }}
          />
          <span style={{ fontSize: '11px', color: '#4b5563', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer' }} onClick={onClose}>Esc</span>
        </div>
        <div style={{ overflowY: 'auto' }}>
          {filtered.length === 0 && <div style={{ padding: '20px', textAlign: 'center', color: '#6b7280', fontSize: '13px' }}>No files found</div>}
          {filtered.map((f, i) => {
            const parts = f.path.split(/[\/\\]/);
            const name = parts.pop();
            const dir = parts.join('/') || '.';
            return (
              <div key={i} onClick={() => { onOpen(f.path); onClose(); }}
                style={{ padding: '9px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(59,130,246,0.12)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <File size={13} color="#6b7280" style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: '#f3f4f6', fontSize: '13px', fontWeight: 500 }}>{name}</div>
                  <div style={{ color: '#6b7280', fontSize: '11px', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dir}</div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ padding: '8px 16px', borderTop: '1px solid rgba(255,255,255,0.07)', display: 'flex', gap: '16px' }}>
          <span style={{ fontSize: '11px', color: '#4b5563' }}><kbd style={{ background: 'rgba(255,255,255,0.06)', borderRadius: '3px', padding: '1px 5px' }}>↵</kbd> open</span>
          <span style={{ fontSize: '11px', color: '#4b5563' }}><kbd style={{ background: 'rgba(255,255,255,0.06)', borderRadius: '3px', padding: '1px 5px' }}>Esc</kbd> close</span>
          <span style={{ fontSize: '11px', color: '#4b5563' }}>{filtered.length} file{filtered.length !== 1 ? 's' : ''} matched</span>
        </div>
      </div>
    </div>
  );
}

// ─── In-File Search Bar (Ctrl+F fallback for preview/non-editor views) ─────────
function InFileSearchBar({ content, onClose }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const lower = q.toLowerCase();
  const matches = q ? [...content.matchAll(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'))] : [];
  const count = matches.length;

  const highlight = (text) => {
    if (!q) return text;
    const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.split(regex).map((part, i) =>
      regex.test(part) ? <mark key={i} style={{ background: '#facc15', color: '#000', borderRadius: '2px' }}>{part}</mark> : part
    );
  };

  // Show lines that match
  const matchedLines = q ? content.split('\n').filter(l => l.toLowerCase().includes(lower)) : [];

  return (
    <div style={{ position: 'absolute', top: '48px', right: '16px', zIndex: 1000, background: '#1e2330', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)', width: '340px', overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Find in file..." style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#f3f4f6', fontSize: '13px' }} />
        {q && <span style={{ fontSize: '12px', color: count ? '#6ee7b7' : '#f87171', minWidth: '50px', textAlign: 'right' }}>{count} match{count !== 1 ? 'es' : ''}</span>}
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: '2px 4px', fontSize: '14px' }}>✕</button>
      </div>
      {matchedLines.length > 0 && (
        <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
          {matchedLines.slice(0, 20).map((line, i) => (
            <div key={i} style={{ padding: '5px 12px', fontSize: '12px', fontFamily: 'monospace', borderBottom: '1px solid rgba(255,255,255,0.04)', color: '#d1d5db', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {highlight(line)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function FileContextMenu({ x, y, node, onClose, onSelectFile, onPreview, onOpenSide, onCopyPath, onCopyRelPath, onCut, onCopy, onRename, onDelete }) {
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(node.name);
  const isFile = !node.isDir;
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleKey);
    return () => { window.removeEventListener('mousedown', handleClick); window.removeEventListener('keydown', handleKey); };
  }, [onClose]);

  const menuStyle = { position: 'fixed', top: y, left: x, zIndex: 9999, background: '#1e2330', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', boxShadow: '0 8px 32px rgba(0,0,0,0.6)', minWidth: '220px', padding: '4px 0', fontSize: '13px', userSelect: 'none' };
  const itemStyle = (danger) => ({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '7px 14px', cursor: 'pointer', color: danger ? '#f87171' : '#d1d5db', transition: 'background 0.1s' });
  const shortcutStyle = { fontSize: '11px', color: '#6b7280', fontFamily: 'monospace' };
  const dividerStyle = { height: '1px', background: 'rgba(255,255,255,0.07)', margin: '3px 0' };

  const Item = ({ icon: Icon, label, shortcut, onClick, danger, disabled }) => (
    <div
      style={{ ...itemStyle(danger), opacity: disabled ? 0.38 : 1, pointerEvents: disabled ? 'none' : 'auto' }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = danger ? 'rgba(248,81,73,0.1)' : 'rgba(255,255,255,0.06)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
      onClick={() => { if (!disabled) { onClick(); onClose(); } }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
        {Icon && <Icon size={14} />}{label}
      </span>
      {shortcut && <span style={shortcutStyle}>{shortcut}</span>}
    </div>
  );

  return (
    <div ref={menuRef} style={menuStyle}>
      {isFile && (
        <>
          <Item icon={Code} label="Open File" onClick={() => onSelectFile(node.path)} />
          {isMarkdown && <Item icon={Eye} label="Open Preview" shortcut="Ctrl+Shift+V" onClick={() => onPreview(node.path)} />}
          <Item icon={FolderOpen} label="Open to the Side" shortcut="Ctrl+Enter" onClick={() => onOpenSide(node.path)} />
          <div style={dividerStyle} />
        </>
      )}
      <Item icon={Pencil} label="Rename..." onClick={() => onRename(node)} />
      <Item icon={Copy} label="Copy Path" onClick={() => onCopyPath(node.path)} />
      <Item icon={Copy} label="Copy Relative Path" onClick={() => onCopyRelPath(node.path)} />
      <div style={dividerStyle} />
      <Item icon={Scissors} label="Cut" shortcut="Ctrl+X" onClick={() => onCut(node)} />
      <Item icon={Copy} label="Copy" shortcut="Ctrl+C" onClick={() => onCopy(node)} />
      <div style={dividerStyle} />
      <Item icon={Trash2} label="Delete" danger onClick={() => onDelete(node)} />
    </div>
  );
}

function TabContextMenu({ x, y, tab, pane, openTabs, activeTabPath, rightActiveTabPath, onClose, onCloseTab, setOpenTabs, setActiveTabPath, setRightActiveTabPath, setIsSplitView, onCopyPath, onCopyRelPath, filesTree, handleSelectFile }) {
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleKey);
    return () => { window.removeEventListener('mousedown', handleClick); window.removeEventListener('keydown', handleKey); };
  }, [onClose]);

  const menuStyle = { position: 'fixed', top: y, left: x, zIndex: 99999, background: '#1e2330', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', boxShadow: '0 8px 32px rgba(0,0,0,0.6)', minWidth: '220px', padding: '4px 0', fontSize: '13px', userSelect: 'none' };
  const itemStyle = (danger) => ({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '7px 14px', cursor: 'pointer', color: danger ? '#f87171' : '#d1d5db', transition: 'background 0.1s' });
  const shortcutStyle = { fontSize: '11px', color: '#6b7280', fontFamily: 'monospace' };
  const dividerStyle = { height: '1px', background: 'rgba(255,255,255,0.07)', margin: '3px 0' };

  const Item = ({ icon: Icon, label, shortcut, onClick, danger }) => (
    <div
      style={itemStyle(danger)}
      onMouseEnter={e => { e.currentTarget.style.background = danger ? 'rgba(248,81,73,0.1)' : 'rgba(255,255,255,0.06)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
      onClick={() => { onClick(); onClose(); }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
        {Icon && <Icon size={14} />}{label}
      </span>
      {shortcut && <span style={shortcutStyle}>{shortcut}</span>}
    </div>
  );

  const handleClose = () => {
    onCloseTab({ stopPropagation: () => {} }, tab.path);
  };

  const handleCloseOthers = () => {
    const remaining = openTabs.filter(t => t.path === tab.path);
    setOpenTabs(remaining);
    if (pane === 'left') {
      setActiveTabPath(tab.path);
    } else {
      setRightActiveTabPath(tab.path);
    }
  };

  const handleCloseToRight = () => {
    const idx = openTabs.findIndex(t => t.path === tab.path);
    if (idx !== -1) {
      const remaining = openTabs.slice(0, idx + 1);
      setOpenTabs(remaining);
      // Ensure active tab is valid
      const curActive = pane === 'left' ? activeTabPath : rightActiveTabPath;
      const remainsActive = remaining.some(t => t.path === curActive);
      if (!remainsActive) {
        if (pane === 'left') setActiveTabPath(tab.path);
        else setRightActiveTabPath(tab.path);
      }
    }
  };

  const handleCloseAll = () => {
    setOpenTabs([]);
    setActiveTabPath(null);
    setRightActiveTabPath(null);
  };

  const handleRevealInExplorer = () => {
    // If it's a file, let's select it in the explorer to trigger selection highlights
    if (!tab.path.startsWith('db:')) {
      handleSelectFile(tab.path);
    }
  };

  const handleSplitRight = () => {
    if (!tab.path.startsWith('db:')) {
      setIsSplitView(true);
      setRightActiveTabPath(tab.path);
    }
  };

  return (
    <div ref={menuRef} style={menuStyle}>
      <Item icon={Trash2} label="Close" shortcut="Ctrl+F4" onClick={handleClose} />
      <Item icon={Trash2} label="Close Others" onClick={handleCloseOthers} />
      <Item icon={Trash2} label="Close to the Right" onClick={handleCloseToRight} />
      <Item icon={Trash2} label="Close Saved" shortcut="Ctrl+K U" onClick={handleCloseOthers} />
      <Item icon={Trash2} label="Close All" shortcut="Ctrl+K W" onClick={handleCloseAll} />
      <div style={dividerStyle} />
      <Item icon={Copy} label="Copy Path" shortcut="Shift+Alt+C" onClick={() => onCopyPath(tab.path)} />
      <Item icon={Copy} label="Copy Relative Path" shortcut="Ctrl+K C" onClick={() => onCopyRelPath(tab.path)} />
      <div style={dividerStyle} />
      <Item icon={FolderOpen} label="Reveal in Explorer" shortcut="Shift+Alt+R" onClick={handleRevealInExplorer} />
      <div style={dividerStyle} />
      <Item icon={Eye} label="Split Right" shortcut="Ctrl+\\" onClick={handleSplitRight} />
    </div>
  );
}

function IDESettingsPanel({
  isOpen,
  onClose,
  themeStyles,
  ideTheme,
  setIdeTheme,
  editorFontSize,
  setEditorFontSize,
  editorLineHeight,
  setEditorLineHeight,
  editorFontFamily,
  setEditorFontFamily,
  editorMinimap,
  setEditorMinimap,
  editorWordWrap,
  setEditorWordWrap,
  editorTabSize,
  setEditorTabSize,
  autoSaveEnabled,
  setAutoSaveEnabled,
  terminalFontSize,
  setTerminalFontSize,
  agentSecurityMode,
  setAgentSecurityMode,
  terminalAutoExecution,
  setTerminalAutoExecution,
  enableShellIntegration,
  setEnableShellIntegration
}) {
  const [settingsTab, setSettingsTab] = useState('IDE');

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      width: '320px',
      background: themeStyles.bgPanel,
      borderLeft: `1px solid ${themeStyles.border}`,
      boxShadow: '-4px 0 24px rgba(0,0,0,0.3)',
      zIndex: 99999,
      display: 'flex',
      flexDirection: 'column',
      color: themeStyles.text,
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      <div style={{
        padding: '14px 16px',
        borderBottom: `1px solid ${themeStyles.border}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: themeStyles.bgHeader
      }}>
        <div style={{ display: 'flex', gap: '16px' }}>
          <button
            onClick={() => setSettingsTab('IDE')}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontWeight: 600, fontSize: '14px',
              color: settingsTab === 'IDE' ? themeStyles.text : themeStyles.textMuted,
              borderBottom: settingsTab === 'IDE' ? `2px solid #2563eb` : 'none',
              paddingBottom: '4px'
            }}
          >IDE</button>
          <button
            onClick={() => setSettingsTab('Agent')}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontWeight: 600, fontSize: '14px',
              color: settingsTab === 'Agent' ? themeStyles.text : themeStyles.textMuted,
              borderBottom: settingsTab === 'Agent' ? `2px solid #2563eb` : 'none',
              paddingBottom: '4px'
            }}
          >Agent</button>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: themeStyles.textMuted, cursor: 'pointer', fontSize: '16px' }}>✕</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {settingsTab === 'IDE' ? (
          <>
        {/* Theme select */}
        <div>
          <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: themeStyles.textMuted, marginBottom: '6px' }}>Theme</label>
          <select
            value={ideTheme}
            onChange={(e) => setIdeTheme(e.target.value)}
            style={{ width: '100%', background: themeStyles.inputBg, border: `1px solid ${themeStyles.border}`, color: themeStyles.text, borderRadius: '4px', padding: '6px', fontSize: '12px' }}
          >
            <option value="light">Light (Visual Studio)</option>
            <option value="dark">Dark (Visual Studio)</option>
            <option value="hc-black">Dark High Contrast</option>
            <option value="abyss">Abyss</option>
            <option value="tokyo-night">Tokyo Night</option>
            <option value="solarized-dark">Solarized Dark</option>
            <option value="solarized-light">Solarized Light</option>
            <option value="synthwave84">SynthWave '84</option>
            <option value="monokai">Monokai</option>
            <option value="powershell-ise">PowerShell ISE</option>
            <option value="quiet-light">Quiet Light</option>
            <option value="red">Red</option>
          </select>
        </div>

        {/* Font size */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: themeStyles.textMuted }}>Font Size</label>
            <span style={{ fontSize: '11px', color: themeStyles.textMuted }}>{editorFontSize}px</span>
          </div>
          <input
            type="range"
            min="10"
            max="24"
            step="0.5"
            value={editorFontSize}
            onChange={(e) => setEditorFontSize(parseFloat(e.target.value))}
            style={{ width: '100%', cursor: 'pointer' }}
          />
        </div>

        {/* Line height */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: themeStyles.textMuted }}>Line Height</label>
            <span style={{ fontSize: '11px', color: themeStyles.textMuted }}>{editorLineHeight}px</span>
          </div>
          <input
            type="range"
            min="16"
            max="32"
            step="1"
            value={editorLineHeight}
            onChange={(e) => setEditorLineHeight(parseInt(e.target.value))}
            style={{ width: '100%', cursor: 'pointer' }}
          />
        </div>

        {/* Font Family */}
        <div>
          <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: themeStyles.textMuted, marginBottom: '6px' }}>Font Family</label>
          <select
            value={editorFontFamily}
            onChange={(e) => setEditorFontFamily(e.target.value)}
            style={{ width: '100%', background: themeStyles.inputBg, border: `1px solid ${themeStyles.border}`, color: themeStyles.text, borderRadius: '4px', padding: '6px', fontSize: '12px' }}
          >
            <option value="Consolas, Monaco, monospace">Consolas / Monaco</option>
            <option value="'Fira Code', monospace">Fira Code</option>
            <option value="'Courier New', Courier, monospace">Courier New</option>
            <option value="monospace">System Monospace</option>
          </select>
        </div>

        {/* Minimap toggle */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '12px', fontWeight: 500 }}>Enable Minimap</span>
          <input
            type="checkbox"
            checked={editorMinimap}
            onChange={(e) => setEditorMinimap(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
        </div>

        {/* Word wrap toggle */}
        <div>
          <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: themeStyles.textMuted, marginBottom: '6px' }}>Word Wrap</label>
          <select
            value={editorWordWrap}
            onChange={(e) => setEditorWordWrap(e.target.value)}
            style={{ width: '100%', background: themeStyles.inputBg, border: `1px solid ${themeStyles.border}`, color: themeStyles.text, borderRadius: '4px', padding: '6px', fontSize: '12px' }}
          >
            <option value="off">Off</option>
            <option value="on">On</option>
            <option value="bounded">Bounded</option>
          </select>
        </div>

        {/* Tab Size */}
        <div>
          <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: themeStyles.textMuted, marginBottom: '6px' }}>Tab Size</label>
          <select
            value={editorTabSize}
            onChange={(e) => setEditorTabSize(parseInt(e.target.value))}
            style={{ width: '100%', background: themeStyles.inputBg, border: `1px solid ${themeStyles.border}`, color: themeStyles.text, borderRadius: '4px', padding: '6px', fontSize: '12px' }}
          >
            <option value="2">2 spaces</option>
            <option value="4">4 spaces</option>
            <option value="8">8 spaces</option>
          </select>
        </div>

        {/* Auto save */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '12px', fontWeight: 500 }}>Auto Save on Blur</span>
          <input
            type="checkbox"
            checked={autoSaveEnabled}
            onChange={(e) => setAutoSaveEnabled(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
        </div>

        {/* Terminal Font size */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
            <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: themeStyles.textMuted }}>Terminal Font Size</label>
            <span style={{ fontSize: '11px', color: themeStyles.textMuted }}>{terminalFontSize}px</span>
          </div>
          <input
            type="range"
            min="10"
            max="18"
            step="1"
            value={terminalFontSize}
            onChange={(e) => setTerminalFontSize(parseInt(e.target.value))}
            style={{ width: '100%', cursor: 'pointer' }}
          />
        </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: themeStyles.textMuted, marginBottom: '6px' }}>Agent Security Mode</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {['Full access', 'Sandboxed', 'Strict'].map((mode) => (
                    <label key={mode} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer' }}>
                      <input 
                        type="radio" 
                        name="securityMode" 
                        value={mode} 
                        checked={agentSecurityMode === mode}
                        onChange={(e) => setAgentSecurityMode(e.target.value)}
                        style={{ marginTop: '2px' }}
                      />
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontSize: '13px', fontWeight: 500 }}>{mode}</span>
                        <span style={{ fontSize: '11px', color: themeStyles.textMuted }}>
                          {mode === 'Full access' && 'Agents have full access to your machine and external resources.'}
                          {mode === 'Sandboxed' && 'Agents run in a secure sandbox that restricts access to external resources outside of your trusted folders.'}
                          {mode === 'Strict' && 'Terminal commands always require review and the agent cannot access files outside of its given workspaces.'}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div style={{ height: '1px', background: themeStyles.border }} />

              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: themeStyles.textMuted, marginBottom: '6px' }}>Terminal Auto Execution</label>
                <select
                  value={terminalAutoExecution}
                  onChange={(e) => setTerminalAutoExecution(e.target.value)}
                  style={{ width: '100%', background: themeStyles.inputBg, border: `1px solid ${themeStyles.border}`, color: themeStyles.text, borderRadius: '4px', padding: '6px', fontSize: '12px' }}
                >
                  <option value="Request Review">Request Review</option>
                  <option value="Auto Execute">Auto Execute</option>
                </select>
                <div style={{ fontSize: '11px', color: themeStyles.textMuted, marginTop: '6px' }}>
                  Controls whether terminal commands require your approval before running.
                </div>
              </div>

              <div style={{ height: '1px', background: themeStyles.border }} />

              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 500 }}>Enable Shell Integration</span>
                  <span style={{ fontSize: '11px', color: themeStyles.textMuted }}>When enabled, Agent will use IDE's shell context.</span>
                </div>
                <input
                  type="checkbox"
                  checked={enableShellIntegration}
                  onChange={(e) => setEnableShellIntegration(e.target.checked)}
                  style={{ cursor: 'pointer', marginTop: '4px' }}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Full-screen Light Theme IDE View ─────────────────────────────────────────
function FullIDEView({
  onClose,
  ideTheme,
  setIdeTheme,
  selectedDep,
  deployments,
  selectedId,
  setSelectedId,
  filesTree,
  activeFile,
  fileContent,
  setFileContent,
  handleSelectFile,
  handleSaveFile,
  isSavingFile,
  dbCollections,
  activeCollection,
  handleSelectCollection,
  collectionData,
  isDbLoading,
  setIsInsertModalOpen,
  handleEditRecord,
  setDeleteConfirmPk,
  deleteConfirmPk,
  handleDeleteRecord,
  shellQuery,
  setShellQuery,
  shellValidationError,
  isRunShellDisabled,
  shellOutput,
  isShellRunning,
  handleRunShellQuery,
  shellPreset,
  shellDbType,
  chats,
  activeChatId,
  handleSelectChat,
  handleCreateChat,
  chatMessages,
  chatInput,
  setChatInput,
  handleSendChat,
  isAgentTyping,
  handleStopChat,
  chatEndRef,
  openTabs,
  setOpenTabs,
  activeTabPath,
  setActiveTabPath,
  explorerOpen,
  setExplorerOpen,
  chatPanelOpen,
  setChatPanelOpen,
  bottomPanelHeight,
  setBottomPanelHeight,
  bottomTab,
  setBottomTab,
  handleNewFile,
  handleContextMenu,
  contextMenu,
  setContextMenu,
  handleContextPreview,
  handleOpenToSide,
  handleCopyPath,
  handleCopyRelPath,
  handleCutFile,
  handleCopyFile,
  setRenameTarget,
  setRenameValue,
  handleDeleteFile,
  renameTarget,
  renameValue,
  handleRenameFile,
  chatSidebarWidth,
  handleDragStart,
  agentSecurityMode,
  setAgentSecurityMode,
  terminalAutoExecution,
  setTerminalAutoExecution,
  enableShellIntegration,
  setEnableShellIntegration,
  expandedDiffs,
  toggleDiffExpansion,
  handleRollback,
  handleUndo
}) {
  const isMarkdown = activeFile && /\.(md|mdx|markdown)$/i.test(activeFile);

  // Editor appearance settings
  const [editorFontSize, setEditorFontSize] = useState(13.5);
  const [editorLineHeight, setEditorLineHeight] = useState(21);
  const [editorFontFamily, setEditorFontFamily] = useState('Consolas, Monaco, monospace');
  const [editorMinimap, setEditorMinimap] = useState(true);
  const [editorWordWrap, setEditorWordWrap] = useState('off');
  const [editorTabSize, setEditorTabSize] = useState(2);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false);
  const [terminalFontSize, setTerminalFontSize] = useState(13);

  // Settings panel and tab context menu state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState(null); // { x, y, tab, pane: 'left'|'right' }

  // Layout customizer states
  const [sidebarPosition, setSidebarPosition] = useState('left'); // 'left' | 'right'
  const [bottomPanelOpen, setBottomPanelOpen] = useState(true);
  const [activityBarOpen, setActivityBarOpen] = useState(true);
  const [statusBarOpen, setStatusBarOpen] = useState(true);
  const [menuBarOpen, setMenuBarOpen] = useState(true);
  const [showLayoutDialog, setShowLayoutDialog] = useState(false);

  const themeStyles = {
    light: {
      bgMain: '#f8fafc', bgPanel: '#ffffff', bgHeader: '#f1f5f9', bgActive: '#ffffff', bgInactive: '#f1f5f9',
      border: '#e2e8f0', text: '#0f172a', textMuted: '#64748b', textDim: '#94a3b8', inputBg: '#ffffff',
      hoverBg: 'rgba(0,0,0,0.04)', selectionBg: 'rgba(37,99,235,0.1)', monacoTheme: 'vs'
    },
    dark: {
      bgMain: '#1e1e1e', bgPanel: '#252526', bgHeader: '#2d2d2d', bgActive: '#1e1e1e', bgInactive: '#2d2d2d',
      border: '#3e3e3e', text: '#cccccc', textMuted: '#858585', textDim: '#555555', inputBg: '#3c3c3c',
      hoverBg: 'rgba(255,255,255,0.05)', selectionBg: 'rgba(37,99,235,0.2)', monacoTheme: 'vs-dark'
    },
    'hc-black': {
      bgMain: '#000000', bgPanel: '#000000', bgHeader: '#0a0a0a', bgActive: '#000000', bgInactive: '#0a0a0a',
      border: '#00ff00', text: '#ffffff', textMuted: '#00ff00', textDim: '#008800', inputBg: '#0a0a0a',
      hoverBg: 'rgba(0,255,0,0.06)', selectionBg: 'rgba(0,255,0,0.15)', monacoTheme: 'hc-black'
    },
    abyss: {
      bgMain: '#000c18', bgPanel: '#001224', bgHeader: '#001e36', bgActive: '#001224', bgInactive: '#001e36',
      border: '#102a45', text: '#88aacc', textMuted: '#597080', textDim: '#405060', inputBg: '#001e36',
      hoverBg: 'rgba(255,255,255,0.05)', selectionBg: 'rgba(0,128,255,0.15)', monacoTheme: 'abyss'
    },
    'tokyo-night': {
      bgMain: '#1a1b26', bgPanel: '#16161e', bgHeader: '#1f2335', bgActive: '#16161e', bgInactive: '#1f2335',
      border: '#24283b', text: '#a9b1d6', textMuted: '#565f89', textDim: '#383e56', inputBg: '#1f2335',
      hoverBg: 'rgba(255,255,255,0.04)', selectionBg: 'rgba(37,99,235,0.2)', monacoTheme: 'tokyo-night'
    },
    'solarized-dark': {
      bgMain: '#002b36', bgPanel: '#073642', bgHeader: '#00212b', bgActive: '#073642', bgInactive: '#00212b',
      border: '#586e75', text: '#839496', textMuted: '#586e75', textDim: '#586e75', inputBg: '#00212b',
      hoverBg: 'rgba(255,255,255,0.04)', selectionBg: 'rgba(42,161,152,0.15)', monacoTheme: 'solarized-dark'
    },
    'solarized-light': {
      bgMain: '#fdf6e3', bgPanel: '#eee8d5', bgHeader: '#fdf6e3', bgActive: '#eee8d5', bgInactive: '#fdf6e3',
      border: '#93a1a1', text: '#657b83', textMuted: '#93a1a1', textDim: '#93a1a1', inputBg: '#fdf6e3',
      hoverBg: 'rgba(0,0,0,0.03)', selectionBg: 'rgba(42,161,152,0.1)', monacoTheme: 'solarized-light'
    },
    synthwave84: {
      bgMain: '#2b213a', bgPanel: '#241b2f', bgHeader: '#1e1627', bgActive: '#241b2f', bgInactive: '#1e1627',
      border: '#463465', text: '#f0efe7', textMuted: '#807a8a', textDim: '#5a4c73', inputBg: '#1e1627',
      hoverBg: 'rgba(255,255,255,0.05)', selectionBg: 'rgba(255,122,230,0.2)', monacoTheme: 'synthwave84'
    },
    monokai: {
      bgMain: '#272822', bgPanel: '#1e1f1c', bgHeader: '#2d2e2b', bgActive: '#1e1f1c', bgInactive: '#2d2e2b',
      border: '#3e3d32', text: '#f8f8f2', textMuted: '#75715e', textDim: '#49483e', inputBg: '#2d2e2b',
      hoverBg: 'rgba(255,255,255,0.05)', selectionBg: 'rgba(249,38,114,0.15)', monacoTheme: 'monokai'
    },
    'powershell-ise': {
      bgMain: '#000080', bgPanel: '#0000a0', bgHeader: '#000060', bgActive: '#0000a0', bgInactive: '#000060',
      border: '#0080ff', text: '#ffffff', textMuted: '#00ffff', textDim: '#0080ff', inputBg: '#000060',
      hoverBg: 'rgba(255,255,255,0.08)', selectionBg: 'rgba(255,255,255,0.2)', monacoTheme: 'powershell-ise'
    },
    'quiet-light': {
      bgMain: '#f5f5f5', bgPanel: '#ffffff', bgHeader: '#e8e8e8', bgActive: '#ffffff', bgInactive: '#e8e8e8',
      border: '#dddddd', text: '#333333', textMuted: '#777777', textDim: '#999999', inputBg: '#e8e8e8',
      hoverBg: 'rgba(0,0,0,0.04)', selectionBg: 'rgba(0,0,255,0.05)', monacoTheme: 'quiet-light'
    },
    red: {
      bgMain: '#390000', bgPanel: '#2a0000', bgHeader: '#1f0000', bgActive: '#2a0000', bgInactive: '#1f0000',
      border: '#5d0000', text: '#ffcccc', textMuted: '#ff6666', textDim: '#990000', inputBg: '#1f0000',
      hoverBg: 'rgba(255,255,255,0.06)', selectionBg: 'rgba(255,0,0,0.15)', monacoTheme: 'red'
    }
  }[ideTheme] || themeStyles.dark;

  // Multi-instance sandboxed terminal list state
  const [terminalsList, setTerminalsList] = useState([
    {
      id: 1,
      name: 'Terminal 1',
      logs: [
        { type: 'sys', text: 'Welcome to Sandboxed Terminal 1' },
        { type: 'sys', text: 'Type "help" to view all available commands.' },
        { type: 'sys', text: '' }
      ]
    }
  ]);
  const [activeTerminalId, setActiveTerminalId] = useState(1);
  const [terminalInputVal, setTerminalInputVal] = useState('');
  const terminalEndRef = useRef(null);

  const handleAddTerminal = () => {
    const nextId = terminalsList.length > 0 ? Math.max(...terminalsList.map(t => t.id)) + 1 : 1;
    const newTerm = {
      id: nextId,
      name: `Terminal ${nextId}`,
      logs: [
        { type: 'sys', text: `Welcome to Sandboxed Terminal ${nextId}` },
        { type: 'sys', text: 'Type "help" to view all available commands.' },
        { type: 'sys', text: '' }
      ]
    };
    setTerminalsList(prev => [...prev, newTerm]);
    setActiveTerminalId(nextId);
  };

  const handleCloseTerminal = (id, e) => {
    e.stopPropagation();
    if (terminalsList.length === 1) return; // Keep at least one
    const remaining = terminalsList.filter(t => t.id !== id);
    setTerminalsList(remaining);
    if (activeTerminalId === id) {
      setActiveTerminalId(remaining[0].id);
    }
  };

  const handleTerminalCommand = (e) => {
    if (e.key !== 'Enter') return;
    const cmd = terminalInputVal.trim();
    if (!cmd) return;

    // Append user command log to the active terminal
    setTerminalsList(prev => prev.map(t => {
      if (t.id === activeTerminalId) {
        return {
          ...t,
          logs: [...t.logs, { type: 'cmd', text: `user@sandbox:~$ ${cmd}` }]
        };
      }
      return t;
    }));
    setTerminalInputVal('');

    const lower = cmd.toLowerCase();
    let response = '';

    if (lower === 'help') {
      response = 'Available sandboxed commands:\n  help        - Display this menu\n  clear       - Clear terminal window\n  ls          - List workspace directories/files\n  pwd         - Print working directory path\n  date        - Print sandbox system date & time\n  whoami      - Print active session user\n  techstack   - Show tech stack information\n  workspace   - Display project stats';
    } else if (lower === 'clear') {
      setTerminalsList(prev => prev.map(t => {
        if (t.id === activeTerminalId) {
          return { ...t, logs: [] };
        }
        return t;
      }));
      return;
    } else if (lower === 'ls') {
      response = filesTree.map(f => f.name + (f.isDir ? '/' : '')).join('\n') || '(empty)';
    } else if (lower === 'pwd') {
      response = `/workspace/${selectedDep?.projectName || 'sandbox'}`;
    } else if (lower === 'date') {
      response = new Date().toString();
    } else if (lower === 'whoami') {
      response = 'sandbox-dev-developer';
    } else if (lower === 'techstack') {
      response = `Detected Tech Stack: ${selectedDep?.techStackDetected || 'MERN'}\nDatabase type: ${selectedDep?.dbInitType || 'mongodb'}`;
    } else if (lower === 'workspace') {
      response = `Workspace Status:\n  Total deployments: ${deployments.length}\n  Current project: ${selectedDep?.projectName}\n  Database collections: ${dbCollections.join(', ') || 'none'}`;
    } else {
      response = `bash: command not found: ${cmd}. Type "help" to see available options.`;
    }

    setTimeout(() => {
      setTerminalsList(prev => prev.map(t => {
        if (t.id === activeTerminalId) {
          return {
            ...t,
            logs: [...t.logs, { type: 'res', text: response }]
          };
        }
        return t;
      }));
    }, 100);
  };

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [terminalsList, activeTerminalId]);

  // Split View States
  const [isSplitView, setIsSplitView] = useState(false);
  const [rightActiveTabPath, setRightActiveTabPath] = useState(null);
  const [rightFileContent, setRightFileContent] = useState('');

  // Dynamically load file content for the right pane in split editor layout
  useEffect(() => {
    if (rightActiveTabPath) {
      if (rightActiveTabPath.startsWith('db:')) {
        // Fetch collection data if right split switches to a database tab
        const collectionName = rightActiveTabPath.replace('db:', '');
        getDbCollectionData(selectedId, collectionName, selectedDep?.dbInitType || 'mongodb')
          .then(res => setCollectionData(res.data))
          .catch(err => console.error('Failed to load DB split data:', err));
        return;
      }
      getWorkspaceFileContent(selectedId, rightActiveTabPath)
        .then(res => setRightFileContent(res.data.content || ''))
        .catch(err => console.error('Failed to get right split file content:', err));
    }
  }, [rightActiveTabPath, selectedId, selectedDep?.dbInitType]);

  // pgAdmin / Compass styled Database View rendering inside editor tabs
  const renderDbTableContent = (collName) => {
    const dbType = selectedDep?.dbInitType || 'mongodb';
    const isSql = ['postgres', 'mysql', 'mariadb', 'sqlite', 'mssql', 'oracle'].includes(dbType);
    const isMongo = dbType === 'mongodb';
    const sqlColumns = collectionData.length > 0 ? Object.keys(collectionData[0]) : [];

    // Determine if we're on a light theme for value coloring
    const isLightBg = ['light', 'solarized-light', 'quiet-light'].includes(ideTheme);
    const idColor = isLightBg ? '#2563eb' : '#58a6ff';
    const numColor = isLightBg ? '#b45309' : '#d2a679';
    const strColor = isLightBg ? '#0f766e' : '#7ee787';
    const nullColor = themeStyles.textDim;
    const headerRowBg = themeStyles.bgHeader;
    const evenRowBg = themeStyles.bgPanel;
    const oddRowBg = themeStyles.bgMain;
    const rowHoverBg = themeStyles.hoverBg;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, padding: '16px', background: themeStyles.bgPanel, overflow: 'hidden', color: themeStyles.text }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13.5px', fontWeight: 600, color: themeStyles.text }}>
              {isSql ? 'Table:' : isMongo ? 'Collection:' : 'Keys in:'}{' '}
              <code style={{ color: idColor, fontFamily: 'monospace', background: themeStyles.bgHeader, padding: '2px 6px', borderRadius: '4px' }}>{collName}</code>
            </span>
            <span style={{
              fontSize: '11px',
              color: themeStyles.textMuted,
              background: themeStyles.bgHeader,
              padding: '2px 6px',
              borderRadius: '4px',
              fontFamily: 'monospace'
            }}>limit 50</span>
            {collectionData.length > 0 && (
              <span style={{
                fontSize: '11px',
                color: themeStyles.textMuted,
                background: themeStyles.bgHeader,
                padding: '2px 6px',
                borderRadius: '4px'
              }}>{collectionData.length} rows</span>
            )}
          </div>
          <button
            onClick={() => {
              setInsertError('');
              if (isSql && collectionData.length > 0) {
                const cols = Object.keys(collectionData[0]).filter(k => k !== 'id' && k !== '_id');
                setCollectionColumns(cols);
                const defaults = {};
                cols.forEach(c => { defaults[c] = ''; });
                setSqlRowValues(defaults);
              } else if (isSql) {
                setCollectionColumns([]);
                setSqlRowValues({});
                setNewRecordJson('{\n  "column": "value"\n}');
              } else {
                setCollectionColumns([]);
                setNewRecordJson('{\n  "field": "value"\n}');
              }
              setIsInsertModalOpen(true);
            }}
            style={{
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              padding: '6px 12px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            <Plus size={13} /> {isSql ? 'Insert Row' : isMongo ? 'Add Document' : 'Set Key'}
          </button>
        </div>

        {/* Data Display */}
        <div style={{ flex: 1, overflow: 'auto', border: `1px solid ${themeStyles.border}`, borderRadius: '6px', background: themeStyles.bgPanel }}>
          {isDbLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '160px', color: themeStyles.textMuted, fontSize: '13px' }}>
              Loading collection data...
            </div>
          ) : collectionData.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '160px', gap: '8px', color: themeStyles.textMuted }}>
              <Database size={28} color={themeStyles.textDim} />
              <span style={{ fontSize: '13px' }}>No records found in <code style={{ color: idColor }}>{collName}</code></span>
            </div>
          ) : isSql ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', color: themeStyles.text }}>
              <thead>
                <tr style={{ background: headerRowBg, position: 'sticky', top: 0, zIndex: 1 }}>
                  {sqlColumns.map((col, ci) => (
                    <th key={ci} style={{
                      padding: '8px 12px',
                      textAlign: 'left',
                      color: themeStyles.textMuted,
                      fontWeight: 600,
                      fontSize: '11px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      borderBottom: `2px solid ${themeStyles.border}`,
                      borderRight: `1px solid ${themeStyles.border}`,
                      whiteSpace: 'nowrap'
                    }}>{col}</th>
                  ))}
                  <th style={{
                    padding: '8px 12px',
                    textAlign: 'center',
                    color: themeStyles.textMuted,
                    fontWeight: 600,
                    fontSize: '11px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    borderBottom: `2px solid ${themeStyles.border}`,
                    width: '100px',
                    whiteSpace: 'nowrap'
                  }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {collectionData.map((row, ri) => {
                  const rowPk = row.id ?? row._id;
                  const isDeleting = deleteConfirmPk === rowPk;
                  const rowBg = isDeleting ? 'rgba(220,38,38,0.15)' : (ri % 2 === 0 ? evenRowBg : oddRowBg);
                  return (
                    <tr key={ri} style={{ background: rowBg, borderBottom: `1px solid ${themeStyles.border}` }}
                      onMouseEnter={e => e.currentTarget.style.background = rowHoverBg}
                      onMouseLeave={e => e.currentTarget.style.background = isDeleting ? 'rgba(220,38,38,0.15)' : (ri % 2 === 0 ? evenRowBg : oddRowBg)}
                    >
                      {sqlColumns.map((col, ci) => {
                        const val = row[col];
                        const isNull = val === null || val === undefined;
                        const isNum = typeof val === 'number';
                        const isId = col === 'id' || col.endsWith('_id');
                        return (
                          <td key={ci} style={{
                            padding: '7px 12px',
                            fontFamily: 'Consolas, Monaco, monospace',
                            fontSize: '12px',
                            color: isNull ? nullColor : isId ? idColor : isNum ? numColor : strColor,
                            borderRight: `1px solid ${themeStyles.border}`,
                            verticalAlign: 'middle',
                            maxWidth: '240px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}>
                            {isNull ? <span style={{ fontStyle: 'italic', color: nullColor }}>NULL</span> : String(val)}
                          </td>
                        );
                      })}
                      <td style={{ padding: '7px 12px', textAlign: 'center', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                        {isDeleting ? (
                          <div style={{ display: 'flex', gap: '4px', justifyContent: 'center', alignItems: 'center' }}>
                            <span style={{ fontSize: '11px', color: '#dc2626', marginRight: '4px', fontWeight: 600 }}>Delete?</span>
                            <button
                              onClick={() => handleDeleteRecord(row)}
                              style={{ background: '#dc2626', border: 'none', borderRadius: '4px', color: 'white', padding: '2px 8px', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}
                            >Yes</button>
                            <button
                              onClick={() => setDeleteConfirmPk(null)}
                              style={{ background: themeStyles.bgHeader, border: `1px solid ${themeStyles.border}`, borderRadius: '4px', color: themeStyles.textMuted, padding: '2px 8px', fontSize: '11px', cursor: 'pointer' }}
                            >No</button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', alignItems: 'center' }}>
                            <button title="Edit row" onClick={() => handleEditRecord(row)}
                              style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', color: themeStyles.textMuted, padding: 0 }}>
                              <Code size={13} />
                            </button>
                            <button title="Delete row" onClick={() => setDeleteConfirmPk(rowPk)}
                              style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', color: themeStyles.textMuted, padding: 0 }}>
                              <Trash2 size={13} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : isMongo ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px' }}>
              {collectionData.map((doc, di) => {
                const id = doc._id || doc.id || `#${di + 1}`;
                const isDeleting = deleteConfirmPk === id;
                const rest = { ...doc };
                delete rest._id;
                delete rest.id;
                const fields = Object.entries(rest);
                return (
                  <div key={di} style={{
                    background: isDeleting ? 'rgba(220,38,38,0.12)' : themeStyles.bgMain,
                    border: `1px solid ${isDeleting ? '#f87171' : themeStyles.border}`,
                    borderRadius: '6px',
                    padding: '12px 16px',
                    fontFamily: 'Consolas, Monaco, monospace',
                    fontSize: '12px'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: `1px solid ${themeStyles.border}`, paddingBottom: '6px', marginBottom: '6px' }}>
                      <span style={{ fontWeight: 600, color: idColor }}>
                        _id: <span style={{ color: strColor }}>{String(id)}</span>
                      </span>
                      {isDeleting ? (
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <span style={{ fontSize: '11px', color: '#dc2626', fontWeight: 600, alignSelf: 'center', marginRight: '4px' }}>Confirm delete?</span>
                          <button onClick={() => handleDeleteRecord(doc)}
                            style={{ background: '#dc2626', border: 'none', color: '#fff', padding: '2px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 600 }}>
                            Delete
                          </button>
                          <button onClick={() => setDeleteConfirmPk(null)}
                            style={{ background: themeStyles.bgHeader, border: `1px solid ${themeStyles.border}`, color: themeStyles.textMuted, padding: '2px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button onClick={() => handleEditRecord(doc)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: themeStyles.textMuted }}><Code size={13} /></button>
                          <button onClick={() => setDeleteConfirmPk(id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: themeStyles.textMuted }}><Trash2 size={13} /></button>
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      {fields.map(([k, v], fi) => (
                        <div key={fi} style={{ display: 'flex', gap: '8px' }}>
                          <span style={{ color: themeStyles.textMuted, fontWeight: 600 }}>{k}:</span>
                          <span style={{ color: typeof v === 'number' ? numColor : strColor }}>
                            {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <pre style={{ padding: '12px', margin: 0, fontSize: '12px', color: themeStyles.text, background: 'transparent' }}>
              {JSON.stringify(collectionData, null, 2)}
            </pre>
          )}
        </div>
      </div>
    );
  };

  // Drag handle for resizing bottom panel
  const [isResizingBottom, setIsResizingBottom] = useState(false);
  const handleBottomMouseDown = (e) => {
    e.preventDefault();
    setIsResizingBottom(true);
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizingBottom) return;
      const newHeight = window.innerHeight - e.clientY - 24; // 24px is status bar
      if (newHeight > 60 && newHeight < window.innerHeight * 0.6) {
        setBottomPanelHeight(newHeight);
      }
    };
    const handleMouseUp = () => {
      setIsResizingBottom(false);
    };
    if (isResizingBottom) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingBottom, setBottomPanelHeight]);

  const handleCloseTab = (e, path) => {
    e.stopPropagation();
    const index = openTabs.findIndex(t => t.path === path);
    const newTabs = openTabs.filter(t => t.path !== path);
    setOpenTabs(newTabs);

    if (activeTabPath === path) {
      if (newTabs.length > 0) {
        const nextActive = newTabs[Math.max(0, index - 1)].path;
        setActiveTabPath(nextActive);
        handleSelectFile(nextActive);
      } else {
        setActiveTabPath(null);
      }
    }
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 9999,
      background: themeStyles.bgMain,
      color: themeStyles.text,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      userSelect: 'none'
    }}>
      {/* ── IDE Title Bar (Light/Dark/HC) ── */}
      {menuBarOpen && (
        <div style={{
          height: '38px',
          background: themeStyles.bgHeader,
        borderBottom: `1px solid ${themeStyles.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px',
        flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <ShieldCheck size={16} color="#2563eb" />
          <span style={{ fontWeight: 600, fontSize: '13px', color: themeStyles.text }}>DevOps Agent IDE View</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Mainstream Editor Theme Switcher Dropdown */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '11px', color: themeStyles.textMuted }}>Theme:</span>
            <select
              value={ideTheme}
              onChange={(e) => setIdeTheme(e.target.value)}
              style={{
                background: themeStyles.bgPanel,
                border: `1px solid ${themeStyles.border}`,
                borderRadius: '4px',
                padding: '3px 8px',
                fontSize: '11.5px',
                fontWeight: 600,
                color: themeStyles.text,
                cursor: 'pointer',
                outline: 'none'
              }}
            >
              <option value="light">Light (Visual Studio)</option>
              <option value="dark">Dark (Visual Studio)</option>
              <option value="hc-black">Dark High Contrast</option>
              <option value="abyss">Abyss</option>
              <option value="tokyo-night">Tokyo Night</option>
              <option value="solarized-dark">Solarized Dark</option>
              <option value="solarized-light">Solarized Light</option>
              <option value="synthwave84">SynthWave '84</option>
              <option value="monokai">Monokai</option>
              <option value="powershell-ise">PowerShell ISE</option>
              <option value="quiet-light">Quiet Light</option>
              <option value="red">Red</option>
            </select>
          </div>

          {/* Quick Layout Toggles */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', borderLeft: `1px solid ${themeStyles.border}`, paddingLeft: '12px' }}>
            <button
              onClick={() => setExplorerOpen(!explorerOpen)}
              style={{ background: explorerOpen ? 'rgba(37,99,235,0.1)' : 'transparent', border: 'none', borderRadius: '4px', padding: '4px', cursor: 'pointer', color: explorerOpen ? '#2563eb' : themeStyles.textMuted, display: 'flex', alignItems: 'center' }}
              title="Toggle Primary Side Bar (Explorer)"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /></svg>
            </button>
            <button
              onClick={() => setBottomPanelOpen(!bottomPanelOpen)}
              style={{ background: bottomPanelOpen ? 'rgba(37,99,235,0.1)' : 'transparent', border: 'none', borderRadius: '4px', padding: '4px', cursor: 'pointer', color: bottomPanelOpen ? '#2563eb' : themeStyles.textMuted, display: 'flex', alignItems: 'center' }}
              title="Toggle Bottom Panel (Console)"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 15h18" /></svg>
            </button>
            <button
              onClick={() => setChatPanelOpen(!chatPanelOpen)}
              style={{ background: chatPanelOpen ? 'rgba(37,99,235,0.1)' : 'transparent', border: 'none', borderRadius: '4px', padding: '4px', cursor: 'pointer', color: chatPanelOpen ? '#2563eb' : themeStyles.textMuted, display: 'flex', alignItems: 'center' }}
              title="Toggle Secondary Side Bar (Chat)"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" /></svg>
            </button>
            <button
              onClick={() => setShowLayoutDialog(!showLayoutDialog)}
              style={{ background: showLayoutDialog ? 'rgba(37,99,235,0.15)' : 'transparent', border: `1px solid ${themeStyles.border}`, borderRadius: '4px', padding: '3px 6px', cursor: 'pointer', color: themeStyles.text, fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 600, position: 'relative' }}
              title="Customize Layout"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="M15 3v18" /><path d="M3 9h18" /><path d="M3 15h18" /></svg>
              Layout

              {showLayoutDialog && (
                <div 
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute',
                    top: '28px',
                    right: 0,
                    width: '260px',
                    background: themeStyles.bgPanel,
                    border: `1px solid ${themeStyles.border}`,
                    borderRadius: '8px',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                    padding: '12px',
                    zIndex: 100000,
                    textAlign: 'left',
                    color: themeStyles.text,
                    fontWeight: 500,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `1px solid ${themeStyles.border}`, paddingBottom: '6px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600 }}>Customize Layout</span>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <span title="Reset Layout" onClick={() => {
                        setMenuBarOpen(true);
                        setActivityBarOpen(true);
                        setExplorerOpen(true);
                        setChatPanelOpen(true);
                        setBottomPanelOpen(true);
                        setStatusBarOpen(true);
                        setSidebarPosition('left');
                      }} style={{ cursor: 'pointer', color: themeStyles.textMuted }}>↺</span>
                      <span onClick={() => setShowLayoutDialog(false)} style={{ cursor: 'pointer', color: themeStyles.textMuted }}>✕</span>
                    </div>
                  </div>

                  {/* Options */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '11.5px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={menuBarOpen} onChange={(e) => setMenuBarOpen(e.target.checked)} />
                      <span>Menu Bar</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={activityBarOpen} onChange={(e) => setActivityBarOpen(e.target.checked)} />
                      <span>Activity Bar</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={explorerOpen} onChange={(e) => setExplorerOpen(e.target.checked)} />
                      <span>Primary Side Bar</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={chatPanelOpen} onChange={(e) => setChatPanelOpen(e.target.checked)} />
                      <span>Secondary Side Bar</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={bottomPanelOpen} onChange={(e) => setBottomPanelOpen(e.target.checked)} />
                      <span>Panel (Ctrl+J)</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={statusBarOpen} onChange={(e) => setStatusBarOpen(e.target.checked)} />
                      <span>Status Bar</span>
                    </label>
                  </div>

                  <div style={{ height: '1px', background: themeStyles.border, margin: '4px 0' }} />

                  {/* Primary Side Bar Position */}
                  <div style={{ fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span style={{ color: themeStyles.textMuted, fontWeight: 600 }}>Primary Side Bar Position</span>
                    <div style={{ display: 'flex', gap: '12px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                        <input type="radio" name="sidebarPos" checked={sidebarPosition === 'left'} onChange={() => setSidebarPosition('left')} />
                        <span>Left</span>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                        <input type="radio" name="sidebarPos" checked={sidebarPosition === 'right'} onChange={() => setSidebarPosition('right')} />
                        <span>Right</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}
            </button>
          </div>

          <button
            onClick={onClose}
            style={{
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              padding: '4px 12px',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            <RotateCcw size={12} /> Exit IDE
          </button>
        </div>
      </div>
      )}

      {/* Floating button to restore Menu Bar if hidden */}
      {!menuBarOpen && (
        <button
          onClick={() => setMenuBarOpen(true)}
          style={{
            position: 'absolute',
            top: '4px',
            left: '4px',
            background: themeStyles.bgHeader,
            border: `1px solid ${themeStyles.border}`,
            color: themeStyles.text,
            borderRadius: '4px',
            padding: '2px 6px',
            fontSize: '10px',
            cursor: 'pointer',
            zIndex: 1000000,
            opacity: 0.8
          }}
          title="Show Menu Bar"
        >
          ☰ Show Menu Bar
        </button>
      )}

      {/* ── IDE Client View Area ── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, flexDirection: sidebarPosition === 'right' ? 'row-reverse' : 'row' }}>
        {/* ── IDE Activity Bar (Left 48px, reuses normal sidebar icons) ── */}
        {activityBarOpen && (
          <div style={{
            width: '48px',
            background: themeStyles.bgHeader,
            borderRight: `1px solid ${themeStyles.border}`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: '12px 0',
            gap: '16px',
            flexShrink: 0
          }}>
            {[
              { icon: LayoutDashboard, label: 'Overview', to: '/' },
              { icon: ShieldAlert, label: 'Threats', to: '/threats' },
              { icon: Network, label: 'Network', to: '/network' },
              { icon: BarChart3, label: 'Analytics', to: '/analytics' },
              { icon: FileText, label: 'Logs', to: '/logs' },
              { icon: Server, label: 'DevOps', to: '/devops' },
              { icon: Bot, label: 'Agent', to: '/agent', active: true },
              { icon: Cpu, label: 'Nodes', to: '/nodes' },
              { icon: Settings, label: 'Settings', to: '/settings', isSettings: true }
            ].map((item, idx) => {
              const isItemActive = item.active || (item.isSettings && settingsOpen);
              return (
                <a
                  key={idx}
                  href={item.to}
                  onClick={(e) => {
                    if (item.active) {
                      e.preventDefault();
                      setExplorerOpen(!explorerOpen);
                    } else if (item.isSettings) {
                      e.preventDefault();
                      setSettingsOpen(!settingsOpen);
                    }
                  }}
                  title={item.label}
                  style={{
                    color: isItemActive ? '#2563eb' : themeStyles.textMuted,
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    width: '34px',
                    height: '34px',
                    borderRadius: '6px',
                    background: isItemActive ? 'rgba(37, 99, 235, 0.08)' : 'transparent'
                  }}
                  onMouseEnter={e => { if (!isItemActive) e.currentTarget.style.background = themeStyles.hoverBg; }}
                  onMouseLeave={e => { if (!isItemActive) e.currentTarget.style.background = 'transparent'; }}
                >
                  <item.icon size={18} />
                </a>
              );
            })}
          </div>
        )}

        {/* ── IDE Explorer Pane (240px wide, theme-aware) ── */}
        {explorerOpen && (
          <div style={{
            width: '240px',
            background: themeStyles.bgMain,
            borderRight: `1px solid ${themeStyles.border}`,
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0
          }}>
            {/* File explorer title bar */}
            <div style={{
              padding: '10px 14px',
              borderBottom: `1px solid ${themeStyles.border}`,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <span style={{ fontSize: '11px', textTransform: 'uppercase', fontWeight: 700, color: themeStyles.textMuted, letterSpacing: '0.5px' }}>Workspace Files</span>
              <button
                onClick={handleNewFile}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: themeStyles.textMuted }}
                title="New File..."
              >
                <Plus size={14} />
              </button>
            </div>

            {/* Flat File Tree list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
              {filesTree.length === 0 ? (
                <div style={{ fontSize: '11px', color: themeStyles.textDim, fontStyle: 'italic', padding: '0 14px' }}>Loading...</div>
              ) : (
                filesTree.map((node, idx) => (
                  <FileTreeNode
                    key={idx}
                    node={node}
                    onSelectFile={handleSelectFile}
                    selectedPath={activeFile}
                    onContextMenu={handleContextMenu}
                    themeStyles={themeStyles}
                  />
                ))
              )}
            </div>

            {/* DB explorer list */}
            <div style={{ borderTop: `1px solid ${themeStyles.border}`, padding: '10px 14px', flex: 1, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                <Database size={13} color={themeStyles.textMuted} />
                <span style={{ fontSize: '11px', textTransform: 'uppercase', fontWeight: 700, color: themeStyles.textMuted, letterSpacing: '0.5px' }}>DB Explorer</span>
              </div>
              <div style={{ overflowY: 'auto', flex: 1 }}>
                {dbCollections.length === 0 ? (
                  <div style={{ fontSize: '11px', color: themeStyles.textDim, fontStyle: 'italic' }}>No active collections</div>
                ) : (
                  dbCollections.map((coll, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleSelectCollection(coll)}
                      style={{
                        background: activeCollection === coll ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
                        border: 'none',
                        color: activeCollection === coll ? '#2563eb' : themeStyles.textMuted,
                        padding: '6px 10px',
                        borderRadius: '4px',
                        textAlign: 'left',
                        fontSize: '12px',
                        cursor: 'pointer',
                        display: 'block',
                        width: '100%',
                        fontWeight: activeCollection === coll ? 600 : 500,
                        borderLeft: activeCollection === coll ? '3px solid #2563eb' : 'none'
                      }}
                    >
                      {coll}
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Context Menu for right-click */}
            {contextMenu && (
              <FileContextMenu
                x={contextMenu.x} y={contextMenu.y} node={contextMenu.node}
                onClose={() => setContextMenu(null)}
                onSelectFile={handleSelectFile}
                onPreview={handleContextPreview}
                onOpenSide={handleOpenToSide}
                onCopyPath={handleCopyPath}
                onCopyRelPath={handleCopyRelPath}
                onCut={handleCutFile}
                onCopy={handleCopyFile}
                onRename={(node) => { setRenameTarget(node); setRenameValue(node.name); }}
                onDelete={handleDeleteFile}
              />
            )}
          </div>
        )}

        {/* ── IDE Center Editor Pane (Monaco, Preview or DB Explorer, in light theme) ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
          
          {/* Main workspace editor and splits area */}
          <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
            
            {/* LEFT EDITOR PANE */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, borderRight: isSplitView ? `1px solid ${themeStyles.border}` : 'none' }}>
              {/* Left Pane Tab Bar */}
              <div style={{
                height: '32px',
                background: themeStyles.bgHeader,
                borderBottom: `1px solid ${themeStyles.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexShrink: 0,
                overflowX: 'auto'
              }}>
                <div style={{ display: 'flex', height: '100%' }}>
                  {openTabs.map((tab, idx) => {
                    const isActive = tab.path === activeTabPath;
                    const isDb = tab.path.startsWith('db:');
                    const displayName = isDb ? tab.name : tab.path.split(/[\/\\]/).pop();
                    return (
                      <div
                        key={idx}
                        onClick={() => {
                          setActiveTabPath(tab.path);
                          if (!isDb) {
                            handleSelectFile(tab.path);
                          } else {
                            handleSelectCollection(tab.collection);
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setTabContextMenu({
                            x: e.clientX,
                            y: e.clientY,
                            tab,
                            pane: 'left'
                          });
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '0 12px',
                          height: '100%',
                          background: isActive ? themeStyles.bgActive : themeStyles.bgInactive,
                          borderRight: `1px solid ${themeStyles.border}`,
                          borderTop: isActive ? '2px solid #2563eb' : 'none',
                          cursor: 'pointer',
                          fontSize: '12px',
                          color: isActive ? themeStyles.text : themeStyles.textMuted,
                          fontWeight: isActive ? 600 : 500
                        }}
                      >
                        {isDb ? <Database size={12} color="#2563eb" /> : <File size={12} color={themeStyles.textMuted} />}
                        <span>{displayName}</span>
                        <span
                          onClick={(e) => handleCloseTab(e, tab.path)}
                          style={{
                            borderRadius: '50%',
                            width: '14px',
                            height: '14px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '10px',
                            color: themeStyles.textMuted,
                            marginLeft: '4px'
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = themeStyles.hoverBg; e.currentTarget.style.color = themeStyles.text; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = themeStyles.textMuted; }}
                        >
                          ×
                        </span>
                      </div>
                    );
                  })}
                </div>
                
                {/* Editor Split Control */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingRight: '12px' }}>
                  <button
                    onClick={() => {
                      if (!isSplitView) {
                        const otherTab = openTabs.find(t => t.path !== activeTabPath) || openTabs[0];
                        if (otherTab) {
                          setRightActiveTabPath(otherTab.path);
                        }
                      }
                      setIsSplitView(!isSplitView);
                    }}
                    style={{
                      background: isSplitView ? 'rgba(37,99,235,0.1)' : 'transparent',
                      border: 'none',
                      borderRadius: '4px',
                      padding: '4px 8px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      color: isSplitView ? '#2563eb' : themeStyles.textMuted,
                      fontSize: '11px',
                      fontWeight: 600,
                      gap: '4px'
                    }}
                    title="Split Editor"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="18" height="18" x="3" y="3" rx="2" />
                      <path d="M12 3v18" />
                    </svg>
                    <span>{isSplitView ? 'Unsplit' : 'Split View'}</span>
                  </button>
                </div>
              </div>

              {/* Left Pane Editor Content Area */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                {activeTabPath ? (
                  activeTabPath.startsWith('db:') ? (
                    renderDbTableContent(activeTabPath.replace('db:', ''))
                  ) : activeTabPath.endsWith('.md') || activeTabPath.endsWith('.mdx') || activeTabPath.endsWith('.markdown') ? (
                    /* Markdown Preview */
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', background: themeStyles.bgPanel }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyStyle: 'space-between', padding: '8px 16px', borderBottom: `1px solid ${themeStyles.border}`, flexShrink: 0 }}>
                        <span style={{ fontSize: '11px', color: themeStyles.textMuted, fontFamily: 'monospace' }}>{activeTabPath}</span>
                      </div>
                      <div
                        className={ideTheme === 'light' ? 'md-preview-light' : 'md-preview-dark'}
                        style={{
                          flex: 1, overflowY: 'auto', padding: '24px 32px',
                          color: themeStyles.text, lineHeight: '1.75', fontSize: '14.5px',
                          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                          background: themeStyles.bgPanel
                        }}
                        dangerouslySetInnerHTML={{
                          __html: (() => {
                            try {
                              marked.setOptions({ breaks: true, gfm: true });
                              return marked.parse(fileContent || '');
                            } catch(_) { return '<pre>' + fileContent + '</pre>'; }
                          })()
                        }}
                      />
                    </div>
                  ) : (
                    /* Monaco Code Editor */
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', background: themeStyles.bgPanel, position: 'relative' }}>
                      <Editor
                        height="100%"
                        defaultLanguage="javascript"
                        language={getLanguageFromPath(activeTabPath)}
                        theme={themeStyles.monacoTheme}
                        beforeMount={registerMonacoThemes}
                        value={fileContent}
                        onChange={(value) => setFileContent(value || '')}
                        onMount={(editor, monaco) => {
                          editor.onDidBlurEditorText(() => {
                            if (autoSaveEnabled && activeFile) {
                              handleSaveFile(activeFile, fileContent);
                            }
                          });
                        }}
                        options={{
                          minimap: { enabled: editorMinimap },
                          fontSize: editorFontSize,
                          lineHeight: editorLineHeight,
                          fontFamily: editorFontFamily,
                          wordWrap: editorWordWrap,
                          tabSize: editorTabSize,
                          automaticLayout: true
                        }}
                      />
                    </div>
                  )
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, color: themeStyles.textMuted, gap: '10px' }}>
                    <Code size={40} color={themeStyles.textDim} />
                    <span style={{ fontSize: '13px' }}>Select a file or DB collection.</span>
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT EDITOR PANE (Split View) */}
            {isSplitView && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                {/* Right Pane Tab Bar */}
                <div style={{
                  height: '32px',
                  background: themeStyles.bgHeader,
                  borderBottom: `1px solid ${themeStyles.border}`,
                  display: 'flex',
                  alignItems: 'center',
                  flexShrink: 0,
                  overflowX: 'auto'
                }}>
                  {openTabs.map((tab, idx) => {
                    const isActive = tab.path === rightActiveTabPath;
                    const isDb = tab.path.startsWith('db:');
                    const displayName = isDb ? tab.name : tab.path.split(/[\/\\]/).pop();
                    return (
                      <div
                        key={idx}
                        onClick={() => setRightActiveTabPath(tab.path)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setTabContextMenu({
                            x: e.clientX,
                            y: e.clientY,
                            tab,
                            pane: 'right'
                          });
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '0 12px',
                          height: '100%',
                          background: isActive ? themeStyles.bgActive : themeStyles.bgInactive,
                          borderRight: `1px solid ${themeStyles.border}`,
                          borderTop: isActive ? '2px solid #2563eb' : 'none',
                          cursor: 'pointer',
                          fontSize: '12px',
                          color: isActive ? themeStyles.text : themeStyles.textMuted,
                          fontWeight: isActive ? 600 : 500
                        }}
                      >
                        {isDb ? <Database size={12} color="#2563eb" /> : <File size={12} color={themeStyles.textMuted} />}
                        <span>{displayName}</span>
                      </div>
                    );
                  })}
                </div>

                {/* Right Pane Editor Content Area */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                  {rightActiveTabPath ? (
                    rightActiveTabPath.startsWith('db:') ? (
                      renderDbTableContent(rightActiveTabPath.replace('db:', ''))
                    ) : rightActiveTabPath.endsWith('.md') || rightActiveTabPath.endsWith('.mdx') || rightActiveTabPath.endsWith('.markdown') ? (
                      /* Markdown Preview Split */
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', background: themeStyles.bgPanel }}>
                        <div style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', borderBottom: `1px solid ${themeStyles.border}`, flexShrink: 0 }}>
                          <span style={{ fontSize: '11px', color: themeStyles.textMuted, fontFamily: 'monospace' }}>{rightActiveTabPath}</span>
                        </div>
                        <div
                          className={ideTheme === 'light' ? 'md-preview-light' : 'md-preview-dark'}
                          style={{
                            flex: 1, overflowY: 'auto', padding: '24px 32px',
                            color: themeStyles.text, lineHeight: '1.75', fontSize: '14.5px',
                            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                            background: themeStyles.bgPanel
                          }}
                          dangerouslySetInnerHTML={{
                            __html: (() => {
                              try {
                                marked.setOptions({ breaks: true, gfm: true });
                                return marked.parse(rightFileContent || '');
                              } catch(_) { return '<pre>' + rightFileContent + '</pre>'; }
                            })()
                          }}
                        />
                      </div>
                    ) : (
                      /* Monaco Code Editor Split */
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', background: themeStyles.bgPanel, position: 'relative' }}>
                        <Editor
                          height="100%"
                          defaultLanguage="javascript"
                          language={getLanguageFromPath(rightActiveTabPath)}
                          theme={themeStyles.monacoTheme}
                          beforeMount={registerMonacoThemes}
                          value={rightFileContent}
                          onChange={(value) => setRightFileContent(value || '')}
                          options={{
                            minimap: { enabled: editorMinimap },
                            fontSize: editorFontSize,
                            lineHeight: editorLineHeight,
                            fontFamily: editorFontFamily,
                            wordWrap: editorWordWrap,
                            tabSize: editorTabSize,
                            automaticLayout: true
                          }}
                        />
                      </div>
                    )
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, color: themeStyles.textMuted, gap: '10px' }}>
                      <Code size={40} color={themeStyles.textDim} />
                      <span style={{ fontSize: '13px' }}>Select a file for split view.</span>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>

          <style>{`
            .md-preview-light h1, .md-preview-light h2, .md-preview-light h3 { color: #0f172a; font-weight: 700; margin: 1.2em 0 0.5em; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.3em; }
            .md-preview-light code { background: rgba(0,0,0,0.06); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 0.88em; color: #b91c1c; }
            .md-preview-light pre { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; overflow-x: auto; }
            .md-preview-light pre code { background: none; padding: 0; color: #0f172a; }
            .md-preview-light blockquote { border-left: 3px solid #2563eb; margin: 0; padding: 4px 16px; color: #64748b; background: #f8fafc; }
            .md-preview-light table { border-collapse: collapse; width: 100%; margin: 16px 0; }
            .md-preview-light th, .md-preview-light td { border: 1px solid #e2e8f0; padding: 8px 12px; text-align: left; }

            .md-preview-dark h1, .md-preview-dark h2, .md-preview-dark h3 { color: #ffffff; font-weight: 700; margin: 1.2em 0 0.5em; border-bottom: 1px solid #3e3e3e; padding-bottom: 0.3em; }
            .md-preview-dark code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 0.88em; color: #f87171; }
            .md-preview-dark pre { background: #1e1e1e; border: 1px solid #3e3e3e; border-radius: 8px; padding: 16px; overflow-x: auto; }
            .md-preview-dark pre code { background: none; padding: 0; color: #d4d4d4; }
            .md-preview-dark blockquote { border-left: 3px solid #2563eb; margin: 0; padding: 4px 16px; color: #858585; background: #252526; }
            .md-preview-dark table { border-collapse: collapse; width: 100%; margin: 16px 0; }
            .md-preview-dark th, .md-preview-dark td { border: 1px solid #3e3e3e; padding: 8px 12px; text-align: left; color: #cccccc; }
          `}</style>
          
          {/* ── IDE Bottom Resizable Panel ── */}
          {bottomPanelOpen && (
            <div style={{ height: `${bottomPanelHeight}px`, display: 'flex', flexDirection: 'column', borderTop: `1px solid ${themeStyles.border}`, flexShrink: 0, minHeight: 0, position: 'relative', background: themeStyles.bgPanel }}>
              {/* Draggable resize handle */}
              <div
                onMouseDown={handleBottomMouseDown}
                style={{
                  position: 'absolute',
                  top: '-4px',
                  left: 0,
                  right: 0,
                  height: '5px',
                  cursor: 'row-resize',
                  background: 'transparent',
                  zIndex: 100
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#2563eb'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              />

              {/* Bottom Panel Tabs (Terminal/DB Shell/Output) */}
              <div style={{
                height: '32px',
                background: themeStyles.bgHeader,
                borderBottom: `1px solid ${themeStyles.border}`,
                display: 'flex',
                alignItems: 'center',
                padding: '0 12px'
              }}>
                {[
                  { id: 'terminal', label: 'Terminal' },
                  { id: 'dbShell', label: 'Database Shell' },
                  { id: 'problems', label: 'Problems' }
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setBottomTab(tab.id)}
                    style={{
                      background: bottomTab === tab.id ? themeStyles.bgActive : 'transparent',
                      border: 'none',
                      color: bottomTab === tab.id ? themeStyles.text : themeStyles.textMuted,
                      padding: '4px 14px',
                      height: '100%',
                      fontSize: '12px',
                      fontWeight: bottomTab === tab.id ? 600 : 500,
                      cursor: 'pointer',
                      borderTop: bottomTab === tab.id ? '2px solid #2563eb' : 'none',
                      borderRight: bottomTab === tab.id ? `1px solid ${themeStyles.border}` : 'none',
                      borderLeft: bottomTab === tab.id ? `1px solid ${themeStyles.border}` : 'none'
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Bottom tab contents */}
              <div style={{ flex: 1, padding: '12px', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                {bottomTab === 'terminal' ? (
                  <TerminalView jobId={selectedDep?.jobId} filesTree={filesTree} deployments={deployments} dbCollections={dbCollections} selectedDep={selectedDep} fontSize={terminalFontSize} themeStyles={themeStyles} />
                ) : bottomTab === 'dbShell' ? (
                  <DbTerminalView selectedId={selectedId} dbType={shellDbType} deployments={deployments} fontSize={terminalFontSize} themeStyles={themeStyles} />
                ) : (
                  <div style={{ fontSize: '12px', color: themeStyles.textMuted, fontStyle: 'italic' }}>No problems detected in workspace files.</div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── IDE Right Chat Bot Sidebar (drag-resizable, theme-aware) ── */}
        {chatPanelOpen && (
          <div style={{
            width: `${chatSidebarWidth || 320}px`,
            background: themeStyles.bgMain,
            borderLeft: `1px solid ${themeStyles.border}`,
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            position: 'relative',
            minWidth: '220px',
            maxWidth: '600px',
            color: themeStyles.text
          }}>
            {/* Drag handle on left edge of chat sidebar */}
            <div
              onMouseDown={handleDragStart}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: '5px',
                cursor: 'col-resize',
                background: 'transparent',
                zIndex: 10,
                transition: 'background 0.15s'
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(37,99,235,0.25)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            />
            {/* Chat list selector dropdown */}
            <div style={{ padding: '10px 14px', borderBottom: `1px solid ${themeStyles.border}`, display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyStyle: 'space-between' }}>
                <span style={{ fontSize: '11px', textTransform: 'uppercase', fontWeight: 700, color: themeStyles.textMuted, letterSpacing: '0.5px' }}>AI Agent Chat</span>
                <button
                  onClick={handleCreateChat}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: themeStyles.textMuted }}
                >
                  <Plus size={14} />
                </button>
              </div>
              <select
                value={activeChatId}
                onChange={(e) => handleSelectChat(e.target.value)}
                style={{ width: '100%', padding: '4px 8px', borderRadius: '4px', border: `1px solid ${themeStyles.border}`, background: themeStyles.inputBg, color: themeStyles.text, fontSize: '12px' }}
              >
                {chats.map(c => <option key={c._id} value={c._id}>{c.title}</option>)}
              </select>
            </div>

            {/* Chat history messages area */}
            <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {chatMessages.map((msg, idx) => {
                const isUser = msg.role === 'user';
                return (
                  <div key={idx} style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '6px',
                    alignSelf: isUser ? 'flex-end' : 'flex-start',
                    maxWidth: '90%',
                    minWidth: 0
                  }}>
                    {/* Undo Button on the LEFT of user query bubbles */}
                    {isUser && (
                      <button
                        onClick={() => handleUndo && handleUndo(idx)}
                        title="Undo changes up to this point"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#64748b',
                          cursor: 'pointer',
                          padding: '4px',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          transition: 'all 0.15s',
                          outline: 'none',
                          alignSelf: 'center'
                        }}
                        onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
                        onMouseLeave={e => e.currentTarget.style.color = '#64748b'}
                      >
                        <RotateCcw size={13} />
                      </button>
                    )}
                    <div style={{
                      background: isUser ? '#2563eb' : themeStyles.bgHeader,
                      border: isUser ? 'none' : `1px solid ${themeStyles.border}`,
                      color: isUser ? '#ffffff' : themeStyles.text,
                      padding: '8px 12px',
                      borderRadius: '8px',
                      fontSize: '12.5px',
                      lineHeight: '1.4',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                      flex: 1,
                      minWidth: 0,
                      maxWidth: '100%',
                      overflowWrap: 'break-word',
                      wordBreak: 'break-word'
                    }}>
                      {/* File modifications patches summary */}
                      {msg.role === 'agent' && msg.patches && msg.patches.length > 0 && (
                        <div style={{
                          background: 'rgba(0,0,0,0.15)',
                          border: `1px solid ${themeStyles.border}`,
                          borderRadius: '6px',
                          padding: '8px',
                          marginBottom: '4px',
                          flex: 1
                        }}>
                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            flexWrap: 'wrap'
                          }}>
                            {/* Files changed pill */}
                            <button
                              onClick={() => toggleDiffExpansion && toggleDiffExpansion(idx)}
                              title="Click to view changed files details"
                              style={{
                                background: 'rgba(0,0,0,0.25)',
                                border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: '20px',
                                padding: '2px 8px',
                                fontSize: '11px',
                                color: '#94a3b8',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '5px',
                                fontFamily: 'monospace'
                              }}
                            >
                              <span style={{ color: '#6b7280' }}>
                                {msg.patches.length} file{msg.patches.length !== 1 ? 's' : ''} changed
                              </span>
                              <span style={{ color: '#4ade80', fontWeight: 700 }}>
                                +{msg.patches.reduce((s, p) => s + (p.added || 0), 0)}
                              </span>
                              <span style={{ color: '#f87171', fontWeight: 700 }}>
                                -{msg.patches.reduce((s, p) => s + (p.removed || 0), 0)}
                              </span>
                              <span style={{ color: '#6b7280', marginLeft: '2px' }}>
                                {expandedDiffs && expandedDiffs[idx] ? '▼' : '▶'}
                              </span>
                            </button>

                            {/* Rollback button */}
                            {!msg.rolledBack ? (
                              <button
                                onClick={() => handleRollback && handleRollback(idx)}
                                title="Rollback these changes"
                                style={{
                                  background: 'rgba(239,68,68,0.08)',
                                  border: '1px solid rgba(239,68,68,0.25)',
                                  borderRadius: '20px',
                                  padding: '2px 8px',
                                  fontSize: '11px',
                                  color: '#f87171',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  transition: 'all 0.15s',
                                  fontWeight: 500
                                }}
                                onMouseEnter={e => {
                                  e.currentTarget.style.background = 'rgba(239,68,68,0.18)';
                                  e.currentTarget.style.borderColor = 'rgba(239,68,68,0.5)';
                                }}
                                onMouseLeave={e => {
                                  e.currentTarget.style.background = 'rgba(239,68,68,0.08)';
                                  e.currentTarget.style.borderColor = 'rgba(239,68,68,0.25)';
                                }}
                              >
                                <RotateCcw size={10} />
                                Rollback
                              </button>
                            ) : (
                              <span style={{
                                fontSize: '11px',
                                color: '#a3a3a3',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                                fontStyle: 'italic'
                              }}>
                                <RotateCcw size={10} />
                                Rolled back
                              </span>
                            )}
                          </div>

                          {/* Collapsible files diff list */}
                          {expandedDiffs && expandedDiffs[idx] && (
                            <div style={{
                              background: 'rgba(15, 23, 42, 0.45)',
                              border: '1px solid rgba(255, 255, 255, 0.08)',
                              borderRadius: '8px',
                              padding: '6px 8px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '4px',
                              marginTop: '2px',
                              maxWidth: '100%',
                              boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.2)'
                            }}>
                              {msg.patches.map((p, pIdx) => {
                                const parts = p.file.split('/');
                                const fileName = parts[parts.length - 1];
                                const dirName = parts.slice(0, -1).join('/');
                                const displayPath = dirName ? `.../${dirName}` : '';
                                return (
                                  <div
                                    key={pIdx}
                                    onClick={() => {
                                      if (handleSelectFile) {
                                        handleSelectFile(p.file);
                                      }
                                    }}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'space-between',
                                      padding: '5px 8px',
                                      borderRadius: '4px',
                                      cursor: 'pointer',
                                      background: 'rgba(255, 255, 255, 0.02)',
                                      transition: 'background 0.15s',
                                      fontSize: '12px',
                                      fontFamily: 'monospace'
                                    }}
                                    onMouseEnter={e => {
                                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)';
                                    }}
                                    onMouseLeave={e => {
                                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
                                    }}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                                      {/* Orange Dot Bullet */}
                                      <span style={{
                                        width: '6px',
                                        height: '6px',
                                        borderRadius: '50%',
                                        background: '#f97316',
                                        display: 'inline-block',
                                        flexShrink: 0
                                      }} />
                                      
                                      {/* File stats */}
                                      <div style={{ display: 'flex', gap: '6px', fontSize: '11px', flexShrink: 0 }}>
                                        <span style={{ color: '#4ade80', fontWeight: 600 }}>+{p.added || 0}</span>
                                        <span style={{ color: '#f87171', fontWeight: 600 }}>-{p.removed || 0}</span>
                                      </div>

                                      {/* File Name */}
                                      <span style={{ color: '#f1f5f9', fontWeight: 500, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                                        {fileName}
                                      </span>
                                    </div>

                                    {/* Directory path */}
                                    {displayPath && (
                                      <span style={{ color: 'var(--text-muted)', fontSize: '10px', marginLeft: '12px', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                                        {displayPath}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      {(() => {
                        if (!msg.text) return null;
                        const { thoughts, cleanText } = parseThoughts(msg.text);
                        if (thoughts) {
                          const duration = msg.durationSec !== undefined ? msg.durationSec : null;
                          const summaryText = msg.isStreaming 
                            ? `Thinking Process (${duration || 0}s...)`
                            : `Thinking Process (${duration || 0}s)`;

                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0, maxWidth: '100%' }}>
                              <details 
                                open={msg.isStreaming}
                                style={{
                                  background: themeStyles.hoverBg,
                                  border: `1px solid ${themeStyles.border}`,
                                  borderRadius: '6px',
                                  padding: '4px 8px',
                                  fontSize: '11px',
                                  maxWidth: '100%'
                                }}
                              >
                                <summary style={{ cursor: 'pointer', color: themeStyles.textMuted, fontWeight: 500, outline: 'none' }}>
                                  {summaryText}
                                </summary>
                                <div style={{ marginTop: '4px', whiteSpace: 'pre-wrap', color: themeStyles.textMuted, fontFamily: 'monospace', fontSize: '10.5px', borderTop: `1px solid ${themeStyles.border}`, paddingTop: '4px', maxWidth: '100%', overflowX: 'auto' }}>
                                  {thoughts}
                                </div>
                              </details>
                              {cleanText && <div style={{ minWidth: 0, maxWidth: '100%', overflowX: 'auto' }}>{renderMarkdown(cleanText, isUser, !isUser, themeStyles)}</div>}
                            </div>
                          );
                        }
                        return <div style={{ minWidth: 0, maxWidth: '100%', overflowX: 'auto' }}>{renderMarkdown(msg.text, isUser, !isUser, themeStyles)}</div>;
                      })()}
                    </div>
                  </div>
                );
              })}
              {isAgentTyping && <div style={{ fontSize: '12px', fontStyle: 'italic', color: themeStyles.textMuted }}>Agent is thinking...</div>}
              <div ref={chatEndRef} />
            </div>

            {/* Chat input box */}
            <div style={{ padding: '10px', borderTop: `1px solid ${themeStyles.border}` }}>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSendChat(); }}
                  placeholder="Ask agent to code..."
                  style={{ flex: 1, padding: '6px 10px', borderRadius: '4px', border: `1px solid ${themeStyles.border}`, background: themeStyles.inputBg, color: themeStyles.text, fontSize: '12px' }}
                />
                <button
                  onClick={handleSendChat}
                  style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: '4px', padding: '0 12px', cursor: 'pointer' }}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── IDE Status Bar (Theme-aware) ── */}
      {statusBarOpen && (
        <div style={{
          height: '24px',
          background: themeStyles.bgHeader,
          borderTop: `1px solid ${themeStyles.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          fontSize: '11px',
          color: themeStyles.textMuted,
          flexShrink: 0
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e' }} />
            <span>Connected to Preview Sandbox</span>
          </div>
          <div>
            <span>Line 1, Column 1 | UTF-8 | JavaScript</span>
          </div>
        </div>
      )}

      {/* Settings Panel & Tab Context Menu Overlays */}
      <IDESettingsPanel
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        themeStyles={themeStyles}
        ideTheme={ideTheme}
        setIdeTheme={setIdeTheme}
        editorFontSize={editorFontSize}
        setEditorFontSize={setEditorFontSize}
        editorLineHeight={editorLineHeight}
        setEditorLineHeight={setEditorLineHeight}
        editorFontFamily={editorFontFamily}
        setEditorFontFamily={setEditorFontFamily}
        editorMinimap={editorMinimap}
        setEditorMinimap={setEditorMinimap}
        editorWordWrap={editorWordWrap}
        setEditorWordWrap={setEditorWordWrap}
        editorTabSize={editorTabSize}
        setEditorTabSize={setEditorTabSize}
        autoSaveEnabled={autoSaveEnabled}
        setAutoSaveEnabled={setAutoSaveEnabled}
        terminalFontSize={terminalFontSize}
        setTerminalFontSize={setTerminalFontSize}
        agentSecurityMode={agentSecurityMode}
        setAgentSecurityMode={setAgentSecurityMode}
        terminalAutoExecution={terminalAutoExecution}
        setTerminalAutoExecution={setTerminalAutoExecution}
        enableShellIntegration={enableShellIntegration}
        setEnableShellIntegration={setEnableShellIntegration}
      />

      {tabContextMenu && (
        <TabContextMenu
          x={tabContextMenu.x}
          y={tabContextMenu.y}
          tab={tabContextMenu.tab}
          pane={tabContextMenu.pane}
          openTabs={openTabs}
          activeTabPath={activeTabPath}
          rightActiveTabPath={rightActiveTabPath}
          onClose={() => setTabContextMenu(null)}
          onCloseTab={handleCloseTab}
          setOpenTabs={setOpenTabs}
          setActiveTabPath={setActiveTabPath}
          setRightActiveTabPath={setRightActiveTabPath}
          setIsSplitView={setIsSplitView}
          onCopyPath={handleCopyPath}
          onCopyRelPath={handleCopyRelPath}
          filesTree={filesTree}
          handleSelectFile={handleSelectFile}
        />
      )}
    </div>
  );
}

// Helper to recursively render file tree node
function FileTreeNode({ node, onSelectFile, selectedPath, onContextMenu, themeStyles = {} }) {
  const [isOpen, setIsOpen] = useState(false);
  const isSelected = selectedPath === node.path;
  
  const textCol = themeStyles.text || '#0f172a';
  const textMutedCol = themeStyles.textMuted || '#64748b';
  const hoverColor = themeStyles.hoverBg || 'rgba(0,0,0,0.04)';
  const borderCol = themeStyles.border || '#e2e8f0';

  if (node.isDir) {
    return (
      <div style={{ marginLeft: '12px', userSelect: 'none' }}>
        <div 
          onClick={() => setIsOpen(!isOpen)}
          onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node); }}
          style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '6px', 
            padding: '4px 6px', 
            cursor: 'pointer',
            borderRadius: '4px',
            color: textCol,
            fontSize: '13px',
            fontWeight: 500
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = hoverColor}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
        >
          {getFileIcon(node.name, true)}
          <span>{node.name}</span>
        </div>
        {isOpen && node.children && (
          <div style={{ borderLeft: `1px solid ${borderCol}`, marginLeft: '6px' }}>
            {node.children.map((child, idx) => (
              <FileTreeNode 
                key={idx} 
                node={child} 
                onSelectFile={onSelectFile} 
                selectedPath={selectedPath}
                onContextMenu={onContextMenu}
                themeStyles={themeStyles}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div 
      draggable={true}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', node.path);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => onSelectFile(node.path)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node); }}
      style={{ 
        marginLeft: '12px',
        display: 'flex', 
        alignItems: 'center', 
        gap: '6px', 
        padding: '4px 6px', 
        cursor: 'pointer',
        borderRadius: '4px',
        color: isSelected ? '#ffffff' : textMutedCol,
        backgroundColor: isSelected ? '#2563eb' : 'transparent',
        fontSize: '13px',
        userSelect: 'none'
      }}
      onMouseEnter={(e) => {
        if (!isSelected) e.currentTarget.style.backgroundColor = hoverColor;
      }}
      onMouseLeave={(e) => {
        if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
      }}
    >
      {getFileIcon(node.name, false)}
      <span>{node.name}</span>
    </div>
  );
}

const parseThoughts = (text) => {
  if (!text) return { thoughts: '', cleanText: '' };
  const thoughtStartIdx = text.search(/<(thought|thinking)>/i);
  if (thoughtStartIdx === -1) {
    return { thoughts: '', cleanText: text };
  }
  const tagMatch = text.match(/<(thought|thinking)>/i);
  const tagName = tagMatch[1];
  const tagOpenLength = tagName.length + 2;
  const contentStartIdx = thoughtStartIdx + tagOpenLength;
  const closingRegex = new RegExp(`</${tagName}>`, 'i');
  const thoughtEndIdx = text.search(closingRegex);
  if (thoughtEndIdx !== -1) {
    const thoughts = text.substring(contentStartIdx, thoughtEndIdx).trim();
    const cleanText = (text.substring(0, thoughtStartIdx) + text.substring(thoughtEndIdx + tagOpenLength + 1)).trim();
    return { thoughts, cleanText };
  } else {
    const thoughts = text.substring(contentStartIdx).trim();
    const cleanText = text.substring(0, thoughtStartIdx).trim();
    return { thoughts, cleanText };
  }
};

const renderMarkdown = (text, isUser = false, isLightTheme = false, themeStyles = null) => {
  if (!text) return null;

  const isLight = isLightTheme || (themeStyles ? themeStyles.monacoTheme === 'vs' : false);
  const textColor = isUser ? '#ffffff' : (themeStyles ? themeStyles.text : (isLight ? '#1e293b' : '#cccccc'));
  const boldColor = isUser ? '#ffffff' : (themeStyles ? themeStyles.text : (isLight ? '#0f172a' : '#ffffff'));
  const headerColor = isUser ? '#ffffff' : (themeStyles ? themeStyles.text : (isLight ? '#0f172a' : '#ffffff'));
  const quoteColor = isUser ? 'rgba(255,255,255,0.85)' : (themeStyles ? themeStyles.textMuted : (isLight ? '#475569' : '#888888'));
  const listColor = isUser ? '#ffffff' : (themeStyles ? themeStyles.text : (isLight ? '#1e293b' : '#cccccc'));
  const codeColor = isUser ? '#ffd2e8' : (isLight ? '#b91c1c' : '#f87171');
  const codeBg = isUser ? 'rgba(255,255,255,0.15)' : (themeStyles ? themeStyles.bgMain : (isLight ? '#f1f5f9' : '#2d2d2d'));
  const codeBorder = isUser ? 'rgba(255,255,255,0.1)' : (themeStyles ? themeStyles.border : (isLight ? '#e2e8f0' : '#3e3e3e'));

  // Split by code blocks first
  const parts = text.split(/(```[\s\S]*?```)/g);

  return parts.map((part, index) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const match = part.match(/```(\w*)\r?\n([\s\S]*?)```/);
      const language = match ? match[1] : '';
      const code = match ? match[2] : part.slice(3, -3);

      return (
        <pre key={index} style={{
          background: '#0f172a',
          padding: '12px',
          borderRadius: '6px',
          border: '1px solid rgba(255,255,255,0.06)',
          overflowX: 'auto',
          maxWidth: '100%',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          margin: '8px 0',
          fontFamily: 'Consolas, Monaco, monospace',
          fontSize: '12px',
          color: '#cbd5e1',
          lineHeight: '1.5'
        }}>
          {language && (
            <div style={{
              fontSize: '10px',
              color: 'var(--accent-blue)',
              textTransform: 'uppercase',
              marginBottom: '6px',
              fontWeight: 600,
              letterSpacing: '0.05em',
              fontFamily: 'sans-serif'
            }}>
              {language}
            </div>
          )}
          <code style={{ fontFamily: 'inherit', color: 'inherit' }}>{code}</code>
        </pre>
      );
    }

    // Process blocks line-by-line
    const lines = part.split('\n');
    const elements = [];
    let listItems = [];
    let inList = false;

    const flushList = (key) => {
      if (listItems.length > 0) {
        elements.push(
          <ul key={key} style={{ margin: '8px 0', paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '4px', listStyleType: 'disc' }}>
            {listItems}
          </ul>
        );
        listItems = [];
        inList = false;
      }
    };

    const parseInline = (lineText) => {
      if (!lineText) return '';
      const boldParts = lineText.split(/(\*\*.*?\*\*)/g);
      return boldParts.map((bp, bpIdx) => {
        if (bp.startsWith('**') && bp.endsWith('**')) {
          const boldText = bp.slice(2, -2);
          return <strong key={bpIdx} style={{ fontWeight: 700, color: boldColor }}>{boldText}</strong>;
        }
        
        const codeParts = bp.split(/(`.*?`)/g);
        return codeParts.map((cp, cpIdx) => {
          if (cp.startsWith('`') && cp.endsWith('`')) {
            const codeText = cp.slice(1, -1);
            return (
              <code key={cpIdx} style={{
                background: codeBg,
                padding: '2px 5px',
                borderRadius: '4px',
                fontFamily: 'monospace',
                fontSize: '12px',
                color: codeColor,
                border: `1px solid ${codeBorder}`
              }}>
                {codeText}
              </code>
            );
          }
          return cp;
        });
      });
    };

    lines.forEach((line, lineIdx) => {
      const trimmed = line.trim();

      if (trimmed.startsWith('#')) {
        flushList(`list-before-h-${lineIdx}`);
        const levelMatch = trimmed.match(/^#+/);
        const level = levelMatch ? levelMatch[0].length : 1;
        const headerText = trimmed.replace(/^#+\s*/, '');
        const size = level === 1 ? '16px' : level === 2 ? '14px' : '13px';
        const margin = level === 1 ? '14px 0 6px 0' : '10px 0 4px 0';
        elements.push(
          <div key={`h-${lineIdx}`} style={{ fontSize: size, fontWeight: 700, margin: margin, color: headerColor }}>
            {parseInline(headerText)}
          </div>
        );
      }
      else if (trimmed.startsWith('>')) {
        flushList(`list-before-q-${lineIdx}`);
        const quoteText = trimmed.replace(/^>\s*/, '');
        elements.push(
          <div key={`q-${lineIdx}`} style={{
            borderLeft: '3px solid var(--accent-blue)',
            background: isUser ? 'rgba(255,255,255,0.08)' : 'rgba(59, 130, 246, 0.04)',
            padding: '8px 12px',
            margin: '8px 0',
            borderRadius: '0 4px 4px 0',
            color: quoteColor,
            fontStyle: 'italic',
            lineHeight: '1.5'
          }}>
            {parseInline(quoteText)}
          </div>
        );
      }
      else if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
        inList = true;
        const itemText = trimmed.replace(/^[-*]\s*/, '');
        listItems.push(
          <li key={`li-${lineIdx}`} style={{ color: listColor, fontSize: '13px', lineHeight: '1.4' }}>
            {parseInline(itemText)}
          </li>
        );
      }
      else if (trimmed) {
        flushList(`list-before-p-${lineIdx}`);
        elements.push(
          <div key={`p-${lineIdx}`} style={{ margin: '4px 0', color: textColor, fontSize: '13px', lineHeight: '1.4' }}>
            {parseInline(line)}
          </div>
        );
      } else {
        flushList(`list-before-br-${lineIdx}`);
      }
    });

    flushList(`list-final-${index}`);
    return <div key={index}>{elements}</div>;
  });
};

const dbShellPresets = {
  postgres: {
    placeholder: "SELECT * FROM users LIMIT 5;\nINSERT INTO users (username, password) VALUES ('bob', 'secure123');",
    description: "Enter standard PostgreSQL queries. Statements run inside a single transaction fallback.",
    templates: [
      { label: "List Tables", query: "SELECT table_name FROM information_schema.tables WHERE table_schema='public';" },
      { label: "Show Schema", query: "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'users';" },
      { label: "Select Users", query: "SELECT * FROM users LIMIT 10;" }
    ]
  },
  mysql: {
    placeholder: "SELECT * FROM users LIMIT 5;\nINSERT INTO users (username, password) VALUES ('bob', 'secure123');",
    description: "Enter standard MySQL queries. Statements run inside a transaction.",
    templates: [
      { label: "List Tables", query: "SHOW TABLES;" },
      { label: "Describe Users", query: "DESCRIBE users;" },
      { label: "Select Users", query: "SELECT * FROM users LIMIT 10;" }
    ]
  },
  mariadb: {
    placeholder: "SELECT * FROM users LIMIT 5;",
    description: "Enter MariaDB SQL statements.",
    templates: [
      { label: "List Tables", query: "SHOW TABLES;" },
      { label: "Describe Users", query: "DESCRIBE users;" },
      { label: "Select Users", query: "SELECT * FROM users LIMIT 10;" }
    ]
  },
  sqlite: {
    placeholder: "SELECT * FROM users LIMIT 5;",
    description: "Enter SQLite statements. Queries run directly against the active sqlite database file.",
    templates: [
      { label: "List Tables", query: ".tables" },
      { label: "Table Schema", query: "PRAGMA table_info(users);" },
      { label: "Select Users", query: "SELECT * FROM users LIMIT 10;" }
    ]
  },
  mongodb: {
    placeholder: "db.users.find().limit(5).toArray();\ndb.users.insertOne({ username: 'bob', role: 'user' });",
    description: "Enter mongosh JavaScript commands. Make sure to end array results with `.toArray()` to print full output.",
    templates: [
      { label: "Find Users", query: "db.users.find().limit(5).toArray()" },
      { label: "Count Users", query: "db.users.countDocuments()" },
      { label: "List Collections", query: "db.getCollectionNames()" }
    ]
  },
  redis: {
    placeholder: "KEYS *\nGET mykey\nSET mykey \"hello\"\nDEL mykey",
    description: "Enter raw Redis CLI command strings.",
    templates: [
      { label: "List Keys", query: "KEYS *" },
      { label: "Ping Server", query: "PING" },
      { label: "Get Info", query: "INFO" }
    ]
  },
  mssql: {
    placeholder: "SELECT * FROM users;\nGO",
    description: "Enter Microsoft SQL Server statements.",
    templates: [
      { label: "List Tables", query: "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE';" },
      { label: "Select Users", query: "SELECT TOP 10 * FROM users;" }
    ]
  },
  oracle: {
    placeholder: "SELECT * FROM users WHERE rownum <= 5;",
    description: "Enter Oracle SQL*Plus database queries.",
    templates: [
      { label: "Show Tables", query: "SELECT table_name FROM user_tables;" },
      { label: "Select Users", query: "SELECT * FROM users WHERE rownum <= 10;" }
    ]
  },
  cassandra: {
    placeholder: "SELECT * FROM users LIMIT 5;",
    description: "Enter Cassandra Query Language (CQL) statements.",
    templates: [
      { label: "Show Tables", query: "DESCRIBE TABLES;" },
      { label: "Select Users", query: "SELECT * FROM users LIMIT 10;" }
    ]
  }
};

const getQueryValidationError = (query, dbType) => {
  if (!query.trim()) return '';
  const trimmed = query.trim().toUpperCase();
  const isSql = ['postgres', 'mysql', 'mariadb', 'sqlite', 'mssql', 'oracle', 'cassandra'].includes(dbType);
  
  if (isSql) {
    if (query.trim().startsWith('db.') || query.trim().startsWith('show dbs') || query.trim().startsWith('use ')) {
      return 'This is a SQL/CQL database. Queries must be SQL statements (e.g. SELECT, INSERT, UPDATE, DELETE). MongoDB syntax is not supported here.';
    }
    if (trimmed.startsWith('GET ') || trimmed.startsWith('SET ') || trimmed.startsWith('KEYS ') || trimmed.startsWith('HGET ') || trimmed.startsWith('PING')) {
      return 'This is a SQL/CQL database. Redis command syntax is not supported here.';
    }
    const sqlKeywords = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'PRAGMA', 'DESCRIBE', 'SHOW', 'SET', 'EXPLAIN', 'WITH', 'BEGIN', 'COMMIT', 'ROLLBACK'];
    const firstWord = trimmed.split(/\s+/)[0];
    if (firstWord && !sqlKeywords.some(kw => firstWord.startsWith(kw))) {
      return 'Warning: Query does not start with a standard SQL/CQL keyword (e.g. SELECT, INSERT). Please verify your syntax.';
    }
  } else if (dbType === 'mongodb') {
    if (trimmed.startsWith('SELECT ') || trimmed.startsWith('INSERT ') || trimmed.startsWith('UPDATE ') || trimmed.startsWith('DELETE ') || trimmed.startsWith('CREATE ') || trimmed.startsWith('DROP ')) {
      return 'This is a MongoDB database. SQL statements are not supported here. Please use MongoDB JS syntax (e.g., db.collection.find()).';
    }
    if (trimmed.startsWith('GET ') || trimmed.startsWith('SET ') || trimmed.startsWith('KEYS ') || trimmed.startsWith('HGET ') || trimmed.startsWith('PING')) {
      return 'This is a MongoDB database. Redis command syntax is not supported here.';
    }
    if (!query.trim().startsWith('db.') && !query.trim().startsWith('show ') && !query.trim().startsWith('use ')) {
      return 'MongoDB queries typically start with "db." (e.g. db.users.find()).';
    }
  } else if (dbType === 'redis') {
    if (trimmed.startsWith('SELECT ') || trimmed.startsWith('INSERT ') || trimmed.startsWith('UPDATE ') || trimmed.startsWith('DELETE ')) {
      return 'This is a Redis database. SQL statements are not supported here. Please use Redis commands (e.g. GET, SET, KEYS).';
    }
    if (query.trim().startsWith('db.')) {
      return 'This is a Redis database. MongoDB syntax is not supported here. Please use Redis commands.';
    }
  }
  return '';
};

export default function Agent() {
  const [ideTheme, setIdeTheme] = useState('dark');
  const [agentSecurityMode, setAgentSecurityMode] = useState('Sandboxed');
  const [terminalAutoExecution, setTerminalAutoExecution] = useState('Request Review');
  const [enableShellIntegration, setEnableShellIntegration] = useState(true);

  const themeStyles = {
    light: {
      bgMain: '#f8fafc', bgPanel: '#ffffff', bgHeader: '#f1f5f9', bgActive: '#ffffff', bgInactive: '#f1f5f9',
      border: '#e2e8f0', text: '#0f172a', textMuted: '#64748b', textDim: '#94a3b8', inputBg: '#ffffff',
      hoverBg: 'rgba(0,0,0,0.04)', selectionBg: 'rgba(37,99,235,0.1)', monacoTheme: 'vs'
    },
    dark: {
      bgMain: '#1e1e1e', bgPanel: '#252526', bgHeader: '#2d2d2d', bgActive: '#1e1e1e', bgInactive: '#2d2d2d',
      border: '#3e3e3e', text: '#cccccc', textMuted: '#858585', textDim: '#555555', inputBg: '#3c3c3c',
      hoverBg: 'rgba(255,255,255,0.05)', selectionBg: 'rgba(37,99,235,0.2)', monacoTheme: 'vs-dark'
    },
    'hc-black': {
      bgMain: '#000000', bgPanel: '#000000', bgHeader: '#0a0a0a', bgActive: '#000000', bgInactive: '#0a0a0a',
      border: '#00ff00', text: '#ffffff', textMuted: '#00ff00', textDim: '#008800', inputBg: '#0a0a0a',
      hoverBg: 'rgba(0,255,0,0.06)', selectionBg: 'rgba(0,255,0,0.15)', monacoTheme: 'hc-black'
    },
    abyss: {
      bgMain: '#000c18', bgPanel: '#001224', bgHeader: '#001e36', bgActive: '#001224', bgInactive: '#001e36',
      border: '#102a45', text: '#88aacc', textMuted: '#597080', textDim: '#405060', inputBg: '#001e36',
      hoverBg: 'rgba(255,255,255,0.05)', selectionBg: 'rgba(0,128,255,0.15)', monacoTheme: 'abyss'
    },
    'tokyo-night': {
      bgMain: '#1a1b26', bgPanel: '#16161e', bgHeader: '#1f2335', bgActive: '#16161e', bgInactive: '#1f2335',
      border: '#24283b', text: '#a9b1d6', textMuted: '#565f89', textDim: '#383e56', inputBg: '#1f2335',
      hoverBg: 'rgba(255,255,255,0.04)', selectionBg: 'rgba(37,99,235,0.2)', monacoTheme: 'tokyo-night'
    },
    'solarized-dark': {
      bgMain: '#002b36', bgPanel: '#073642', bgHeader: '#00212b', bgActive: '#073642', bgInactive: '#00212b',
      border: '#586e75', text: '#839496', textMuted: '#586e75', textDim: '#586e75', inputBg: '#00212b',
      hoverBg: 'rgba(255,255,255,0.04)', selectionBg: 'rgba(42,161,152,0.15)', monacoTheme: 'solarized-dark'
    },
    'solarized-light': {
      bgMain: '#fdf6e3', bgPanel: '#eee8d5', bgHeader: '#fdf6e3', bgActive: '#eee8d5', bgInactive: '#fdf6e3',
      border: '#93a1a1', text: '#657b83', textMuted: '#93a1a1', textDim: '#93a1a1', inputBg: '#fdf6e3',
      hoverBg: 'rgba(0,0,0,0.03)', selectionBg: 'rgba(42,161,152,0.1)', monacoTheme: 'solarized-light'
    },
    synthwave84: {
      bgMain: '#2b213a', bgPanel: '#241b2f', bgHeader: '#1e1627', bgActive: '#241b2f', bgInactive: '#1e1627',
      border: '#463465', text: '#f0efe7', textMuted: '#807a8a', textDim: '#5a4c73', inputBg: '#1e1627',
      hoverBg: 'rgba(255,255,255,0.05)', selectionBg: 'rgba(255,122,230,0.2)', monacoTheme: 'synthwave84'
    },
    monokai: {
      bgMain: '#272822', bgPanel: '#1e1f1c', bgHeader: '#2d2e2b', bgActive: '#1e1f1c', bgInactive: '#2d2e2b',
      border: '#3e3d32', text: '#f8f8f2', textMuted: '#75715e', textDim: '#49483e', inputBg: '#2d2e2b',
      hoverBg: 'rgba(255,255,255,0.05)', selectionBg: 'rgba(249,38,114,0.15)', monacoTheme: 'monokai'
    },
    'powershell-ise': {
      bgMain: '#000080', bgPanel: '#0000a0', bgHeader: '#000060', bgActive: '#0000a0', bgInactive: '#000060',
      border: '#0080ff', text: '#ffffff', textMuted: '#00ffff', textDim: '#0080ff', inputBg: '#000060',
      hoverBg: 'rgba(255,255,255,0.08)', selectionBg: 'rgba(255,255,255,0.2)', monacoTheme: 'powershell-ise'
    },
    'quiet-light': {
      bgMain: '#f5f5f5', bgPanel: '#ffffff', bgHeader: '#e8e8e8', bgActive: '#ffffff', bgInactive: '#e8e8e8',
      border: '#dddddd', text: '#333333', textMuted: '#777777', textDim: '#999999', inputBg: '#e8e8e8',
      hoverBg: 'rgba(0,0,0,0.04)', selectionBg: 'rgba(0,0,255,0.05)', monacoTheme: 'quiet-light'
    },
    red: {
      bgMain: '#390000', bgPanel: '#2a0000', bgHeader: '#1f0000', bgActive: '#2a0000', bgInactive: '#1f0000',
      border: '#5d0000', text: '#ffcccc', textMuted: '#ff6666', textDim: '#990000', inputBg: '#1f0000',
      hoverBg: 'rgba(255,255,255,0.06)', selectionBg: 'rgba(255,0,0,0.15)', monacoTheme: 'red'
    }
  }[ideTheme] || {
    bgMain: '#1e1e1e', bgPanel: '#252526', bgHeader: '#2d2d2d', bgActive: '#1e1e1e', bgInactive: '#2d2d2d',
    border: '#3e3e3e', text: '#cccccc', textMuted: '#858585', textDim: '#555555', inputBg: '#3c3c3c',
    hoverBg: 'rgba(255,255,255,0.05)', selectionBg: 'rgba(37,99,235,0.2)', monacoTheme: 'vs-dark'
  };

  const [deployments, setDeployments] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [selectedDep, setSelectedDep] = useState(null);
  
  // File System State
  const [filesTree, setFilesTree] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  // File context menu state
  const [contextMenu, setContextMenu] = useState(null); // { x, y, node }
  const [clipboard, setClipboard] = useState(null); // { node, op: 'cut'|'copy' }
  const [renameTarget, setRenameTarget] = useState(null); // node
  const [renameValue, setRenameValue] = useState('');
  // Side-by-side second editor pane
  const [sideFile, setSideFile] = useState(null);
  const [sideContent, setSideContent] = useState('');
  const [isSavingFile, setIsSavingFile] = useState(false);
  // IDE overlay features
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [inFileSearchOpen, setInFileSearchOpen] = useState(false);
  const editorRef = useRef(null); // Monaco editor instance ref
  
  // Full-screen IDE Mode States
  const [ideMode, setIdeMode] = useState(false);
  const [openTabs, setOpenTabs] = useState([]); // [{path, content}]
  const [activeTabPath, setActiveTabPath] = useState(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [chatPanelOpen, setChatPanelOpen] = useState(true);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(240);
  const [bottomTab, setBottomTab] = useState('terminal');
  
  // Database Explorer State
  const [dbCollections, setDbCollections] = useState([]);
  const [activeCollection, setActiveCollection] = useState('');
  const [collectionData, setCollectionData] = useState([]);
  const [isDbLoading, setIsDbLoading] = useState(false);
  
  // Database record insertion state
  const [isInsertModalOpen, setIsInsertModalOpen] = useState(false);
  const [newRecordJson, setNewRecordJson] = useState('{\n  "name": "Jane Doe",\n  "email": "jane@example.com"\n}');
  const [insertError, setInsertError] = useState('');
  const [collectionColumns, setCollectionColumns] = useState([]); // for SQL: column names
  const [sqlRowValues, setSqlRowValues] = useState({}); // for SQL: per-column values

  // Database record edit & delete state
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editRecord, setEditRecord] = useState(null);
  const [editPkColumn, setEditPkColumn] = useState('id');
  const [editPkValue, setEditPkValue] = useState(null);
  const [editSqlRowValues, setEditSqlRowValues] = useState({});
  const [editNewRecordJson, setEditNewRecordJson] = useState('{}');
  const [editError, setEditError] = useState('');
  const [deleteConfirmPk, setDeleteConfirmPk] = useState(null);



  // AI Chat Agent State & Thread Sessions
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState('');
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const [expandedDiffs, setExpandedDiffs] = useState({});

  // Page-level WebSocket connection for streaming thoughts
  const socketRef = useRef(null);
  useEffect(() => {
    const socket = io('http://localhost:5000');
    socketRef.current = socket;
    return () => {
      socket.disconnect();
    };
  }, []);

  // Draggable chat sidebar
  const [chatSidebarWidth, setChatSidebarWidth] = useState(320);
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(320);
  
  // Current tab inside center pane
  const [centerTab, setCenterTab] = useState('editor'); // 'editor' | 'mdPreview' | 'database' | 'terminal' | 'dbShell'
  
  // Database Shell State
  const [shellQuery, setShellQuery] = useState('');
  const [shellOutput, setShellOutput] = useState('');
  const [isShellRunning, setIsShellRunning] = useState(false);
  
  // Computed DB Query Shell properties
  const shellDbType = selectedDep?.dbInitType || 'mongodb';
  const shellPreset = dbShellPresets[shellDbType] || {
    placeholder: "Enter database query...",
    description: `Run query commands inside the active ${shellDbType} container.`,
    templates: []
  };
  const shellValidationError = getQueryValidationError(shellQuery, shellDbType);
  const isShellStrictError = shellValidationError && !shellValidationError.startsWith('Warning:');
  const isRunShellDisabled = isShellRunning || !shellQuery.trim() || isShellStrictError;
  
  const chatEndRef = useRef(null);
  const abortControllerRef = useRef(null);

  // Drag-to-resize sidebar handlers
  const handleDragStart = useCallback((e) => {
    isDraggingRef.current = true;
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = chatSidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [chatSidebarWidth]);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDraggingRef.current) return;
      const delta = dragStartXRef.current - e.clientX; // dragging left increases width
      const newWidth = Math.min(600, Math.max(240, dragStartWidthRef.current + delta));
      setChatSidebarWidth(newWidth);
    };
    const handleMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    fetchDeployments();
  }, []);

  // ── Global keyboard shortcut handler ───────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      // Ctrl+P  — Command palette (file search)
      if (e.key === 'p' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setCmdPaletteOpen(v => !v);
        return;
      }
      // Ctrl+F  — Find in file
      if (e.key === 'f' && !e.shiftKey && !e.altKey) {
        if (centerTab === 'editor' && editorRef.current) {
          // Let Monaco handle it natively
          return;
        }
        e.preventDefault();
        setInFileSearchOpen(v => !v);
        return;
      }
      // Ctrl+S  — Save
      if (e.key === 's' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (activeFile) handleSaveFile();
        return;
      }
      // Ctrl+W / Ctrl+F4  — Close editor
      if (e.key === 'w' || e.key === 'F4') {
        e.preventDefault();
        setActiveFile(null);
        setFileContent('');
        setCenterTab('editor');
        return;
      }
      // Ctrl+N  — New file
      if (e.key === 'n' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        handleNewFile();
        return;
      }
      // Ctrl+Shift+V  — Toggle MD preview
      if (e.key === 'V' && e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (activeFile && /\.(md|mdx|markdown)$/i.test(activeFile)) {
          setCenterTab(t => t === 'mdPreview' ? 'editor' : 'mdPreview');
        }
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerTab, activeFile, filesTree]);

  useEffect(() => {
    if (selectedId) {
      const dep = deployments.find(d => d._id === selectedId);
      setSelectedDep(dep);
      fetchWorkspaceFiles(selectedId);
      fetchDbCollections(selectedId, dep?.dbInitType);
      fetchChats(selectedId);
      setActiveFile(null);
      setFileContent('');
      setActiveCollection('');
      setCollectionData([]);
    } else {
      setSelectedDep(null);
      setFilesTree([]);
      setDbCollections([]);
      setChats([]);
      setActiveChatId('');
      setChatMessages([]);
    }
  }, [selectedId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const fetchDeployments = async () => {
    try {
      const res = await getDeployments();
      setDeployments(res.data);
      if (res.data.length > 0) {
        setSelectedId(res.data[0]._id);
      }
    } catch (err) {
      console.error('Failed to fetch deployments:', err);
    }
  };

  const fetchWorkspaceFiles = async (id) => {
    try {
      const res = await getWorkspaceFiles(id);
      setFilesTree(res.data);
    } catch (err) {
      console.error('Failed to fetch workspace files:', err);
    }
  };

  const fetchDbCollections = async (id, dbType) => {
    try {
      const res = await getDbCollections(id, dbType || 'mongodb');
      setDbCollections(res.data);
    } catch (err) {
      console.error('Failed to fetch collections:', err);
    }
  };

  const fetchChats = async (id) => {
    try {
      const res = await getChatsList(id);
      setChats(res.data);
      if (res.data.length > 0) {
        handleSelectChat(res.data[0]._id, id);
      } else {
        const newThreadRes = await createChatThread(id, 'Default Session');
        setChats([newThreadRes.data]);
        setActiveChatId(newThreadRes.data._id);
        setChatMessages(newThreadRes.data.messages || []);
      }
    } catch (err) {
      console.error('Failed to fetch chats list:', err);
    }
  };

  const handleSelectChat = async (chatId, depId = selectedId) => {
    try {
      setActiveChatId(chatId);
      const res = await getChatMessages(depId, chatId);
      setChatMessages(res.data.messages || []);
    } catch (err) {
      console.error('Failed to load chat messages:', err);
    }
  };

  const handleCreateChat = async () => {
    try {
      const threadTitle = prompt('Enter a title for the new chat thread:', `Session ${new Date().toLocaleTimeString()}`);
      if (!threadTitle) return;
      const res = await createChatThread(selectedId, threadTitle);
      setChats(prev => [res.data, ...prev]);
      setActiveChatId(res.data._id);
      setChatMessages(res.data.messages || []);
    } catch (err) {
      console.error('Failed to create new chat thread:', err);
    }
  };

  const handleSelectFile = async (pathStr) => {
    try {
      const res = await getWorkspaceFileContent(selectedId, pathStr);
      setActiveFile(pathStr);
      setFileContent(res.data.content);
      const isMarkdown = /\.(md|mdx|markdown)$/i.test(pathStr);
      setCenterTab(isMarkdown ? 'mdPreview' : 'editor');
      setInFileSearchOpen(false);

      // Tab tracking for Full IDE mode
      setOpenTabs(prev => {
        if (prev.some(t => t.path === pathStr)) return prev;
        return [...prev, { path: pathStr, content: res.data.content }];
      });
      setActiveTabPath(pathStr);
    } catch (err) {
      console.error('Failed to read file:', err);
    }
  };

  const handleNewFile = async () => {
    const name = prompt('New file name (relative path from workspace root):');
    if (!name) return;
    try {
      await saveWorkspaceFile(selectedId, name, '');
      fetchWorkspaceFiles(selectedId);
      const res = await getWorkspaceFileContent(selectedId, name);
      setActiveFile(name);
      setFileContent(res.data.content || '');
      setCenterTab('editor');
    } catch (err) {
      console.error('Failed to create new file:', err);
    }
  };

  const handleOpenToSide = async (pathStr) => {
    try {
      const res = await getWorkspaceFileContent(selectedId, pathStr);
      setSideFile(pathStr);
      setSideContent(res.data.content);
    } catch (err) {
      console.error('Failed to open file to side:', err);
    }
  };

  const handleContextMenu = (e, node) => {
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  };

  const handleContextPreview = async (pathStr) => {
    try {
      const res = await getWorkspaceFileContent(selectedId, pathStr);
      setActiveFile(pathStr);
      setFileContent(res.data.content);
      setCenterTab('mdPreview');
    } catch (err) {
      console.error('Failed to open preview:', err);
    }
  };

  const handleCopyPath = (pathStr) => {
    navigator.clipboard.writeText(pathStr).catch(() => {});
  };

  const handleCopyRelPath = (pathStr) => {
    const rel = pathStr.replace(/^\//, '');
    navigator.clipboard.writeText(rel).catch(() => {});
  };

  const handleCutFile = (node) => setClipboard({ node, op: 'cut' });
  const handleCopyFile = (node) => setClipboard({ node, op: 'copy' });

  const handleRenameFile = async (node, newName) => {
    if (!newName || newName === node.name) return;
    const oldPath = node.path;
    const newPath = oldPath.replace(/[^/\\]*$/, newName);
    try {
      const res = await getWorkspaceFileContent(selectedId, oldPath);
      await saveWorkspaceFile(selectedId, newPath, res.data.content);
      await saveWorkspaceFile(selectedId, oldPath, null); // signal delete (handled backend side if supported)
      fetchWorkspaceFiles(selectedId);
      if (activeFile === oldPath) { setActiveFile(newPath); }
    } catch (err) {
      console.error('Rename failed:', err);
    }
    setRenameTarget(null);
    setRenameValue('');
  };

  const handleDeleteFile = async (node) => {
    if (!window.confirm(`Delete "${node.name}"?`)) return;
    try {
      await saveWorkspaceFile(selectedId, node.path, null);
      fetchWorkspaceFiles(selectedId);
      if (activeFile === node.path) { setActiveFile(null); setFileContent(''); }
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const handleSaveFile = async () => {
    if (!activeFile) return;
    setIsSavingFile(true);
    try {
      await saveWorkspaceFile(selectedId, activeFile, fileContent);
      setIsSavingFile(false);
    } catch (err) {
      console.error('Failed to save file:', err);
      setIsSavingFile(false);
    }
  };

  const handleSelectCollection = async (collName) => {
    setActiveCollection(collName);
    setCenterTab('database');
    setIsDbLoading(true);
    try {
      const res = await getDbCollectionData(selectedId, collName, selectedDep?.dbInitType || 'mongodb');
      setCollectionData(res.data);
      setIsDbLoading(false);
      
      // If we are in IDE mode, push a special tab for the DB collection
      const dbTabPath = `db:${collName}`;
      setOpenTabs(prev => {
        if (prev.some(t => t.path === dbTabPath)) return prev;
        return [...prev, { path: dbTabPath, name: `DB: ${collName}`, type: 'db', collection: collName }];
      });
      setActiveTabPath(dbTabPath);
    } catch (err) {
      console.error('Failed to fetch collection data:', err);
      setIsDbLoading(false);
    }
  };

  const handleInsertRecord = async () => {
    setInsertError('');
    try {
      const record = JSON.parse(newRecordJson);
      await insertDbRecord(selectedId, activeCollection, record, selectedDep?.dbInitType || 'mongodb');
      setIsInsertModalOpen(false);
      handleSelectCollection(activeCollection); // refresh list
    } catch (err) {
      setInsertError(err.response?.data?.message || err.message || 'Invalid JSON format');
    }
  };

  const handleEditRecord = (row) => {
    setEditError('');
    setEditRecord(row);
    
    const dbType = selectedDep?.dbInitType || 'mongodb';
    const isSql = ['postgres', 'mysql', 'mariadb', 'sqlite', 'mssql', 'oracle'].includes(dbType);
    
    if (isSql) {
      const pkCol = row.id !== undefined ? 'id' : Object.keys(row)[0] || 'id';
      setEditPkColumn(pkCol);
      setEditPkValue(row[pkCol]);
      
      const cols = Object.keys(row).filter(k => k !== pkCol);
      setCollectionColumns(cols);
      
      const vals = {};
      cols.forEach(c => { vals[c] = row[c] ?? ''; });
      setEditSqlRowValues(vals);
    } else if (dbType === 'mongodb') {
      const pk = row._id || row.id;
      setEditPkColumn('_id');
      setEditPkValue(pk);
      
      const rest = { ...row };
      delete rest._id;
      setEditNewRecordJson(JSON.stringify(rest, null, 2));
    } else {
      const key = row.key || Object.keys(row)[0];
      setEditPkColumn('key');
      setEditPkValue(key);
      setEditNewRecordJson(JSON.stringify(row, null, 2));
    }
    
    setIsEditModalOpen(true);
  };

  const handleSaveEdit = async () => {
    setEditError('');
    try {
      const dbType = selectedDep?.dbInitType || 'mongodb';
      const isSql = ['postgres', 'mysql', 'mariadb', 'sqlite', 'mssql', 'oracle'].includes(dbType);
      
      let record;
      if (isSql) {
        record = {};
        for (const col of collectionColumns) {
          const v = editSqlRowValues[col];
          const asNum = Number(v);
          record[col] = v === '' ? null : (!isNaN(asNum) && v !== '' ? asNum : v);
        }
      } else {
        record = JSON.parse(editNewRecordJson);
      }
      
      await updateDbRecord(selectedId, activeCollection, editPkColumn, editPkValue, record, dbType);
      setIsEditModalOpen(false);
      handleSelectCollection(activeCollection);
    } catch (err) {
      setEditError(err.response?.data?.message || err.message || 'Failed to update record');
    }
  };

  const handleDeleteRecord = async (row) => {
    try {
      const dbType = selectedDep?.dbInitType || 'mongodb';
      const isSql = ['postgres', 'mysql', 'mariadb', 'sqlite', 'mssql', 'oracle'].includes(dbType);
      
      let pkCol = 'id';
      let pkVal = null;
      
      if (isSql) {
        pkCol = row.id !== undefined ? 'id' : Object.keys(row)[0] || 'id';
        pkVal = row[pkCol];
      } else if (dbType === 'mongodb') {
        pkCol = '_id';
        pkVal = row._id || row.id;
      } else {
        pkCol = 'key';
        pkVal = row.key || Object.keys(row)[0];
      }
      
      await deleteDbRecord(selectedId, activeCollection, pkCol, pkVal, dbType);
      setDeleteConfirmPk(null);
      handleSelectCollection(activeCollection);
    } catch (err) {
      alert(err.response?.data?.message || err.message || 'Failed to delete record');
    }
  };

  const handleRunShellQuery = async () => {
    if (!shellQuery.trim() || !selectedId) return;
    setIsShellRunning(true);
    setShellOutput('Executing database query inside container...');
    try {
      const res = await executeDeploymentDbQuery(selectedId, shellQuery, selectedDep?.dbInitType || 'mongodb');
      setShellOutput(res.data.output || '(Query successfully completed with empty output.)');
    } catch (err) {
      setShellOutput(`Error: ${err.response?.data?.message || err.message}`);
    } finally {
      setIsShellRunning(false);
    }
  };

  const handleSendChat = async (customMessage = '') => {
    const text = (customMessage || chatInput).trim();
    if (!text) return;

    if (!customMessage) setChatInput('');
    
    // We add user message AND a placeholder agent streaming message
    setChatMessages(prev => [
      ...prev, 
      { role: 'user', text },
      { 
        role: 'agent', 
        text: '<thought>Initializing reasoning engine...</thought>', 
        isStreaming: true, 
        durationSec: 0 
      }
    ]);
    setIsAgentTyping(true);

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Start local timer for the live progress indicator
    const startStreamingTime = Date.now();
    const timerInterval = setInterval(() => {
      const elapsed = parseFloat(((Date.now() - startStreamingTime) / 1000).toFixed(1));
      setChatMessages(prev => {
        const copy = [...prev];
        const lastIdx = copy.length - 1;
        if (lastIdx >= 0 && copy[lastIdx].role === 'agent' && copy[lastIdx].isStreaming) {
          copy[lastIdx] = {
            ...copy[lastIdx],
            durationSec: elapsed
          };
        }
        return copy;
      });
    }, 200);

    // Setup socket listener for agent iterations
    const listener = (data) => {
      setChatMessages(prev => {
        const copy = [...prev];
        const lastIdx = copy.length - 1;
        if (lastIdx >= 0 && copy[lastIdx].role === 'agent' && copy[lastIdx].isStreaming) {
          let updatedText = data.assistantText;
          if (data.executionLogs) {
            const logsFormatted = `\n\n**[AI Agent Terminal Output]:**\n\`\`\`bash\n${data.executionLogs}\n\`\`\``;
            if (updatedText.includes('</thought>')) {
              updatedText = updatedText.replace('</thought>', `${logsFormatted}\n</thought>`);
            } else if (updatedText.includes('</thinking>')) {
              updatedText = updatedText.replace('</thinking>', `${logsFormatted}\n</thinking>`);
            } else {
              updatedText += `\n\n<thought>${logsFormatted}</thought>`;
            }
          }
          copy[lastIdx] = {
            ...copy[lastIdx],
            text: updatedText
          };
        }
        return copy;
      });
    };

    // Setup socket listener for token chunks
    const tokenListener = (data) => {
      setChatMessages(prev => {
        const copy = [...prev];
        const lastIdx = copy.length - 1;
        if (lastIdx >= 0 && copy[lastIdx].role === 'agent' && copy[lastIdx].isStreaming) {
          let currentText = copy[lastIdx].text;
          if (currentText === '<thought>Initializing reasoning engine...</thought>') {
            currentText = '';
          }
          copy[lastIdx] = {
            ...copy[lastIdx],
            text: currentText + data.token
          };
        }
        return copy;
      });
    };

    socketRef.current?.on(`agent:thinking:${selectedId}`, listener);
    socketRef.current?.on(`agent:token:${selectedId}`, tokenListener);

    try {
      const res = await executeAgentChat(selectedId, text, activeChatId, { signal: controller.signal });
      const { message, pendingExec, commands, chatId, patches, durationSec } = res.data;
      
      if (chatId && chatId !== activeChatId) {
        setActiveChatId(chatId);
      }
      
      setChatMessages(prev => {
        const copy = [...prev];
        const lastIdx = copy.length - 1;
        if (lastIdx >= 0 && copy[lastIdx].role === 'agent') {
          copy[lastIdx] = {
            role: 'agent',
            text: message,
            pendingAction: pendingExec ? { commands } : null,
            patches: patches && patches.length > 0 ? patches : null,
            rolledBack: false,
            durationSec: durationSec || parseFloat(((Date.now() - startStreamingTime) / 1000).toFixed(1)),
            isStreaming: false
          };
        }
        return copy;
      });

      // Reload chats list to get new titles without selecting
      const listRes = await getChatsList(selectedId);
      setChats(listRes.data);
      
      // Auto reload tree and collections on chat updates in case files/db were seeded or modified!
      fetchWorkspaceFiles(selectedId);
      fetchDbCollections(selectedId, selectedDep?.dbInitType);
      if (activeFile) {
        handleSelectFile(activeFile);
      }
      if (activeCollection) {
        handleSelectCollection(activeCollection);
      }
    } catch (err) {
      clearInterval(timerInterval);
      socketRef.current?.off(`agent:thinking:${selectedId}`, listener);
      socketRef.current?.off(`agent:token:${selectedId}`, tokenListener);

      if (err.name === 'CanceledError' || axios.isCancel(err)) {
        setChatMessages(prev => {
          const copy = [...prev];
          const lastIdx = copy.length - 1;
          if (lastIdx >= 0 && copy[lastIdx].role === 'agent') {
            copy[lastIdx] = {
              role: 'agent',
              text: '⚠️ *Thinking paused/execution stopped by user.*',
              isStreaming: false
            };
          } else {
            copy.push({ role: 'agent', text: '⚠️ *Thinking paused/execution stopped by user.*' });
          }
          return copy;
        });
      } else {
        setChatMessages(prev => {
          const copy = [...prev];
          const lastIdx = copy.length - 1;
          if (lastIdx >= 0 && copy[lastIdx].role === 'agent') {
            copy[lastIdx] = {
              role: 'agent',
              text: `Failed to talk to DevOps Agent: ${err.message}`,
              isStreaming: false
            };
          } else {
            copy.push({ role: 'agent', text: `Failed to talk to DevOps Agent: ${err.message}` });
          }
          return copy;
        });
      }
    } finally {
      clearInterval(timerInterval);
      socketRef.current?.off(`agent:thinking:${selectedId}`, listener);
      socketRef.current?.off(`agent:token:${selectedId}`, tokenListener);
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsAgentTyping(false);
    }
  };

  const handleStopChat = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsAgentTyping(false);
  };

  const toggleDiffExpansion = (idx) => {
    setExpandedDiffs(prev => ({
      ...prev,
      [idx]: !prev[idx]
    }));
  };

  const handleRollback = async (msgIndex) => {
    const msg = chatMessages[msgIndex];
    if (!msg || !msg.patches || msg.rolledBack) return;
    try {
      await rollbackAgentPatches(selectedId, msg.patches, activeChatId, msgIndex);
      setChatMessages(prev => {
        const copy = [...prev];
        copy[msgIndex] = { ...copy[msgIndex], rolledBack: true };
        return copy;
      });
      fetchWorkspaceFiles(selectedId);
      if (activeFile) handleSelectFile(activeFile);
    } catch (err) {
      alert('Rollback failed: ' + err.message);
    }
  };

  const handleUndo = async (msgIndex) => {
    try {
      const res = await undoChatMessages(selectedId, activeChatId, msgIndex);
      setChatMessages(res.data.messages || []);
      fetchWorkspaceFiles(selectedId);
      fetchDbCollections(selectedId, selectedDep?.dbInitType);
      if (activeFile) handleSelectFile(activeFile);
    } catch (err) {
      alert('Undo failed: ' + err.message);
    }
  };

  const handlePermissionAllow = async (msgIndex, commands) => {
    try {
      setIsAgentTyping(true);
      const res = await executePendingCommands(selectedId, commands, activeChatId);
      
      // Load fresh messages from DB to stay perfectly in sync
      const messagesRes = await getChatMessages(selectedId, activeChatId);
      setChatMessages(messagesRes.data.messages || []);

      fetchWorkspaceFiles(selectedId);
      fetchDbCollections(selectedId, selectedDep?.dbInitType);
      if (activeCollection) {
        handleSelectCollection(activeCollection);
      }
    } catch (err) {
      console.error('Failed to run pending commands:', err);
    } finally {
      setIsAgentTyping(false);
    }
  };

  const handlePermissionAllowEverytime = async (msgIndex, commands) => {
    try {
      setIsAgentTyping(true);
      await updateAgentPermission(selectedId, 'always');
      const res = await executePendingCommands(selectedId, commands, activeChatId);
      
      // Load fresh messages from DB to stay perfectly in sync
      const messagesRes = await getChatMessages(selectedId, activeChatId);
      setChatMessages(messagesRes.data.messages || []);

      fetchWorkspaceFiles(selectedId);
      fetchDbCollections(selectedId, selectedDep?.dbInitType);
      if (activeCollection) {
        handleSelectCollection(activeCollection);
      }
    } catch (err) {
      console.error('Failed to run pending commands:', err);
    } finally {
      setIsAgentTyping(false);
    }
  };

  const handlePermissionNever = async (msgIndex) => {
    try {
      await updateAgentPermission(selectedId, 'never');
      setChatMessages(prev => {
        const copy = [...prev];
        copy[msgIndex] = {
          ...copy[msgIndex],
          text: copy[msgIndex].text + `\n\n**[AI Agent Terminal Output]:**\n\`\`\`bash\n[Execution blocked: User has disabled command execution for this agent]\n\`\`\``,
          pendingAction: null
        };
        return copy;
      });
    } catch (err) {
      console.error('Failed to update permission:', err);
    }
  };

  if (ideMode) {
    return (
      <FullIDEView
        onClose={() => setIdeMode(false)}
        agentSecurityMode={agentSecurityMode}
        setAgentSecurityMode={setAgentSecurityMode}
        terminalAutoExecution={terminalAutoExecution}
        setTerminalAutoExecution={setTerminalAutoExecution}
        enableShellIntegration={enableShellIntegration}
        setEnableShellIntegration={setEnableShellIntegration}
        expandedDiffs={expandedDiffs}
        toggleDiffExpansion={toggleDiffExpansion}
        handleRollback={handleRollback}
        handleUndo={handleUndo}
        ideTheme={ideTheme}
        setIdeTheme={setIdeTheme}
        selectedDep={selectedDep}
        deployments={deployments}
        selectedId={selectedId}
        setSelectedId={setSelectedId}
        filesTree={filesTree}
        activeFile={activeFile}
        fileContent={fileContent}
        setFileContent={setFileContent}
        handleSelectFile={handleSelectFile}
        handleSaveFile={handleSaveFile}
        isSavingFile={isSavingFile}
        dbCollections={dbCollections}
        activeCollection={activeCollection}
        handleSelectCollection={handleSelectCollection}
        collectionData={collectionData}
        isDbLoading={isDbLoading}
        setIsInsertModalOpen={setIsInsertModalOpen}
        handleEditRecord={handleEditRecord}
        setDeleteConfirmPk={setDeleteConfirmPk}
        deleteConfirmPk={deleteConfirmPk}
        handleDeleteRecord={handleDeleteRecord}
        shellQuery={shellQuery}
        setShellQuery={setShellQuery}
        shellValidationError={shellValidationError}
        isRunShellDisabled={isRunShellDisabled}
        shellOutput={shellOutput}
        isShellRunning={isShellRunning}
        handleRunShellQuery={handleRunShellQuery}
        shellPreset={shellPreset}
        shellDbType={shellDbType}
        chats={chats}
        activeChatId={activeChatId}
        handleSelectChat={handleSelectChat}
        handleCreateChat={handleCreateChat}
        chatMessages={chatMessages}
        chatInput={chatInput}
        setChatInput={setChatInput}
        handleSendChat={handleSendChat}
        isAgentTyping={isAgentTyping}
        handleStopChat={handleStopChat}
        chatEndRef={chatEndRef}
        openTabs={openTabs}
        setOpenTabs={setOpenTabs}
        activeTabPath={activeTabPath}
        setActiveTabPath={setActiveTabPath}
        explorerOpen={explorerOpen}
        setExplorerOpen={setExplorerOpen}
        chatPanelOpen={chatPanelOpen}
        setChatPanelOpen={setChatPanelOpen}
        bottomPanelHeight={bottomPanelHeight}
        setBottomPanelHeight={setBottomPanelHeight}
        bottomTab={bottomTab}
        setBottomTab={setBottomTab}
        handleNewFile={handleNewFile}
        handleContextMenu={handleContextMenu}
        contextMenu={contextMenu}
        setContextMenu={setContextMenu}
        handleContextPreview={handleContextPreview}
        handleOpenToSide={handleOpenToSide}
        handleCopyPath={handleCopyPath}
        handleCopyRelPath={handleCopyRelPath}
        handleCutFile={handleCutFile}
        handleCopyFile={handleCopyFile}
        setRenameTarget={setRenameTarget}
        setRenameValue={setRenameValue}
        handleDeleteFile={handleDeleteFile}
        renameTarget={renameTarget}
        renameValue={renameValue}
        handleRenameFile={handleRenameFile}
        chatSidebarWidth={chatSidebarWidth}
        handleDragStart={handleDragStart}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 100px)', gap: '16px', color: 'var(--text-primary)' }}>
      {/* Header Panel */}
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        background: 'var(--bg-secondary)', 
        padding: '12px 20px', 
        borderRadius: '8px', 
        border: '1px solid var(--border-subtle)' 
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Bot size={20} color="var(--accent-blue)" />
          <h2 style={{ fontSize: '16px', fontWeight: 600, margin: 0 }}>DevOps AI Workspace Agent</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Target Deployment:</span>
          <select 
            value={selectedId} 
            onChange={(e) => setSelectedId(e.target.value)}
            style={{ 
              background: '#1f2937', 
              color: '#ffffff', 
              border: '1px solid var(--border-subtle)', 
              padding: '6px 12px', 
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer'
            }}
          >
            {deployments.map(d => (
              <option key={d._id} value={d._id} style={{ background: '#1f2937', color: '#ffffff' }}>
                {d.projectName} ({d.techStackDetected || 'MERN'}) {d.previewStatus === 'running' ? '● Live' : '○ Offline'}
              </option>
            ))}
          </select>

          {/* Status Badge & Start Button */}
          {selectedDep && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{
                fontSize: '11px',
                fontWeight: 600,
                color: selectedDep.previewStatus === 'running' ? '#34d399' : selectedDep.previewStatus === 'starting' ? '#facc15' : '#ef4444',
                background: selectedDep.previewStatus === 'running' ? 'rgba(52, 211, 153, 0.1)' : selectedDep.previewStatus === 'starting' ? 'rgba(250, 204, 21, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                border: `1px solid ${selectedDep.previewStatus === 'running' ? 'rgba(52, 211, 153, 0.25)' : selectedDep.previewStatus === 'starting' ? 'rgba(250, 204, 21, 0.25)' : 'rgba(239, 68, 68, 0.25)'}`,
                padding: '3px 8px',
                borderRadius: '20px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px'
              }}>
                <span style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: selectedDep.previewStatus === 'running' ? '#34d399' : selectedDep.previewStatus === 'starting' ? '#facc15' : '#ef4444'
                }} />
                {selectedDep.previewStatus === 'running' ? 'Live' : selectedDep.previewStatus === 'starting' ? 'Starting...' : 'Offline'}
              </span>

              {selectedDep.previewStatus !== 'running' && selectedDep.previewStatus !== 'starting' && (
                <button
                  onClick={async () => {
                    try {
                      setSelectedDep(prev => prev ? { ...prev, previewStatus: 'starting' } : null);
                      await startDeploymentPreview(selectedId);
                      
                      // Poll for deployments update
                      let attempts = 0;
                      const checkInterval = setInterval(async () => {
                        attempts++;
                        const res = await getDeployments();
                        setDeployments(res.data);
                        const updated = res.data.find(d => d._id === selectedId);
                        if (updated) {
                          setSelectedDep(updated);
                          if (updated.previewStatus === 'running' || attempts >= 10) {
                            clearInterval(checkInterval);
                            // Refresh page workspace trees
                            fetchWorkspaceFiles(selectedId);
                            fetchDbCollections(selectedId, updated.dbInitType);
                          }
                        }
                      }, 2500);
                    } catch (err) {
                      alert('Failed to start preview: ' + (err.response?.data?.message || err.message));
                    }
                  }}
                  style={{
                    background: 'var(--accent-blue)',
                    color: '#fff',
                    border: 'none',
                    padding: '4px 10px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                >
                  <Play size={10} fill="#fff" stroke="none" /> Make Live
                </button>
              )}
            </div>
          )}

          <button 
            onClick={() => {
              if (selectedId) {
                fetchWorkspaceFiles(selectedId);
                fetchDbCollections(selectedId, selectedDep?.dbInitType);
              }
            }}
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
              padding: '6px',
              borderRadius: '6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center'
            }}
            title="Reload Workspace"
          >
            <RefreshCw size={14} />
          </button>

          <button
            onClick={() => setIdeMode(true)}
            style={{
              background: 'var(--accent-blue)',
              color: '#fff',
              border: 'none',
              padding: '6px 14px',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
            title="Open Full IDE View"
          >
            <Eye size={14} /> Open IDE View
          </button>
        </div>
      </div>

      {/* ── IDE Overlays: Command Palette & In-File Search ───────────────────── */}
      {cmdPaletteOpen && (
        <CommandPalette
          files={flattenTree(filesTree)}
          onOpen={handleSelectFile}
          onClose={() => setCmdPaletteOpen(false)}
        />
      )}

      {/* ── Keyboard Shortcut Status Bar ─────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '5px 12px', background: 'rgba(0,0,0,0.18)', borderRadius: '6px', flexShrink: 0 }}>
        <span style={{ fontSize: '11px', color: '#4b5563' }}>IDE Shortcuts:</span>
        {[['Ctrl+P', 'Open file'], ['Ctrl+F', 'Find in file'], ['Ctrl+S', 'Save'], ['Ctrl+W', 'Close editor'], ['Ctrl+N', 'New file'], ['Ctrl+Shift+V', 'MD Preview']]
          .map(([key, label]) => (
            <span key={key} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#6b7280' }}>
              <kbd style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '3px', padding: '1px 5px', fontFamily: 'monospace', fontSize: '10px', color: '#9ca3af' }}>{key}</kbd>
              <span>{label}</span>
            </span>
          ))
        }
      </div>

      {/* Main Workspace Panels Layout */}
      <div style={{ display: 'flex', flex: 1, gap: '16px', minHeight: 0 }}>
        
        {/* Left Side Navigation Pane (File tree & DB explorer) */}
        <div style={{ 
          width: '260px', 
          background: 'var(--bg-secondary)', 
          borderRadius: '8px', 
          border: '1px solid var(--border-subtle)', 
          display: 'flex', 
          flexDirection: 'column',
          overflowY: 'auto'
        }}>
          {/* File Explorer section */}
          <div style={{ padding: '16px', borderBottom: '1px solid var(--border-subtle)' }}>
            <h3 style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', margin: '0 0 12px 0', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Code size={13} /> Project Workspace Files
            </h3>
            <div style={{ maxHeight: '250px', overflowY: 'auto' }}>
              {filesTree.length === 0 ? (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>Empty or loading...</div>
              ) : (
                filesTree.map((node, idx) => (
                  <FileTreeNode 
                    key={idx} 
                    node={node} 
                    onSelectFile={handleSelectFile} 
                    selectedPath={activeFile}
                    onContextMenu={handleContextMenu}
                  />
                ))
              )}
            </div>
            {/* Rename inline input */}
            {renameTarget && (
              <div style={{ padding: '6px 8px', background: 'rgba(59,130,246,0.08)', borderRadius: '6px', marginTop: '6px', display: 'flex', gap: '6px' }}>
                <input
                  autoFocus
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleRenameFile(renameTarget, renameValue);
                    if (e.key === 'Escape') { setRenameTarget(null); setRenameValue(''); }
                  }}
                  style={{ flex: 1, background: '#1e2330', border: '1px solid var(--accent-blue)', borderRadius: '4px', color: '#fff', padding: '3px 7px', fontSize: '12px', outline: 'none', fontFamily: 'monospace' }}
                />
                <button onClick={() => handleRenameFile(renameTarget, renameValue)} style={{ background: 'var(--accent-blue)', border: 'none', borderRadius: '4px', color: '#fff', padding: '3px 8px', fontSize: '11px', cursor: 'pointer' }}>OK</button>
                <button onClick={() => { setRenameTarget(null); setRenameValue(''); }} style={{ background: 'transparent', border: '1px solid var(--border-subtle)', borderRadius: '4px', color: 'var(--text-muted)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer' }}>✕</button>
              </div>
            )}
            {/* Context Menu */}
            {contextMenu && (
              <FileContextMenu
                x={contextMenu.x} y={contextMenu.y} node={contextMenu.node}
                onClose={() => setContextMenu(null)}
                onSelectFile={handleSelectFile}
                onPreview={handleContextPreview}
                onOpenSide={handleOpenToSide}
                onCopyPath={handleCopyPath}
                onCopyRelPath={handleCopyRelPath}
                onCut={handleCutFile}
                onCopy={handleCopyFile}
                onRename={(node) => { setRenameTarget(node); setRenameValue(node.name); }}
                onDelete={handleDeleteFile}
              />
            )}
          </div>

          {/* Database Collections Section */}
          <div style={{ padding: '16px', flex: 1 }}>
            <h3 style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', margin: '0 0 12px 0', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Database size={13} /> DB Explorer ({selectedDep?.dbInitType || 'mongodb'})
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {dbCollections.length === 0 ? (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>No active collections/tables</div>
              ) : (
                dbCollections.map((coll, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSelectCollection(coll)}
                    style={{
                      background: activeCollection === coll ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                      border: 'none',
                      color: activeCollection === coll ? '#fff' : 'var(--text-secondary)',
                      padding: '6px 10px',
                      borderRadius: '4px',
                      textAlign: 'left',
                      fontSize: '13px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      borderLeft: activeCollection === coll ? '2px solid var(--accent-blue)' : 'none'
                    }}
                    onMouseEnter={(e) => {
                      if (activeCollection !== coll) e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.03)';
                    }}
                    onMouseLeave={(e) => {
                      if (activeCollection !== coll) e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    <ListFilter size={13} color="var(--text-muted)" />
                    {coll}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Center Panel (Code Editor or Live Database grid) */}
        <div style={{ 
          flex: 1, 
          background: 'var(--bg-secondary)', 
          borderRadius: '8px', 
          border: '1px solid var(--border-subtle)', 
          display: 'flex', 
          flexDirection: 'column',
          minWidth: 0
        }}>
          {/* Tab headers */}
          <div style={{ 
            display: 'flex', 
            background: 'rgba(0,0,0,0.03)', 
            borderBottom: '1px solid var(--border-subtle)', 
            borderTopLeftRadius: '8px', 
            borderTopRightRadius: '8px' 
          }}>
            <button
              onClick={() => setCenterTab('editor')}
              style={{
                background: centerTab === 'editor' ? 'var(--bg-secondary)' : 'transparent',
                border: 'none',
                color: centerTab === 'editor' ? 'var(--text-primary)' : 'var(--text-muted)',
                padding: '10px 18px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
                borderRight: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}
            >
              <Code size={14} /> File Editor
            </button>
            <button
              onClick={() => setCenterTab('database')}
              disabled={!activeCollection}
              style={{
                background: centerTab === 'database' ? 'var(--bg-secondary)' : 'transparent',
                border: 'none',
                color: centerTab === 'database' ? 'var(--text-primary)' : 'var(--text-muted)',
                padding: '10px 18px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: activeCollection ? 'pointer' : 'not-allowed',
                borderRight: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                opacity: activeCollection ? 1 : 0.5
              }}
            >
              <Database size={14} /> Live DB Data
            </button>
            <button
              onClick={() => setCenterTab('terminal')}
              style={{
                background: centerTab === 'terminal' ? 'var(--bg-secondary)' : 'transparent',
                border: 'none',
                color: centerTab === 'terminal' ? 'var(--text-primary)' : 'var(--text-muted)',
                padding: '10px 18px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
                borderRight: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}
            >
              <Terminal size={14} /> Interactive Terminal
            </button>
            <button
              onClick={() => setCenterTab('dbShell')}
              style={{
                background: centerTab === 'dbShell' ? 'var(--bg-secondary)' : 'transparent',
                border: 'none',
                color: centerTab === 'dbShell' ? 'var(--text-primary)' : 'var(--text-muted)',
                padding: '10px 18px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
                borderRight: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}
            >
              <Terminal size={14} /> Database Shell
            </button>
            {activeFile && /\.(md|mdx|markdown)$/i.test(activeFile) && (
              <button
                onClick={() => setCenterTab('mdPreview')}
                style={{
                  background: centerTab === 'mdPreview' ? 'var(--bg-secondary)' : 'transparent',
                  border: 'none',
                  color: centerTab === 'mdPreview' ? 'var(--text-primary)' : 'var(--text-muted)',
                  padding: '10px 18px',
                  fontSize: '13px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  borderRight: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}
              >
                <Eye size={14} /> MD Preview
              </button>
            )}
          </div>

          {/* Tab contents */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: centerTab === 'mdPreview' ? '0' : '16px', minHeight: 0, overflow: 'hidden' }}>
            {centerTab === 'editor' ? (
              activeFile ? (
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative' }}>
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{activeFile}</span>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <button
                        onClick={() => { if (editorRef.current) { editorRef.current.getAction('actions.find').run(); } else { setInFileSearchOpen(v => !v); } }}
                        title="Find (Ctrl+F)"
                        style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-subtle)', borderRadius: '5px', color: 'var(--text-muted)', padding: '5px 8px', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        <Code size={12} /> Find
                      </button>
                      <button
                        onClick={handleSaveFile}
                        disabled={isSavingFile}
                        style={{
                          background: 'var(--accent-blue)',
                          color: '#fff',
                          border: 'none',
                          padding: '6px 14px',
                          borderRadius: '6px',
                          fontSize: '13px',
                          fontWeight: 500,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px'
                        }}
                      >
                        <Save size={14} />
                      </button>
                    </div>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, borderRadius: '6px', border: '1px solid var(--border-subtle)', overflow: 'hidden', position: 'relative' }}>
                    <Editor
                      height="100%"
                      defaultLanguage="javascript"
                      language={getLanguageFromPath(activeFile)}
                      theme="vs-dark"
                      beforeMount={registerMonacoThemes}
                      value={fileContent}
                      onChange={(value) => setFileContent(value || '')}
                      onMount={(editor) => {
                        editorRef.current = editor;
                      }}
                      options={{
                        minimap: { enabled: false },
                        fontSize: 13,
                        lineHeight: 20,
                        fontFamily: 'Consolas, Monaco, monospace',
                        automaticLayout: true
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'var(--text-muted)', gap: '10px' }}>
                  <Code size={36} color="var(--border-subtle)" />
                  <span style={{ fontSize: '13px' }}>Select a file from the explorer to begin editing.</span>
                </div>
              )
            ) : centerTab === 'mdPreview' ? (
              /* ── Markdown Preview Pane ── */
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{activeFile}</span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button onClick={() => setInFileSearchOpen(v => !v)} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-subtle)', borderRadius: '5px', color: 'var(--text-secondary)', padding: '4px 10px', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px' }}><Code size={12} /> Find</button>
                    <button onClick={() => setCenterTab('editor')} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-subtle)', borderRadius: '5px', color: 'var(--text-secondary)', padding: '4px 10px', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px' }}><Code size={12} /> Edit</button>
                    <button onClick={handleSaveFile} disabled={isSavingFile} style={{ background: 'var(--accent-blue)', color: '#fff', border: 'none', borderRadius: '5px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px' }}><Save size={12} /> Save</button>
                  </div>
                </div>
                {/* In-file search bar for MD Preview */}
                {inFileSearchOpen && (
                  <div style={{ position: 'relative' }}>
                    <InFileSearchBar content={fileContent} onClose={() => setInFileSearchOpen(false)} />
                  </div>
                )}
                <div
                  style={{
                    flex: 1, overflowY: 'auto', padding: '24px 32px',
                    color: 'var(--text-primary)', lineHeight: '1.75', fontSize: '15px',
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
                  }}
                  dangerouslySetInnerHTML={{
                    __html: (() => {
                      try {
                        marked.setOptions({ breaks: true, gfm: true });
                        return marked.parse(fileContent || '');
                      } catch(_) { return '<pre>' + fileContent + '</pre>'; }
                    })()
                  }}
                />
                <style>{`
                  .md-preview h1,.md-preview h2,.md-preview h3 { color: var(--text-primary); font-weight: 700; margin: 1.2em 0 0.5em; border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.3em; }
                  .md-preview code { background: rgba(0,0,0,0.12); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 0.88em; }
                  .md-preview pre { background: #0d1117; border-radius: 8px; padding: 16px; overflow-x: auto; }
                  .md-preview pre code { background: none; padding: 0; }
                  .md-preview blockquote { border-left: 3px solid var(--accent-blue); margin: 0; padding: 4px 16px; color: var(--text-muted); }
                  .md-preview table { border-collapse: collapse; width: 100%; }
                  .md-preview th, .md-preview td { border: 1px solid var(--border-subtle); padding: 6px 12px; }
                  .md-preview a { color: var(--accent-blue); }
                  .md-preview img { max-width: 100%; border-radius: 6px; }
                `}</style>
              </div>
            ) : centerTab === 'terminal' ? (
              <TerminalView jobId={selectedDep?.jobId} filesTree={filesTree} deployments={deployments} dbCollections={dbCollections} selectedDep={selectedDep} />
            ) : centerTab === 'dbShell' ? (
              <DbTerminalView selectedId={selectedId} dbType={shellDbType} deployments={deployments} />
            ) : (
              // Live DB collection grid — adapts to DB type
              (() => {
                const dbType = selectedDep?.dbInitType || 'mongodb';
                const isSql = ['postgres', 'mysql', 'mariadb', 'sqlite', 'mssql', 'oracle'].includes(dbType);
                const isMongo = dbType === 'mongodb';
                const isRedis = dbType === 'redis';
                const sqlColumns = collectionData.length > 0 ? Object.keys(collectionData[0]) : [];

                return (
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                    {/* Toolbar */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '13.5px', fontWeight: 600 }}>
                          {isSql ? 'Table:' : isMongo ? 'Collection:' : 'Keys in:'}{' '}
                          <code style={{ color: isSql ? '#4ec9b0' : '#58a6ff', fontFamily: 'monospace' }}>{activeCollection}</code>
                        </span>
                        <span style={{
                          fontSize: '11px',
                          color: '#8b949e',
                          background: 'rgba(255,255,255,0.05)',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontFamily: 'monospace'
                        }}>limit 50</span>
                        {collectionData.length > 0 && (
                          <span style={{
                            fontSize: '11px',
                            color: '#8b949e',
                            background: 'rgba(255,255,255,0.04)',
                            padding: '2px 6px',
                            borderRadius: '4px'
                          }}>{collectionData.length} rows</span>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          setInsertError('');
                          // For SQL, seed form fields from the first row's keys (minus id/pk)
                          if (isSql && collectionData.length > 0) {
                            const cols = Object.keys(collectionData[0]).filter(k => k !== 'id' && k !== '_id');
                            setCollectionColumns(cols);
                            const defaults = {};
                            cols.forEach(c => { defaults[c] = ''; });
                            setSqlRowValues(defaults);
                          } else if (isSql) {
                            setCollectionColumns([]);
                            setSqlRowValues({});
                            setNewRecordJson('{\n  \"column\": \"value\"\n}');
                          } else {
                            setCollectionColumns([]);
                            setNewRecordJson('{\n  \"field\": \"value\"\n}');
                          }
                          setIsInsertModalOpen(true);
                        }}
                        style={{
                          background: isSql ? '#0e6655' : 'var(--accent-blue)',
                          color: '#fff',
                          border: 'none',
                          padding: '6px 12px',
                          borderRadius: '6px',
                          fontSize: '12.5px',
                          fontWeight: 500,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px'
                        }}
                      >
                        <Plus size={13} /> {isSql ? 'Insert Row' : isMongo ? 'Add Document' : 'Set Key'}
                      </button>
                    </div>

                    {/* Data Display */}
                    <div style={{ flex: 1, overflow: 'auto', border: '1px solid #30363d', borderRadius: '6px', background: '#0d1117' }}>
                      {isDbLoading ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '160px', color: '#8b949e', fontSize: '13px' }}>
                          Loading...
                        </div>
                      ) : collectionData.length === 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '160px', gap: '8px', color: '#8b949e' }}>
                          <Database size={28} color="#30363d" />
                          <span style={{ fontSize: '13px' }}>No records found in <code style={{ color: '#4ec9b0' }}>{activeCollection}</code></span>
                        </div>
                      ) : isSql ? (
                        /* ── pgAdmin-style SQL Grid ── */
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                          <thead>
                            <tr style={{ background: '#161b22', position: 'sticky', top: 0, zIndex: 1 }}>
                              {sqlColumns.map((col, ci) => (
                                <th key={ci} style={{
                                  padding: '8px 12px',
                                  textAlign: 'left',
                                  color: '#8b949e',
                                  fontWeight: 600,
                                  fontSize: '11px',
                                  textTransform: 'uppercase',
                                  letterSpacing: '0.04em',
                                  borderBottom: '2px solid #30363d',
                                  borderRight: '1px solid #21262d',
                                  whiteSpace: 'nowrap'
                                }}>{col}</th>
                              ))}
                              <th style={{
                                padding: '8px 12px',
                                textAlign: 'center',
                                color: '#8b949e',
                                fontWeight: 600,
                                fontSize: '11px',
                                textTransform: 'uppercase',
                                letterSpacing: '0.04em',
                                borderBottom: '2px solid #30363d',
                                width: '100px',
                                whiteSpace: 'nowrap'
                              }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {collectionData.map((row, ri) => {
                              const rowPk = row.id ?? row._id;
                              const isDeleting = deleteConfirmPk === rowPk;
                              const rowBg = isDeleting ? 'rgba(248,81,73,0.15)' : (ri % 2 === 0 ? '#0d1117' : '#0e1623');
                              return (
                                <tr key={ri} style={{ background: rowBg, borderBottom: '1px solid #21262d' }}
                                  onMouseEnter={e => e.currentTarget.style.background = '#1c2128'}
                                  onMouseLeave={e => e.currentTarget.style.background = isDeleting ? 'rgba(248,81,73,0.15)' : (ri % 2 === 0 ? '#0d1117' : '#0e1623')}
                                >
                                  {sqlColumns.map((col, ci) => {
                                    const val = row[col];
                                    const isNull = val === null || val === undefined;
                                    const isNum = typeof val === 'number';
                                    const isId = col === 'id' || col.endsWith('_id');
                                    return (
                                      <td key={ci} style={{
                                        padding: '7px 12px',
                                        fontFamily: 'Consolas, Monaco, monospace',
                                        fontSize: '12px',
                                        color: isNull ? '#484f58' : isId ? '#58a6ff' : isNum ? '#d2a679' : '#7ee787',
                                        borderRight: '1px solid #21262d',
                                        verticalAlign: 'middle',
                                        maxWidth: '240px',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap'
                                      }}>
                                        {isNull ? <span style={{ fontStyle: 'italic', color: '#484f58' }}>NULL</span> : String(val)}
                                      </td>
                                    );
                                  })}
                                  <td style={{
                                    padding: '7px 12px',
                                    textAlign: 'center',
                                    verticalAlign: 'middle',
                                    whiteSpace: 'nowrap'
                                  }}>
                                    {isDeleting ? (
                                      <div style={{ display: 'flex', gap: '4px', justifyContent: 'center', alignItems: 'center' }}>
                                        <span style={{ fontSize: '11px', color: '#f85149', marginRight: '4px', fontWeight: 600 }}>Delete?</span>
                                        <button
                                          onClick={() => handleDeleteRecord(row)}
                                          style={{ background: '#f85149', border: 'none', borderRadius: '4px', color: 'white', padding: '2px 8px', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}
                                        >
                                          Yes
                                        </button>
                                        <button
                                          onClick={() => setDeleteConfirmPk(null)}
                                          style={{ background: '#30363d', border: 'none', borderRadius: '4px', color: '#8b949e', padding: '2px 8px', fontSize: '11px', cursor: 'pointer' }}
                                        >
                                          No
                                        </button>
                                      </div>
                                    ) : (
                                      <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', alignItems: 'center' }}>
                                        <button
                                          title="Edit row"
                                          onClick={() => handleEditRecord(row)}
                                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', color: '#8b949e', padding: 0 }}
                                          onMouseEnter={e => e.currentTarget.style.color = '#58a6ff'}
                                          onMouseLeave={e => e.currentTarget.style.color = '#8b949e'}
                                        >
                                          <Code size={13} />
                                        </button>
                                        <button
                                          title="Delete row"
                                          onClick={() => setDeleteConfirmPk(rowPk)}
                                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', color: '#8b949e', padding: 0 }}
                                          onMouseEnter={e => e.currentTarget.style.color = '#f85149'}
                                          onMouseLeave={e => e.currentTarget.style.color = '#8b949e'}
                                        >
                                          <Trash2 size={13} />
                                        </button>
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      ) : isMongo ? (
                        /* ── MongoDB Compass-style Document Cards ── */
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '6px' }}>
                          {collectionData.map((doc, di) => {
                            const id = doc._id || doc.id || `#${di + 1}`;
                            const isDeleting = deleteConfirmPk === id;
                            const rest = { ...doc };
                            delete rest._id;
                            delete rest.id;
                            const fields = Object.entries(rest);
                            return (
                              <div key={di} style={{
                                background: isDeleting ? 'rgba(248,81,73,0.1)' : '#111620',
                                border: isDeleting ? '1px solid #f85149' : '1px solid #21262d',
                                borderRadius: '5px',
                                padding: '10px 14px',
                                fontFamily: 'Consolas, Monaco, monospace',
                                fontSize: '12px',
                                lineHeight: 1.6,
                                position: 'relative'
                              }}>
                                {/* Action Buttons in Corner */}
                                <div style={{
                                  position: 'absolute',
                                  top: '8px',
                                  right: '12px',
                                  display: 'flex',
                                  gap: '8px',
                                  alignItems: 'center'
                                }}>
                                  {isDeleting ? (
                                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center', background: '#161b22', padding: '3px 6px', borderRadius: '4px', border: '1px solid #f85149' }}>
                                      <span style={{ fontSize: '10.5px', color: '#f85149', marginRight: '4px', fontWeight: 600 }}>Delete?</span>
                                      <button onClick={() => handleDeleteRecord(doc)} style={{ background: '#f85149', border: 'none', borderRadius: '3px', color: 'white', padding: '2px 6px', fontSize: '10px', cursor: 'pointer', fontWeight: 600 }}>Yes</button>
                                      <button onClick={() => setDeleteConfirmPk(null)} style={{ background: '#30363d', border: 'none', borderRadius: '3px', color: '#8b949e', padding: '2px 6px', fontSize: '10px', cursor: 'pointer' }}>No</button>
                                    </div>
                                  ) : (
                                    <>
                                      <button
                                        onClick={() => handleEditRecord(doc)}
                                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#8b949e', padding: 0 }}
                                        onMouseEnter={e => e.currentTarget.style.color = '#58a6ff'}
                                        onMouseLeave={e => e.currentTarget.style.color = '#8b949e'}
                                        title="Edit Document"
                                      >
                                        <Code size={12} />
                                      </button>
                                      <button
                                        onClick={() => setDeleteConfirmPk(id)}
                                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#8b949e', padding: 0 }}
                                        onMouseEnter={e => e.currentTarget.style.color = '#f85149'}
                                        onMouseLeave={e => e.currentTarget.style.color = '#8b949e'}
                                        title="Delete Document"
                                      >
                                        <Trash2 size={12} />
                                      </button>
                                    </>
                                  )}
                                </div>

                                <div style={{ color: '#58a6ff', fontWeight: 600, marginBottom: '4px', fontSize: '11.5px', width: '80%' }}>
                                  _id: <span style={{ color: '#e6edf3' }}>{String(id)}</span>
                                </div>
                                {fields.map(([k, v], fi) => (
                                  <div key={fi}>
                                    <span style={{ color: '#79c0ff' }}>{k}</span>:
                                    {' '}
                                    <span style={{ color: typeof v === 'number' ? '#d2a679' : typeof v === 'boolean' ? '#f69d50' : '#7ee787' }}>
                                      {v === null ? <span style={{ fontStyle: 'italic', color: '#484f58' }}>null</span> : JSON.stringify(v)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            );
                          })}
                        </div>
                      ) : isRedis ? (
                        /* ── Redis Key-Value List ── */
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                          <thead>
                            <tr style={{ background: '#161b22', borderBottom: '2px solid #30363d' }}>
                              <th style={{ padding: '8px 12px', textAlign: 'left', color: '#8b949e', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Key</th>
                              <th style={{ padding: '8px 12px', textAlign: 'left', color: '#8b949e', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Value</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', color: '#8b949e', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em', width: '100px' }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {collectionData.map((row, ri) => {
                              const key = row.key || Object.keys(row)[0];
                              const isDeleting = deleteConfirmPk === key;
                              const rowBg = isDeleting ? 'rgba(248,81,73,0.15)' : (ri % 2 === 0 ? '#0d1117' : '#0e1623');
                              return (
                                <tr key={ri} style={{ borderBottom: '1px solid #21262d', background: rowBg }}>
                                  <td style={{ padding: '7px 12px', fontFamily: 'monospace', color: '#58a6ff', verticalAlign: 'middle' }}>{key}</td>
                                  <td style={{ padding: '7px 12px', fontFamily: 'monospace', color: '#7ee787', verticalAlign: 'middle' }}>{row.value || Object.values(row)[1]}</td>
                                  <td style={{ padding: '7px 12px', textAlign: 'center', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                                    {isDeleting ? (
                                      <div style={{ display: 'flex', gap: '4px', justifyContent: 'center', alignItems: 'center' }}>
                                        <span style={{ fontSize: '11px', color: '#f85149', marginRight: '4px', fontWeight: 600 }}>Del?</span>
                                        <button onClick={() => handleDeleteRecord(row)} style={{ background: '#f85149', border: 'none', borderRadius: '4px', color: 'white', padding: '2px 8px', fontSize: '11.5px', cursor: 'pointer', fontWeight: 600 }}>Yes</button>
                                        <button onClick={() => setDeleteConfirmPk(null)} style={{ background: '#30363d', border: 'none', borderRadius: '4px', color: '#8b949e', padding: '2px 8px', fontSize: '11.5px', cursor: 'pointer' }}>No</button>
                                      </div>
                                    ) : (
                                      <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', alignItems: 'center' }}>
                                        <button onClick={() => handleEditRecord(row)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#8b949e', padding: 0 }} onMouseEnter={e => e.currentTarget.style.color = '#58a6ff'} onMouseLeave={e => e.currentTarget.style.color = '#8b949e'} title="Edit Value"><Code size={13} /></button>
                                        <button onClick={() => setDeleteConfirmPk(key)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#8b949e', padding: 0 }} onMouseEnter={e => e.currentTarget.style.color = '#f85149'} onMouseLeave={e => e.currentTarget.style.color = '#8b949e'} title="Delete Key"><Trash2 size={13} /></button>
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      ) : (
                        /* ── Generic JSON Table ── */
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                          <thead>
                            <tr style={{ background: '#161b22', borderBottom: '2px solid #30363d' }}>
                              {collectionData.length > 0 && Object.keys(collectionData[0]).map((col, ci) => (
                                <th key={ci} style={{ padding: '8px 12px', textAlign: 'left', color: '#8b949e', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em', borderRight: '1px solid #21262d' }}>{col}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {collectionData.map((row, ri) => (
                              <tr key={ri} style={{ borderBottom: '1px solid #21262d', background: ri % 2 === 0 ? '#0d1117' : '#0e1623' }}>
                                {Object.values(row).map((val, vi) => (
                                  <td key={vi} style={{ padding: '7px 12px', fontFamily: 'monospace', color: '#7ee787', borderRight: '1px solid #21262d' }}>{val === null ? 'NULL' : String(val)}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                );
              })()
            )}
          </div>
        </div>

        {/* Right Side Chat Bot Pane — Drag Handle */}
        <div
          onMouseDown={handleDragStart}
          title="Drag to resize chat panel"
          style={{
            width: '5px',
            cursor: 'col-resize',
            background: 'transparent',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 0.15s',
            borderRadius: '3px',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(59,130,246,0.35)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <GripVertical size={12} color="rgba(255,255,255,0.25)" />
        </div>

        {/* Right Side Chat Bot Pane */}
        <div style={{ 
          width: `${chatSidebarWidth}px`,
          minWidth: '240px',
          maxWidth: '600px',
          flexShrink: 0,
          background: 'var(--bg-secondary)', 
          borderRadius: '8px', 
          border: '1px solid var(--border-subtle)', 
          display: 'flex', 
          flexDirection: 'column',
          height: '100%',
          minHeight: 0,
          overflow: 'hidden'
        }}>
          {/* Chat header */}
          <div style={{ 
            padding: '12px 16px', 
            borderBottom: '1px solid var(--border-subtle)', 
            display: 'flex', 
            flexDirection: 'column', 
            gap: '10px' 
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Bot size={16} color="var(--accent-blue)" />
                <span style={{ fontWeight: 600, fontSize: '13px' }}>DevOps Chat Threads</span>
              </div>
              <button
                onClick={handleCreateChat}
                style={{
                  background: 'rgba(59, 130, 246, 0.1)',
                  border: '1px solid rgba(59, 130, 246, 0.2)',
                  color: 'var(--accent-blue)',
                  fontSize: '11px',
                  fontWeight: 600,
                  padding: '3px 8px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                <Plus size={11} /> New Chat
              </button>
            </div>
            {/* Thread Selector Dropdown */}
            <select
              value={activeChatId}
              onChange={(e) => handleSelectChat(e.target.value)}
              style={{
                width: '100%',
                background: '#1f2937',
                color: '#ffffff',
                border: '1px solid var(--border-subtle)',
                borderRadius: '6px',
                padding: '6px 10px',
                fontSize: '12px',
                outline: 'none',
                cursor: 'pointer'
              }}
            >
              {chats.map(chat => (
                <option key={chat._id} value={chat._id} style={{ background: '#1f2937', color: '#ffffff' }}>
                  {chat.title || 'Untitled Thread'}
                </option>
              ))}
            </select>
            {/* Exec Permission Selector */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Exec Mode:</span>
              <select
                value={selectedDep?.execPermission || 'ask'}
                onChange={async (e) => {
                  const val = e.target.value;
                  try {
                    await updateAgentPermission(selectedId, val);
                    setSelectedDep(prev => prev ? { ...prev, execPermission: val } : null);
                    setDeployments(prev => prev.map(d => d._id === selectedId ? { ...d, execPermission: val } : d));
                  } catch (err) {
                    console.error('Failed to update permission:', err);
                  }
                }}
                style={{
                  flex: 1,
                  background: 'var(--bg-base)',
                  color: selectedDep?.execPermission === 'always' ? '#10b981' : selectedDep?.execPermission === 'never' ? '#ef4444' : 'var(--accent-blue)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '6px',
                  padding: '4px 8px',
                  fontSize: '12px',
                  fontWeight: 600,
                  outline: 'none',
                  cursor: 'pointer',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.03)'
                }}
              >
                <option value="ask" style={{ color: 'var(--accent-blue)' }}>Ask for permission</option>
                <option value="always" style={{ color: '#10b981' }}>Always run autonomously</option>
                <option value="never" style={{ color: '#ef4444' }}>Block all executions</option>
              </select>
            </div>
          </div>

          {/* Quick prompt templates */}
          <div style={{ padding: '10px 16px', background: 'rgba(255,255,255,0.02)', display: 'flex', flexDirection: 'column', gap: '6px', borderBottom: '1px solid var(--border-subtle)' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>Quick Actions:</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              <button 
                onClick={() => handleSendChat('Write a Node.js seed script to insert mock products data and run it in the container')}
                style={{
                  background: 'rgba(59, 130, 246, 0.1)',
                  border: '1px solid rgba(59, 130, 246, 0.2)',
                  color: 'var(--accent-blue)',
                  fontSize: '11px',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                Seed Mock Products (Node.js)
              </button>
              <button 
                onClick={() => handleSendChat('Scan the project compile files and fix any typescript lint or compiler errors')}
                style={{
                  background: 'rgba(16, 185, 129, 0.1)',
                  border: '1px solid rgba(16, 185, 129, 0.2)',
                  color: 'var(--accent-green)',
                  fontSize: '11px',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                Scan & Fix Build Errors
              </button>
            </div>
          </div>

          {/* Chat bubbles list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {chatMessages.map((msg, idx) => {
              const isUser = msg.role === 'user';
              return (
                <div 
                  key={idx}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '8px',
                    alignSelf: isUser ? 'flex-end' : 'flex-start',
                    maxWidth: isUser ? '85%' : '100%',
                    width: isUser ? 'auto' : '100%',
                    minWidth: 0
                  }}
                >
                  {/* Undo Button on the LEFT of user query bubbles */}
                  {isUser && (
                    <button
                      onClick={() => handleUndo(idx)}
                      title="Undo changes up to this point"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#64748b',
                        cursor: 'pointer',
                        padding: '4px',
                        borderRadius: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.15s',
                        outline: 'none',
                        alignSelf: 'center'
                      }}
                      onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
                      onMouseLeave={e => e.currentTarget.style.color = '#64748b'}
                    >
                      <RotateCcw size={13} />
                    </button>
                  )}

                   {/* Message Bubble Body */}
                  <div 
                    style={{ 
                      background: isUser ? 'var(--accent-blue)' : themeStyles.bgHeader,
                      border: isUser ? 'none' : `1px solid ${themeStyles.border}`,
                      boxShadow: isUser ? 'none' : '0 1px 2px rgba(0,0,0,0.08)',
                      padding: '10px 14px',
                      borderRadius: '8px',
                      fontSize: '13px',
                      lineHeight: '1.45',
                      color: isUser ? '#ffffff' : themeStyles.text,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      flex: 1,
                      minWidth: 0
                    }}
                  >
                    {/* Diff pill + Rollback button for agent messages with patches */}
                    {msg.role === 'agent' && msg.patches && msg.patches.length > 0 && (
                      <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        marginBottom: '4px',
                        flex: 1
                      }}>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          flexWrap: 'wrap'
                        }}>
                          {/* Files changed pill */}
                          <button
                            onClick={() => toggleDiffExpansion(idx)}
                            title="Click to view changed files details"
                            style={{
                              background: 'rgba(0,0,0,0.25)',
                              border: '1px solid rgba(255,255,255,0.1)',
                              borderRadius: '20px',
                              padding: '2px 8px',
                              fontSize: '11px',
                              color: '#94a3b8',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '5px',
                              fontFamily: 'monospace'
                            }}
                          >
                            <span style={{ color: '#6b7280' }}>
                              {msg.patches.length} file{msg.patches.length !== 1 ? 's' : ''} changed
                            </span>
                            <span style={{ color: '#4ade80', fontWeight: 700 }}>
                              +{msg.patches.reduce((s, p) => s + (p.added || 0), 0)}
                            </span>
                            <span style={{ color: '#f87171', fontWeight: 700 }}>
                              -{msg.patches.reduce((s, p) => s + (p.removed || 0), 0)}
                            </span>
                            <span style={{ color: '#6b7280', marginLeft: '2px' }}>
                              {expandedDiffs[idx] ? '▼' : '▶'}
                            </span>
                          </button>

                          {/* Rollback button */}
                          {!msg.rolledBack ? (
                            <button
                              onClick={() => handleRollback(idx)}
                              title="Rollback these changes"
                              style={{
                                background: 'rgba(239,68,68,0.08)',
                                border: '1px solid rgba(239,68,68,0.25)',
                                borderRadius: '20px',
                                padding: '2px 8px',
                                fontSize: '11px',
                                color: '#f87171',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                                transition: 'all 0.15s',
                                fontWeight: 500
                              }}
                              onMouseEnter={e => {
                                e.currentTarget.style.background = 'rgba(239,68,68,0.18)';
                                e.currentTarget.style.borderColor = 'rgba(239,68,68,0.5)';
                              }}
                              onMouseLeave={e => {
                                e.currentTarget.style.background = 'rgba(239,68,68,0.08)';
                                e.currentTarget.style.borderColor = 'rgba(239,68,68,0.25)';
                              }}
                            >
                              <RotateCcw size={10} />
                              Rollback
                            </button>
                          ) : (
                            <span style={{
                              fontSize: '11px',
                              color: '#a3a3a3',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              fontStyle: 'italic'
                            }}>
                              <RotateCcw size={10} />
                              Rolled back
                            </span>
                          )}
                        </div>

                        {/* Collapsible files diff list */}
                        {expandedDiffs[idx] && (
                          <div style={{
                            background: 'rgba(15, 23, 42, 0.45)',
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            borderRadius: '8px',
                            padding: '6px 8px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '4px',
                            marginTop: '2px',
                            maxWidth: '100%',
                            boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.2)'
                          }}>
                            {msg.patches.map((p, pIdx) => {
                              const parts = p.file.split('/');
                              const fileName = parts[parts.length - 1];
                              const dirName = parts.slice(0, -1).join('/');
                              const displayPath = dirName ? `.../${dirName}` : '';
                              return (
                                <div
                                  key={pIdx}
                                  onClick={() => {
                                    handleSelectFile(p.file);
                                    setCenterTab('editor');
                                  }}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '5px 8px',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    background: 'rgba(255, 255, 255, 0.02)',
                                    transition: 'background 0.15s',
                                    fontSize: '12px',
                                    fontFamily: 'monospace'
                                  }}
                                  onMouseEnter={e => {
                                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)';
                                  }}
                                  onMouseLeave={e => {
                                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
                                  }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                                    {/* Orange Dot Bullet */}
                                    <span style={{
                                      width: '6px',
                                      height: '6px',
                                      borderRadius: '50%',
                                      background: '#f97316',
                                      display: 'inline-block',
                                      flexShrink: 0
                                    }} />
                                    
                                    {/* File stats */}
                                    <div style={{ display: 'flex', gap: '6px', fontSize: '11px', flexShrink: 0 }}>
                                      <span style={{ color: '#4ade80', fontWeight: 600 }}>+{p.added || 0}</span>
                                      <span style={{ color: '#f87171', fontWeight: 600 }}>-{p.removed || 0}</span>
                                    </div>

                                    {/* File Name */}
                                    <span style={{ color: '#f1f5f9', fontWeight: 500, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                                      {fileName}
                                    </span>
                                  </div>

                                  {/* Directory path */}
                                  {displayPath && (
                                    <span style={{ color: 'var(--text-muted)', fontSize: '10px', marginLeft: '12px', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                                      {displayPath}
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Content Rendering with Thought Parsing & Markdown support */}
                    {(() => {
                      const isLightTheme = ['light', 'solarized-light', 'quiet-light'].includes(ideTheme);
                      if (!msg.text) return null;
                      const { thoughts, cleanText } = parseThoughts(msg.text);
                      if (thoughts) {
                        const duration = msg.durationSec !== undefined ? msg.durationSec : null;
                        const summaryText = msg.isStreaming 
                          ? `Thinking Process (Worked for ${duration || 0}s...)`
                          : `Thinking Process (Worked for ${duration || 0}s)`;

                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <details 
                              open={msg.isStreaming}
                              style={{
                                background: themeStyles.bgMain,
                                border: `1px solid ${themeStyles.border}`,
                                borderRadius: '6px',
                                padding: '6px 10px',
                                fontSize: '12px'
                              }}
                            >
                              <summary style={{ cursor: 'pointer', color: themeStyles.textMuted, fontWeight: 500, outline: 'none' }}>
                                {summaryText}
                              </summary>
                              <div style={{ marginTop: '6px', whiteSpace: 'pre-wrap', color: themeStyles.textDim, fontFamily: 'monospace', fontSize: '11px', borderTop: `1px solid ${themeStyles.border}`, paddingTop: '6px' }}>
                                {thoughts}
                              </div>
                            </details>
                            {cleanText && <div style={{ color: themeStyles.text }}>{renderMarkdown(cleanText, isUser, isLightTheme, themeStyles)}</div>}
                          </div>
                        );
                      }
                      return <div>{renderMarkdown(msg.text, isUser, isLightTheme, themeStyles)}</div>;
                    })()}

                    {/* Confirm actions (only show on the last message) */}
                    {msg.pendingAction && msg.pendingAction.commands && msg.pendingAction.commands.length > 0 && idx === chatMessages.length - 1 && (
                      <div style={{
                        marginTop: '8px',
                        padding: '10px',
                        background: 'rgba(0,0,0,0.2)',
                        borderRadius: '6px',
                        border: '1px solid rgba(234, 179, 8, 0.3)',
                        fontSize: '12px',
                        color: '#fef08a'
                      }}>
                        <div style={{ fontWeight: 600, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <AlertCircle size={14} color="#facc15" /> Confirm Execution Command
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
                          {msg.pendingAction.commands.map((cmd, cIdx) => (
                            <div key={cIdx} style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(0,0,0,0.3)', padding: '4px 6px', borderRadius: '4px' }}>
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
                                      pendingAction: {
                                        ...copy[idx].pendingAction,
                                        commands: updatedCmds
                                      }
                                    };
                                    return copy;
                                  });
                                }}
                                style={{
                                  flex: 1,
                                  background: 'transparent',
                                  color: '#fff',
                                  border: 'none',
                                  outline: 'none',
                                  fontFamily: 'monospace',
                                  fontSize: '12px'
                                }}
                              />
                            </div>
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <button 
                            onClick={() => handlePermissionAllow(idx, msg.pendingAction.commands)}
                            style={{
                              background: 'var(--accent-blue)',
                              color: '#fff',
                              border: 'none',
                              padding: '4px 8px',
                              borderRadius: '4px',
                              fontSize: '11px',
                              fontWeight: 500,
                              cursor: 'pointer'
                            }}
                          >
                            Allow this time
                          </button>
                          <button 
                            onClick={() => handlePermissionAllowEverytime(idx, msg.pendingAction.commands)}
                            style={{
                              background: '#10b981',
                              color: '#fff',
                              border: 'none',
                              padding: '4px 8px',
                              borderRadius: '4px',
                              fontSize: '11px',
                              fontWeight: 500,
                              cursor: 'pointer'
                            }}
                          >
                            Allow everytime
                          </button>
                          <button 
                            onClick={() => handlePermissionNever(idx)}
                            style={{
                              background: '#ef4444',
                              color: '#fff',
                              border: 'none',
                              padding: '4px 8px',
                              borderRadius: '4px',
                              fontSize: '11px',
                              fontWeight: 500,
                              cursor: 'pointer'
                            }}
                          >
                            Never allow
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {isAgentTyping && (
              <div style={{ alignSelf: 'flex-start', color: 'var(--text-muted)', fontSize: '12px', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Bot size={13} /> DevOps Agent is thinking...
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Chat Input panel */}
          <div style={{ padding: '12px', borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <textarea
                placeholder={selectedDep?.previewStatus === 'running' 
                  ? "Ask agent to seed db or edit code..." 
                  : "Target deployment is offline. Start the preview sandbox above to begin chatting."}
                value={chatInput}
                disabled={selectedDep?.previewStatus !== 'running'}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && selectedDep?.previewStatus === 'running') {
                    e.preventDefault();
                    handleSendChat();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const filePath = e.dataTransfer.getData('text/plain');
                  if (filePath) {
                    setChatInput(prev => {
                      const suffix = ` [Reference: ${filePath}]`;
                      return prev ? prev + suffix : suffix;
                    });
                  }
                }}
                rows={5}
                style={{
                  flex: 1,
                  background: selectedDep?.previewStatus === 'running' ? '#fff' : '#f1f5f9',
                  color: selectedDep?.previewStatus === 'running' ? 'black' : '#94a3b8',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '6px',
                  padding: '8px 12px',
                  fontSize: '13px',
                  outline: 'none',
                  resize: 'none',
                  fontFamily: 'inherit',
                  lineHeight: '1.4',
                  overflowY: 'auto',
                  cursor: selectedDep?.previewStatus === 'running' ? 'text' : 'not-allowed'
                }}
              />
              {isAgentTyping ? (
                <button
                  onClick={handleStopChat}
                  style={{
                    background: '#ef4444',
                    color: '#fff',
                    border: 'none',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'background 0.15s'
                  }}
                  title="Stop Execution"
                >
                  <span style={{ width: '10px', height: '10px', background: '#fff', borderRadius: '1px' }} />
                </button>
              ) : (
                <button
                  onClick={() => handleSendChat()}
                  disabled={selectedDep?.previewStatus !== 'running'}
                  style={{
                    background: selectedDep?.previewStatus === 'running' ? 'var(--accent-blue)' : '#cbd5e1',
                    color: '#fff',
                    border: 'none',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    cursor: selectedDep?.previewStatus === 'running' ? 'pointer' : 'not-allowed',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: selectedDep?.previewStatus === 'running' ? 1 : 0.6
                  }}
                >
                  <Send size={14} />
                </button>
              )}
            </div>
          </div>
        </div>

      </div>

      {/* Insert Record Modal Dialog — DB type aware */}
      {isInsertModalOpen && (() => {
        const dbType = selectedDep?.dbInitType || 'mongodb';
        const isSql = ['postgres', 'mysql', 'mariadb', 'sqlite', 'mssql', 'oracle'].includes(dbType);
        const hasCols = isSql && collectionColumns.length > 0;

        const handleSubmit = async () => {
          setInsertError('');
          try {
            let record;
            if (hasCols) {
              // Build record from per-column inputs
              record = {};
              for (const col of collectionColumns) {
                const v = sqlRowValues[col];
                const asNum = Number(v);
                record[col] = v === '' ? null : (!isNaN(asNum) && v !== '' ? asNum : v);
              }
            } else {
              record = JSON.parse(newRecordJson);
            }
            await insertDbRecord(selectedId, activeCollection, record, dbType);
            setIsInsertModalOpen(false);
            handleSelectCollection(activeCollection);
          } catch (err) {
            setInsertError(err.response?.data?.message || err.message || 'Invalid input');
          }
        };

        return (
          <div style={{
            position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
            background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
          }}>
            <div style={{
              background: '#161b22',
              border: '1px solid #30363d',
              borderRadius: '10px',
              width: hasCols ? '500px' : '460px',
              maxHeight: '80vh',
              overflow: 'auto',
              padding: '22px',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Database size={15} color={isSql ? '#4ec9b0' : '#58a6ff'} />
                <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#e6edf3' }}>
                  {isSql ? `Insert Row into` : `Add Document to`}{' '}
                  <code style={{ color: isSql ? '#4ec9b0' : '#58a6ff', background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: '3px' }}>{activeCollection}</code>
                </h3>
              </div>

              {hasCols ? (
                /* SQL column-per-row form */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <span style={{ fontSize: '11.5px', color: '#8b949e' }}>Fill in values for each column. Leave blank to insert NULL.</span>
                  {collectionColumns.map(col => (
                    <div key={col} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <label style={{ width: '130px', fontSize: '12px', fontFamily: 'monospace', color: '#8b949e', flexShrink: 0, textAlign: 'right' }}>{col}</label>
                      <input
                        value={sqlRowValues[col] ?? ''}
                        onChange={e => setSqlRowValues(prev => ({ ...prev, [col]: e.target.value }))}
                        placeholder={`NULL`}
                        style={{
                          flex: 1, background: '#0d1117', color: '#7ee787',
                          border: '1px solid #30363d', borderRadius: '5px',
                          padding: '6px 10px', fontFamily: 'Consolas, monospace',
                          fontSize: '12.5px', outline: 'none'
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                /* NoSQL / unknown: JSON textarea */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span style={{ fontSize: '11.5px', color: '#8b949e' }}>Enter the document fields as JSON:</span>
                  <textarea
                    value={newRecordJson}
                    onChange={(e) => setNewRecordJson(e.target.value)}
                    style={{
                      height: '140px', background: '#0d1117', color: '#7ee787',
                      border: '1px solid #30363d', borderRadius: '6px',
                      padding: '10px', fontFamily: 'Consolas, Monaco, monospace',
                      fontSize: '12.5px', outline: 'none', resize: 'vertical', lineHeight: 1.5
                    }}
                  />
                </div>
              )}

              {insertError && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#f85149', fontSize: '12px', background: 'rgba(248,81,73,0.08)', padding: '8px 10px', borderRadius: '5px' }}>
                  <AlertCircle size={13} />
                  <span>{insertError}</span>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px', borderTop: '1px solid #21262d', paddingTop: '14px' }}>
                <button
                  onClick={() => { setIsInsertModalOpen(false); setInsertError(''); }}
                  style={{ background: 'transparent', border: '1px solid #30363d', color: '#8b949e', padding: '6px 14px', borderRadius: '6px', fontSize: '13px', cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  style={{ background: isSql ? '#0e6655' : 'var(--accent-blue)', color: '#fff', border: 'none', padding: '6px 16px', borderRadius: '6px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
                >
                  {isSql ? 'Execute INSERT' : 'Insert'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Edit Record Modal Dialog — DB type aware */}
      {isEditModalOpen && (() => {
        const dbType = selectedDep?.dbInitType || 'mongodb';
        const isSql = ['postgres', 'mysql', 'mariadb', 'sqlite', 'mssql', 'oracle'].includes(dbType);
        const hasCols = isSql && collectionColumns.length > 0;

        return (
          <div style={{
            position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
            background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
          }}>
            <div style={{
              background: '#161b22',
              border: '1px solid #30363d',
              borderRadius: '10px',
              width: hasCols ? '500px' : '460px',
              maxHeight: '80vh',
              overflow: 'auto',
              padding: '22px',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Database size={15} color={isSql ? '#4ec9b0' : '#58a6ff'} />
                <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#e6edf3' }}>
                  {isSql ? `Update Row in` : `Edit Document in`}{' '}
                  <code style={{ color: isSql ? '#4ec9b0' : '#58a6ff', background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: '3px' }}>{activeCollection}</code>
                </h3>
              </div>

              {isSql && (
                <div style={{ fontSize: '11px', color: '#8b949e', background: 'rgba(255,255,255,0.03)', padding: '6px 10px', borderRadius: '4px', fontFamily: 'monospace' }}>
                  Primary Key: <span style={{ color: '#58a6ff' }}>{editPkColumn}</span> = <span style={{ color: '#7ee787' }}>{String(editPkValue)}</span>
                </div>
              )}

              {hasCols ? (
                /* SQL column-per-row form */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <span style={{ fontSize: '11.5px', color: '#8b949e' }}>Modify values for each column:</span>
                  {collectionColumns.map(col => (
                    <div key={col} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <label style={{ width: '130px', fontSize: '12px', fontFamily: 'monospace', color: '#8b949e', flexShrink: 0, textAlign: 'right' }}>{col}</label>
                      <input
                        value={editSqlRowValues[col] ?? ''}
                        onChange={e => setEditSqlRowValues(prev => ({ ...prev, [col]: e.target.value }))}
                        placeholder={`NULL`}
                        style={{
                          flex: 1, background: '#0d1117', color: '#7ee787',
                          border: '1px solid #30363d', borderRadius: '5px',
                          padding: '6px 10px', fontFamily: 'Consolas, monospace',
                          fontSize: '12.5px', outline: 'none'
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                /* NoSQL / unknown: JSON textarea */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span style={{ fontSize: '11.5px', color: '#8b949e' }}>Modify document JSON fields:</span>
                  <textarea
                    value={editNewRecordJson}
                    onChange={(e) => setEditNewRecordJson(e.target.value)}
                    style={{
                      height: '160px', background: '#0d1117', color: '#7ee787',
                      border: '1px solid #30363d', borderRadius: '6px',
                      padding: '10px', fontFamily: 'Consolas, Monaco, monospace',
                      fontSize: '12.5px', outline: 'none', resize: 'vertical', lineHeight: 1.5
                    }}
                  />
                </div>
              )}

              {editError && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#f85149', fontSize: '12px', background: 'rgba(248,81,73,0.08)', padding: '8px 10px', borderRadius: '5px' }}>
                  <AlertCircle size={13} />
                  <span>{editError}</span>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px', borderTop: '1px solid #21262d', paddingTop: '14px' }}>
                <button
                  onClick={() => { setIsEditModalOpen(false); setEditError(''); }}
                  style={{ background: 'transparent', border: '1px solid #30363d', color: '#8b949e', padding: '6px 14px', borderRadius: '6px', fontSize: '13px', cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveEdit}
                  style={{ background: isSql ? '#0e6655' : 'var(--accent-blue)', color: '#fff', border: 'none', padding: '6px 16px', borderRadius: '6px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
                >
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
