import { useState, useEffect, useRef } from 'react';
import {
  Cpu, Users, Zap, AlertTriangle, Play, RefreshCw, BarChart2,
  ShieldAlert, Sparkles, Hash, Database, Clock, X, Info, Settings
} from 'lucide-react';
import { getAgentPerformance, simulateAgentLoad, getAdminThresholds, updateAdminThresholds } from '../services/api';
import StatCard from '../components/StatCard';

function AdminManageAgent() {
  const [thresholds, setThresholds] = useState({
    maxTokensPerUser: 100000,
    maxSessionsPerUser: 5,
    modelName: 'llama3',
    rateLimitPerMinute: 60
  });

  const [metrics, setMetrics] = useState({
    totalRequests: 0,
    successCount: 0,
    errorCount: 0,
    avgLatency: 0,
    totalIterations: 0,
    totalErrors: 0,
    totalPatches: 0,
    concurrencyCount: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    sessionTokens: []
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [simulating, setSimulating] = useState(false);
  const [userCount, setUserCount] = useState(3);
  const [iterations, setIterations] = useState(2);
  const [history, setHistory] = useState([]); // Track latency history for micro-graph
  const [saveSuccess, setSaveSuccess] = useState('');

  const pollingInterval = useRef(null);

  // Modals state
  const [selectedSession, setSelectedSession] = useState(null);
  const [activeMetricDist, setActiveMetricDist] = useState(null); // { title: '', key: '', data: [] }

  const fetchData = async () => {
    try {
      const [metricsRes, thresholdsRes] = await Promise.all([
        getAgentPerformance(),
        getAdminThresholds('agent')
      ]);
      setMetrics(metricsRes.data);
      if (thresholdsRes.data) {
        setThresholds(thresholdsRes.data);
      }

      // Update latency history list (limit to 12 data points)
      setHistory(prev => {
        const next = [...prev, { time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), val: metricsRes.data.avgLatency }];
        if (next.length > 12) next.shift();
        return next;
      });
      setError('');
    } catch (err) {
      setError('Failed to fetch real-time agent metrics.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Poll every 1.5 seconds for real-time responsiveness
    pollingInterval.current = setInterval(fetchData, 1500);

    return () => {
      if (pollingInterval.current) clearInterval(pollingInterval.current);
    };
  }, []);

  const handleSaveThresholds = async (e) => {
    e.preventDefault();
    try {
      setSaveSuccess('');
      await updateAdminThresholds('agent', thresholds);
      setSaveSuccess('AI Agent parameters and token limit policy updated successfully.');
      setTimeout(() => setSaveSuccess(''), 4000);
    } catch (err) {
      setError('Failed to update agent limits.');
    }
  };

  const handleSimulate = async (e) => {
    e.preventDefault();
    setSimulating(true);
    try {
      await simulateAgentLoad(userCount, iterations);
      // Boost local metrics temporarily to show activity
      setMetrics(prev => ({
        ...prev,
        concurrencyCount: prev.concurrencyCount + userCount
      }));
      // Auto disable simulating after estimated run duration
      setTimeout(() => {
        setSimulating(false);
      }, userCount * iterations * 1500 + 4000);
    } catch (err) {
      setError('Failed to start load simulation.');
      setSimulating(false);
    }
  };

  // Open realtime metric distribution per user modal
  const handleMetricCardClick = (title, key) => {
    // Generate distribution data per user based on metrics.sessionTokens
    const distribution = metrics.sessionTokens.reduce((acc, session) => {
      const uName = session.username || 'Anonymous';
      let value = 0;
      if (key === 'totalRequests') value = session.requestCount || 0;
      else if (key === 'concurrencyCount') value = session.techStack.toLowerCase() === 'simulation' ? 1 : 1; // mock active loops
      else if (key === 'avgLatency') value = session.avgSpeed || 0; // represent by speed
      else if (key === 'totalTokens') value = session.totalTokens || 0;
      else if (key === 'promptTokens') value = session.promptTokens || 0;
      else if (key === 'completionTokens') value = session.completionTokens || 0;
      else if (key === 'successRate') value = session.requestCount > 0 ? 100 : 0; // mock rate
      else if (key === 'activeThreads') value = 1; // each record counts as 1 thread

      const existing = acc.find(item => item.username === uName);
      if (existing) {
        if (key === 'avgLatency') {
          // Average speed values
          existing.value = parseFloat(((existing.value + value) / 2).toFixed(1));
        } else {
          existing.value += value;
        }
      } else {
        acc.push({ username: uName, value });
      }
      return acc;
    }, []);

    // Sort descending by value
    distribution.sort((a, b) => b.value - a.value);

    setActiveMetricDist({
      title,
      key,
      data: distribution
    });
  };

  if (loading && history.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '16px' }}>
        <RefreshCw className="animate-spin" size={40} color="var(--accent-blue)" />
        <p style={{ color: '#4b5563' }}>Establishing connection to Ollama Prometheus registry...</p>
      </div>
    );
  }

  // Calculate success percentage
  const total = metrics.totalRequests || 1;
  const successRate = ((metrics.successCount / total) * 100).toFixed(1);

  // Peak latency in history
  const maxLatency = history.length > 0 ? Math.max(...history.map(h => h.val)) : 0;

  // Max session tokens to calculate relative bars
  const maxSessionTokens = metrics.sessionTokens.length > 0 
    ? Math.max(...metrics.sessionTokens.map(s => s.totalTokens)) 
    : 1;

  return (
    <div style={{ color: '#1f2937', position: 'relative' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, margin: 0, color: '#111827', letterSpacing: '-0.5px' }}>Ollama Performance & Limits</h1>
          <p style={{ fontSize: '13px', color: '#4b5563', marginTop: '4px' }}>Configure model rate limits, token quotas, and run concurrency simulation</p>
        </div>
      </div>

      {saveSuccess && (
        <div style={{ padding: '12px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '6px', color: '#10b981', marginBottom: '20px' }}>
          {saveSuccess}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: '20px', marginBottom: '24px' }}>
        {/* Settings Panel */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
            <Settings size={18} color="#f59e0b" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Agent Model Limits</h3>
          </div>

          <form onSubmit={handleSaveThresholds} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={labelStyle}>Global LLM Model Identifier</label>
              <input
                type="text"
                value={thresholds.modelName}
                onChange={(e) => setThresholds({ ...thresholds, modelName: e.target.value })}
                style={inputStyle}
                required
              />
            </div>

            <div>
              <label style={labelStyle}>Max Tokens Per User Session</label>
              <input
                type="number"
                value={thresholds.maxTokensPerUser}
                onChange={(e) => setThresholds({ ...thresholds, maxTokensPerUser: parseInt(e.target.value, 10) })}
                style={inputStyle}
                required
              />
            </div>

            <div>
              <label style={labelStyle}>Max Chat Sessions Per User</label>
              <input
                type="number"
                value={thresholds.maxSessionsPerUser}
                onChange={(e) => setThresholds({ ...thresholds, maxSessionsPerUser: parseInt(e.target.value, 10) })}
                style={inputStyle}
                required
              />
            </div>

            <div>
              <label style={labelStyle}>Model Rate Limit (Requests/Min)</label>
              <input
                type="number"
                value={thresholds.rateLimitPerMinute}
                onChange={(e) => setThresholds({ ...thresholds, rateLimitPerMinute: parseInt(e.target.value, 10) })}
                style={inputStyle}
                required
              />
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
              Save Model Configuration
            </button>
          </form>
        </div>

        {/* Load Simulator Panel */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
            <Sparkles size={18} color="#10b981" />
            <h3 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: '#111827' }}>Ollama Concurrency Simulator</h3>
          </div>

          <form onSubmit={handleSimulate} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <label style={{ fontSize: '12px', color: '#4b5563', fontWeight: 600 }}>Simulate Concurrent Users</label>
              <input
                type="number"
                value={userCount}
                onChange={(e) => setUserCount(Math.max(1, parseInt(e.target.value) || 1))}
                style={inputStyle}
                min={1}
                max={15}
              />
              <span style={{ fontSize: '10.5px', color: '#6b7280', marginTop: '4px', display: 'block' }}>
                Allocates sandboxed mock agents to query Ollama.
              </span>
            </div>

            <div>
              <label style={{ fontSize: '12px', color: '#4b5563', fontWeight: 600 }}>Iterations Per Agent</label>
              <input
                type="number"
                value={iterations}
                onChange={(e) => setIterations(Math.max(1, parseInt(e.target.value) || 1))}
                style={inputStyle}
                min={1}
                max={10}
              />
            </div>

            <button
              type="submit"
              disabled={simulating}
              style={{
                background: simulating ? '#e5e7eb' : '#10b981',
                border: 'none',
                color: simulating ? '#9ca3af' : '#fff',
                padding: '10px 16px',
                borderRadius: '6px',
                fontWeight: 700,
                cursor: simulating ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px'
              }}
            >
              <Play size={14} />
              {simulating ? 'Load Test in Progress...' : 'Launch Agent Load Test'}
            </button>
          </form>
        </div>
      </div>

      {/* Ollama Stats cards */}
      <h3 style={{ fontSize: '15px', fontWeight: 700, margin: '0 0 16px', color: '#111827' }}>
        Ollama Analytics Dashboard (Click Card to View Distribution)
      </h3>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px', marginBottom: '24px' }}>
        <div onClick={() => handleMetricCardClick('Total API Requests', 'totalRequests')} style={cardInteractive}>
          <StatCard title="Total API Requests" value={metrics.totalRequests} icon={Hash} color="var(--accent-blue)" />
        </div>
        <div onClick={() => handleMetricCardClick('Success Rate %', 'successRate')} style={cardInteractive}>
          <StatCard title="Success Rate" value={`${successRate}%`} icon={Zap} color="var(--sev-low)" />
        </div>
        <div onClick={() => handleMetricCardClick('Average Speed (Tokens/s)', 'avgLatency')} style={cardInteractive}>
          <StatCard title="Avg Token Speed" value={`${metrics.avgLatency || 0} T/s`} icon={Clock} color="#8b5cf6" />
        </div>
        <div onClick={() => handleMetricCardClick('Total Tokens Consumed', 'totalTokens')} style={cardInteractive}>
          <StatCard title="Total Tokens" value={metrics.totalTokens.toLocaleString()} icon={Database} color="#10b981" />
        </div>
      </div>

      {/* Real-time users token consumption list */}
      <div style={panelStyle}>
        <h3 style={{ fontSize: '15px', fontWeight: 700, margin: '0 0 16px', color: '#111827' }}>Per-User / Per-Session Token Consumption</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {metrics.sessionTokens.map((session, index) => {
            const pct = ((session.totalTokens / maxSessionTokens) * 100) || 0;
            return (
              <div
                key={session.chatId || index}
                onClick={() => setSelectedSession(session)}
                style={{
                  background: '#f9fafb',
                  border: '1px solid #e5e7eb',
                  borderRadius: '6px',
                  padding: '12px 16px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  transition: 'background 0.12s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'}
                onMouseLeave={(e) => e.currentTarget.style.background = '#f9fafb'}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: 700, marginBottom: '6px', color: '#1f2937' }}>
                    <span>{session.username || 'Anonymous'} <span style={{ fontSize: '11px', color: '#4b5563', fontWeight: 400 }}>({session.techStack})</span></span>
                    <span>{session.totalTokens.toLocaleString()} Tokens</span>
                  </div>
                  <div style={{ width: '100%', height: '6px', background: '#e5e7eb', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: '#10b981', borderRadius: '3px' }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Session Details Modal */}
      {selectedSession && (
        <div style={modalOverlay}>
          <div style={modalContent}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e5e7eb', paddingBottom: '14px', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#111827' }}>Session Analytics Profile</h3>
              <X onClick={() => setSelectedSession(null)} style={{ cursor: 'pointer', color: '#4b5563' }} size={18} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '13px', color: '#1f2937' }}>
              <div style={detailRowStyle}>
                <span style={{ color: '#4b5563' }}>User Identity:</span>
                <span style={{ fontWeight: 700, color: '#111827' }}>{selectedSession.username || 'Anonymous'}</span>
              </div>
              <div style={detailRowStyle}>
                <span style={{ color: '#4b5563' }}>Model Target Stack:</span>
                <span style={{ fontWeight: 700, color: '#d97706' }}>{selectedSession.techStack}</span>
              </div>
              <div style={detailRowStyle}>
                <span style={{ color: '#4b5563' }}>Session Key:</span>
                <span style={{ fontFamily: 'monospace', color: '#4b5563', fontSize: '11.5px' }}>{selectedSession.chatId}</span>
              </div>
              <div style={detailRowStyle}>
                <span style={{ color: '#4b5563' }}>Ollama Prompt Tokens:</span>
                <span style={{ fontWeight: 600 }}>{selectedSession.promptTokens}</span>
              </div>
              <div style={detailRowStyle}>
                <span style={{ color: '#4b5563' }}>Ollama Completion Tokens:</span>
                <span style={{ fontWeight: 600 }}>{selectedSession.completionTokens}</span>
              </div>
              <div style={detailRowStyle}>
                <span style={{ color: '#4b5563' }}>Total Token Sum:</span>
                <span style={{ fontWeight: 700, color: '#059669' }}>{selectedSession.totalTokens}</span>
              </div>
              <div style={detailRowStyle}>
                <span style={{ color: '#4b5563' }}>Average Speed:</span>
                <span style={{ fontWeight: 700, color: '#111827' }}>{selectedSession.avgSpeed || 0} Tokens/s</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Metric Distribution Modal */}
      {activeMetricDist && (
        <div style={modalOverlay}>
          <div style={{ ...modalContent, width: '400px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e5e7eb', paddingBottom: '14px', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#111827' }}>{activeMetricDist.title} Distribution</h3>
              <X onClick={() => setActiveMetricDist(null)} style={{ cursor: 'pointer', color: '#4b5563' }} size={18} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {activeMetricDist.data.length === 0 ? (
                <div style={{ color: '#4b5563', fontSize: '13px', textAlign: 'center', padding: '20px' }}>No active user data found for this metric.</div>
              ) : (
                activeMetricDist.data.map((item, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', borderBottom: '1px solid #f3f4f6', paddingBottom: '8px' }}>
                    <span style={{ fontWeight: 600, color: '#1f2937' }}>{item.username}</span>
                    <span style={{ fontFamily: 'monospace', color: '#059669', fontWeight: 700 }}>{item.value.toLocaleString()}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Styling Config
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

const cardInteractive = {
  cursor: 'pointer',
  transition: 'transform 0.15s ease'
};

const modalOverlay = {
  position: 'fixed',
  top: 0,
  left: 0,
  width: '100vw',
  height: '100vh',
  background: 'rgba(0,0,0,0.4)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000
};

const modalContent = {
  background: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  padding: '24px',
  width: '450px',
  maxWidth: '90%',
  boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)'
};

const detailRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center'
};

export default AdminManageAgent;
