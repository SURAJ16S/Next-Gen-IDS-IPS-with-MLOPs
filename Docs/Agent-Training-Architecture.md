# DevOps AI Agent — Training & Memory Architecture

**Date:** 2026-08-18  
**Scope:** `/agent` page (localhost:5173/agent) and `/devops` chat panel  
**Author:** System Architecture Team

---

## Overview

The DevOps AI Chat Agent is an **autonomous, multi-step reasoning agent** embedded in the DevOps platform. It can read files, execute shell commands inside preview containers, apply code patches, and iteratively solve tasks using a Reason-Act-Observe (ReAct) loop.

This document covers:
1. Why MongoDB alone was insufficient for agent memory
2. The full tiered memory architecture implemented
3. The agent behavioral training system
4. The system prompt engineering changes
5. File inventory of all components

---

## 1. Why MongoDB was Replaced as Agent Memory

### Previous Architecture

```
User Message → MongoDB chat history → LLM → Response
```

MongoDB stored flat `DevOpsChat` documents with an array of `{ role, content }` messages. Every call loaded the entire chat history and sent it to the LLM.

### Problems

| Problem | Impact |
|---|---|
| **No semantic search** | Agent could not retrieve *relevant* past context — only chronological raw history |
| **Token explosion** | Full history grew unboundedly, hitting LLM token limits on long sessions |
| **No working memory** | No short-term scratchpad — agent restarted reasoning from scratch each message |
| **No training context** | No way to inject curated best practices at query time |
| **Inefficient storage** | Chat messages stored as large BSON strings; no compression |

### Result

The agent would fail on complex multi-step tasks because it had no mechanism to:
- Remember that it already executed step 1 while planning step 2
- Retrieve relevant past solutions for similar problems
- Maintain state across the "ask permission → execute → observe" permission flow

---

## 2. New Tiered Memory Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Memory Stack                   │
│                                                         │
│  ┌──────────┐   ┌──────────────┐   ┌────────────────┐  │
│  │  REDIS   │   │  PGVECTOR    │   │   MONGODB      │  │
│  │          │   │              │   │                │  │
│  │ Working  │   │  Episodic +  │   │ Archive /      │  │
│  │ Memory   │   │  Semantic    │   │ Persistent     │  │
│  │ (fast)   │   │  Memory      │   │ Logs           │  │
│  │          │   │  (search)    │   │                │  │
│  │ TTL: 1h  │   │  Permanent   │   │ All history    │  │
│  └──────────┘   └──────────────┘   └────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Layer 1: Redis — Working Memory

**Container:** `devops-local-redis` (port 6379)  
**Service:** `agent-memory.service.js` → `setWorkingMemory()`, `getWorkingMemory()`

Stores temporary per-session state with a 1-hour TTL:
- **ReAct loop state** — the current iteration count and message history so execution can be paused (pending user permission) and resumed later
- **Scratch variables** — intermediate results from `<exec>` commands

```javascript
// Usage example — pause and resume the ReAct loop
await setWorkingMemory(chatId, 'react_loop_state', {
  iteration: currentIteration,
  history: reactHistory
});

// Resume on next message
const savedState = await getWorkingMemory(chatId, 'react_loop_state');
```

### Layer 2: pgvector — Semantic / Episodic Memory

**Container:** `devops-local-pgvector` (port 5432, schema: pgvector extension)  
**Service:** `agent-memory.service.js` → `storeEpisodicMemory()`, `getRelevantHistory()`

Stores all agent interactions as **vector embeddings** in a `agent_memories` table:

```sql
CREATE TABLE agent_memories (
  id         SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,      -- 'user' | 'agent'
  content    TEXT NOT NULL,
  embedding  vector(384),        -- all-MiniLM-L6-v2 embeddings
  created_at TIMESTAMP DEFAULT NOW()
);
```

At query time, the top-K most semantically relevant memories are retrieved using cosine similarity and injected into the LLM context:

```javascript
// At start of each ReAct loop iteration
const semanticContext = await getRelevantHistory(chatId, userMessage, 5);
// Returns 5 most relevant past messages to the current query
```

**Global Training Data** is stored in `session_id = 'global_training'` and is retrieved for every conversation — this is how the behavioral training files are injected.

### Layer 3: MongoDB — Archive

Stores the final assistant response per conversation for UI display and historical audits. Not used for agent reasoning — only for "load previous chat" on page refresh.

---

## 3. ReAct Agent Loop

The agent follows the **Reason → Act → Observe** pattern:

```
┌─────────────────────────────────────────────────────────────┐
│                     ReAct Loop (max 5 iterations)           │
│                                                             │
│  User message                                               │
│       │                                                     │
│       ▼                                                     │
│  [Retrieve semantic context from pgvector]                  │
│       │                                                     │
│       ▼                                                     │
│  [LLM Call] → generates <thought>, <exec>, <patch> tags    │
│       │                                                     │
│       ├──→ Parse <patch> tags → write files to workspace   │
│       │                                                     │
│       ├──→ Parse <exec> tags:                               │
│       │         read-only commands → run immediately        │
│       │         CUD commands → ask user OR run if 'always'  │
│       │                                                     │
│       ▼                                                     │
│  [Feed terminal output back as Observation]                 │
│       │                                                     │
│       ▼                                                     │
│  [Next iteration] → LLM sees its own output + results      │
│       │                                                     │
│       ▼                                                     │
│  [No more <exec> tags → break loop → return final answer]  │
└─────────────────────────────────────────────────────────────┘
```

### Key Implementation Details

- **File:** `Web/backend/src/services/agent-loop.service.js`
- **Max iterations:** 5 (prevents infinite loops on confused LLM responses)
- **Temperature:** 0.1 (low, for deterministic tool use)
- **Observation injection:** Terminal stdout/stderr is appended as a `role: 'user'` message in the next iteration, giving the LLM full awareness of what its commands produced

---

## 4. Behavioral Training System

### Why Training was Needed

Without curated training data, the LLM (Groq / Hugging Face / Ollama) made the following systematic mistakes:

| Mistake | Example |
|---|---|
| Generated Python scripts | `pip install pymongo` → `python seed.py` |
| Used `localhost` for DB | `mongodb://localhost:27017` (unreachable inside Docker) |
| Guessed schema fields | Created `{ name, price, description }` without reading model files |
| Explained instead of acting | "You can navigate to the file and check..." |
| Wrong patch paths | `<patch file="/workspace/server/models/Product.js">` |
| Used `ts-node` | `ts-node seed.ts` (not installed in container) |

### Training Architecture

Training is split into two layers:

**Layer A — pgvector Semantic Memory (retrieved at query time)**

Training files are chunked into sections, embedded with `all-MiniLM-L6-v2`, and stored in pgvector under `session_id = 'global_training'`. The top-5 most relevant chunks are retrieved for each user query.

**Layer B — System Prompt (hardcoded, always present)**

7 non-negotiable behavioral rules are embedded directly in the system prompt as labeled `RULE N —` sections. These fire on every single LLM call regardless of what the semantic retrieval returns.

### Training Files

| File | Content | Chunks |
|---|---|---|
| `DevOps/training/database_best_practices.md` | SQL vs NoSQL selection, indexing, connection pooling | 8 |
| `DevOps/training/framework_debugging_cheat_sheet.md` | Node.js, Django, Spring Boot error patterns | 13 |
| `DevOps/training/few_shot_examples.md` | Self-healing build agent examples | 9 |
| `DevOps/training/agent_behavior_examples.md` | 10 WRONG vs CORRECT agent behavior patterns | 11 |
| `DevOps/training/agent_reasoning_guide.md` | 7 situation guides for autonomous decision-making | 16 |

**Total:** 57 embedding chunks stored in pgvector

### Seeding the Training Data

```bash
# Run from Web/backend directory
node ../../DevOps/scripts/seed-training.js
```

The seed script:
1. Connects to pgvector (`devops-local-pgvector:5432`)
2. Deletes previous `global_training` memories
3. Reads each training `.md` file, splits on `## ` headings
4. Calls HuggingFace `all-MiniLM-L6-v2` API to embed each chunk
5. Inserts chunks into `agent_memories` table with `session_id = 'global_training'`

---

## 5. System Prompt Engineering

The system prompt in `agent-loop.service.js` was redesigned with a **"rules before capabilities"** structure:

### Structure

```
[Dynamic Context]
  - Tech stack, database type, package.json details
  - Workspace file listing

[NON-NEGOTIABLE BEHAVIORAL RULES]
  - 7 labeled rules with explicit WRONG / CORRECT examples

[CAPABILITIES]
  - How to use <patch>, <exec>, <thought> tags
```

### The 7 Hardcoded Rules

```
RULE 1 — SCHEMA FIRST, SEED SECOND
  Never guess field names. Always cat the model file first.
  Step 1: find models → Step 2: read them → Step 3: generate seed.

RULE 2 — NEVER USE PYTHON
  All scripts in plain JavaScript, run with: node script.js
  Python, pip, python3 are NOT installed in this container.

RULE 3 — NEVER USE localhost FOR DATABASES
  Database containers are on the Docker network, not localhost.
  Always use: process.env.MONGODB_URI || 'mongodb://devops-db-mongodb-{jobId}:27017/preview_db'

RULE 4 — DO, DON'T EXPLAIN
  Never tell the user HOW to find a file. Use <exec> to find it.
  If user asks "show me nodemon.json" → immediately: <exec command="find . -name 'nodemon.json'" />

RULE 5 — PATCH PATHS ARE RELATIVE FROM WORKSPACE ROOT
  <patch file="server/models/Product.js">  ✅
  <patch file="/workspace/server/models/Product.js">  ❌

RULE 6 — RETRY ON ERROR AUTONOMOUSLY
  "Cannot find module 'X'" → npm install X, then retry
  "python: not found" → rewrite in Node.js
  "ECONNREFUSED 127.0.0.1" → fix database URL

RULE 7 — ts-node IS NOT AVAILABLE
  Write plain .js files. Run with node, not ts-node.
```

---

## 6. LLM Routing

The agent supports three LLM backends with automatic fallback:

```
Priority 1: Groq API (GROQ_API_KEY set)
  Model: qwen-2.5-coder-32b (default) or $GROQ_MODEL

Priority 2: HuggingFace Inference API (HUGGINGFACE_API_KEY set)
  Model: Qwen/Qwen2.5-Coder-32B-Instruct or $HUGGINGFACE_MODEL

Priority 3: Local Ollama (fallback)
  Host: $OLLAMA_HOST || http://127.0.0.1:11434
  Model: qwen2.5-coder:7b or $OLLAMA_MODEL
```

---

## 7. Security — Command Guardrails

Before executing any `<exec>` command, the agent classifies it:

| Category | Examples | Action |
|---|---|---|
| **Unsafe** | `rm -rf /`, `curl pipe sh`, `wget \| bash` | Blocked, logged, never run |
| **Read-only** | `cat`, `find`, `ls`, `grep`, `printenv` | Executed immediately (no permission needed) |
| **CUD** | `node seed.js`, `npm install`, `echo > file` | Requires user permission OR `execPermission: 'always'` |

**Credential leak detection** runs on all `<patch>` content before writing to disk. Patches containing hardcoded API keys, passwords, or tokens are blocked.

---

## 8. File Inventory

| File | Purpose |
|---|---|
| `Web/backend/src/services/agent-memory.service.js` | Redis + pgvector abstraction layer |
| `Web/backend/src/services/agent-loop.service.js` | Full ReAct loop implementation |
| `Web/backend/src/controllers/devops.controller.js` | Routes `/agent` chat messages to the loop |
| `DevOps/docker-compose-devops.yml` | Adds Redis + pgvector sidecar containers |
| `DevOps/scripts/seed-training.js` | Seeds training chunks into pgvector |
| `DevOps/training/database_best_practices.md` | DB selection & best practices training |
| `DevOps/training/framework_debugging_cheat_sheet.md` | Framework error pattern training |
| `DevOps/training/few_shot_examples.md` | Self-healing build agent few-shot examples |
| `DevOps/training/agent_behavior_examples.md` | 10 WRONG/CORRECT agent behavior patterns |
| `DevOps/training/agent_reasoning_guide.md` | 7 autonomous decision-making situation guides |

---

## 9. Running the Full Stack

```bash
# 1. Start all sidecars (Redis, pgvector, MongoDB, etc.)
./start-devops.sh

# 2. Seed training data into pgvector
cd Web/backend
node ../../DevOps/scripts/seed-training.js

# 3. Start backend
npm run dev

# 4. Start frontend
cd Web/frontend && npm run dev

# 5. Navigate to Agent
open http://localhost:5173/agent
```

> **Re-seed whenever** you add or modify files in `DevOps/training/`. The seed script fully replaces all `global_training` memories on each run.
