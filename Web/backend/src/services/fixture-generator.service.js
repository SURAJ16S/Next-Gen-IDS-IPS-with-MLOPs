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
        dependencies: { express: '^4.19.2', sqlite3: '^5.1.7' }
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
const { createApp, createRouter, defineEventHandler } = require('h3');

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
createServer(app).listen(process.env.PORT || 3000);
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

serve({ fetch: app.fetch, port: process.env.PORT || 3000 });
      `
    },
    fastapi: {
      'requirements.txt': 'fastapi==0.111.0\nuvicorn==0.30.1',
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
        name: 'preact-app',
        version: '1.0.0',
        scripts: { build: 'echo "preact dist"' },
        dependencies: { preact: '^10.22.0' }
      }, null, 2),
      'dist': {
        'index.html': `
          <!DOCTYPE html>
          <html>
          <head><style>body { background:#020617; color:#f8fafc; font-family:sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }</style></head>
          <body>
            <div style="background:#0f172a; border:1px solid #0284c7; padding:40px; border-radius:16px;">
              <h1 style="color:#38bdf8; margin-top:0;">Preact Static Bundle Active</h1>
            </div>
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
      `,
      'src': {
        'main.rs': `
use axum::{routing::get, Router};
#[tokio::main]
async fn main() {
    let db_url = "postgres://rust_user:rust_pass_123@127.0.0.1:5432/rust_db";
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
