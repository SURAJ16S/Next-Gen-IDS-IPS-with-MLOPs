import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { 
  getDeployments, 
  getWorkspaceFiles, 
  getWorkspaceFileContent, 
  saveWorkspaceFile, 
  getDbCollections, 
  getDbCollectionData, 
  insertDbRecord, 
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
  Folder, File, Database, Play, Save, Send, Bot, RefreshCw, Plus, 
  Terminal, ShieldCheck, Code, ListFilter, AlertCircle, Trash2, RotateCcw, GripVertical
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

function TerminalView({ jobId }) {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    if (!jobId || !terminalRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#f8f8f2',
        cursor: '#f8f8f0'
      },
      fontSize: 13,
      fontFamily: 'Consolas, Monaco, monospace',
      rows: 24,
      cols: 80
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    setTimeout(() => {
      try {
        fitAddon.fit();
      } catch (_) {}
    }, 100);

    xtermRef.current = term;

    const socket = io('http://localhost:5000');
    socketRef.current = socket;

    socket.on('connect', () => {
      term.write('\x1b[32m*** Connected to terminal stream ***\x1b[0m\r\n');
      socket.emit('terminal:init', { jobId });
      // Subscribe to pipeline logs so build progress streams here too
      socket.emit('subscribe:pipeline', { jobId });
    });

    socket.on('terminal:data', (data) => {
      term.write(data);
    });

    // Listen to real-time build and health check logs
    socket.on('pipeline:log', ({ log }) => {
      term.write('\r\n\x1b[90m' + log + '\x1b[0m\r\n');
    });

    term.onData((data) => {
      socket.emit('terminal:input', data);
    });

    const handleResize = () => {
      try {
        fitAddon.fit();
      } catch (_) {}
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
      socket.emit('unsubscribe:pipeline', { jobId });
      socket.disconnect();
    };
  }, [jobId]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#1e1e1e', padding: '8px', minHeight: 0, borderRadius: '6px' }}>
      <div ref={terminalRef} style={{ flex: 1, width: '100%', height: '100%', overflow: 'hidden' }} />
    </div>
  );
}

// Helper to recursively render file tree node
function FileTreeNode({ node, onSelectFile, selectedPath }) {
  const [isOpen, setIsOpen] = useState(false);
  const isSelected = selectedPath === node.path;

  if (node.isDir) {
    return (
      <div style={{ marginLeft: '12px', userSelect: 'none' }}>
        <div 
          onClick={() => setIsOpen(!isOpen)}
          style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '6px', 
            padding: '4px 6px', 
            cursor: 'pointer',
            borderRadius: '4px',
            color: 'var(--text-secondary)',
            fontSize: '13px',
            fontWeight: 500
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.03)'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
        >
          <Folder size={15} color="#eab308" />
          <span>{node.name}</span>
        </div>
        {isOpen && node.children && (
          <div style={{ borderLeft: '1px solid var(--border-subtle)', marginLeft: '6px' }}>
            {node.children.map((child, idx) => (
              <FileTreeNode 
                key={idx} 
                node={child} 
                onSelectFile={onSelectFile} 
                selectedPath={selectedPath} 
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
      style={{ 
        marginLeft: '12px',
        display: 'flex', 
        alignItems: 'center', 
        gap: '6px', 
        padding: '4px 6px', 
        cursor: 'pointer',
        borderRadius: '4px',
        color: isSelected ? '#fff' : 'var(--text-muted)',
        backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
        borderLeft: isSelected ? '2px solid var(--accent-blue)' : 'none',
        fontSize: '13px',
        userSelect: 'none'
      }}
      onMouseEnter={(e) => {
        if (!isSelected) e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.03)';
      }}
      onMouseLeave={(e) => {
        if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
      }}
    >
      <File size={14} color="#94a3b8" />
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

const renderMarkdown = (text) => {
  if (!text) return null;

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
      // Parse bold **text** and inline code `code`
      const boldParts = lineText.split(/(\*\*.*?\*\*)/g);
      return boldParts.map((bp, bpIdx) => {
        if (bp.startsWith('**') && bp.endsWith('**')) {
          const boldText = bp.slice(2, -2);
          return <strong key={bpIdx} style={{ fontWeight: 600, color: '#f8fafc' }}>{boldText}</strong>;
        }
        
        const codeParts = bp.split(/(`.*?`)/g);
        return codeParts.map((cp, cpIdx) => {
          if (cp.startsWith('`') && cp.endsWith('`')) {
            const codeText = cp.slice(1, -1);
            return (
              <code key={cpIdx} style={{
                background: 'rgba(255,255,255,0.08)',
                padding: '2px 5px',
                borderRadius: '4px',
                fontFamily: 'monospace',
                fontSize: '12px',
                color: '#f472b6',
                border: '1px solid rgba(255,255,255,0.04)'
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
          <div key={`h-${lineIdx}`} style={{ fontSize: size, fontWeight: 700, margin: margin, color: '#f1f5f9' }}>
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
            background: 'rgba(59, 130, 246, 0.04)',
            padding: '8px 12px',
            margin: '8px 0',
            borderRadius: '0 4px 4px 0',
            color: '#94a3b8',
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
          <li key={`li-${lineIdx}`} style={{ color: '#cbd5e1', fontSize: '13px', lineHeight: '1.4' }}>
            {parseInline(itemText)}
          </li>
        );
      }
      else if (trimmed) {
        flushList(`list-before-p-${lineIdx}`);
        elements.push(
          <div key={`p-${lineIdx}`} style={{ margin: '4px 0', color: '#cbd5e1', fontSize: '13px', lineHeight: '1.4' }}>
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

export default function Agent() {
  const [deployments, setDeployments] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [selectedDep, setSelectedDep] = useState(null);
  
  // File System State
  const [filesTree, setFilesTree] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [isSavingFile, setIsSavingFile] = useState(false);
  
  // Database Explorer State
  const [dbCollections, setDbCollections] = useState([]);
  const [activeCollection, setActiveCollection] = useState('');
  const [collectionData, setCollectionData] = useState([]);
  const [isDbLoading, setIsDbLoading] = useState(false);
  
  // Database record insertion state
  const [isInsertModalOpen, setIsInsertModalOpen] = useState(false);
  const [newRecordJson, setNewRecordJson] = useState('{\n  "name": "Jane Doe",\n  "email": "jane@example.com"\n}');
  const [insertError, setInsertError] = useState('');

  // AI Chat Agent State & Thread Sessions
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState('');
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const [expandedDiffs, setExpandedDiffs] = useState({});

  // Draggable chat sidebar
  const [chatSidebarWidth, setChatSidebarWidth] = useState(320);
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(320);
  
  // Current tab inside center pane
  const [centerTab, setCenterTab] = useState('editor'); // 'editor' | 'database' | 'terminal' | 'dbShell'
  
  // Database Shell State
  const [shellQuery, setShellQuery] = useState('');
  const [shellOutput, setShellOutput] = useState('');
  const [isShellRunning, setIsShellRunning] = useState(false);
  
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
      setCenterTab('editor');
    } catch (err) {
      console.error('Failed to read file:', err);
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
    
    setChatMessages(prev => [...prev, { role: 'user', text }]);
    setIsAgentTyping(true);

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await executeAgentChat(selectedId, text, activeChatId, { signal: controller.signal });
      const { message, pendingExec, commands, chatId, patches } = res.data;
      
      if (chatId && chatId !== activeChatId) {
        setActiveChatId(chatId);
      }
      
      setChatMessages(prev => [...prev, { 
        role: 'agent', 
        text: message, 
        pendingAction: pendingExec ? { commands } : null,
        patches: patches && patches.length > 0 ? patches : null,
        rolledBack: false
      }]);

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
      if (err.name === 'CanceledError' || axios.isCancel(err)) {
        setChatMessages(prev => [...prev, { role: 'agent', text: '⚠️ *Thinking paused/execution stopped by user.*' }]);
      } else {
        setChatMessages(prev => [...prev, { role: 'agent', text: `Failed to talk to DevOps Agent: ${err.message}` }]);
      }
    } finally {
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
        </div>
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
                  />
                ))
              )}
            </div>
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
            background: 'rgba(0,0,0,0.2)', 
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
          </div>

          {/* Tab contents */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '16px', minHeight: 0 }}>
            {centerTab === 'editor' ? (
              activeFile ? (
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{activeFile}</span>
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
                  <div style={{ flex: 1, minHeight: 0, borderRadius: '6px', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
                    <Editor
                      height="100%"
                      defaultLanguage="javascript"
                      language={getLanguageFromPath(activeFile)}
                      theme="vs-dark"
                      value={fileContent}
                      onChange={(value) => setFileContent(value || '')}
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
            ) : centerTab === 'terminal' ? (
              <TerminalView jobId={selectedDep?.jobId} />
            ) : centerTab === 'dbShell' ? (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '12px', minHeight: 0 }}>
                <div style={{ fontSize: '14px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Database size={15} color="var(--accent-blue)" /> Database Query Shell
                </div>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  Enter queries to run inside the database container. Use Mongo syntax (e.g. <code>db.products.find()</code>) or SQL commands depending on database.
                </span>
                <textarea
                  value={shellQuery}
                  onChange={(e) => setShellQuery(e.target.value)}
                  placeholder="e.g. db.products.find().toArray()"
                  style={{
                    height: '100px',
                    background: 'rgba(0,0,0,0.2)',
                    color: '#fff',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '6px',
                    padding: '10px',
                    fontFamily: 'monospace',
                    fontSize: '12.5px',
                    outline: 'none',
                    resize: 'none'
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    DB Type: <code style={{ color: 'var(--accent-cyan)' }}>{selectedDep?.dbInitType || 'mongodb'}</code>
                  </span>
                  <button
                    onClick={handleRunShellQuery}
                    disabled={isShellRunning || !shellQuery.trim()}
                    style={{
                      background: 'var(--accent-blue)',
                      color: '#fff',
                      border: 'none',
                      padding: '6px 16px',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: 500,
                      cursor: 'pointer',
                      opacity: isShellRunning || !shellQuery.trim() ? 0.6 : 1
                    }}
                  >
                    {isShellRunning ? 'Running Query...' : 'Run Query'}
                  </button>
                </div>
                <div style={{ flex: 1, background: '#1e1e1e', border: '1px solid var(--border-subtle)', borderRadius: '6px', padding: '10px', overflow: 'auto', fontFamily: 'monospace', fontSize: '12px', color: '#10b981' }}>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{shellOutput}</pre>
                </div>
              </div>
            ) : (
              // Live DB collection grid
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 600 }}>Collection: <code style={{ color: 'var(--accent-blue)' }}>{activeCollection}</code></span>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: '4px' }}>limit 50</span>
                  </div>
                  <button
                    onClick={() => {
                      setInsertError('');
                      setIsInsertModalOpen(true);
                    }}
                    style={{
                      background: 'var(--accent-blue)',
                      color: '#fff',
                      border: 'none',
                      padding: '6px 12px',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: 500,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                  >
                    <Plus size={14} /> Add Document
                  </button>
                </div>

                <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--border-subtle)', borderRadius: '6px', background: 'rgba(0,0,0,0.15)' }}>
                  {isDbLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'var(--text-muted)' }}>
                      Loading collection records...
                    </div>
                  ) : collectionData.length === 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'var(--text-muted)', fontSize: '13px' }}>
                      No documents found in this collection.
                    </div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
                      <thead>
                        <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--border-subtle)' }}>
                          <th style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>ID / Ref</th>
                          <th style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>Document Fields</th>
                        </tr>
                      </thead>
                      <tbody>
                        {collectionData.map((row, idx) => {
                          const id = row._id || row.id || `Row #${idx + 1}`;
                          const rest = { ...row };
                          delete rest._id;
                          delete rest.id;
                          return (
                            <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                              <td style={{ padding: '10px 12px', verticalAlign: 'top', color: 'var(--accent-blue)', fontWeight: 600, fontFamily: 'monospace' }}>{id}</td>
                              <td style={{ padding: '10px 12px', verticalAlign: 'top', fontFamily: 'monospace', color: '#a7f3d0' }}>
                                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(rest, null, 2)}</pre>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
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
          flexDirection: 'column'
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
                  background: '#111827',
                  color: selectedDep?.execPermission === 'always' ? '#34d399' : selectedDep?.execPermission === 'never' ? '#f87171' : '#60a5fa',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '4px',
                  padding: '2px 6px',
                  fontSize: '11px',
                  fontWeight: 500,
                  outline: 'none',
                  cursor: 'pointer'
                }}
              >
                <option value="ask" style={{ color: '#60a5fa' }}>Ask for permission</option>
                <option value="always" style={{ color: '#34d399' }}>Always run autonomously</option>
                <option value="never" style={{ color: '#f87171' }}>Block all executions</option>
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
                    maxWidth: '85%'
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
                      background: isUser ? 'var(--accent-blue)' : 'rgba(255,255,255,0.05)',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      fontSize: '13px',
                      lineHeight: '1.4',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      flex: 1
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
                      if (!msg.text) return null;
                      const { thoughts, cleanText } = parseThoughts(msg.text);
                      if (thoughts) {
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <details style={{
                              background: 'rgba(0,0,0,0.15)',
                              border: '1px solid var(--border-subtle)',
                              borderRadius: '6px',
                              padding: '6px 10px',
                              fontSize: '12px'
                            }}>
                              <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontWeight: 500, outline: 'none' }}>
                                Thinking Process...
                              </summary>
                              <div style={{ marginTop: '6px', whiteSpace: 'pre-wrap', color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: '11px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '6px' }}>
                                {thoughts}
                              </div>
                            </details>
                            {cleanText && <div>{renderMarkdown(cleanText)}</div>}
                          </div>
                        );
                      }
                      return <div>{renderMarkdown(msg.text)}</div>;
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

      {/* Insert Record Modal Dialog */}
      {isInsertModalOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(3px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '8px',
            width: '450px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}>
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>Insert Document / Row</h3>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Enter the document fields in raw JSON format:</span>
            
            <textarea
              value={newRecordJson}
              onChange={(e) => setNewRecordJson(e.target.value)}
              style={{
                height: '150px',
                background: 'rgba(0,0,0,0.2)',
                color: '#10b981',
                border: '1px solid var(--border-subtle)',
                borderRadius: '6px',
                padding: '10px',
                fontFamily: 'monospace',
                fontSize: '12px',
                outline: 'none',
                resize: 'none'
              }}
            />

            {insertError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#ef4444', fontSize: '12px' }}>
                <AlertCircle size={13} />
                <span>{insertError}</span>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
              <button
                onClick={() => setIsInsertModalOpen(false)}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                  padding: '6px 14px',
                  borderRadius: '6px',
                  fontSize: '13px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleInsertRecord}
                style={{
                  background: 'var(--accent-blue)',
                  color: '#fff',
                  border: 'none',
                  padding: '6px 14px',
                  borderRadius: '6px',
                  fontSize: '13px',
                  cursor: 'pointer'
                }}
              >
                Insert
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
