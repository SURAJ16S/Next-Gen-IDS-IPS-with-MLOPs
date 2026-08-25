const client = require('prom-client');

// Create a custom registry
const register = new client.Registry();

// Enable default metrics collection
client.collectDefaultMetrics({ register });

// Custom metrics for agent monitoring
const llmRequestsTotal = new client.Counter({
  name: 'llm_requests_total',
  help: 'Total number of LLM API requests made by the DevOps agent',
  labelNames: ['model', 'techStack', 'status'],
  registers: [register]
});

const llmResponseDurationSeconds = new client.Histogram({
  name: 'llm_response_duration_seconds',
  help: 'Duration of LLM API requests in seconds',
  labelNames: ['model', 'techStack'],
  buckets: [1, 2, 5, 10, 20, 30, 45, 60, 90, 120],
  registers: [register]
});

const agentLoopIterationsTotal = new client.Counter({
  name: 'agent_loop_iterations_total',
  help: 'Total number of ReAct loop iterations completed',
  labelNames: ['jobId', 'techStack'],
  registers: [register]
});

const agentLoopErrorsTotal = new client.Counter({
  name: 'agent_loop_errors_total',
  help: 'Total number of errors encountered during agent loop execution',
  labelNames: ['jobId', 'errorType'],
  registers: [register]
});

const agentPatchesAppliedTotal = new client.Counter({
  name: 'agent_patches_applied_total',
  help: 'Total number of patch files written by the AI agent',
  labelNames: ['jobId', 'fileName'],
  registers: [register]
});

const llmPromptTokensTotal = new client.Counter({
  name: 'llm_prompt_tokens_total',
  help: 'Total number of LLM prompt tokens consumed',
  labelNames: ['model'],
  registers: [register]
});

const llmCompletionTokensTotal = new client.Counter({
  name: 'llm_completion_tokens_total',
  help: 'Total number of LLM completion tokens generated',
  labelNames: ['model'],
  registers: [register]
});

const llmTokenSpeedGauges = new client.Gauge({
  name: 'llm_token_speed_gauges',
  help: 'LLM token generation speed (tokens/sec)',
  labelNames: ['model'],
  registers: [register]
});

module.exports = {
  register,
  llmRequestsTotal,
  llmResponseDurationSeconds,
  agentLoopIterationsTotal,
  agentLoopErrorsTotal,
  agentPatchesAppliedTotal,
  llmPromptTokensTotal,
  llmCompletionTokensTotal,
  llmTokenSpeedGauges
};
