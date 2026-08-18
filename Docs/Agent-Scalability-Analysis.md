# Agent Scalability Analysis: 10 Parallel Users
## Laptop (Ollama) vs. Cloud (Groq / HuggingFace) — Realistic Limits & Solutions

---

## 1. What One Agent Request Actually Costs

Before counting users, you need to know the cost of **a single agent session** in this project.

When a user opens `/agent` and sends one prompt, the ReAct loop runs up to 10 iterations:

```
User Prompt
  └── LLM Call #1  → Think (Reasoning)
  └── LLM Call #2  → Act (Tool call: read file / run command)
  └── LLM Call #3  → Observe (process result)
  └── ... up to 10 iterations
```

**10 users × 10 calls = 100 LLM calls potentially in-flight simultaneously.**

| Per Call | Tokens |
|---|---|
| Input (system prompt + memory + history) | ~2,000–4,000 |
| Output (reasoning + code patch) | ~500–1,500 |
| **Total per LLM call** | **~5,000 tokens** |

---

## 2. Scenario A: Laptop-Hosted Ollama (`qwen2.5-coder:7b`)

### The Hard Reality

Ollama runs **one request at a time** by default. It is single-threaded inference on a single model instance. Requests queue behind each other like a single ATM machine.

### What Actually Happens With 10 Users:

| User | Waits for | Est. Wait Before Response Starts | Experience |
|---|---|---|---|
| User 1 | Nothing | 0 s | ✅ Normal (15–40 s per response) |
| User 2 | User 1 | ~40 s | 🟡 Slow but works |
| User 3 | Users 1+2 | ~80 s | 🟠 Noticeably delayed |
| User 4 | Users 1–3 | ~2 min | 🔴 Feels broken |
| Users 5–10 | All above | 3–8 min | ❌ Timeout / user gives up |

### Memory Math on 8GB Laptop:

```
Ollama model (qwen2.5-coder:7b Q4_K_M):  ~4.7 GB
Minikube Control Plane + Sidecars:        ~2.8 GB
Windows + Chrome + VS Code:               ~1.0 GB
Node.js backend:                          ~0.2 GB
─────────────────────────────────────────────────
TOTAL:                                    ~8.7 GB  ← OVER LIMIT
```

> [!CAUTION]
> With Minikube running alongside Ollama on 8GB RAM, the system is already at OOM edge. Even a single agent session pushes Windows into heavy disk swapping (pagefile), slowing everything by 10–100x.

### Laptop Realistic Concurrent User Limits:

| Concurrent Users | Status |
|---|---|
| **1** | ✅ Works, 15–40 s response |
| **2–3** | 🟡 Queue forms, 1–2 min total wait |
| **4–5** | 🔴 Memory pressure + 3–5 min waits, may crash |
| **6+** | ❌ OOM crash or 10+ min timeouts — unusable |

**Laptop realistic concurrent user limit: 2–3 users.**

---

## 3. Scenario B: Groq API (`qwen-2.5-coder-32b`)

Groq uses custom **LPU (Language Processing Unit)** hardware. It runs inference at 500–900 tokens/second — roughly 10× faster than Ollama on a laptop. Requests run **in parallel** on Groq's infrastructure.

### Groq Free Tier Rate Limits:

| Limit Type | Value |
|---|---|
| Requests Per Minute (RPM) | 30 RPM |
| Tokens Per Minute (TPM) | 14,400 TPM |
| Tokens Per Day (TPD) | 1,000,000 TPD |

### 10 Users on Free Tier — The Math:

```
10 users × 5,000 tokens/call = 50,000 TPM needed
Free tier cap:                = 14,400 TPM available
─────────────────────────────────────────────────────
Token deficit:                = -35,600 TPM  ← RATE LIMITED
```

When rate limited, Groq returns HTTP `429 Too Many Requests`. If the backend has no retry logic (currently it doesn't), all sessions from user 3+ fail with an error in the chat.

### Groq Paid Tier (~$0.04/M tokens, no flat fee):

| Limit | Value |
|---|---|
| RPM | 6,000 |
| TPM | 200,000+ |
| Concurrent users comfortable | 10–50 |

With paid Groq, **10 users work comfortably**:
- 10 users × 5,000 tokens = 50,000 TPM (well under 200,000 TPM limit)
- Groq parallelizes natively — no queue like Ollama
- Response latency: **2–5 seconds** per iteration (vs. 15–40 s on laptop)

### Groq Concurrent User Reality:

| Concurrent Users | Free Tier | Paid Tier |
|---|---|---|
| **1–2** | ✅ Works | ✅ Excellent |
| **3–5** | 🔴 Rate limited (429 errors) | ✅ Works fine |
| **10** | ❌ Throttled instantly | ✅ Comfortable |
| **50** | ❌ Unusable | 🟡 Near limit — monitor |
| **100+** | ❌ | 🔴 Need enterprise plan |

---

## 4. Scenario C: HuggingFace Inference API

> [!WARNING]
> HuggingFace's free Inference API routes to **shared, overloaded community servers**. Do NOT rely on it for real user traffic.

### HuggingFace Free Tier Reality:

| Behaviour | What Actually Happens |
|---|---|
| Queue position | Model may have 50+ requests queued — 5–30 min wait |
| Model availability | Large models go offline randomly |
| Rate limit | ~1 RPM effective for large models |
| Error rate | High — model loading, timeouts, 503s |

**HuggingFace Free: Only suitable for personal testing, never for 2+ users.**

### HuggingFace Dedicated Inference Endpoints (Paid — Your Own GPU):

You deploy `Qwen2.5-Coder-7B` on HuggingFace's GPU infrastructure (~$0.80–$2.00/hour for a T4 GPU — 16GB VRAM).

| Concurrent Users | T4 GPU (Dedicated) |
|---|---|
| **1–5** | ✅ Works, ~5–10 s/response |
| **10–20** | 🟡 Queue forms (1 GPU, sequential) |
| **20+** | 🔴 Need multiple GPU replicas |

---

## 5. Full Comparison Table

| Metric | Laptop Ollama | Groq Free | Groq Paid | HF Dedicated GPU |
|---|---|---|---|---|
| **Max Concurrent Users** | 2–3 | ~2 | 10–50 | 5–20 per GPU |
| **Response Latency** | 15–40 s | 2–5 s | 2–5 s | 5–15 s |
| **Cost** | $0 (electricity) | $0 | ~$0.04/M tokens | ~$1–2/hr |
| **Parallel Requests** | ❌ No (queue) | ✅ Yes | ✅ Yes | ❌ No (per GPU) |
| **Data Privacy** | ✅ 100% local | 🟡 Groq servers | 🟡 Groq servers | 🟡 HF servers |
| **Reliability** | 🟡 Your uptime | ✅ SLA-backed | ✅ SLA-backed | ✅ SLA-backed |
| **Best For** | Dev / Demo | Solo testing | Real users | Private LLM hosting |

---

## 6. What Must Be Fixed for Real Scalability

### Fix 1: Add a BullMQ Job Queue (Redis-backed — Redis Already Deployed!)

Currently the backend fires LLM calls immediately. Under load, 10 sessions all call Ollama/Groq simultaneously with no throttle.

Redis is **already running** in your cluster at `localhost:6379` — this is exactly why it was deployed.

```javascript
// Install: npm install bullmq
import { Queue, Worker } from 'bullmq';

const agentQueue = new Queue('agent-loop', { connection: redisClient });

// Enqueue instead of direct call:
await agentQueue.add('run-loop', { deploymentId, chatId, prompt }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 }
});

// Worker — set concurrency based on provider:
const worker = new Worker('agent-loop', processAgentJob, {
  connection: redisClient,
  concurrency: 1   // Ollama (laptop): 1   |  Groq Paid (VPS): 10
});
```

---

### Fix 2: Groq 429 Retry with Exponential Backoff

Currently if Groq returns `429 Too Many Requests`, the session fails immediately.

```javascript
// In agent-loop.service.js — wrap the LLM call:
let attempt = 0;
while (attempt < 5) {
  try {
    const response = await axios.post(url, payload, { headers });
    break;
  } catch (err) {
    if (err.response?.status === 429) {
      const wait = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s, 16s
      console.log(`[REACT LOOP] Rate limited — retrying in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
      attempt++;
    } else throw err;
  }
}
```

---

### Fix 3: Enable Ollama Parallel Mode (Laptop Only)

```bash
# Start Ollama with 2 parallel inference slots instead of 1
OLLAMA_NUM_PARALLEL=2 ollama serve
```

This time-shares CPU/RAM across 2 requests. Each response is ~2× slower, but 2 users are served simultaneously instead of queuing.

---

### Fix 4: LLM Provider Cascade (Auto-Failover)

```javascript
// Priority: Groq → Ollama → HuggingFace
async function callLLMWithFallback(payload) {
  if (process.env.GROQ_API_KEY) {
    try { return await callGroq(payload); }
    catch (err) {
      if (err.response?.status === 429)
        console.warn('[LLM] Groq rate limited → falling back to Ollama...');
    }
  }
  try { return await callOllama(payload); }
  catch { console.warn('[LLM] Ollama unavailable → falling back to HuggingFace...'); }
  return await callHuggingFace(payload);
}
```

---

### Fix 5: Multiple Backend Replicas on VPS k3s

For 10+ real users, deploy 3 backend pods on the VPS — they share the same Redis queue and all call Groq Paid simultaneously.

```yaml
# DevOps/k8s/backend-deployment.yaml (VPS only)
spec:
  replicas: 3       # k3s load-balances across all 3 backend pods
```

---

## 7. Scalability Roadmap

| Step | Change | Impact | Effort |
|---|---|---|---|
| 1 | Fix Ollama `localhost` → `127.0.0.1` | ✅ Already done | Done |
| 2 | `OLLAMA_NUM_PARALLEL=2` | 2 users simultaneously (laptop) | 5 min |
| 3 | Groq 429 retry with backoff | Survives rate limits gracefully | 30 min |
| 4 | BullMQ job queue (use existing Redis) | No more crash under load | 2–3 hours |
| 5 | Groq Paid (~$0.04/M tokens) | 10 users, 2–5 s responses | Account upgrade |
| 6 | 3 backend replicas on VPS k3s | True horizontal scale | 1 hour |
| 7 | Kubernetes HPA (autoscaling) | Auto-scale 1→10 pods by CPU | 1 hour |
