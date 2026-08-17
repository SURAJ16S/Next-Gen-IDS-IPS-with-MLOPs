import { useState, useEffect, useRef } from 'react';
import { 
  getDeployments, 
  getWorkspaceFiles, 
  getWorkspaceFileContent, 
  saveWorkspaceFile, 
  getDbCollections, 
  getDbCollectionData, 
  insertDbRecord, 
  executeAgentChat,
  updateAgentPermission,
  executePendingCommands,
  getChatsList,
  createChatThread,
  getChatMessages
} from '../services/api';
import { 
  Folder, File, Database, Play, Save, Send, Bot, RefreshCw, Plus, 
  Terminal, ShieldCheck, Code, ListFilter, AlertCircle, Trash2 
} from 'lucide-react';

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
  
  // Current tab inside center pane
  const [centerTab, setCenterTab] = useState('editor'); // 'editor' | 'database'
  
  const chatEndRef = useRef(null);

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

  const handleSendChat = async (customMessage = '') => {
    const text = (customMessage || chatInput).trim();
    if (!text) return;

    if (!customMessage) setChatInput('');
    
    setChatMessages(prev => [...prev, { role: 'user', text }]);
    setIsAgentTyping(true);

    try {
      const res = await executeAgentChat(selectedId, text, activeChatId);
      const { message, pendingExec, commands, chatId } = res.data;
      
      if (chatId && chatId !== activeChatId) {
        setActiveChatId(chatId);
      }
      
      setChatMessages(prev => [...prev, { 
        role: 'agent', 
        text: message, 
        pendingAction: pendingExec ? { commands } : null 
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
      setChatMessages(prev => [...prev, { role: 'agent', text: `Failed to talk to DevOps Agent: ${err.message}` }]);
    } finally {
      setIsAgentTyping(false);
    }
  };

  const handlePermissionAllow = async (msgIndex, commands) => {
    try {
      setIsAgentTyping(true);
      const res = await executePendingCommands(selectedId, commands, activeChatId);
      const logs = res.data.execLogs;
      
      setChatMessages(prev => {
        const copy = [...prev];
        copy[msgIndex] = {
          ...copy[msgIndex],
          text: copy[msgIndex].text + `\n\n**[AI Agent Terminal Output]:**\n\`\`\`bash${logs}\`\`\``,
          pendingAction: null
        };
        return copy;
      });

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
      const logs = res.data.execLogs;
      
      setChatMessages(prev => {
        const copy = [...prev];
        copy[msgIndex] = {
          ...copy[msgIndex],
          text: copy[msgIndex].text + `\n\n**[AI Agent Terminal Output]:**\n\`\`\`bash${logs}\`\`\``,
          pendingAction: null
        };
        return copy;
      });

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
                {d.projectName} ({d.techStackDetected || 'MERN'})
              </option>
            ))}
          </select>
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
                      {isSavingFile ? 'Saving...' : 'Save File'}
                    </button>
                  </div>
                  <textarea
                    value={fileContent}
                    onChange={(e) => setFileContent(e.target.value)}
                    style={{
                      flex: 1,
                      background: 'rgba(0,0,0,0.3)',
                      color: '#a7f3d0',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '6px',
                      padding: '12px',
                      fontFamily: 'Consolas, Monaco, monospace',
                      fontSize: '13px',
                      lineHeight: '1.5',
                      resize: 'none',
                      outline: 'none'
                    }}
                  />
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'var(--text-muted)', gap: '10px' }}>
                  <Code size={36} color="var(--border-subtle)" />
                  <span style={{ fontSize: '13px' }}>Select a file from the explorer to begin editing.</span>
                </div>
              )
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

        {/* Right Side Chat Bot Pane */}
        <div style={{ 
          width: '320px', 
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
          </div>

          {/* Quick prompt templates */}
          <div style={{ padding: '10px 16px', background: 'rgba(255,255,255,0.02)', display: 'flex', flexDirection: 'column', gap: '6px', borderBottom: '1px solid var(--border-subtle)' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>Quick Actions:</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              <button 
                onClick={() => handleSendChat('Write a Python seed script to insert mock products data and run it in the container')}
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
                Seed Mock Products (Python)
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
            {chatMessages.map((msg, idx) => (
              <div 
                key={idx} 
                style={{ 
                  alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                  background: msg.role === 'user' ? 'var(--accent-blue)' : 'rgba(255,255,255,0.05)',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  fontSize: '13px',
                  lineHeight: '1.4',
                  whiteSpace: 'pre-wrap',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px'
                }}
              >
                <div>{msg.text}</div>
                {msg.pendingAction && (
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
                    <div style={{ fontFamily: 'monospace', background: 'rgba(0,0,0,0.3)', padding: '6px', borderRadius: '4px', marginBottom: '8px', color: '#fff' }}>
                      {msg.pendingAction.commands.map((cmd, cIdx) => (
                        <div key={cIdx}>$ {cmd}</div>
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
            ))}
            {isAgentTyping && (
              <div style={{ alignSelf: 'flex-start', color: 'var(--text-muted)', fontSize: '12px', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Bot size={13} /> DevOps Agent is writing seed scripts...
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Chat Input panel */}
          <div style={{ padding: '12px', borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                placeholder="Ask agent to seed db or edit code..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendChat()}
                style={{
                  flex: 1,
                  background: '#fff',
                  color: 'black',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '6px',
                  padding: '8px 12px',
                  fontSize: '13px',
                  outline: 'none'
                }}
              />
              <button
                onClick={() => handleSendChat()}
                style={{
                  background: 'var(--accent-blue)',
                  color: '#fff',
                  border: 'none',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <Send size={14} />
              </button>
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
