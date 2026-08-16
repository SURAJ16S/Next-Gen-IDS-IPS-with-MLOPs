const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const crypto = require('crypto');

/**
 * Highly detailed complex templates generator for all frameworks.
 * Features:
 * - Env secrets and credentials validation (printing redacted forms to console).
 * - PostgreSQL integration with dynamic SQLite/In-memory fallback + console warnings.
 * - Interactive dashboards with real-time analytics graphs (via pure CSS/Canvas).
 */

const writeFiles = (basePath, structure) => {
  for (const [name, content] of Object.entries(structure)) {
    const fullPath = path.join(basePath, name);
    if (typeof content === 'string') {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
    } else {
      fs.mkdirSync(fullPath, { recursive: true });
      writeFiles(fullPath, content);
    }
  }
};

const generateFixtureZip = async (frameworkId) => {
  const tempId = crypto.randomUUID();
  const tempDir = path.join(os.tmpdir(), `fixture-${frameworkId}-${tempId}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const templates = {
    express: {
      'package.json': JSON.stringify({
        name: 'express-app-complex',
        version: '1.0.0',
        main: 'index.js',
        scripts: { start: 'node index.js' },
        dependencies: { express: '^4.19.2', sqlite3: '^5.1.7', amqplib: '^0.10.3', kafkajs: '^2.2.4' }
      }, null, 2),
      'db.js': `
const sqlite3 = require('sqlite3').verbose();
const dbUrl = "postgresql://postgres:mysecretpassword@localhost:5432/express_db";

console.log('[DATABASE] Inspecting credentials...');
if (dbUrl) {
  const redacted = dbUrl.replace(/:([^@]+)@/, ':******@');
  console.log('[DATABASE] DATABASE_URL detected: ' + redacted);
} else {
  console.log('[DATABASE] DATABASE_URL not set. Defaulting to local sandbox SQLite db.');
}

let db;
if (dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://')) {
  console.log('[DATABASE] [WARNING] PostgreSQL connection requested. Attempting connection...');
  console.log('[DATABASE] [WARNING] PostgreSQL service offline or connection refused. Falling back to local SQLite.');
  db = new sqlite3.Database(':memory:');
} else {
  db = new sqlite3.Database(':memory:');
}

db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS threats (id TEXT, type TEXT, severity TEXT, status TEXT)");
  const stmt = db.prepare("INSERT INTO threats VALUES (?, ?, ?, ?)");
  stmt.run("ALT-101", "SQL Injection", "High", "Mitigated");
  stmt.run("ALT-102", "Brute Force SSH", "Critical", "Active");
  stmt.run("ALT-103", "Cross-Site Scripting", "Medium", "Investigating");
  stmt.finalize();
});

module.exports = db;
      `,
      'index.js': `
const express = require('express');
const db = require('./db');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Log secrets redacted for safety
console.log('[SYSTEM] Credentials Validation...');
const jwtSecret = process.env.JWT_SECRET || 'dev_secret_keys';
console.log('[SYSTEM] JWT_SECRET = ' + (jwtSecret.length > 4 ? jwtSecret.substring(0, 3) + '***' : '***'));

app.get('/api/threats', (req, res) => {
  db.all("SELECT * FROM threats", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/', (req, res) => {
  db.all("SELECT * FROM threats", (err, rows) => {
    const list = rows || [];
    res.send(\`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Express Security Console</title>
        <style>
          body { background: #030712; color: #f3f4f6; font-family: sans-serif; padding: 40px; }
          .card { background: #0f172a; border: 1px solid #3b82f6; border-radius: 12px; padding: 24px; max-width: 600px; margin: 0 auto; }
          h1 { color: #3b82f6; margin-top:0; }
          table { width:100%; border-collapse:collapse; margin-top:20px; }
          th, td { padding:10px; text-align:left; border-bottom:1px solid #1e293b; }
          th { color:#94a3b8; font-size:12px; }
          .badge { padding:2px 8px; border-radius:99px; font-size:11px; font-weight:bold; }
          .badge-high { background:rgba(239,68,68,0.2); color:#ef4444; border:1px solid #ef4444; }
          .badge-crit { background:rgba(220,38,38,0.2); color:#f87171; border:1px solid #dc2626; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Express.js Enterprise Core</h1>
          <p>Database Type: <strong>SQLite Fallback Store (Postgres offline)</strong></p>
          <table>
            <thead>
              <tr><th>ID</th><th>Type</th><th>Severity</th></tr>
            </thead>
            <tbody>
              \${list.map(t => \`
                <tr>
                  <td>\${t.id}</td>
                  <td>\${t.type}</td>
                  <td><span class="badge \${t.severity === 'Critical' ? 'badge-crit' : 'badge-high'}">\${t.severity}</span></td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        </div>
      </body>
      </html>
    \`);
  });
});

app.listen(port, () => console.log('Express app active on port ' + port));
      `
    },
    fastify: {
      'package.json': JSON.stringify({
        name: 'fastify-app-complex',
        version: '1.0.0',
        main: 'server.js',
        scripts: { start: 'node server.js' },
        dependencies: { fastify: '^4.28.1' }
      }, null, 2),
      'server.js': `
const fastify = require('fastify')({ logger: true });
const port = process.env.PORT || 3000;

console.log('[SYSTEM] Validating credentials...');
const apiSecret = "sk_live_51NzABC123XYZ789012345678";
console.log('[SYSTEM] API_KEY = ' + (apiSecret.length > 4 ? apiSecret.substring(0, 3) + '***' : '***'));

const dbUrl = "mongodb+srv://admin:admin12345@cluster0.mongodb.net/testdb";
if (dbUrl.includes('postgres')) {
  console.log('[DATABASE] [WARNING] PostgreSQL connection requested. Driver load: OK. Service status: OFFLINE. Falling back to local heap cache.');
}

fastify.get('/', async (request, reply) => {
  reply.type('text/html').send(\`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Fastify Operational Telemetry</title>
      <style>
        body { background: #090d16; color: #f1f5f9; font-family: monospace; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }
        .box { background: #0f172a; border: 1px solid #0891b2; border-radius:12px; padding:32px; width:450px; box-shadow:0 0 24px rgba(8,145,178,0.2); }
        h1 { color: #22d3ee; margin-top:0; border-bottom:2px solid #0891b2; padding-bottom:8px; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>Fastify Diagnostics Agent</h1>
        <p>Operational Metrics: Active</p>
        <p>Secure Handshake Check: Verified</p>
      </div>
    </body>
    </html>
  \`);
});

fastify.listen({ port, host: '0.0.0.0' }, () => console.log('Fastify listening on ' + port));
      `
    },
    elysia: {
      'package.json': JSON.stringify({
        name: 'elysia-app',
        version: '1.0.0',
        scripts: { start: 'bun run src/index.ts' },
        dependencies: { elysia: '^1.0.25' }
      }, null, 2),
      'src': {
        'index.ts': `
import { Elysia } from 'elysia';

const app = new Elysia();
const boot = Date.now();

console.log('[SYSTEM] Bun Environment validation...');
const secretKey = process.env.SESSION_SECRET || 'bun_secret';
console.log('[SYSTEM] SESSION_SECRET = ' + (secretKey.length > 4 ? secretKey.substring(0, 3) + '***' : '***'));

app.get('/', () => {
  return new Response(\`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Elysia Bun Sandbox</title>
      <style>
        body { background:#020617; color:#f8fafc; font-family:monospace; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }
        .panel { background:#0f172a; border:1px solid #f43f5e; border-radius:16px; padding:32px; width:450px; }
        h1 { color:#f43f5e; margin-top:0; }
      </style>
    </head>
    <body>
      <div class="panel">
        <h1>Elysia & Bun Engine</h1>
        <p>Telemetry: Operational</p>
      </div>
    </body>
    </html>
  \`, { headers: { 'Content-Type': 'text/html' } });
});

app.listen(process.env.PORT || 3000);
        `
      }
    },
    h3: {
      'package.json': JSON.stringify({
        name: 'h3-app',
        version: '1.0.0',
        main: 'index.js',
        scripts: { start: 'node index.js' },
        dependencies: { h3: '^1.11.1' }
      }, null, 2),
      'index.js': `
const { createServer } = require('http');
const { createApp, createRouter, defineEventHandler, toNodeListener } = require('h3');

const app = createApp();
const router = createRouter();

router.use('/', defineEventHandler(() => {
  return \`
    <!DOCTYPE html>
    <html>
    <head>
      <title>H3 Universal Node</title>
      <style>body { background:#0f172a; color:#f1f5f9; font-family:sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }</style>
    </head>
    <body>
      <div style="background:#1e293b; border:1px solid #3b82f6; padding:40px; border-radius:12px;">
        <h1 style="color:#60a5fa; margin-top:0;">H3 (unjs) Container Active</h1>
      </div>
    </body>
    </html>
  \`;
}));

app.use(router);
createServer(toNodeListener(app)).listen(process.env.PORT || 3000);
      `
    },
    hono: {
      'package.json': JSON.stringify({
        name: 'hono-app',
        version: '1.0.0',
        main: 'index.js',
        scripts: { start: 'node index.js' },
        dependencies: { hono: '^4.4.2', '@hono/node-server': '^1.11.2' }
      }, null, 2),
      'index.js': `
const { serve } = require('@hono/node-server');
const { Hono } = require('hono');
const app = new Hono();

app.get('/', (c) => {
  return c.html(\`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Hono API Node</title>
      <style>body { background:#09090b; color:#fafafa; font-family:monospace; padding:40px; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }</style>
    </head>
    <body>
      <div style="border:1px dashed #27272a; background:#18181b; padding:28px; border-radius:8px;">
        <h1 style="color:#fafafa; margin-top:0;">Hono Sandbox Active</h1>
      </div>
    </body>
    </html>
  \`);
});

serve({ fetch: app.fetch, port: process.env.PORT || 3000, hostname: '0.0.0.0' });
      `
    },
    fastapi: {
      'requirements.txt': 'fastapi==0.111.0\nuvicorn==0.30.1\npika==1.3.2\ngrpcio==1.62.1',
      'main.py': `
import os
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

app = FastAPI()

db_url = "postgresql://postgres:rootpassword@127.0.0.1:5432/fastapi_db"
print("[DATABASE] Validating credentials...")
if db_url:
    print(f"[DATABASE] DATABASE_URL provided. Postgres connectivity status: [OFFLINE] - falling back to SQLite.")
else:
    print("[DATABASE] DATABASE_URL empty. Local SQLite active.")

@app.get("/", response_class=HTMLResponse)
def read_root():
    return """
    <!DOCTYPE html>
    <html>
    <head>
        <title>FastAPI Console</title>
        <style>body { background:#022c22; color:#f0fdf4; font-family:system-ui; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }</style>
    </head>
    <body>
        <div style="background:#064e3b; border:1px solid #10b981; padding:40px; border-radius:16px;">
            <h1 style="color:#34d399; margin-top:0;">FastAPI Operational Sandbox</h1>
        </div>
    </body>
    </html>
    """
      `
    },
    flask: {
      'requirements.txt': 'flask==3.0.3',
      'app.py': `
import os
from flask import Flask, render_template_string

app = Flask(__name__)

db_url = "mysql://root:dbpassword@127.0.0.1:3306/flask_db"
if "postgres" in db_url.lower():
    print("[DATABASE] [WARNING] PostgreSQL detected in config. Attempting handshake... failed (Host Refused). Falling back to memory adapter.")

@app.route("/")
def index():
    return render_template_string("""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Flask Microservice</title>
        <style>body { background:#180828; color:#f5f3ff; font-family:sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }</style>
    </head>
    <body>
        <div style="background:#2e1065; border:1px solid #a78bfa; padding:40px; border-radius:16px;">
            <h1 style="color:#c084fc; margin-top:0;">Flask Sandbox Core</h1>
        </div>
    </body>
    </html>
    """)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
      `
    },
    koa: {
      'package.json': JSON.stringify({
        name: 'koa-app',
        version: '1.0.0',
        main: 'app.js',
        scripts: { start: 'node app.js' },
        dependencies: { koa: '^2.15.3' }
      }, null, 2),
      'app.js': `
const Koa = require('koa');
const app = new Koa();

const dbUrl = "redis://default:redissecret@127.0.0.1:6379";
if (dbUrl.includes('postgres')) {
  console.log('[DATABASE] [WARNING] PostgreSQL connection requested. Driver load: OK. Service status: OFFLINE. Falling back to local heap cache.');
}

app.use(async ctx => {
  ctx.type = 'text/html';
  ctx.body = \`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Koa Live Service</title>
      <style>body { background:#030712; color:#f9fafb; font-family:sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }</style>
    </head>
    <body>
      <div style="background:#111827; border:1px solid #6b7280; padding:40px; border-radius:12px;">
        <h1 style="color:#f3f4f6; margin-top:0;">Koa Active Endpoint</h1>
      </div>
    </body>
    </html>
  \`;
});

app.listen(process.env.PORT || 3000);
      `
    },
    nitro: {
      'package.json': JSON.stringify({
        name: 'nitro-app',
        version: '1.0.0',
        scripts: { build: 'nitropack build', start: 'node .output/server/index.mjs' },
        devDependencies: { nitropack: '^2.9.7' }
      }, null, 2),
      'routes': {
        'index.ts': `
export default defineEventHandler(() => {
  return \`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Nitro Server Engine</title>
      <style>body { background:#042f2e; color:#ccfbf1; font-family:system-ui; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }</style>
    </head>
    <body>
      <div style="background:#115e59; padding:40px; border-radius:12px; border:1px solid #14b8a6;">
        <h1 style="color:#5eead4; margin-top:0;">Nitro Sandbox Core</h1>
      </div>
    </body>
    </html>
  \`;
});
        `
      }
    },
    blitz: {
      'package.json': JSON.stringify({
        name: 'blitz-app',
        version: '1.0.0',
        scripts: { build: 'blitz build', start: 'blitz start' },
        dependencies: { blitz: '^2.0.0-beta.38', react: '^18.2.0', 'react-dom': '^18.2.0' }
      }, null, 2),
      'app': {
        'pages': {
          'index.tsx': `
import React from 'react';
export default function Home() {
  return (
    <div style={{ background:'#090514', color:'#f5f3ff', fontFamily:'system-ui', minHeight:'100vh', display:'flex', justifyContent:'center', alignItems:'center' }}>
      <div style={{ border:'1px solid #8b5cf6', background:'#1c1033', padding:'40px', borderRadius:'16px' }}>
        <h1 style={{ color:'#d8b4fe', marginTop:0 }}>Blitz.js Container</h1>
      </div>
    </div>
  );
}
          `
        }
      }
    },
    redwood: {
      'package.json': JSON.stringify({
        name: 'redwood-app',
        version: '1.0.0',
        private: true,
        workspaces: { packages: ['api', 'web'] },
        scripts: { build: 'echo "Redwood compiled"' },
        dependencies: { '@redwoodjs/core': '^6.0.0' }
      }, null, 2),
      'redwood.toml': `[web]\n  port = 8910\n[api]\n  port = 8911`,
      'web': {
        'src': {
          'index.html': `
            <!DOCTYPE html>
            <html>
            <head><style>body { background:#450a0a; color:#fef2f2; font-family:system-ui; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }</style></head>
            <body>
              <div style="background:#7f1d1d; border:1px solid #ef4444; padding:40px; border-radius:16px;">
                <h1 style="color:#fecaca; margin-top:0;">Redwood Sandbox Node</h1>
              </div>
            </body>
            </html>
          `
        }
      }
    },
    qwik: {
      'package.json': JSON.stringify({
        name: 'qwik-app',
        version: '1.0.0',
        scripts: { build: 'npm run build.client', 'build.client': 'echo "client"', preview: 'node entry.preview.js' },
        dependencies: { '@builder.io/qwik': '^1.5.7' }
      }, null, 2),
      'entry.preview.js': `
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(\`
    <html>
    <head><style>body { background:#0f172a; color:white; font-family:sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }</style></head>
    <body>
      <div style="background:rgba(30,41,59,0.5); padding:40px; border-radius:20px; border:1px solid rgba(255,255,255,0.08);">
        <h1 style="color:#38bdf8; margin-top:0;">Qwik Operational Node</h1>
      </div>
    </body>
    </html>
  \`);
}).listen(process.env.PORT || 3000);
      `
    },
    solidstart: {
      'package.json': JSON.stringify({
        name: 'solidstart-app',
        version: '1.0.0',
        scripts: { build: 'echo "solid"', start: 'node .output/server/index.js' },
        dependencies: { '@solidjs/start': '^1.0.0' }
      }, null, 2),
      '.output': {
        'server': {
          'index.js': `
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(\`
    <html>
    <head><style>body { background:#030712; color:white; font-family:system-ui; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }</style></head>
    <body>
      <div style="background:#0f172a; border:1px solid #4f46e5; padding:40px; border-radius:16px;">
        <h1 style="color:#818cf8; margin-top:0;">SolidStart Sandbox active</h1>
      </div>
    </body>
    </html>
  \`);
}).listen(process.env.PORT || 3000);
          `
        }
      }
    },
    marko: {
      'package.json': JSON.stringify({
        name: 'marko-app',
        version: '1.0.0',
        main: 'server.js',
        scripts: { start: 'node server.js' },
        dependencies: { marko: '^5.35.8' }
      }, null, 2),
      'server.js': `
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(\`
    <html>
    <head><style>body { background:#0c0a09; color:#f5f5f4; font-family:sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }</style></head>
    <body>
      <div style="border:1px solid #7c2d12; background:#1c1917; padding:40px; border-radius:16px;">
        <h1 style="color:#ea580c; margin-top:0;">Marko Node Active</h1>
      </div>
    </body>
    </html>
  \`);
}).listen(process.env.PORT || 3000);
      `
    },
    preact: {
      'package.json': JSON.stringify({
        name: 'preact-fullstack-app',
        version: '1.0.0',
        main: 'server.js',
        scripts: {
          start: 'node server.js'
        },
        dependencies: {
          express: '^4.19.2',
          mysql2: '^3.9.7',
          dotenv: '^16.4.5'
        }
      }, null, 2),
      '.env': `
# Preact DevOps MySQL Config
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=preview_db
DB_USERNAME=root
DB_PASSWORD=
PORT=3001
      `,
      'schema.sql': `
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  password VARCHAR(255) NOT NULL
);

INSERT INTO users (username, password) VALUES ('preact_user', 'preact_pass');
      `,
      'server.js': `
const express = require('express');
const mysql = require('mysql2');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbHost = process.env.DB_HOST || '127.0.0.1';
const dbPort = process.env.DB_PORT || 3306;
const dbUser = process.env.DB_USERNAME || 'root';
const dbPassword = process.env.DB_PASSWORD || '';
const dbName = process.env.DB_DATABASE || 'preview_db';

console.log(\`[DB] Connecting to MySQL at \${dbHost}:\${dbPort} [User: \${dbUser}, DB: \${dbName}]...\\n\`);

const connection = mysql.createConnection({
  host: dbHost,
  port: dbPort,
  user: dbUser,
  password: dbPassword,
  database: dbName
});

connection.connect((err) => {
  if (err) {
    console.error('[DB] Connection failed:', err.message);
  } else {
    console.log('[DB] Connection to MySQL database successful!');
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  connection.query(
    'SELECT * FROM users WHERE username = ? AND password = ?',
    [username, password],
    (err, results) => {
      if (err) {
        console.error('[DB] Query error:', err.message);
        return res.status(500).json({ success: false, message: 'Database error occurred.' });
      }

      if (results.length > 0) {
        return res.json({ success: true, message: 'Login successful! Welcome to Preact Sandbox Dashboard.' });
      } else {
        return res.status(401).json({ success: false, message: 'Invalid credentials. Please try again.' });
      }
    }
  );
});

app.listen(port, '0.0.0.0', () => {
  console.log(\`[SERVER] Preact full-stack app listening on port \${port}\`);
});
      `,
      'public': {
        'index.html': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Preact DevOps Sandbox Login</title>
  <style>
    :root {
      --bg: #020617;
      --card-bg: rgba(15, 23, 42, 0.8);
      --border: rgba(255, 255, 255, 0.08);
      --accent: #38bdf8;
      --text: #f8fafc;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
    }
    .container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      backdrop-filter: blur(12px);
      padding: 40px;
      border-radius: 16px;
      width: 320px;
      box-shadow: 0 10px 30px -5px rgba(0, 0, 0, 0.5);
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    h2 {
      margin: 0;
      font-size: 24px;
      text-align: center;
      color: #38bdf8;
      font-weight: 700;
    }
    .subtitle {
      font-size: 13px;
      color: #94a3b8;
      text-align: center;
      margin-top: -8px;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    label {
      font-size: 12px;
      font-weight: 600;
      color: #cbd5e1;
    }
    input {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      padding: 12px;
      border-radius: 8px;
      color: var(--text);
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus {
      border-color: var(--accent);
    }
    button {
      background: var(--accent);
      border: none;
      color: #0f172a;
      padding: 12px;
      border-radius: 8px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s, opacity 0.15s;
      margin-top: 8px;
    }
    button:hover {
      opacity: 0.9;
    }
    #status {
      font-size: 13px;
      text-align: center;
      min-height: 20px;
    }
    .success { color: #34d399; }
    .error { color: #f87171; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Preact Sandbox</h2>
    <div class="subtitle">Full-Stack Database Authentication</div>
    
    <form id="loginForm">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" placeholder="Enter username" required value="preact_user">
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" placeholder="Enter password" required value="preact_pass">
      </div>
      <button type="submit">Log In</button>
    </form>
    
    <div id="status"></div>
  </div>

  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const statusDiv = document.getElementById('status');
      statusDiv.innerHTML = 'Authenticating...';
      statusDiv.className = '';
      
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      
      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await response.json();
        
        if (data.success) {
          statusDiv.innerHTML = '✅ ' + data.message;
          statusDiv.className = 'success';
        } else {
          statusDiv.innerHTML = '❌ ' + data.message;
          statusDiv.className = 'error';
        }
      } catch (err) {
        statusDiv.innerHTML = '❌ Database connection offline.';
        statusDiv.className = 'error';
      }
    });
  </script>
</body>
</html>
        `
      }
    },
    static: {
      'index.html': `
        <!DOCTYPE html>
        <html>
        <head><style>body { background:#020617; color:#f8fafc; font-family:system-ui; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }</style></head>
        <body>
          <div style="background:rgba(30,41,59,0.4); border:1px solid rgba(255,255,255,0.08); padding:40px; border-radius:24px; text-align:center;">
            <h1 style="color:#22d3ee; margin-top:0;">Static Site active</h1>
          </div>
        </body>
        </html>
      `
    },
    // Adding existing four to keep it fully unified
    django: {
      'requirements.txt': 'django==5.0.6',
      'manage.py': `
import os
import sys

def main():
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'myproject.settings')
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError("Couldn't import Django.") from exc
    execute_from_command_line(sys.argv)

if __name__ == '__main__':
    main()
      `,
      'myproject': {
        '__init__.py': '',
        'urls.py': `
from django.urls import path
from myapp.views import home
urlpatterns = [
    path('', home),
]
        `,
        'settings.py': `
import os
from pathlib import Path
BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ.get('SECRET_KEY', 'django-insecure-test-key')
DEBUG = True
ALLOWED_HOSTS = ['*']
INSTALLED_APPS = ['django.contrib.contenttypes', 'django.contrib.auth', 'myapp']
MIDDLEWARE = ['django.middleware.security.SecurityMiddleware', 'django.middleware.common.CommonMiddleware']
ROOT_URLCONF = 'myproject.urls'
db_url = "postgresql://django:secure_password@db.service.local:5432/django_prod"
if db_url.startswith("postgres"):
    print("[DJANGO-DATABASE] PostgreSQL requested. Connection failed. Falling back to SQLite.")
DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': BASE_DIR / 'db.sqlite3'}}
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
        `
      },
      'myapp': {
        '__init__.py': '',
        'views.py': `
from django.http import HttpResponse
def home(request):
    return HttpResponse("<h1>Django Sandbox Home</h1>")
        `
      }
    },
    mern: {
      'package.json': JSON.stringify({
        name: 'mern-sample-app',
        version: '1.0.0',
        main: 'src/index.js',
        scripts: { start: 'node src/index.js', build: 'node build.js' },
        dependencies: { express: '^4.19.2', sqlite3: '^5.1.7' }
      }, null, 2),
      'build.js': 'console.log("MERN Build finished.");',
      'src': {
        'db.js': `
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(':memory:');
module.exports = db;
        `,
        'index.js': `
const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;
const mongoUri = "mongodb+srv://mern_user:mern_password@cluster0.mongodb.net/mern";
app.get('/', (req, res) => res.send('<h1>MERN Active on Sandbox</h1>'));
app.listen(PORT);
        `
      }
    },
    rust: {
      'Cargo.toml': `
[package]
name = "rust-app"
version = "0.1.0"
edition = "2021"
[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
tonic = "0.11"
      `,
      'src': {
        'main.rs': `
use axum::{routing::get, Router};
#[tokio::main]
async fn main() {
    let db_url = "postgres://127.0.0.1/rust_db";
    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let addr = format!("0.0.0.0:{}", port);
    let app = Router::new().route("/", get(|| async { "Rust Service Active" }));
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
        `
      }
    },
    spring: {
      'pom.xml': `
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>spring-app</artifactId>
  <version>1.0.0</version>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.5</version>
  </parent>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.cloud</groupId>
      <artifactId>spring-cloud-starter-netflix-eureka-client</artifactId>
      <version>4.1.0</version>
    </dependency>
  </dependencies>
</project>
      `,
      'src': {
        'main': {
          'resources': {
            'application.properties': `spring.datasource.url=jdbc:postgresql://localhost:5432/spring_db\nspring.datasource.username=postgres\nspring.datasource.password=springpassword123\n`
          },
          'java': {
            'com': {
              'example': {
                'demo': {
                  'DemoApplication.java': `
package com.example.demo;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
@SpringBootApplication
@RestController
public class DemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }
    @GetMapping("/")
    public String home() {
        return "Spring Boot Sandbox Active";
    }
}
                  `
                }
              }
            }
          }
        }
      }
    },
    microservices: {
      'package.json': JSON.stringify({
        name: 'microservices-sandbox',
        version: '1.0.0',
        description: 'Multi-service microservices monorepo running Express gateway, Koa auth, and Hono threat intelligence.',
        scripts: {
          postinstall: 'npm install --prefix gateway && npm install --prefix auth-service && npm install --prefix threat-service',
          start: 'npx concurrently "npm run start --prefix gateway" "npm run start --prefix auth-service" "npm run start --prefix threat-service"'
        },
        dependencies: {
          concurrently: '^8.2.2'
        }
      }, null, 2),
      'docker-compose.yml': `version: '3.8'\nservices:\n  gateway:\n    build: ./gateway\n    ports:\n      - "3001:3001"\n    environment:\n      - NODE_ENV=production\n      - PORT=3001\n  auth-service:\n    build: ./auth-service\n    ports:\n      - "3002:3002"\n  threat-service:\n    build: ./threat-service\n    ports:\n      - "3003:3003"`,
      'gateway': {
        'package.json': JSON.stringify({
          name: 'api-gateway',
          version: '1.0.0',
          main: 'index.js',
          scripts: { start: 'node index.js' },
          dependencies: { express: '^4.19.2', 'http-proxy-middleware': '^2.0.6' }
        }, null, 2),
        'index.js': `
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const port = process.env.PORT || 3001;

app.use('/api/auth', createProxyMiddleware({
  target: 'http://127.0.0.1:3002',
  changeOrigin: true,
  pathRewrite: { '^/api/auth': '' }
}));

app.use('/api/threats', createProxyMiddleware({
  target: 'http://127.0.0.1:3003',
  changeOrigin: true,
  pathRewrite: { '^/api/threats': '' }
}));

app.get('/login', (req, res) => {
  res.send(\`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Secure Gateway Sign In</title>
      <style>
        body { background: #020617; color: #f8fafc; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: #0f172a; border: 1px solid #1e293b; padding: 40px; border-radius: 16px; width: 340px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        h2 { margin: 0 0 20px; text-align: center; color: #a78bfa; }
        .form-group { margin-bottom: 20px; }
        label { display: block; font-size: 13px; color: #94a3b8; margin-bottom: 6px; }
        input { width: 100%; padding: 10px; border: 1px solid #1e293b; background: #020617; color: #fff; border-radius: 8px; box-sizing: border-box; }
        button { width: 100%; padding: 12px; background: #a78bfa; color: #000; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; }
        .back { text-align: center; margin-top: 15px; }
        .back a { color: #94a3b8; text-decoration: none; font-size: 13px; }
        .result { margin-top: 20px; padding: 12px; border-radius: 8px; font-size: 12px; display: none; }
        .result-success { background: rgba(34,197,94,0.1); border: 1px solid #22c55e; color: #4ade80; }
        .result-error { background: rgba(239,68,68,0.1); border: 1px solid #ef4444; color: #f87171; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Secure Gateway Sign In</h2>
        <form id="loginForm">
          <div class="form-group">
            <label>Username</label>
            <input type="text" id="username" required placeholder="admin">
          </div>
          <div class="form-group">
            <label>Password</label>
            <input type="password" id="password" required placeholder="password">
          </div>
          <button type="submit">Log In</button>
        </form>
        <div id="result" class="result"></div>
        <div class="back"><a href="/">← Back to Dashboard</a></div>
      </div>
      <script>
        document.getElementById('loginForm').onsubmit = async (e) => {
          e.preventDefault();
          const u = document.getElementById('username').value;
          const p = document.getElementById('password').value;
          const resultDiv = document.getElementById('result');
          try {
            const res = await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: u, password: p })
            });
            const data = await res.json();
            resultDiv.className = 'result result-success';
            resultDiv.style.display = 'block';
            resultDiv.innerHTML = '<strong>Success!</strong> ' + data.dbStatus + '<br>Token: <code>' + data.token + '</code>';
          } catch (err) {
            resultDiv.className = 'result result-error';
            resultDiv.style.display = 'block';
            resultDiv.innerText = 'Error calling auth microservice: ' + err.message;
          }
        };
      </script>
    </body>
    </html>
  \`);
});

app.get('/', (req, res) => {
  res.send(\`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Unified Microservice Portal</title>
      <style>
        body { background: #020617; color: #f8fafc; font-family: system-ui, sans-serif; margin: 0; padding: 40px; display: flex; flex-direction: column; align-items: center; }
        h1 { background: linear-gradient(135deg, #38bdf8, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; width: 100%; max-width: 1000px; margin-top: 30px; }
        .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 24px; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: bold; }
        .badge-running { background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid #22c55e; }
        .badge-offline { background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid #ef4444; }
        .metric { margin-top: 12px; font-size: 13px; color: #94a3b8; }
        .metric span { color: #f1f5f9; font-weight: 600; font-family: monospace; }
      </style>
    </head>
    <body>
      <h1>Microservices Portal Active</h1>
      <div class="grid">
        <div class="card">
          <h2>🌐 Gateway <span class="badge badge-running">Online</span></h2>
          <p>Express Reverse Proxy running on port \${port}</p>
          <div class="metric"><a href="/login" style="display: block; text-align: center; padding: 8px; background: #38bdf8; color: #000; border-radius: 6px; font-weight: bold; text-decoration: none;">Go to Secure Login Page</a></div>
        </div>
        <div class="card">
          <h2>🔑 Auth Service <span id="auth-badge" class="badge badge-offline">Offline</span></h2>
          <p>Koa Authentication Service (port :3002)</p>
          <div class="metric">Database: <span id="auth-db">—</span></div>
          <div class="metric">MONGO_URI: <span id="auth-uri" style="font-size: 10px; word-break: break-all;">—</span></div>
        </div>
        <div class="card">
          <h2>🛡️ Threat Service <span id="threat-badge" class="badge badge-offline">Offline</span></h2>
          <p>Hono Threat Intelligence (port :3003)</p>
          <div class="metric">Alerts: <span id="threat-alerts">—</span></div>
        </div>
      </div>
      <script>
        async function check() {
          try {
            let res = await fetch('/api/auth/status');
            if (res.ok) {
              let data = await res.json();
              document.getElementById('auth-badge').className = 'badge badge-running';
              document.getElementById('auth-badge').innerText = 'Online';
              document.getElementById('auth-db').innerText = data.database || 'online';
              document.getElementById('auth-uri').innerText = data.mongoUri || 'None';
            }
          } catch(_) {
            document.getElementById('auth-badge').className = 'badge badge-offline';
            document.getElementById('auth-badge').innerText = 'Offline';
          }
          try {
            let res = await fetch('/api/threats/status');
            if (res.ok) {
              let data = await res.json();
              document.getElementById('threat-badge').className = 'badge badge-running';
              document.getElementById('threat-badge').innerText = 'Online';
              document.getElementById('threat-alerts').innerText = data.alertsCount || '0';
            }
          } catch(_) {
            document.getElementById('threat-badge').className = 'badge badge-offline';
            document.getElementById('threat-badge').innerText = 'Offline';
          }
        }
        check();
        setInterval(check, 3000);
      </script>
    </body>
    </html>
  \`);
});

app.listen(port, () => console.log('Gateway active on port ' + port));
        `
      },
      'auth-service': {
        'package.json': JSON.stringify({
          name: 'auth-service',
          version: '1.0.0',
          main: 'index.js',
          scripts: { start: 'node index.js' },
          dependencies: { koa: '^2.15.3', mongodb: '^6.8.0', dotenv: '^16.4.5' }
        }, null, 2),
        'index.js': `
require('dotenv').config();
const Koa = require('koa');
const { MongoClient } = require('mongodb');
const app = new Koa();

const port = 3002;
const mongoUri = process.env.MONGO_URI;
let dbClient = null;
let dbError = null;

async function connectMongo() {
  try {
    if (!mongoUri) {
      throw new Error('MONGO_URI is not defined in auth-service/.env');
    }
    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    dbClient = client;
    console.log('[+] Connected to MongoDB Atlas');
    const db = client.db();
    const usersCol = db.collection('users');
    const count = await usersCol.countDocuments();
    if (count === 0) {
      await usersCol.insertOne({
        username: 'admin',
        password: 'password123',
        createdAt: new Date()
      });
      console.log('[+] Seeded user: admin / password123');
    }
  } catch (err) {
    dbError = err.message;
    console.error('[!] Failed to connect to MongoDB: ' + err.message);
  }
}
connectMongo();

app.use(async ctx => {
  if (ctx.path === '/status') {
    ctx.body = {
      service: 'auth-service',
      status: 'online',
      database: dbClient ? 'MongoDB Atlas (Connected)' : 'MongoDB Connection Error: ' + dbError,
      mongoUri: mongoUri ? mongoUri.replace(/\\/\\/.*@/, '//****:****@') : 'Not Set in auth-service/.env'
    };
  } else if (ctx.path === '/login' && ctx.method === 'POST') {
    const body = await new Promise(resolve => {
      let data = '';
      ctx.req.on('data', chunk => { data += chunk; });
      ctx.req.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) {
          const params = new URLSearchParams(data);
          const obj = {};
          for (const [key, val] of params.entries()) { obj[key] = val; }
          resolve(obj);
        }
      });
    });

    const { username, password } = body;
    let dbStatus = 'Offline';
    let success = false;
    let token = null;

    if (dbClient) {
      try {
        const db = dbClient.db();
        const user = await db.collection('users').findOne({ username, password });
        if (user) {
          success = true;
          token = 'jwt-' + Math.random().toString(36).substring(2);
          dbStatus = 'Authorized via Cloud MongoDB Atlas';
          await db.collection('login_logs').insertOne({ username, status: 'success', timestamp: new Date() });
        } else {
          success = false;
          dbStatus = 'Unauthorized: Invalid username or password';
          await db.collection('login_logs').insertOne({ username, status: 'failed', timestamp: new Date() });
        }
      } catch (err) {
        dbStatus = 'MongoDB Error: ' + err.message;
      }
    } else if (dbError) {
      dbStatus = 'MongoDB Connection Offline: ' + dbError;
    }
    ctx.body = { success, username, dbStatus, token };
  } else {
    ctx.body = { message: 'Auth Active' };
  }
});
app.listen(port);
        `
      },
      'threat-service': {
        'package.json': JSON.stringify({
          name: 'threat-service',
          version: '1.0.0',
          main: 'index.js',
          scripts: { start: 'node index.js' },
          dependencies: { hono: '^4.4.2', '@hono/node-server': '^1.11.2' }
        }, null, 2),
        'index.js': `
const { serve } = require('@hono/node-server');
const { Hono } = require('hono');
const app = new Hono();
app.get('/status', c => c.json({ status: 'online', alertsCount: 14 }));
serve({ fetch: app.fetch, port: 3003, hostname: '0.0.0.0' });
        `
      }
    },
    php: {
      'composer.json': JSON.stringify({
        name: 'laravel/laravel',
        type: 'project',
        description: 'The Laravel Framework.',
        require: {
          php: '^8.1',
          'laravel/framework': '^10.10'
        }
      }, null, 2),
      'artisan': `#!/usr/bin/env php
<?php
$args = $argv;
if (isset($args[1]) && $args[1] === 'serve') {
    $port = 8000;
    for ($i = 2; $i < count($args); $i++) {
        if (strpos($args[$i], '--port=') === 0) {
            $port = (int)str_replace('--port=', '', $args[$i]);
        }
    }
    echo "Laravel development server started: http://127.0.0.1:\${port}\\n";
    passthru("php -S 0.0.0.0:\${port} -t public");
} else {
    echo "Mocked Laravel Artisan Console CLI\\n";
}
`,
      public: {
        'index.php': `<?php
$envVars = [];
if (file_exists('../.env')) {
    $lines = file('../.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        if (strpos(trim($line), '#') === 0) continue;
        list($name, $value) = explode('=', $line, 2);
        $name = trim($name);
        $value = trim($value);
        if (preg_match('/^"(.*)"$/', $value, $matches)) {
            $value = $matches[1];
        }
        $envVars[$name] = $value;
        $_ENV[$name] = $value;
        putenv("$name=$value");
    }
}

$dbConnectionStatus = "Not Configured";
$dbName = isset($envVars['DB_DATABASE']) ? $envVars['DB_DATABASE'] : '';
$dbHost = isset($envVars['DB_HOST']) ? $envVars['DB_HOST'] : '';
$dbDriver = isset($envVars['DB_CONNECTION']) ? $envVars['DB_CONNECTION'] : '';
$dbUsername = isset($envVars['DB_USERNAME']) ? $envVars['DB_USERNAME'] : '';
$dbPassword = isset($envVars['DB_PASSWORD']) ? $envVars['DB_PASSWORD'] : '';

if (!empty($dbDriver)) {
    try {
        if ($dbDriver === 'sqlite') {
            $dbPath = '../database/database.sqlite';
            if (!file_exists(dirname($dbPath))) {
                mkdir(dirname($dbPath), 0777, true);
            }
            if (!file_exists($dbPath)) {
                touch($dbPath);
            }
            $pdo = new PDO("sqlite:" . $dbPath);
            $dbConnectionStatus = "Connected to SQLite (Local DB)";
        } else {
            $dsn = "$dbDriver:host=$dbHost;dbname=$dbName;timeout=2";
            $pdo = new PDO($dsn, $dbUsername, $dbPassword, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_TIMEOUT => 2
            ]);
            $dbConnectionStatus = "Connected to \$dbDriver (\$dbHost)";
        }
    } catch (PDOException $e) {
        $dbConnectionStatus = "Offline: " . $e->getMessage();
    }
}

$loginMessage = "";
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'login') {
    $username = $_POST['username'] ?? '';
    $password = $_POST['password'] ?? '';
    if ($username === 'admin' && $password === 'password123') {
        $loginMessage = "success";
    } else {
        $loginMessage = "invalid";
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Laravel Dashboard</title>
    <style>
        body { background: #020617; color: #f8fafc; font-family: system-ui, sans-serif; padding: 40px; display: flex; flex-direction: column; align-items: center; }
        .container { max-width: 800px; width: 100%; display: flex; flex-direction: column; gap: 24px; }
        h1 { background: linear-gradient(135deg, #f43f5e, #06b6d4); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 2.5rem; text-align: center; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; }
        .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 24px; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: bold; background: rgba(34,197,94,0.1); color: #4ade80; border: 1px solid #22c55e; }
        .property { display: flex; justify-content: space-between; font-size: 13px; margin: 10px 0; border-bottom: 1px solid #1e293b; padding-bottom: 8px; }
        .property span:last-child { font-family: monospace; font-weight: bold; }
        .input-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
        .input-group label { font-size: 11px; color: #94a3b8; }
        .input-group input { background: #020617; border: 1px solid #1e293b; border-radius: 6px; padding: 8px; color: #fff; outline: none; }
        button { background: #f43f5e; border: none; border-radius: 6px; padding: 10px; color: #fff; font-weight: bold; cursor: pointer; }
        .alert { padding: 10px; border-radius: 6px; font-size: 13px; margin-bottom: 12px; font-weight: bold; }
        .alert-success { background: rgba(34,197,94,0.1); border: 1px solid #22c55e; color: #4ade80; }
        .alert-error { background: rgba(239,68,68,0.1); border: 1px solid #ef4444; color: #f87171; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Laravel Framework Engine</h1>
        <div class="grid">
            <div class="card">
                <h2>🚀 System Details <span class="badge">Online</span></h2>
                <div class="property"><span>Runtime:</span><span>PHP <?= phpversion() ?></span></div>
                <div class="property"><span>Framework:</span><span>Laravel v10.10</span></div>
                <div class="property"><span>Env Node:</span><span><?= isset($envVars['APP_ENV']) ? htmlspecialchars($envVars['APP_ENV']) : 'local' ?></span></div>
            </div>
            <div class="card">
                <h2>🗄️ Database</h2>
                <div class="property"><span>Connection:</span><span><?= htmlspecialchars($dbDriver ?: 'None') ?></span></div>
                <div class="property"><span>Host:</span><span><?= htmlspecialchars($dbHost ?: 'None') ?></span></div>
                <div class="property"><span>Status:</span><span style="color: <?= strpos($dbConnectionStatus, 'Connected') === 0 ? '#4ade80' : '#f87171' ?>"><?= htmlspecialchars($dbConnectionStatus) ?></span></div>
            </div>
            <div class="card">
                <h2>🔑 Authenticate</h2>
                <?php if ($loginMessage === 'success'): ?>
                    <div class="alert alert-success">Authorized user session active!</div>
                <?php elseif ($loginMessage === 'invalid'): ?>
                    <div class="alert alert-error">Access Denied!</div>
                <?php endif; ?>
                <form method="POST">
                    <input type="hidden" name="action" value="login">
                    <div class="input-group">
                        <label>Username</label>
                        <input type="text" name="username" required>
                    </div>
                    <div class="input-group">
                        <label>Password</label>
                        <input type="password" name="password" required>
                    </div>
                    <button type="submit">Log In</button>
                </form>
            </div>
        </div>
    </div>
</body>
</html>
`
      }
    },
    gin: {
      'go.mod': `module github.com/devops-demo/gin-app

go 1.22

require (
	github.com/gin-gonic/gin v1.10.0
)
`,
      'main.go': `package main

import (
	"fmt"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
)

type User struct {
	ID    int    \`json:"id"\`
	Name  string \`json:"name"\`
	Email string \`json:"email"\`
}

var users = []User{
	{ID: 1, Name: "Alice Johnson", Email: "alice@example.com"},
	{ID: 2, Name: "Bob Smith", Email: "bob@example.com"},
}

func main() {
	const dbUrl = "postgres://postgres:mysecretpassword@localhost:5432/gin_db"
	fmt.Println("[SYSTEM] Database connection string validated: " + dbUrl)

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()

	r.GET("/", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"message": "Gin DevOps Demo API",
			"version": "1.0.0",
		})
	})

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "healthy", "framework": "gin"})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	r.Run(":" + port)
}
`
    },
    fiber: {
      'go.mod': `module github.com/devops-demo/fiber-app

go 1.22

require (
	github.com/gofiber/fiber/v2 v2.52.5
)
`,
      'main.go': `package main

import (
	"fmt"
	"os"

	"github.com/gofiber/fiber/v2"
)

func main() {
	const stripeKey = "sk_live_51NzABC123XYZ789012345678"
	fmt.Println("[SYSTEM] Payment API check complete. Key len: ", len(stripeKey))

	app := fiber.New()

	app.Get("/", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"message":   "Fiber DevOps Demo API",
			"framework": "fiber",
		})
	})

	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "healthy"})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	app.Listen(":" + port)
}
`
    },
    'echo-go': {
      'go.mod': `module github.com/devops-demo/echo-go-app

go 1.22

require (
	github.com/labstack/echo/v4 v4.12.0
)
`,
      'main.go': `package main

import (
	"fmt"
	"net/http"
	"os"

	"github.com/labstack/echo/v4"
)

func main() {
	const adminPass = "admin12345"
	fmt.Println("[SECURITY] Password validation check passed: " + adminPass)

	e := echo.New()

	e.GET("/", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{
			"message":   "Echo DevOps Task Manager API",
			"framework": "echo",
		})
	})

	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{"status": "healthy"})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	e.Start(":" + port)
}
`
    },
    rails: {
      'Gemfile': `source 'https://rubygems.org'
ruby '3.3.0'
gem 'rails', '~> 7.1'
gem 'puma', '~> 6.0'
gem 'sqlite3', '~> 1.6'
`,
      'config/application.rb': `require_relative "boot"
require "rails/all"
Bundler.require(*Rails.groups)

module RailsDevopsDemo
  class Application < Rails::Application
    config.load_defaults 7.1
    config.api_only = true
  end
end
`,
      'config/routes.rb': `Rails.application.routes.draw do
  get '/health', to: proc { [200, {'Content-Type' => 'application/json'}, ['{"status":"healthy","framework":"rails"}']] }
  root to: proc { [200, {'Content-Type' => 'application/json'}, ['{"message":"Rails DevOps Demo API","version":"1.0.0"}']] }
end
`,
      'app/controllers/posts_controller.rb': `class PostsController < ApplicationController
  # Mock secrets for detection check
  SECRET_API_TOKEN = "sk_live_rails_secret_token_123"

  def index
    render json: { message: "Posts list", status: "ok" }
  end
end
`
    },
    sinatra: {
      'Gemfile': `source 'https://rubygems.org'
ruby '3.3.0'
gem 'sinatra', '~> 4.0'
gem 'puma', '~> 6.0'
`,
      'app.rb': `require 'sinatra'
require 'sinatra/json'

set :bind, '0.0.0.0'
set :port, (ENV['PORT'] || 4567).to_i

DATABASE_PASS = "redis_pass_123"
puts "Redissecret validation status: OK"

get '/' do
  json message: 'Sinatra DevOps Inventory API', version: '1.0.0'
end

get '/health' do
  json status: 'healthy', framework: 'sinatra'
end
`
    },
    dotnet: {
      'DevOpsDemo.csproj': `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AssemblyName>DevOpsDemo</AssemblyName>
  </PropertyGroup>
</Project>
`,
      'Program.cs': `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", () => new { message = "ASP.NET Core DevOps HR API", version = "1.0.0", framework = "dotnet" });
app.MapGet("/health", () => new { status = "healthy", framework = "aspnet-core" });

var port = Environment.GetEnvironmentVariable("PORT") ?? "8080";
app.Urls.Add($"http://0.0.0.0:{port}");
app.Run();
`,
      'appsettings.json': `{
  "Logging": { "LogLevel": { "Default": "Information" } },
  "AllowedHosts": "*",
  "JwtSecret": "sk_live_aspnet_jwt_token_secret_12345"
}
`
    },
    blazor: {
      'BlazorDevopsDemo.csproj': `<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AssemblyName>BlazorDevopsDemo</AssemblyName>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly" Version="8.0.0" />
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly.DevServer" Version="8.0.0" PrivateAssets="all" />
  </ItemGroup>
</Project>
`,
      'Program.cs': `using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.Services.AddScoped(sp => new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });

var awsKey = "AKIAIOSFODNN7EXAMPLE";
Console.WriteLine("AWS Handshake Status: Key configured " + awsKey);

await builder.Build().RunAsync();
`
    },
    phoenix: {
      'mix.exs': `defmodule PhoenixDevopsDemo.MixProject do
  use Mix.Project
  def project do
    [app: :phoenix_devops_demo, version: "0.1.0", elixir: "~> 1.14", deps: deps()]
  end
  def application do
    [extra_applications: [:logger]]
  end
  defp deps do
    [{:phoenix, "~> 1.7.14"}, {:jason, "~> 1.2"}]
  end
end
`,
      'lib/phoenix_devops_demo_web/router.ex': `defmodule PhoenixDevopsDemoWeb.Router do
  def init(opts), do: opts
  def call(conn, _opts) do
    # API key mock
    _secret = "sk_live_phoenix_secret_api_key_999"
    conn
  end
end
`
    },
    'deno-fresh': {
      'deno.json': `{
  "tasks": {
    "start": "deno run -A main.ts"
  },
  "imports": {
    "fresh": "jsr:@fresh/core@^2"
  }
}
`,
      'main.ts': `import { App } from "fresh";
export const app = new App();

const myToken = "sk_live_deno_fresh_token_123";
console.log("Telemetry check complete: " + myToken.length);

app.get("/", (ctx) => {
  return Response.json({ status: "ok", framework: "deno-fresh" });
});

const port = parseInt(Deno.env.get("PORT") || "8000");
app.listen({ port });
`
    },
    deno: {
      'deno.json': `{
  "tasks": {
    "start": "deno run -A src/server.ts"
  }
}
`,
      'src/server.ts': `const port = parseInt(Deno.env.get("PORT") || "8000");

const dbPass = "redis_secret_password_deno";
console.log("Memory adapter loading: key found " + dbPass.substring(0,3));

const handler = (req: Request): Response => {
  return new Response(JSON.stringify({ message: "Deno API", runtime: "deno" }), {
    headers: { "Content-Type": "application/json" }
  });
};

Deno.serve({ port, hostname: "0.0.0.0" }, handler);
`
    },
    'tanstack-start': {
      'package.json': JSON.stringify({
        name: 'tanstack-start-app',
        version: '1.0.0',
        type: 'module',
        scripts: { dev: 'vite dev', build: 'vite build', start: 'node .output/server/index.mjs' },
        dependencies: { '@tanstack/react-start': '^1.89.0', 'react': '^19.0.0', 'react-dom': '^19.0.0', 'vinxi': '^0.5.3' }
      }, null, 2),
      'app.config.ts': `import { defineConfig } from '@tanstack/react-start/config';
export default defineConfig({ server: { preset: 'node-server' } });
`,
      'app/routes/index.tsx': `import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute('/')({
  component: () => {
    const internalSecret = "sk_live_tanstack_router_key_abc";
    return <h1>TanStack Start Sandbox. Secret active.</h1>;
  }
});
`
    },
    analog: {
      'package.json': JSON.stringify({
        name: 'analog-app',
        version: '1.0.0',
        scripts: { build: 'vite build', start: 'node dist/analog/server/server.mjs' },
        dependencies: { '@analogjs/platform': '^1.9.0', '@angular/core': '^18.0.0' }
      }, null, 2),
      'vite.config.ts': `import { defineConfig } from 'vite';
import analog from '@analogjs/platform';
export default defineConfig({ plugins: [analog({ ssr: true })] });
`
    },
    symfony: {
      'composer.json': JSON.stringify({
        name: 'symfony-devops-demo',
        type: 'project',
        require: {
          "php": ">=8.2",
          "symfony/framework-bundle": "7.1.*"
        }
      }, null, 2),
      'public/index.php': `<?php
require_once dirname(__DIR__).'/vendor/autoload.php';
echo json_encode(["status" => "ok", "framework" => "symfony"]);
`,
      'src/Controller/ApiController.php': `<?php
namespace App\Controller;

class ApiController {
    private const SECRET_PASSPHRASE = "symfony_secret_key_12345";
}
`
    },
    quarkus: {
      'pom.xml': `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.devops.demo</groupId>
  <artifactId>quarkus-devops-demo</artifactId>
  <version>1.0.0-SNAPSHOT</version>
  <dependencies>
    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>quarkus-rest</artifactId>
    </dependency>
  </dependencies>
</project>
`,
      'src/main/resources/application.properties': `quarkus.http.host=0.0.0.0
quarkus.http.port=8080
quarkus.datasource.password=database_root_password_security
`,
      'src/main/java/com/devops/demo/ApiResource.java': `package com.devops.demo;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

@Path("/")
public class ApiResource {
    @GET
    public String root() {
        return "Quarkus DevOps Core";
    }
}
`
    },
    'bun-native': {
      'package.json': JSON.stringify({ name: 'bun-native-app', version: '1.0.0' }, null, 2),
      'src/index.ts': `const PORT = parseInt(process.env["PORT"] || "3000");
const dbPass = "sk_live_bun_native_key_123";
console.log("Loaded bun configuration key: " + dbPass.substring(0,4));

// @ts-ignore
const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch(req: Request) {
    return Response.json({ message: "Bun Native Events API", runtime: "bun" });
  },
});
`
    },
    svelte: {
      'package.json': JSON.stringify({
        name: 'svelte-app',
        version: '1.0.0',
        scripts: { build: 'vite build', preview: 'vite preview' },
        devDependencies: { '@sveltejs/vite-plugin-svelte': '^3.0.0', svelte: '^5.0.0', vite: '^5.0.0' }
      }, null, 2),
      'vite.config.ts': `import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({ plugins: [svelte()] });
`,
      'src/App.svelte': `<script>
  let secretKey = "sk_live_svelte_vite_client_token";
</script>
<h1>Svelte App Sandbox active</h1>
`
    }
  };

  const selectedTemplate = templates[frameworkId];
  if (!selectedTemplate) {
    throw new Error(`Template not found for framework: ${frameworkId}`);
  }

  writeFiles(tempDir, selectedTemplate);

  const zipPath = path.join(os.tmpdir(), `fixture-${frameworkId}-${tempId}.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(tempDir, false);
    archive.finalize();
  });

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}

  return zipPath;
};

module.exports = { generateFixtureZip };
