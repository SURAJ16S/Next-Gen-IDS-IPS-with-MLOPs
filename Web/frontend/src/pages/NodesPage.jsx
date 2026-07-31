import { useEffect, useState } from 'react';
import { ShieldCheck, ShieldOff, Key, Plus } from 'lucide-react';
import { getNodes, generateEnrollmentToken, revokeNode } from '../services/api';
import EmptyState from '../components/EmptyState';

function NodesPage() {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [nodeName, setNodeName] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatedToken, setGeneratedToken] = useState('');
  const [error, setError] = useState('');

  const fetchNodes = async () => {
    try {
      const res = await getNodes();
      setNodes(res.data);
    } catch (err) {
      console.error('Failed to fetch nodes', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNodes();
    const interval = setInterval(fetchNodes, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleGenerate = async (e) => {
    e.preventDefault();
    setGenerating(true);
    setError('');
    try {
      const res = await generateEnrollmentToken(nodeName);
      setGeneratedToken(res.data.token);
      setNodeName('');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to generate token');
    } finally {
      setGenerating(false);
    }
  };

  const handleRevoke = async (nodeId) => {
    if (!window.confirm('Are you sure you want to revoke this node? It will immediately lose access.')) return;
    try {
      await revokeNode(nodeId);
      fetchNodes();
    } catch (err) {
      alert('Failed to revoke node');
    }
  };

  const closeModal = () => {
    setShowModal(false);
    setGeneratedToken('');
    setNodeName('');
    setError('');
  };

  if (loading && nodes.length === 0) return <p style={{ color: 'var(--text-secondary)' }}>Loading nodes...</p>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h1 className="page-title" style={{ marginBottom: '4px' }}>Agent Nodes</h1>
          <p className="page-subtitle">Manage paired NGFW sensors</p>
        </div>
        <button className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }} onClick={() => setShowModal(true)}>
          <Plus size={16} /> Link New Node
        </button>
      </div>

      <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Hostname</th>
              <th>IP Address</th>
              <th>OS / Version</th>
              <th>Last Seen</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {nodes.length === 0 ? (
              <tr><td colSpan={6}><EmptyState message="No nodes registered yet" /></td></tr>
            ) : (
              nodes.map(node => (
                <tr key={node._id}>
                  <td>
                    {node.status === 'active' && <span className="badge" style={{ backgroundColor: 'rgba(0,230,118,0.1)', color: 'var(--sev-low)' }}><ShieldCheck size={12}/> Active</span>}
                    {node.status === 'revoked' && <span className="badge" style={{ backgroundColor: 'rgba(255,23,68,0.1)', color: 'var(--sev-critical)' }}><ShieldOff size={12}/> Revoked</span>}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '13px' }}>{node.hostname}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--text-secondary)' }}>{node.ipAddress}</td>
                  <td style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{node.osVersion}</td>
                  <td style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    {node.lastSeen ? new Date(node.lastSeen).toLocaleString() : 'Never'}
                  </td>
                  <td>
                    {node.status === 'active' && (
                      <button onClick={() => handleRevoke(node.nodeId)} className="btn" style={{ padding: '4px 8px', fontSize: '12px', borderColor: 'var(--sev-critical)', color: 'var(--sev-critical)' }}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, 
          backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', 
          justifyContent: 'center', alignItems: 'center', zIndex: 1000
        }}>
          <div className="card" style={{ width: '100%', maxWidth: '450px' }}>
            <h3 style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Key size={18} /> Generate Enrollment Token
            </h3>
            
            {generatedToken ? (
              <div>
                <div style={{ backgroundColor: 'rgba(255,193,7,0.1)', color: 'var(--sev-medium)', padding: '12px', borderRadius: 'var(--radius-md)', marginBottom: '15px', fontSize: '13px', lineHeight: 1.5 }}>
                  <strong>Warning:</strong> Copy this secret now. It is cryptographically hashed in the database and you will not be able to see it again.
                </div>
                <div style={{ padding: '12px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: '13px', wordBreak: 'break-all', marginBottom: '20px' }}>
                  {generatedToken}
                </div>
                <button className="btn btn-primary" style={{ width: '100%' }} onClick={closeModal}>Done</button>
              </div>
            ) : (
              <form onSubmit={handleGenerate}>
                <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '15px', lineHeight: 1.5 }}>
                  Provide a label for the new agent (e.g. "Web-Server-1"). We will generate a secure Enrollment Token for it.
                </p>
                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Agent Name / Label</label>
                  <input 
                    className="input-field" 
                    placeholder="e.g. Production-DB-01" 
                    value={nodeName}
                    onChange={(e) => setNodeName(e.target.value)}
                    required
                    style={{ width: '100%', padding: '10px', boxSizing: 'border-box' }}
                  />
                </div>
                {error && <p style={{ color: 'var(--sev-critical)', fontSize: '13px', marginBottom: '15px' }}>{error}</p>}
                
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                  <button type="button" className="btn" onClick={closeModal}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={generating || !nodeName}>
                    {generating ? 'Generating...' : 'Generate Token'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default NodesPage;
