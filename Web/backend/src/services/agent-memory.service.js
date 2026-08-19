const Redis = require('ioredis');
const { Client } = require('pg');
const axios = require('axios');

// Redis Connection & Local Fallback
let redisClient = null;
const localCache = new Map();

try {
  redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    retryStrategy(times) {
      if (times > 2) return null; // stop retrying
      return 1000;
    }
  });
  redisClient.on('error', (err) => {
    console.warn('[REDIS] Connection failed, using in-memory fallback cache. Error:', err.message);
  });
} catch (e) {
  console.warn('[REDIS] Failed to initialize Redis client, using in-memory fallback.', e.message);
}

// PostgreSQL pgvector Connection & Fallback
let pgClient = null;
let usePgVector = false;
let usePgTextFallback = false;
const episodicMemoryMemoryFallback = []; // Array of { session_id, role, content, created_at }

const pgConfig = {
  host: process.env.PG_HOST || '127.0.0.1',
  port: parseInt(process.env.PG_PORT, 10) || 5433,
  database: process.env.PG_DATABASE || 'agent_memory',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
};

const initializeDatabase = async () => {
  const client = new Client(pgConfig);
  try {
    await client.connect();
    pgClient = client;
    console.log('[PGVECTOR] Connected to PostgreSQL at', pgConfig.host + ':' + pgConfig.port);

    // Try to enable pgvector extension
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
      // Create table with vector type (768 dimensions for nomic-embed-text)
      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_memories (
          id SERIAL PRIMARY KEY,
          session_id VARCHAR(255) NOT NULL,
          role VARCHAR(50) NOT NULL,
          content TEXT NOT NULL,
          embedding vector(768),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      usePgVector = true;
      console.log('[PGVECTOR] Extension and vector table initialized successfully.');
    } catch (vectorError) {
      console.warn('[PGVECTOR] pgvector extension not supported. Creating text-fallback table. Error:', vectorError.message);
      // Fallback: create table without vector type
      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_memories (
          id SERIAL PRIMARY KEY,
          session_id VARCHAR(255) NOT NULL,
          role VARCHAR(50) NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      usePgTextFallback = true;
    }
  } catch (err) {
    console.warn('[PGVECTOR] Could not connect to PostgreSQL. Using in-memory episodic memory fallback. Error:', err.message);
  }
};

// Trigger database initialization
initializeDatabase().catch(err => console.error('[PGVECTOR] DB init failed:', err.message));

// Embedding fetch with nomic-embed-text / local fallback
const getEmbedding = async (text) => {
  const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  const url = `${ollamaHost}/api/embeddings`;
  const embeddingModel = 'nomic-embed-text';

  try {
    const response = await axios.post(url, {
      model: embeddingModel,
      prompt: text
    }, { timeout: 3000 });
    
    if (response.data && response.data.embedding) {
      return response.data.embedding;
    }
  } catch (err) {
    // If nomic-embed-text is missing, try default qwen2.5-coder:7b or fallback
    try {
      const fallbackModel = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
      const response = await axios.post(url, {
        model: fallbackModel,
        prompt: text
      }, { timeout: 3000 });
      if (response.data && response.data.embedding) {
        return response.data.embedding;
      }
    } catch (_) {}
  }
  return null; // Return null so we fallback to keyword search
};

/**
 * Store Working Memory (Redis or local memory cache)
 */
const setWorkingMemory = async (sessionId, key, value, ttlSeconds = 3600) => {
  const cacheKey = `agent:work:${sessionId}:${key}`;
  const serializedValue = JSON.stringify(value);

  if (redisClient && redisClient.status === 'ready') {
    try {
      await redisClient.set(cacheKey, serializedValue, 'EX', ttlSeconds);
      return;
    } catch (_) {}
  }
  localCache.set(cacheKey, { value, expiresAt: Date.now() + (ttlSeconds * 1000) });
};

/**
 * Retrieve Working Memory
 */
const getWorkingMemory = async (sessionId, key) => {
  const cacheKey = `agent:work:${sessionId}:${key}`;

  if (redisClient && redisClient.status === 'ready') {
    try {
      const data = await redisClient.get(cacheKey);
      if (data) return JSON.parse(data);
    } catch (_) {}
  }

  const cached = localCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.value;
    }
    localCache.delete(cacheKey); // expired
  }
  return null;
};

/**
 * Delete Working Memory key
 */
const deleteWorkingMemory = async (sessionId, key) => {
  const cacheKey = `agent:work:${sessionId}:${key}`;
  if (redisClient && redisClient.status === 'ready') {
    try {
      await redisClient.del(cacheKey);
      return;
    } catch (_) {}
  }
  localCache.delete(cacheKey);
};

/**
 * Push an observation (tool execution stdout/stderr) to Redis list/local queue
 */
const pushObservation = async (sessionId, observation) => {
  const key = `agent:obs:${sessionId}`;
  if (redisClient && redisClient.status === 'ready') {
    try {
      await redisClient.rpush(key, JSON.stringify(observation));
      await redisClient.expire(key, 600); // 10 minutes TTL
      return;
    } catch (_) {}
  }
  
  const localObsKey = `obs:${sessionId}`;
  let list = localCache.get(localObsKey) || [];
  list.push(observation);
  localCache.set(localObsKey, list);
};

/**
 * Pop all observations for a session
 */
const popObservations = async (sessionId) => {
  const key = `agent:obs:${sessionId}`;
  const observations = [];

  if (redisClient && redisClient.status === 'ready') {
    try {
      const len = await redisClient.llen(key);
      for (let i = 0; i < len; i++) {
        const item = await redisClient.lpop(key);
        if (item) {
          observations.push(JSON.parse(item));
        }
      }
      return observations;
    } catch (_) {}
  }

  const localObsKey = `obs:${sessionId}`;
  const list = localCache.get(localObsKey) || [];
  localCache.delete(localObsKey);
  return list;
};

/**
 * Save Episodic/Long-Term Memory
 */
const saveEpisodicMemory = async (sessionId, role, content) => {
  const embedding = await getEmbedding(content);

  // 1. pgvector save
  if (pgClient && usePgVector && embedding) {
    try {
      const pgVectorStr = `[${embedding.join(',')}]`;
      await pgClient.query(
        'INSERT INTO agent_memories (session_id, role, content, embedding) VALUES ($1, $2, $3, $4::vector)',
        [sessionId, role, content, pgVectorStr]
      );
      return;
    } catch (err) {
      console.warn('[PGVECTOR] Insert failed, falling back to basic insert.', err.message);
    }
  }

  // 2. pgtext fallback save
  if (pgClient && (usePgTextFallback || !embedding)) {
    try {
      await pgClient.query(
        'INSERT INTO agent_memories (session_id, role, content) VALUES ($1, $2, $3)',
        [sessionId, role, content]
      );
      return;
    } catch (_) {}
  }

  // 3. In-memory array fallback
  episodicMemoryMemoryFallback.push({
    session_id: sessionId,
    role,
    content,
    created_at: new Date()
  });
};

/**
 * Retrieve Relevant History (Semantic Search)
 */
const getRelevantHistory = async (sessionId, queryText, limit = 5) => {
  // Try to generate query embedding
  const queryEmbedding = await getEmbedding(queryText);

  // Case A: pgvector retrieval
  if (pgClient && usePgVector && queryEmbedding) {
    try {
      const pgVectorStr = `[${queryEmbedding.join(',')}]`;
      const res = await pgClient.query(
        `SELECT role, content FROM agent_memories 
         WHERE session_id = $1 OR session_id = 'global_training'
         ORDER BY embedding <=> $2::vector 
         LIMIT $3`,
        [sessionId, pgVectorStr, limit]
      );
      return res.rows;
    } catch (err) {
      console.warn('[PGVECTOR] Query failed, falling back to text search.', err.message);
    }
  }

  // Case B: pg text search fallback
  if (pgClient && (usePgTextFallback || !queryEmbedding)) {
    try {
      const keywords = queryText.toLowerCase().replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).filter(k => k.length > 2);
      let queryStr = "SELECT role, content FROM agent_memories WHERE (session_id = $1 OR session_id = 'global_training')";
      const params = [sessionId];
      
      if (keywords.length > 0) {
        queryStr += ' AND (';
        const clauses = keywords.map((k, idx) => {
          params.push(`%${k}%`);
          return `content ILIKE $${idx + 2}`;
        });
        queryStr += clauses.join(' OR ') + ')';
      }
      queryStr += ' ORDER BY created_at DESC LIMIT $1';
      
      const finalParams = [sessionId, ...params.slice(1)];
      const res = await pgClient.query(queryStr.replace('LIMIT $1', `LIMIT ${limit}`), finalParams);
      return res.rows;
    } catch (err) {
      console.warn('[PGTEXT] Text query failed, falling back to memory search.', err.message);
    }
  }

  // Case C: In-memory keyword search fallback
  const sessionMemories = episodicMemoryMemoryFallback.filter(m => m.session_id === sessionId || m.session_id === 'global_training');

  const keywords = queryText.toLowerCase().replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).filter(k => k.length > 2);
  
  if (keywords.length === 0) {
    return sessionMemories.slice(-limit).map(m => ({ role: m.role, content: m.content }));
  }

  const scored = sessionMemories.map(m => {
    let score = 0;
    const lowerContent = m.content.toLowerCase();
    keywords.forEach(k => {
      if (lowerContent.includes(k)) {
        score += 1;
      }
    });
    return { memory: m, score };
  });

  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.created_at - a.memory.created_at)
    .slice(0, limit)
    .map(item => ({ role: item.memory.role, content: item.memory.content }));
};

module.exports = {
  setWorkingMemory,
  getWorkingMemory,
  deleteWorkingMemory,
  pushObservation,
  popObservations,
  saveEpisodicMemory,
  getRelevantHistory
};
