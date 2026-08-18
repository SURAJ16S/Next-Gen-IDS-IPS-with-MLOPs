const fs = require('fs');
const path = require('path');

// Resolve modules from backend node_modules dynamically
module.paths.push(path.join(__dirname, '../../Web/backend/node_modules'));

const { Client } = require('pg');
const axios = require('axios');

const pgConfig = {
  host: process.env.PG_HOST || '127.0.0.1',
  port: parseInt(process.env.PG_PORT, 10) || 5433,
  database: process.env.PG_DATABASE || 'agent_memory',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
};

const getEmbedding = async (text) => {
  const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  const url = `${ollamaHost}/api/embeddings`;
  try {
    const response = await axios.post(url, {
      model: 'nomic-embed-text',
      prompt: text
    }, { timeout: 4000 });
    if (response.data && response.data.embedding) {
      return response.data.embedding;
    }
  } catch (err) {
    try {
      const response = await axios.post(url, {
        model: 'qwen2.5-coder:7b',
        prompt: text
      }, { timeout: 4000 });
      if (response.data && response.data.embedding) {
        return response.data.embedding;
      }
    } catch (_) {}
  }
  return null;
};

const run = async () => {
  const client = new Client(pgConfig);
  try {
    await client.connect();
    console.log('[SEED] Connected to PostgreSQL.');

    // Ensure database structure is setup
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
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

    // Clean previous global training data
    await client.query("DELETE FROM agent_memories WHERE session_id = 'global_training'");
    console.log('[SEED] Cleaned previous global training memories.');

    const trainingDir = path.join(__dirname, '..', 'training');
    const files = [
      { name: 'database_best_practices.md', splitPattern: /## /g },
      { name: 'framework_debugging_cheat_sheet.md', splitPattern: /## /g },
      { name: 'few_shot_examples.md', splitPattern: /## /g },
      { name: 'agent_behavior_examples.md', splitPattern: /## /g },
      { name: 'agent_reasoning_guide.md', splitPattern: /## /g }
    ];

    for (const fileInfo of files) {
      const filePath = path.join(trainingDir, fileInfo.name);
      if (!fs.existsSync(filePath)) {
        console.warn(`[SEED] File not found: ${filePath}`);
        continue;
      }

      console.log(`[SEED] Processing ${fileInfo.name}...`);
      const fileContent = fs.readFileSync(filePath, 'utf8');
      
      // Chunking by split pattern
      const sections = fileContent.split(fileInfo.splitPattern).map(s => s.trim()).filter(Boolean);
      
      for (const section of sections) {
        // Reconstruct title header if split removed it
        const chunkText = `Context from ${fileInfo.name}:\n\n` + section;
        console.log(`[SEED] Generating embedding for chunk (${chunkText.substring(0, 50).replace(/\n/g, ' ')}...)`);
        
        const embedding = await getEmbedding(chunkText);
        
        if (embedding) {
          const pgVectorStr = `[${embedding.join(',')}]`;
          await client.query(
            'INSERT INTO agent_memories (session_id, role, content, embedding) VALUES ($1, $2, $3, $4::vector)',
            ['global_training', 'system', chunkText, pgVectorStr]
          );
        } else {
          await client.query(
            'INSERT INTO agent_memories (session_id, role, content) VALUES ($1, $2, $3)',
            ['global_training', 'system', chunkText]
          );
        }
      }
    }

    console.log('[SUCCESS] Model context training data seeded successfully into pgvector!');
  } catch (error) {
    console.error('[SEED ERROR]', error.message);
  } finally {
    await client.end();
  }
};

run();
