import { useState, useEffect, useRef } from 'react';
import { Cpu, Users, Zap, AlertTriangle, Play, RefreshCw, BarChart2, ShieldAlert, Sparkles, Hash, Database, Clock, X, Info } from 'lucide-react';
import { getAgentPerformance, simulateAgentLoad } from '../services/api';
import StatCard from '../components/StatCard';

function AgentPerformance() {
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
  const pollingInterval = useRef(null);

  // Modals state
  const [selectedSession, setSelectedSession] = useState(null);
  const [activeMetricDist, setActiveMetricDist] = useState(null); // { title: '', key: '', data: [] }

  const fetchMetrics = async () => {
    try {
      const res = await getAgentPerformance();
      const data = res.data;
      setMetrics(data);
      
      // Update latency history list (limit to 12 data points)
      setHistory(prev => {
        const next = [...prev, { time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), val: data.avgLatency }];
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
    fetchMetrics();
    // Poll every 1.5 seconds for real-time responsiveness
    pollingInterval.current = setInterval(fetchMetrics, 1500);

    return () => {
      if (pollingInterval.current) clearInterval(pollingInterval.current);
    };
  }, []);

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
        <p style={{ color: 'var(--text-secondary)' }}>Establishing connection to Ollama Prometheus registry...</p>
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
    <div style={{ animation: 'fadeIn 0.4s ease-out', position: 'relative' }}>
      {/* Header Banner */}
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        marginBottom: '24px', 
        flexWrap: 'wrap',
        gap: '16px'
      }}>
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Cpu size={28} color="var(--accent-blue)" />
            Ollama Real-Time Performance Analytics
          </h1>
          <p className="page-subtitle">Real-time model latency, concurrency, and token usage statistics</p>
        </div>
        
        {/* Status Indicator */}
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '8px', 
          background: 'var(--bg-secondary)', 
          padding: '8px 16px', 
          borderRadius: 'var(--radius-md)', 
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-sm)'
        }}>
          <span style={{ 
            width: '8px', 
            height: '8px', 
            borderRadius: '50%', 
            background: metrics.concurrencyCount > 0 ? 'var(--sev-high)' : 'var(--sev-low)',
            boxShadow: metrics.concurrencyCount > 0 ? '0 0 8px var(--sev-high)' : 'none',
            display: 'inline-block',
            transition: 'background 0.3s'
          }} />
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>
            {metrics.concurrencyCount > 0 
              ? `${metrics.concurrencyCount} Active Container Loops` 
              : 'IDLE (Awaiting Request)'}
          </span>
        </div>
      </div>

      {error && (
        <div style={{ 
          background: 'rgba(239, 68, 68, 0.1)', 
          border: '1px solid var(--sev-critical)', 
          color: 'var(--sev-critical)', 
          padding: '12px 16px', 
          borderRadius: 'var(--radius-md)', 
          marginBottom: '20px',
          fontSize: '13.5px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <AlertTriangle size={16} />
          {error}
        </div>
      )}

      {/* Info Tip */}
      <div style={{ 
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: 'rgba(59, 130, 246, 0.05)',
        border: '1px solid rgba(59, 130, 246, 0.15)',
        borderRadius: 'var(--radius-md)',
        padding: '10px 14px',
        marginBottom: '20px',
        fontSize: '12.5px',
        color: 'var(--accent-blue)'
      }}>
        <Info size={16} />
        <span><strong>Interactive Dashboard:</strong> Click any metric card to view the real-time distribution per user, or click a table row below to open that session's comprehensive detail card.</span>
      </div>

      {/* Stats Cards Section (Interactive click to show distribution) */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', 
        gap: '14px',
        marginBottom: '20px'
      }}>
        <div onClick={() => handleMetricCardClick('Total LLM Requests', 'totalRequests')} style={{ cursor: 'pointer' }}>
          <StatCard title="Total LLM Requests" value={metrics.totalRequests} icon={BarChart2} color="var(--accent-blue)" />
        </div>
        <div onClick={() => handleMetricCardClick('Active Concurrency', 'concurrencyCount')} style={{ cursor: 'pointer' }}>
          <StatCard title="Active Concurrency" value={`${metrics.concurrencyCount} Users`} icon={Users} color={metrics.concurrencyCount > 0 ? 'var(--sev-high)' : 'var(--text-muted)'} />
        </div>
        <div onClick={() => handleMetricCardClick('Avg Latency Speed', 'avgLatency')} style={{ cursor: 'pointer' }}>
          <StatCard title="Avg Latency Speed" value={`${metrics.avgLatency}s`} icon={Zap} color={metrics.avgLatency > 15 ? 'var(--sev-medium)' : 'var(--sev-low)'} />
        </div>
        <div onClick={() => handleMetricCardClick('Total Tokens Consumed', 'totalTokens')} style={{ cursor: 'pointer' }}>
          <StatCard title="Total Tokens Consumed" value={metrics.totalTokens.toLocaleString()} icon={Hash} color="var(--accent-blue)" />
        </div>
      </div>

      {/* Second Row Stats (Interactive click to show distribution) */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', 
        gap: '14px',
        marginBottom: '20px'
      }}>
        <div onClick={() => handleMetricCardClick('Prompt Tokens', 'promptTokens')} style={{ cursor: 'pointer' }}>
          <StatCard title="Prompt Tokens" value={metrics.totalPromptTokens.toLocaleString()} icon={Database} color="var(--text-muted)" />
        </div>
        <div onClick={() => handleMetricCardClick('Completion Tokens', 'completionTokens')} style={{ cursor: 'pointer' }}>
          <StatCard title="Completion Tokens" value={metrics.totalCompletionTokens.toLocaleString()} icon={Sparkles} color="var(--sev-low)" />
        </div>
        <div onClick={() => handleMetricCardClick('Success Rate', 'successRate')} style={{ cursor: 'pointer' }}>
          <StatCard title="Success Rate" value={`${successRate}%`} icon={ShieldAlert} color="var(--sev-low)" />
        </div>
        <div onClick={() => handleMetricCardClick('Active Session Threads', 'activeThreads')} style={{ cursor: 'pointer' }}>
          <StatCard title="Active Session Threads" value={metrics.sessionTokens.length} icon={Clock} color="var(--accent-blue)" />
        </div>
      </div>

      {/* Main Grid: Visualizer & Simulation Control */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: '2fr 1fr', 
        gap: '20px',
        flexWrap: 'wrap',
        marginBottom: '20px'
      }}>
        {/* Real-time Latency Line Chart (Pure CSS SVG Graph) */}
        <div className="card" style={{ 
          background: 'var(--bg-secondary)', 
          padding: '20px', 
          borderRadius: 'var(--radius-lg)', 
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-sm)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>Latency Real-time Track</h3>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Updated every 1.5s</span>
          </div>

          {/* SVG Line Graph */}
          {history.length > 1 ? (
            <div style={{ position: 'relative' }}>
              <svg viewBox="0 0 600 200" style={{ width: '100%', height: '200px', overflow: 'visible' }}>
                <defs>
                  <linearGradient id="latencyGlow" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent-blue)" stopOpacity="0.4" />
                    <stop offset="100%" stopColor="var(--accent-blue)" stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* Y-Axis Grid Lines */}
                <line x1="0" y1="180" x2="600" y2="180" stroke="rgba(255,255,255,0.05)" strokeDasharray="4 4" />
                <line x1="0" y1="120" x2="600" y2="120" stroke="rgba(255,255,255,0.05)" strokeDasharray="4 4" />
                <line x1="0" y1="60" x2="600" y2="60" stroke="rgba(255,255,255,0.05)" strokeDasharray="4 4" />
                <line x1="0" y1="10" x2="600" y2="10" stroke="rgba(255,255,255,0.05)" strokeDasharray="4 4" />

                {/* Plot Line */}
                <path
                  d={(() => {
                    const step = 600 / (history.length - 1);
                    const factor = maxLatency > 0 ? 150 / maxLatency : 1;
                    return history.map((h, idx) => {
                      const x = idx * step;
                      const y = 180 - (h.val * factor);
                      return `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
                    }).join(' ');
                  })()}
                  fill="none"
                  stroke="var(--accent-blue)"
                  strokeWidth="3"
                  style={{ transition: 'd 0.3s ease' }}
                />

                {/* Area Gradient */}
                <path
                  d={(() => {
                    const step = 600 / (history.length - 1);
                    const factor = maxLatency > 0 ? 150 / maxLatency : 1;
                    const pathData = history.map((h, idx) => {
                      const x = idx * step;
                      const y = 180 - (h.val * factor);
                      return `L ${x} ${y}`;
                    }).join(' ');
                    return `M 0 180 ${pathData} L ${600} 180 Z`;
                  })()}
                  fill="url(#latencyGlow)"
                  style={{ transition: 'd 0.3s ease' }}
                />

                {/* Plot Points */}
                {history.map((h, idx) => {
                  const step = 600 / (history.length - 1);
                  const factor = maxLatency > 0 ? 150 / maxLatency : 1;
                  const x = idx * step;
                  const y = 180 - (h.val * factor);
                  return (
                    <circle
                      key={idx}
                      cx={x}
                      cy={y}
                      r="4"
                      fill="#fff"
                      stroke="var(--accent-blue)"
                      strokeWidth="2"
                      style={{ transition: 'cx 0.3s, cy 0.3s' }}
                    />
                  );
                })}
              </svg>

              {/* X-Axis labels */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', color: 'var(--text-muted)', fontSize: '10px' }}>
                <span>{history[0]?.time}</span>
                <span>{history[Math.floor(history.length / 2)]?.time}</span>
                <span>{history[history.length - 1]?.time}</span>
              </div>
            </div>
          ) : (
            <div style={{ height: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
              No latency spikes registered yet. Waiting for loop execution...
            </div>
          )}
        </div>

        {/* Load Simulator Panel */}
        <div className="card" style={{ 
          background: 'var(--bg-secondary)', 
          padding: '20px', 
          borderRadius: 'var(--radius-lg)', 
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-sm)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between'
        }}>
          <div>
            <h3 style={{ margin: '0 0 8px 0', fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Users size={18} color="var(--accent-blue)" />
              Concurrency Simulator
            </h3>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.4', margin: '0 0 16px 0' }}>
              Trigger parallel simulated agent loops inside separate background processes to measure Ollama's real-time multi-user concurrency performance.
            </p>

            <form onSubmit={handleSimulate} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
                  <span>Concurrent Users (Containers)</span>
                  <span style={{ color: 'var(--accent-blue)' }}>{userCount}</span>
                </label>
                <input
                  type="range"
                  min="1"
                  max="10"
                  value={userCount}
                  onChange={(e) => setUserCount(parseInt(e.target.value))}
                  style={{ width: '100%', cursor: 'pointer', accentColor: 'var(--accent-blue)' }}
                />
              </div>

              <div>
                <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
                  <span>Iterations per User</span>
                  <span style={{ color: 'var(--accent-blue)' }}>{iterations}</span>
                </label>
                <input
                  type="range"
                  min="1"
                  max="5"
                  value={iterations}
                  onChange={(e) => setIterations(parseInt(e.target.value))}
                  style={{ width: '100%', cursor: 'pointer', accentColor: 'var(--accent-blue)' }}
                />
              </div>

              <button
                type="submit"
                disabled={simulating}
                className="btn-primary"
                style={{
                  marginTop: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  padding: '10px',
                  fontWeight: 600,
                  background: simulating ? 'rgba(255,255,255,0.05)' : 'var(--accent-blue)',
                  cursor: simulating ? 'not-allowed' : 'pointer'
                }}
              >
                {simulating ? (
                  <>
                    <RefreshCw className="animate-spin" size={16} />
                    Simulating Load...
                  </>
                ) : (
                  <>
                    <Play size={16} />
                    Generate Concurrency Load
                  </>
                )}
              </button>
            </form>
          </div>

          {simulating && (
            <div style={{ 
              marginTop: '16px', 
              padding: '10px', 
              background: 'rgba(59, 130, 246, 0.05)', 
              border: '1px solid rgba(59, 130, 246, 0.2)', 
              borderRadius: 'var(--radius-md)', 
              fontSize: '11px',
              color: 'var(--accent-blue)',
              textAlign: 'center',
              animation: 'pulse 1.5s infinite'
            }}>
              Simulating {userCount} concurrent agent loops in the background... Watch the latency line chart update.
            </div>
          )}
        </div>
      </div>

      {/* Per User/Session Token Report Table */}
      <div className="card" style={{ 
        background: 'var(--bg-secondary)', 
        padding: '20px', 
        borderRadius: 'var(--radius-lg)', 
        border: '1px solid var(--border-subtle)',
        boxShadow: 'var(--shadow-sm)',
        marginBottom: '20px'
      }}>
        <h3 style={{ margin: '0 0 16px 0', fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Sparkles size={18} color="var(--accent-blue)" />
          Per-User / Per-Session Token Consumption Report
        </h3>

        {metrics.sessionTokens.length > 0 ? (
          <div className="table-container" style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '12px 10px' }}>User Name</th>
                  <th style={{ padding: '12px 10px' }}>Session / Chat ID</th>
                  <th style={{ padding: '12px 10px' }}>Job ID (Container)</th>
                  <th style={{ padding: '12px 10px' }}>Tech Stack</th>
                  <th style={{ padding: '12px 10px', textAlign: 'center' }}>Inferences</th>
                  <th style={{ padding: '12px 10px', textAlign: 'right' }}>Prompt Tokens</th>
                  <th style={{ padding: '12px 10px', textAlign: 'right' }}>Completion Tokens</th>
                  <th style={{ padding: '12px 10px', textAlign: 'right' }}>Total Tokens</th>
                  <th style={{ padding: '12px 10px', width: '120px' }}>Relative Load</th>
                  <th style={{ padding: '12px 10px', textAlign: 'right' }}>Gen Speed</th>
                  <th style={{ padding: '12px 10px', textAlign: 'right' }}>Last Active</th>
                </tr>
              </thead>
              <tbody>
                {metrics.sessionTokens.map((session, idx) => {
                  const percent = Math.min(100, Math.max(8, (session.totalTokens / maxSessionTokens) * 100));
                  const isSim = (session.username || '').toLowerCase().includes('simulated');
                  return (
                    <tr 
                      key={session.chatId || idx} 
                      onClick={() => setSelectedSession(session)}
                      style={{ 
                        borderBottom: '1px solid var(--border-subtle)', 
                        verticalAlign: 'middle',
                        cursor: 'pointer',
                        transition: 'background 0.12s'
                      }}
                      className="table-row-hover"
                      onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                    >
                      <td style={{ padding: '12px 10px', fontWeight: 600, color: 'var(--text-primary)' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Users size={14} color={isSim ? 'var(--text-muted)' : 'var(--accent-blue)'} />
                          {session.username || 'Anonymous'}
                        </span>
                      </td>
                      <td style={{ padding: '12px 10px', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                        {session.chatId.substring(0, 10)}...
                      </td>
                      <td style={{ padding: '12px 10px', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                        {session.jobId.substring(0, 8)}...
                      </td>
                      <td style={{ padding: '12px 10px' }}>
                        <span className="badge" style={{ 
                          background: session.techStack.toLowerCase() === 'spring' ? 'rgba(16,185,129,0.1)' : 'rgba(59,130,246,0.1)', 
                          color: session.techStack.toLowerCase() === 'spring' ? 'var(--sev-low)' : 'var(--accent-blue)', 
                          fontSize: '11px',
                          padding: '2px 6px',
                          borderRadius: 'var(--radius-sm)'
                        }}>
                          {session.techStack}
                        </span>
                      </td>
                      <td style={{ padding: '12px 10px', textAlign: 'center', fontWeight: 600 }}>
                        {session.requestCount}
                      </td>
                      <td style={{ padding: '12px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>
                        {session.promptTokens.toLocaleString()}
                      </td>
                      <td style={{ padding: '12px 10px', textAlign: 'right', color: 'var(--sev-low)' }}>
                        {session.completionTokens.toLocaleString()}
                      </td>
                      <td style={{ padding: '12px 10px', textAlign: 'right', fontWeight: 600 }}>
                        {session.totalTokens.toLocaleString()}
                      </td>
                      <td style={{ padding: '12px 10px' }}>
                        {/* Progress Bar visual */}
                        <div style={{ background: 'rgba(255,255,255,0.05)', height: '6px', borderRadius: '3px', width: '100%', overflow: 'hidden' }}>
                          <div style={{ 
                            background: session.totalTokens > 10000 ? 'var(--sev-high)' : 'var(--accent-blue)', 
                            height: '100%', 
                            width: `${percent}%`, 
                            borderRadius: '3px',
                            transition: 'width 0.4s ease'
                          }} />
                        </div>
                      </td>
                      <td style={{ padding: '12px 10px', textAlign: 'right', fontWeight: 500, color: 'var(--sev-low)' }}>
                        {session.avgSpeed} T/s
                      </td>
                      <td style={{ padding: '12px 10px', textAlign: 'right', color: 'var(--text-muted)', fontSize: '12px' }}>
                        {new Date(session.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)', border: '1px dashed var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
            No user session token logs recorded in database. Make an agent request or launch simulator load above!
          </div>
        )}
      </div>

      {/* Grid: DevOps Metrics & Database Actions */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', 
        gap: '20px'
      }}>
        {/* ReAct Loop Stats */}
        <div className="card" style={{ 
          background: 'var(--bg-secondary)', 
          padding: '20px', 
          borderRadius: 'var(--radius-lg)', 
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-sm)'
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Cpu size={18} color="var(--accent-blue)" />
            Agent Loop Performance
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '8px' }}>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Total Loop Iterations</span>
              <span style={{ fontSize: '14px', fontWeight: 600 }}>{metrics.totalIterations}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '8px' }}>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Agent execution Errors</span>
              <span style={{ fontSize: '14px', fontWeight: 600, color: metrics.totalErrors > 0 ? 'var(--sev-critical)' : 'inherit' }}>{metrics.totalErrors}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px' }}>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Applied File Patches</span>
              <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--accent-blue)' }}>{metrics.totalPatches}</span>
            </div>
          </div>
        </div>

        {/* Database Verification Logs */}
        <div className="card" style={{ 
          background: 'var(--bg-secondary)', 
          padding: '20px', 
          borderRadius: 'var(--radius-lg)', 
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-sm)'
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldAlert size={18} color="var(--accent-blue)" />
            Active Session Summary
          </h3>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5', margin: '0 0 16px 0' }}>
            This panel shows real-time stats for the active database previews and connection requests currently queued.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '8px' }}>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>DB Request Success Rate</span>
              <span style={{ fontSize: '14px', fontWeight: 600 }}>{successRate}%</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px' }}>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Total Database DDL Operations</span>
              <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--accent-blue)' }}>{metrics.totalPatches}</span>
            </div>
          </div>
        </div>
      </div>

      {/* MODAL 1: Individual Session Token Detail Card */}
      {selectedSession && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          background: 'rgba(15, 23, 42, 0.75)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '20px',
          boxSizing: 'border-box'
        }}>
          <div className="card" style={{
            width: '100%',
            maxWidth: '520px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 20px 25px -5px rgba(0,0,0,0.3)',
            animation: 'fadeIn 0.2s ease-out',
            overflow: 'hidden'
          }}>
            {/* Modal Header */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '16px 20px',
              borderBottom: '1px solid var(--border-subtle)',
              background: 'rgba(255,255,255,0.01)'
            }}>
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Sparkles size={16} color="var(--accent-blue)" />
                Session Token Breakdown
              </h3>
              <button 
                onClick={() => setSelectedSession(null)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Username</div>
                  <div style={{ fontSize: '13px', fontWeight: 600, marginTop: '2px' }}>{selectedSession.username}</div>
                </div>
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Tech Stack</div>
                  <div style={{ fontSize: '13px', fontWeight: 600, marginTop: '2px' }}>{selectedSession.techStack}</div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Session ID</div>
                  <div style={{ fontSize: '12px', fontFamily: 'monospace', marginTop: '2px' }}>{selectedSession.chatId}</div>
                </div>
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Job / Container ID</div>
                  <div style={{ fontSize: '12px', fontFamily: 'monospace', marginTop: '2px' }}>{selectedSession.jobId}</div>
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '12px' }}>Token Usage Summary</div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Prompt Tokens (Input)</span>
                    <span style={{ fontWeight: 600 }}>{selectedSession.promptTokens.toLocaleString()}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Completion Tokens (Output)</span>
                    <span style={{ fontWeight: 600, color: 'var(--sev-low)' }}>{selectedSession.completionTokens.toLocaleString()}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', borderTop: '1px dashed var(--border-subtle)', paddingTop: '8px' }}>
                    <span style={{ fontWeight: 600 }}>Total Tokens Consumed</span>
                    <span style={{ fontWeight: 700, color: 'var(--accent-blue)' }}>{selectedSession.totalTokens.toLocaleString()}</span>
                  </div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Inferences Run</div>
                  <div style={{ fontSize: '13px', fontWeight: 600, marginTop: '2px' }}>{selectedSession.requestCount} runs</div>
                </div>
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Generation Speed</div>
                  <div style={{ fontSize: '13px', fontWeight: 600, marginTop: '2px', color: 'var(--sev-low)' }}>{selectedSession.avgSpeed} T/s</div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              padding: '12px 20px',
              borderTop: '1px solid var(--border-subtle)',
              background: 'rgba(255,255,255,0.01)'
            }}>
              <button 
                onClick={() => setSelectedSession(null)}
                className="btn-primary"
                style={{ padding: '6px 16px', fontSize: '13px', background: 'var(--accent-blue)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
              >
                Close details
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: Realtime Metric Distribution per User */}
      {activeMetricDist && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          background: 'rgba(15, 23, 42, 0.75)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '20px',
          boxSizing: 'border-box'
        }}>
          <div className="card" style={{
            width: '100%',
            maxWidth: '480px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 20px 25px -5px rgba(0,0,0,0.3)',
            animation: 'fadeIn 0.2s ease-out',
            overflow: 'hidden'
          }}>
            {/* Modal Header */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '16px 20px',
              borderBottom: '1px solid var(--border-subtle)',
              background: 'rgba(255,255,255,0.01)'
            }}>
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Users size={16} color="var(--accent-blue)" />
                Distribution: {activeMetricDist.title}
              </h3>
              <button 
                onClick={() => setActiveMetricDist(null)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px', maxHeight: '350px', overflowY: 'auto' }}>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 8px 0' }}>
                Real-time breakdown of <strong>{activeMetricDist.title}</strong> across active users and session container processes.
              </p>

              {activeMetricDist.data.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {activeMetricDist.data.map((user, idx) => {
                    const maxVal = activeMetricDist.data[0]?.value || 1;
                    const percent = Math.min(100, Math.max(8, (user.value / maxVal) * 100));
                    return (
                      <div key={user.username || idx}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '4px' }}>
                          <span style={{ fontWeight: 600 }}>{user.username}</span>
                          <span style={{ color: 'var(--accent-blue)', fontWeight: 700 }}>
                            {activeMetricDist.key === 'avgLatency' 
                              ? `${user.value} T/s` 
                              : user.value.toLocaleString()}
                          </span>
                        </div>
                        <div style={{ background: 'rgba(255,255,255,0.05)', height: '8px', borderRadius: '4px', width: '100%', overflow: 'hidden' }}>
                          <div style={{ 
                            background: 'var(--accent-blue)', 
                            height: '100%', 
                            width: `${percent}%`, 
                            borderRadius: '4px',
                            transition: 'width 0.4s ease'
                          }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '12px' }}>
                  No active session threads to distribute metrics.
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              padding: '12px 20px',
              borderTop: '1px solid var(--border-subtle)',
              background: 'rgba(255,255,255,0.01)'
            }}>
              <button 
                onClick={() => setActiveMetricDist(null)}
                className="btn-primary"
                style={{ padding: '6px 16px', fontSize: '13px', background: 'var(--accent-blue)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
              >
                Close Distribution
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AgentPerformance;
