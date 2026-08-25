const SecurityEvent = require('../models/SecurityEvent');
const MLResult = require('../models/MLResult');

const getAnalyticsSummary = async (req, res) => {
  try {
    const totalEvents = await SecurityEvent.countDocuments();
    const blocked = await SecurityEvent.countDocuments({ action: 'block' });
    const tarpitted = await SecurityEvent.countDocuments({ action: 'tarpit' });
    const avgRisk = await MLResult.aggregate([
      { $group: { _id: null, avgScore: { $avg: '$anomalyScore' } } },
    ]);

    res.json({
      totalEvents,
      blocked,
      tarpitted,
      avgRiskScore: avgRisk[0]?.avgScore || 0,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAgentPerformance = async (req, res) => {
  try {
    const { register } = require('../services/agent/metrics');

    // Helper to get metric sum
    const getMetricSum = async (name) => {
      const metric = register.getSingleMetric(name);
      if (!metric) return 0;
      const data = await metric.get();
      return data.values.reduce((sum, item) => sum + item.value, 0);
    };

    // Helper to get raw values list
    const getMetricValues = async (name) => {
      const metric = register.getSingleMetric(name);
      if (!metric) return [];
      const data = await metric.get();
      return data.values;
    };

    const requestsTotal = await getMetricValues('llm_requests_total');
    const durations = await getMetricValues('llm_response_duration_seconds');
    const iterations = await getMetricSum('agent_loop_iterations_total');
    const errors = await getMetricSum('agent_loop_errors_total');
    const patches = await getMetricSum('agent_patches_applied_total');

    // Parse statuses for requests
    let successCount = 0;
    let errorCount = 0;
    requestsTotal.forEach(r => {
      if (r.labels.status === 'success') successCount += r.value;
      if (r.labels.status === 'error') errorCount += r.value;
    });

    // Calculate average latency
    let totalLatency = 0;
    let latencyCount = 0;
    durations.forEach(d => {
      if (d.metricName === 'llm_response_duration_seconds_sum') {
        totalLatency += d.value;
      }
      if (d.metricName === 'llm_response_duration_seconds_count') {
        latencyCount += d.value;
      }
    });
    const avgLatency = latencyCount > 0 ? parseFloat((totalLatency / latencyCount).toFixed(2)) : 0;

    // Fetch all per-session token usage records
    const AgentTokenUsage = require('../models/AgentTokenUsage');
    const sessionTokens = await AgentTokenUsage.find().sort({ updatedAt: -1 });

    // Calculate totals from database
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalTokens = 0;
    sessionTokens.forEach(st => {
      totalPromptTokens += st.promptTokens || 0;
      totalCompletionTokens += st.completionTokens || 0;
      totalTokens += st.totalTokens || 0;
    });

    res.json({
      totalRequests: successCount + errorCount,
      successCount,
      errorCount,
      avgLatency,
      totalIterations: iterations,
      totalErrors: errors,
      totalPatches: patches,
      concurrencyCount: global.activeAgentLoops || 0,
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      sessionTokens,
      timestamp: new Date()
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const simulateAgentLoad = async (req, res) => {
  try {
    const { userCount = 3, iterations = 2 } = req.body;
    res.json({ 
      message: `Started load simulation with ${userCount} concurrent users in the background.`, 
      status: 'running',
      concurrencyCount: (global.activeAgentLoops || 0) + parseInt(userCount)
    });

    // Spawn parallel background simulators
    for (let i = 1; i <= userCount; i++) {
      (async () => {
        for (let j = 1; j <= iterations; j++) {
          if (!global.activeAgentLoops) global.activeAgentLoops = 0;
          global.activeAgentLoops++;

          const startTime = Date.now();
          try {
            const { llmRequestsTotal, llmResponseDurationSeconds, agentLoopIterationsTotal } = require('../services/agent/metrics');
            const axios = require('axios');

            let url = '';
            let headers = { 'Content-Type': 'application/json' };
            let model = '';
            const groqKey = process.env.GROQ_API_KEY;
            const hfKey = process.env.HUGGINGFACE_API_KEY;

            if (groqKey) {
              url = 'https://api.groq.com/openai/v1/chat/completions';
              headers['Authorization'] = `Bearer ${groqKey}`;
              model = 'qwen-2.5-coder-32b';
            } else if (hfKey) {
              url = 'https://api-inference.huggingface.co/v1/chat/completions';
              headers['Authorization'] = `Bearer ${hfKey}`;
              model = 'Qwen/Qwen2.5-Coder-32B-Instruct';
            } else {
              const ollamaHost = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
              url = `${ollamaHost}/v1/chat/completions`;
              model = 'qwen2.5-coder:7b';
            }

            // Make the real request to generate load on the LLM
            await axios.post(url, {
              model,
              messages: [
                { role: 'system', content: 'You are a load simulator. Respond with a single short sentence.' },
                { role: 'user', content: 'Say hello!' }
              ],
              temperature: 0.7,
              max_tokens: 15
            }, { headers, timeout: 30000 });

            // Record metrics
            llmRequestsTotal.inc({ model, techStack: 'simulation', status: 'success' });
            llmResponseDurationSeconds.observe({ model, techStack: 'simulation' }, (Date.now() - startTime) / 1000);
            agentLoopIterationsTotal.inc({ jobId: `sim-user-${i}`, techStack: 'simulation' });

            // Record Mongoose simulation usage
            try {
              const AgentTokenUsage = require('../models/AgentTokenUsage');
              const simDurationSec = (Date.now() - startTime) / 1000;
              const simPromptTokens = Math.ceil(80 / 4);
              const simCompletionTokens = Math.ceil(40 / 4);
              const simTotalTokens = simPromptTokens + simCompletionTokens;
              const simSpeed = simDurationSec > 0 ? parseFloat((simCompletionTokens / simDurationSec).toFixed(1)) : 0;
              
              await AgentTokenUsage.findOneAndUpdate(
                { chatId: `sim-chat-${i}` },
                {
                  $inc: { 
                    promptTokens: simPromptTokens, 
                    completionTokens: simCompletionTokens, 
                    totalTokens: simTotalTokens,
                    requestCount: 1
                  },
                  $set: { 
                    jobId: `sim-job-${i}`,
                    avgSpeed: simSpeed, 
                    username: `SimulatedUser-${i}`,
                    techStack: 'Simulation'
                  }
                },
                { upsert: true, new: true }
              );
            } catch (dbErr) {
              console.error('[SIMULATOR] Mongoose log failed:', dbErr.message);
            }

          } catch (err) {
            const { llmRequestsTotal } = require('../services/agent/metrics');
            llmRequestsTotal.inc({ model: 'simulation-model', techStack: 'simulation', status: 'error' });
          } finally {
            global.activeAgentLoops = Math.max(0, global.activeAgentLoops - 1);
          }

          // Wait a small random interval before next iteration
          await new Promise(r => setTimeout(r, Math.random() * 2000 + 1000));
        }
      })();
    }
  } catch (error) {
    // Fail silently in bg
  }
};

module.exports = {
  getAnalyticsSummary,
  getAgentPerformance,
  simulateAgentLoad
};