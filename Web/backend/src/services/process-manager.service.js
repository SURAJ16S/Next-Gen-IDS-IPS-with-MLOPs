const { spawn, exec } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');
const Docker = require('dockerode');
const Deployment = require('../models/Deployment');
const { getIO } = require('../websocket/socket');
const { detectFramework } = require('./framework-detector.service');
const { analyzeLogsAndDiagnose } = require('./diagnostics.service');

/**
 * Polls http://localhost:{port}/ until the server returns any response (≤599)
 * or until the timeout expires. Logs each attempt to the deployment.
 * @returns {Promise<{ok: boolean, status: number|null, durationMs: number}>}
 */
const waitForHttpReady = (port, deploymentId, jobId, opts = {}) => {
  const maxWaitMs  = opts.maxWaitMs  || 1_200_000; // 20 min
  const intervalMs = opts.intervalMs || 3_000;     // poll every 3 s
  const start      = Date.now();
  let attempt      = 0;

  return new Promise((resolve) => {
    const poll = () => {
      attempt++;
      const elapsed = Date.now() - start;
      const req = http.get(`http://localhost:${port}/`, { timeout: 5_000 }, (res) => {
        const durationMs = Date.now() - start;
        const isHtml = (res.headers['content-type'] || '').includes('text/html');
        const ok = res.statusCode < 400 || isHtml;
        logPreview(deploymentId, jobId,
          `[HEALTH] ✅ App responded — HTTP ${res.statusCode} in ${durationMs}ms (attempt #${attempt})`
        );
        resolve({ ok: true, status: res.statusCode, durationMs });
      });
      req.on('error', () => {
        const elapsed = Date.now() - start;
        if (elapsed >= maxWaitMs) {
          logPreview(deploymentId, jobId,
            `[HEALTH] ❌ Timeout after ${Math.round(elapsed / 1000)}s — app never responded on port ${port}.`
          );
          resolve({ ok: false, status: null, durationMs: elapsed });
        } else {
          logPreview(deploymentId, jobId,
            `[HEALTH] ⏳ Waiting for app on port ${port}… (${Math.round(elapsed / 1000)}s elapsed, attempt #${attempt})`
          );
          setTimeout(poll, intervalMs);
        }
      });
      req.on('timeout', () => req.destroy());
    };
    poll();
  });
};

// Dynamically list our modular framework modules
const mern = require('./frameworks/mern');
const spring = require('./frameworks/spring');
const django = require('./frameworks/django');
const rust = require('./frameworks/rust');
const generic = require('./frameworks/generic');

// ── Original Frontend & SSG Stack ────────────────────────────────────
const angular = require('./frameworks/angular');
const astro = require('./frameworks/astro');
const cra = require('./frameworks/cra');
const eleventy = require('./frameworks/eleventy');
const gatsby = require('./frameworks/gatsby');
const hugo = require('./frameworks/hugo');
const nextjs = require('./frameworks/nextjs');
const nuxt = require('./frameworks/nuxt');
const remix = require('./frameworks/remix');
const sveltekit = require('./frameworks/sveltekit');
const vite = require('./frameworks/vite');
const vuecli = require('./frameworks/vuecli');

// ── Backend Stack ───────────────────────────────────────────────────
const fastapi = require('./frameworks/fastapi');
const flask = require('./frameworks/flask');
const fastify = require('./frameworks/fastify');
const elysia = require('./frameworks/elysia');
const hono = require('./frameworks/hono');
const koa = require('./frameworks/koa');
const h3 = require('./frameworks/h3');
const express = require('./frameworks/express');
const php = require('./frameworks/php');

// ── New: Java Ecosystem ─────────────────────────────────────────
const quarkus = require('./frameworks/quarkus');

// ── New: .NET / C# ───────────────────────────────────────────────
const blazor = require('./frameworks/blazor');
const dotnet = require('./frameworks/dotnet');

// ── New: Elixir ──────────────────────────────────────────────────
const phoenix = require('./frameworks/phoenix');

// ── New: Ruby ────────────────────────────────────────────────────
const rails = require('./frameworks/rails');
const sinatra = require('./frameworks/sinatra');

// ── New: PHP Full-Stack ─────────────────────────────────────────
const symfony = require('./frameworks/symfony');

// ── New: Deno ────────────────────────────────────────────────────
const denoFresh = require('./frameworks/deno-fresh');
const deno = require('./frameworks/deno');

// ── New: Go Ecosystem ───────────────────────────────────────────
const gin = require('./frameworks/gin');
const fiber = require('./frameworks/fiber');
const echoGo = require('./frameworks/echo-go');

// ── New: Modern React Meta-Frameworks ───────────────────────────
const tanstackStart = require('./frameworks/tanstack-start');
const analog = require('./frameworks/analog');

// ── New: Svelte Standalone ─────────────────────────────────────────
const svelte = require('./frameworks/svelte');

// ── New: Bun Native ───────────────────────────────────────────────
const bunNative = require('./frameworks/bun-native');

// ── Emerging & Other Stack ─────────────────────────────────────────
const nitro = require('./frameworks/nitro');
const blitz = require('./frameworks/blitz');
const redwood = require('./frameworks/redwood');
const qwik = require('./frameworks/qwik');
const solidstart = require('./frameworks/solidstart');
const marko = require('./frameworks/marko');
const preact = require('./frameworks/preact');
const staticAssets = require('./frameworks/static');

const plugins = [
  // Java
  quarkus, spring,
  // Compiled languages
  rust,
  // .NET
  blazor, dotnet,
  // Elixir
  phoenix,
  // Ruby
  rails, sinatra,
  // PHP (Symfony before generic)
  symfony, php,
  // Deno (Fresh before generic)
  denoFresh, deno,
  // Python
  fastapi, flask, django,
  // Bun (elysia first, then bun-native)
  elysia, bunNative,
  // Modern React meta-frameworks
  tanstackStart, analog,
  // Full-Stack meta-frameworks
  nextjs, sveltekit, nuxt, astro, remix, blitz, redwood, solidstart,
  // Svelte standalone (after sveltekit)
  svelte,
  // Emerging / Component frameworks
  qwik, nitro, marko, preact,
  // Bundler-based frontends
  gatsby, cra, vite, angular, vuecli,
  // Static Site Generators
  hugo, eleventy,
  // Go backends
  gin, fiber, echoGo,
  // Node.js backends
  fastify, hono, koa, h3, express,
  // Full-stack Node catch-all
  mern,
  // Static HTML/CSS/JS
  staticAssets
];

// Initialize Docker client
const isWindows = process.platform === 'win32';

/**
 * Gets a working Docker instance (checking Named Pipe and TCP socket fallbacks).
 * Returns null if Docker is not running or accessible.
 */
const getDockerInstance = async () => {
  const activeDocker = new Docker(isWindows ? { socketPath: '//./pipe/docker_engine' } : { socketPath: '/var/run/docker.sock' });
  try {
    await activeDocker.ping();
    return activeDocker;
  } catch (_) {
    try {
      const tcpDocker = new Docker({ host: '127.0.0.1', port: 2375 });
      await tcpDocker.ping();
      return tcpDocker;
    } catch (__) {
      return null;
    }
  }
};

// In-memory registry: jobId -> { process/container, port, deploymentId, type: 'process' | 'container' }
const runningPreviews = new Map();

// Ports permanently reserved by this project (never suggest these)
const RESERVED_PORTS = new Set([3000, 5000, 5173, 8080, 27017, 5432]);

/**
 * Checks if a port is available by attempting to bind to it.
 */
const isPortAvailable = (port) => {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
};

/**
 * Suggests the next available port in range 3001-3999.
 */
const suggestPort = async () => {
  for (let port = 3001; port <= 3999; port++) {
    if (RESERVED_PORTS.has(port)) continue;
    if (runningPreviews.has(port)) continue; // already allocated
    const available = await isPortAvailable(port);
    if (available) return port;
  }
  return null; // all ports busy
};

/**
 * Returns the preview start command for a framework.
 */
const getPreviewCommand = async (framework, workDir) => {
  const plugin = plugins.find(p => p.id === framework) || generic;
  return await plugin.getPreviewCommand(workDir);
};

/**
 * Logs a message to the Socket.IO pipeline room and MongoDB.
 */
const logPreview = async (deploymentId, jobId, message) => {
  const formattedLog = `[${new Date().toISOString()}] ${message}`;
  console.log(`[Preview ${jobId}] ${message}`);
  await Deployment.findByIdAndUpdate(deploymentId, { $push: { buildLogs: formattedLog } });
  try {
    const io = getIO();
    io.to(`pipeline:${jobId}`).emit('pipeline:log', { jobId, log: formattedLog });
  } catch (_) {}
};

/**
 * Helper to parse a .env file from the workspace directory.
 */
const parseEnvFile = (workDir) => {
  let envPath = path.join(workDir, '.env');
  if (!fs.existsSync(envPath)) {
    const parentEnvPath = path.join(workDir, '..', '.env');
    if (fs.existsSync(parentEnvPath)) {
      envPath = parentEnvPath;
    }
  }
  const env = {};
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const index = trimmed.indexOf('=');
        if (index > 0) {
          const key = trimmed.substring(0, index).trim();
          let val = trimmed.substring(index + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.substring(1, val.length - 1);
          }
          env[key] = val;
        }
      }
    } catch (err) {
      console.error('Error parsing .env file for preview:', err);
    }
  }
  return env;
};

const resolvePortPlaceholder = (args, port) => {
  return args.map(arg => {
    if (typeof arg === 'string') {
      return arg.replace(/\$\{PORT(?::-?\d+)?\}/g, String(port));
    }
    return arg;
  });
};

/**
 * Helper to run the preview process on the local host.
 */
const spawnHostPreview = async (jobId, deploymentId, workDir, framework, port) => {
  const { cmd, args, env: extraEnv } = await getPreviewCommand(framework, workDir);
  const envFileVars = parseEnvFile(workDir);

  const childEnv = {
    ...process.env,
    PORT: String(port),
    SERVER_PORT: String(port), // For Spring Boot
    NODE_ENV: 'production',
    ...envFileVars,
    ...extraEnv,
  };

  let finalArgs = resolvePortPlaceholder(args, port);
  finalArgs = finalArgs.map(a => (a === '0' ? `0.0.0.0:${port}` : a));

  // On Windows host, normalize Unix-style relative paths and classpath separators
  let hostCmd = cmd;
  if (process.platform === 'win32') {
    hostCmd = cmd.replace(/\//g, '\\');
    finalArgs = finalArgs.map(arg => {
      if (typeof arg === 'string') {
        let normalized = arg;
        if (arg.includes('/')) {
          normalized = normalized.replace(/\//g, '\\');
        }
        // Normalize classpath separator from Unix colon (:) to Windows semicolon (;)
        // but avoid breaking URLs (e.g. http://...)
        if (normalized.includes(':') && !normalized.includes('://')) {
          normalized = normalized.replace(/:/g, ';');
        }
        return normalized;
      }
      return arg;
    });
  }

  await logPreview(deploymentId, jobId, `[PREVIEW] Spawning live preview on host → http://localhost:${port}`);
  await logPreview(deploymentId, jobId, `[PREVIEW] Command: ${hostCmd} ${finalArgs.join(' ')}`);

  const child = spawn(hostCmd, finalArgs, {
    cwd: workDir,
    env: childEnv,
    shell: process.platform === 'win32',
  });

  runningPreviews.set(jobId, { type: 'process', process: child, port, deploymentId });

  child.stdout.on('data', async (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) await logPreview(deploymentId, jobId, `[APP] ${line.trim()}`);
    }
  });

  child.stderr.on('data', async (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) await logPreview(deploymentId, jobId, `[APP][STDERR] ${line.trim()}`);
    }
  });

  child.on('close', async (code) => {
    runningPreviews.delete(jobId);
    await logPreview(deploymentId, jobId, `[PREVIEW] Host process exited with code ${code}.`);
    await Deployment.findByIdAndUpdate(deploymentId, { previewStatus: 'stopped', previewPid: null });
    try {
      const io = getIO();
      io.to(`pipeline:${jobId}`).emit('preview:stopped', { jobId });
    } catch (_) {}
  });

  await Deployment.findByIdAndUpdate(deploymentId, {
    previewPort: port,
    previewPid: child.pid,
    previewStatus: 'running',
  });

  // Wait for the app to actually serve HTTP before declaring it live
  const health = await waitForHttpReady(port, deploymentId, jobId);
  if (health.ok) {
    await Deployment.findByIdAndUpdate(deploymentId, { status: 'deployed' });
    try {
      const io = getIO();
      io.to(`pipeline:${jobId}`).emit('preview:ready', {
        jobId,
        port,
        url: `http://localhost:${port}`,
      });
    } catch (_) {}
  } else {
    await logPreview(deploymentId, jobId, `[PREVIEW] ❌ App failed health check — marking as failed.`);
    await Deployment.findByIdAndUpdate(deploymentId, { status: 'failed', previewStatus: 'stopped' });
    try {
      const io = getIO();
      io.to(`pipeline:${jobId}`).emit('preview:stopped', { jobId });
    } catch (_) {}
  }
};

/**
 * Helper to ensure a Docker image exists locally by pulling it if missing.
 */
const ensureDockerImage = async (activeDocker, imageName, deploymentId, jobId) => {
  try {
    const image = activeDocker.getImage(imageName);
    await image.inspect();
    await logPreview(deploymentId, jobId, `[PREVIEW] Using local cached image: ${imageName}`);
  } catch (_) {
    await logPreview(deploymentId, jobId, `[PREVIEW] Pulling image from registry: ${imageName}...`);
    await new Promise((resolve, reject) => activeDocker.pull(imageName, (err, stream) => {
      if (err) return reject(err);
      activeDocker.modem.followProgress(stream, resolve);
    }));
  }
};

const detectRequiredDatabases = (envVars) => {
  const dbs = [];
  const envString = JSON.stringify(envVars).toLowerCase();

  // 1. MySQL Detection
  const hasMysql = envString.includes('mysql://') || 
                   (envVars.DB_CONNECTION && envVars.DB_CONNECTION.toLowerCase() === 'mysql') ||
                   Object.keys(envVars).some(k => k.toUpperCase().includes('MYSQL'));
  if (hasMysql) {
    dbs.push({
      type: 'mysql',
      image: 'mysql:8.0',
      port: 3306,
      env: ['MYSQL_ALLOW_EMPTY_PASSWORD=yes', 'MYSQL_DATABASE=preview_db']
    });
  }

  // 2. PostgreSQL Detection
  const hasPostgres = envString.includes('postgres://') || 
                      envString.includes('postgresql://') || 
                      (envVars.DB_CONNECTION && (envVars.DB_CONNECTION.toLowerCase() === 'pgsql' || envVars.DB_CONNECTION.toLowerCase() === 'postgres')) ||
                      Object.keys(envVars).some(k => k.toUpperCase().includes('POSTGRES'));
  if (hasPostgres) {
    dbs.push({
      type: 'postgres',
      image: 'postgres:15-alpine',
      port: 5432,
      env: ['POSTGRES_HOST_AUTH_METHOD=trust', 'POSTGRES_DB=preview_db']
    });
  }

  // 3. MongoDB Detection
  const hasMongo = envString.includes('mongodb://') || 
                   envString.includes('mongodb+srv://') ||
                   Object.keys(envVars).some(k => k.toUpperCase().includes('MONGO'));
  if (hasMongo) {
    dbs.push({
      type: 'mongodb',
      image: 'mongo:6.0',
      port: 27017
    });
  }

  // 4. Redis Detection
  const hasRedis = envString.includes('redis://') || 
                   Object.keys(envVars).some(k => k.toUpperCase().includes('REDIS'));
  if (hasRedis) {
    dbs.push({
      type: 'redis',
      image: 'redis:7.0-alpine',
      port: 6379
    });
  }

  // 5. Qdrant Detection
  const hasQdrant = Object.keys(envVars).some(k => k.toUpperCase().includes('QDRANT')) || envString.includes('qdrant');
  if (hasQdrant) {
    dbs.push({
      type: 'qdrant',
      image: 'qdrant/qdrant:latest',
      port: 6333
    });
  }

  // 6. Chroma Detection
  const hasChroma = Object.keys(envVars).some(k => k.toUpperCase().includes('CHROMA')) || envString.includes('chroma');
  if (hasChroma) {
    dbs.push({
      type: 'chroma',
      image: 'chromadb/chroma:latest',
      port: 8000
    });
  }

  return dbs;
};

const patchPhpConfigs = (workDir, jobId) => {
  const recPatch = (dir) => {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        if (file !== 'node_modules' && file !== 'vendor' && file !== '.git') {
          recPatch(fullPath);
        }
      } else if (file.endsWith('.php')) {
        try {
          let content = fs.readFileSync(fullPath, 'utf8');
          let modified = false;
          if (content.includes('localhost') || content.includes('127.0.0.1')) {
            content = content.replace(/(['"])localhost\1/g, `$1devops-db-mysql-${jobId}$2`);
            content = content.replace(/(['"])127\.0\.0\.1\1/g, `$1devops-db-mysql-${jobId}$2`);
            modified = true;
          }
          if (modified) {
            fs.writeFileSync(fullPath, content, 'utf8');
          }
        } catch (_) {}
      }
    }
  };
  recPatch(workDir);
};

const detectDbNameFromPhp = (workDir) => {
  let detected = null;
  const recDetect = (dir) => {
    if (!fs.existsSync(dir) || detected) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (detected) return;
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        if (file !== 'node_modules' && file !== 'vendor' && file !== '.git') {
          recDetect(fullPath);
        }
      } else if (file.endsWith('.php')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const match = content.match(/dbname=([a-zA-Z0-9_-]+)/i) || 
                        content.match(/['"]DB_DATABASE['"]\s*,\s*['"]([a-zA-Z0-9_-]+)['"]/i) ||
                        content.match(/['"]database['"]\s*=>\s*['"]([a-zA-Z0-9_-]+)['"]/i);
          if (match && match[1]) {
            detected = match[1];
            return;
          }
        } catch (_) {}
      }
    }
  };
  recDetect(workDir);
  return detected;
};

const cleanupDockerResources = async (activeDocker, jobId) => {
  const dbTypes = ['mysql', 'postgres', 'mongodb', 'redis', 'qdrant', 'chroma'];
  for (const dbType of dbTypes) {
    const dbContainerName = `devops-db-${dbType}-${jobId}`;
    try {
      const dbContainer = activeDocker.getContainer(dbContainerName);
      await dbContainer.stop().catch(() => {});
      await dbContainer.remove().catch(() => {});
    } catch (_) {}
  }
  const containerName = `devops-preview-${jobId}`;
  try {
    const appContainer = activeDocker.getContainer(containerName);
    await appContainer.stop().catch(() => {});
    await appContainer.remove().catch(() => {});
  } catch (_) {}
  const networkName = `devops-net-${jobId}`;
  try {
    const network = activeDocker.getNetwork(networkName);
    await network.remove().catch(() => {});
  } catch (_) {}
};

/**
 * Spawns the compiled app on the given port (using container mode if Docker is available, or host mode as fallback).
 */
const spawnPreview = async (jobId, deploymentId, workDir, framework, port) => {
  if (runningPreviews.has(jobId)) {
    await logPreview(deploymentId, jobId, `[PREVIEW] Job ${jobId} already has a running preview.`);
    return;
  }

  // 1. Try Docker container mode if Docker is running
  const activeDocker = await getDockerInstance();
  if (activeDocker) {
    const detection = detectFramework(workDir);
    const containerName = `devops-preview-${jobId}`;
    const { cmd, args } = await getPreviewCommand(framework, workDir);
    const finalArgs = resolvePortPlaceholder(args, port);

    // Auto-patch database connection hostnames and detect target DB name for PHP applications
    let detectedDbName = 'preview_db';
    const deployment = await Deployment.findById(deploymentId);
    const useTempDb = deployment ? deployment.useTempDb !== false : true;

    if (framework === 'php') {
      if (useTempDb) {
        patchPhpConfigs(workDir, jobId);
      }
      const parsedDb = detectDbNameFromPhp(workDir);
      if (parsedDb) {
        detectedDbName = parsedDb;
        await logPreview(deploymentId, jobId, `[PREVIEW] Detected database schema name from PHP configuration: ${detectedDbName}`);
      }
    }

    // Pre-emptively stop and remove any conflicting preview container of the same name or port.
    // Wrap in try/catch to make it completely crash-safe (prevents unhandled modem 404s)
    try {
      const containers = await activeDocker.listContainers({ all: true });
      for (const containerInfo of containers) {
        const isPortMatch = containerInfo.Ports && containerInfo.Ports.some(p => p.PublicPort === Number(port) || p.PrivatePort === Number(port));
        const isNameMatch = containerInfo.Names && containerInfo.Names.some(name => name.includes(containerName));
        if (isPortMatch || isNameMatch) {
          const conflictingContainer = activeDocker.getContainer(containerInfo.Id);
          await conflictingContainer.stop().catch(() => {});
          await conflictingContainer.remove().catch(() => {});
        }
      }
    } catch (_) {}

    const bind = `${path.resolve(workDir)}:/workspace`;
    const previewImage = detection.previewImage || detection.buildImage;

    await logPreview(deploymentId, jobId, `[PREVIEW] Spawning live preview in isolated container: ${containerName}`);
    await logPreview(deploymentId, jobId, `[PREVIEW] Image: ${previewImage}`);

    try {
      await ensureDockerImage(activeDocker, previewImage, deploymentId, jobId);
    } catch (pullErr) {
      await logPreview(deploymentId, jobId, `[PREVIEW] [WARNING] Failed to pull preview image: ${pullErr.message}. Trying container start anyway...`);
    }

    // Detect MERN monorepo patterns:
    // Case A: client/ is inside workDir (e.g. workDir has both client/ and server/ or just client/)
    // Case B: client/ is a sibling of workDir (workDir IS the server/, client/ is next to it)
    const clientDir = path.join(workDir, 'client');
    const clientDirSibling = path.join(workDir, '..', 'client');
    const hasClientDir = fs.existsSync(path.join(clientDir, 'package.json'));
    const hasClientSibling = !hasClientDir && fs.existsSync(path.join(clientDirSibling, 'package.json'));

    // When client is a SIBLING, we must mount the PARENT directory so both
    // client/ and server/ are accessible inside the container.
    // Otherwise Docker only sees the server/ directory at /workspace.
    let containerBind = `${path.resolve(workDir)}:/workspace`;
    let containerWorkDir = '/workspace';
    let absClientPath = null;
    let absServerPath = '/workspace';

    if (hasClientSibling) {
      // Mount parent dir at /project so /project/client and /project/server both exist
      const parentDir = path.resolve(workDir, '..');
      containerBind = `${parentDir}:/project`;
      const serverDirName = path.basename(workDir); // e.g. "server"
      absClientPath = '/project/client';
      absServerPath = `/project/${serverDirName}`;
      containerWorkDir = absServerPath;
      await logPreview(deploymentId, jobId, `[PREVIEW] Detected MERN monorepo (sibling layout). Mounting parent at /project.`);
    } else if (hasClientDir) {
      absClientPath = '/workspace/client';
    }

    // Build the startup command, chaining client build first if needed
    let containerCmd = [cmd, ...finalArgs];
    if (absClientPath && (framework === 'mern' || framework === 'express')) {
      // Write the proxy file to the parent of absServerPath (which is /project on container, and workDir/.. on host)
      try {
        const parentDirHost = path.resolve(workDir, '..');
        const proxyPathHost = path.join(parentDirHost, 'devops-proxy.js');
        const proxyCode = `const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');

const PREVIEW_PORT = process.env.PORT || 3001;
const BACKEND_PORT = 3002;
const CLIENT_DIST = path.resolve(__dirname, 'client/dist');
const CLIENT_BUILD = path.resolve(__dirname, 'client/build');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With,x-workspace-id,Cookie',
  'Access-Control-Allow-Credentials': 'true'
};

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json'
};

// Build sanitized headers: strip Origin/Referer so backend CORS passes, spoof Host to backend port
function buildBackendHeaders(req) {
  const headers = Object.assign({}, req.headers);
  delete headers['origin'];
  delete headers['referer'];
  headers['host'] = 'localhost:' + BACKEND_PORT;
  return headers;
}

const server = http.createServer((req, res) => {
  const url = req.url;

  // Handle CORS preflight from browser before proxying
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const isApiReq = url.startsWith('/api/') || url.startsWith('/socket.io/') || url.startsWith('/uploads/') || url.startsWith('/webhook') || url.startsWith('/razorpay');

  if (isApiReq) {
    const proxyReq = http.request({
      host: 'localhost',
      port: BACKEND_PORT,
      path: req.url,
      method: req.method,
      headers: buildBackendHeaders(req)
    }, (proxyRes) => {
      const responseHeaders = Object.assign({}, proxyRes.headers, CORS_HEADERS);
      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502, CORS_HEADERS);
      res.end('Proxy Error: ' + err.message);
    });

    req.pipe(proxyReq);
    return;
  }

  let staticPath = CLIENT_DIST;
  if (!fs.existsSync(staticPath)) {
    staticPath = CLIENT_BUILD;
  }

  let filePath = path.join(staticPath, url === '/' ? 'index.html' : url);
  
  if (!filePath.startsWith(staticPath)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(staticPath, 'index.html');
      fs.stat(filePath, (err2, stats2) => {
        if (err2 || !stats2.isFile()) {
          const proxyReq = http.request({
            host: 'localhost',
            port: BACKEND_PORT,
            path: req.url,
            method: req.method,
            headers: req.headers
          }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          });
          proxyReq.on('error', (err) => {
            res.writeHead(502);
            res.end('Proxy Error: ' + err.message);
          });
          req.pipe(proxyReq);
          return;
        }
        serveFile(filePath, res);
      });
      return;
    }
    serveFile(filePath, res);
  });
});

function serveFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

server.on('upgrade', (req, socket, head) => {
  const proxySocket = net.connect(BACKEND_PORT, 'localhost', () => {
    let rawHeaders = req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\\r\\n';
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      rawHeaders += req.rawHeaders[i] + ': ' + req.rawHeaders[i+1] + '\\r\\n';
    }
    rawHeaders += '\\r\\n';
    proxySocket.write(rawHeaders);
    if (head && head.length > 0) {
      proxySocket.write(head);
    }
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxySocket.on('error', () => {
    socket.end();
  });
});

server.listen(PREVIEW_PORT, () => {
  console.log('[DEVOPS PROXY] Listening on port ' + PREVIEW_PORT + ', proxying APIs to port ' + BACKEND_PORT);
});`;
        fs.writeFileSync(proxyPathHost, proxyCode, 'utf8');
      } catch (err) {
        await logPreview(deploymentId, jobId, `[PREVIEW] [WARNING] Failed to write devops-proxy.js: ${err.message}`);
      }

      const serverStartCmd = [cmd, ...finalArgs].join(' ');
      containerCmd = [
        'sh', '-c',
        `cd ${absClientPath} && npm install --prefer-offline --no-audit --no-fund --ignore-scripts --include=dev --legacy-peer-deps && npm run build && cd /project && PORT=${port} node devops-proxy.js & cd ${absServerPath} && PORT=3002 SERVER_PORT=3002 ${serverStartCmd}`
      ];
      await logPreview(deploymentId, jobId, `[PREVIEW] Detected MERN monorepo. Will build React client at ${absClientPath} before starting server at ${absServerPath}.`);
    }

    // ── Database & Network Provisioning ─────────────────────────────────────────
    const envFileVars = parseEnvFile(workDir);
    const requiredDbs = useTempDb ? detectRequiredDatabases(envFileVars) : [];
    
    // Inject the user-selected database type from UI configuration to ensure it is always provisioned
    const dbInitType = deployment ? deployment.dbInitType : 'none';
    if (useTempDb && dbInitType && dbInitType !== 'none') {
      const alreadyIncluded = requiredDbs.some(d => d.type === dbInitType);
      if (!alreadyIncluded) {
        if (dbInitType === 'mysql') {
          requiredDbs.push({ type: 'mysql', image: 'mysql:8.0', port: 3306, env: ['MYSQL_ALLOW_EMPTY_PASSWORD=yes', 'MYSQL_DATABASE=preview_db'] });
        } else if (dbInitType === 'postgres') {
          requiredDbs.push({ type: 'postgres', image: 'postgres:15-alpine', port: 5432, env: ['POSTGRES_HOST_AUTH_METHOD=trust', 'POSTGRES_DB=preview_db'] });
        } else if (dbInitType === 'mongodb') {
          requiredDbs.push({ type: 'mongodb', image: 'mongo:6.0', port: 27017 });
        }
      }
    }
    
    let networkName = 'bridge';
    if (requiredDbs.length > 0) {
      networkName = `devops-net-${jobId}`;
      try {
        // Create bridge network
        try {
          const existingNet = activeDocker.getNetwork(networkName);
          await existingNet.inspect();
        } catch (_) {
          await activeDocker.createNetwork({ Name: networkName, Driver: 'bridge' });
          await logPreview(deploymentId, jobId, `[PREVIEW] Created isolated database network: ${networkName}`);
        }

        // Spawn each database container
        for (const db of requiredDbs) {
          const dbContainerName = `devops-db-${db.type}-${jobId}`;
          
          try {
            const oldDbContainer = activeDocker.getContainer(dbContainerName);
            await oldDbContainer.stop().catch(() => {});
            await oldDbContainer.remove().catch(() => {});
          } catch (_) {}

          await logPreview(deploymentId, jobId, `[PREVIEW] Launching database container: ${db.image} (${dbContainerName})`);
          await ensureDockerImage(activeDocker, db.image, deploymentId, jobId);

          let dbEnv = db.env || [];
          if (db.type === 'mysql') {
            dbEnv = [`MYSQL_ALLOW_EMPTY_PASSWORD=yes`, `MYSQL_DATABASE=${detectedDbName}`];
          } else if (db.type === 'postgres') {
            dbEnv = [`POSTGRES_HOST_AUTH_METHOD=trust`, `POSTGRES_DB=${detectedDbName}`];
          }

          const dbContainer = await activeDocker.createContainer({
            Image: db.image,
            name: dbContainerName,
            Env: dbEnv,
            HostConfig: {
              NetworkMode: networkName
            }
          });
          
          await dbContainer.start();
          await logPreview(deploymentId, jobId, `[PREVIEW] Database container is ready: ${dbContainerName}`);

          // Run initialization script if provided in deployment settings
          if (deployment && deployment.dbInitScript && deployment.dbInitScript.trim() !== '') {
            await logPreview(deploymentId, jobId, `[PREVIEW] Running database initialization script...`);
            
            const runDbExec = async (cmd, timeoutMs = 15000) => {
              return new Promise(async (resolve) => {
                let resolved = false;
                let timer;
                try {
                  const exec = await dbContainer.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
                  const stream = await exec.start();
                  let output = '';
                  
                  timer = setTimeout(() => {
                    if (!resolved) {
                      resolved = true;
                      try { stream.destroy(); } catch (_) {}
                      resolve(output);
                    }
                  }, timeoutMs);

                  stream.on('data', (chunk) => { output += chunk.toString(); });
                  stream.on('end', () => {
                    if (!resolved) {
                      resolved = true;
                      clearTimeout(timer);
                      resolve(output);
                    }
                  });
                  stream.on('error', () => {
                    if (!resolved) {
                      resolved = true;
                      clearTimeout(timer);
                      resolve(output);
                    }
                  });
                } catch (err) {
                  if (!resolved) {
                    resolved = true;
                    if (timer) clearTimeout(timer);
                    resolve('');
                  }
                }
              });
            };

            // Wait for database engine to accept connections (up to 15s)
            let ready = false;
            for (let i = 0; i < 15; i++) {
              try {
                let checkCmd = [];
                if (db.type === 'mysql') {
                  checkCmd = ['mysqladmin', 'ping', '-u', 'root'];
                } else if (db.type === 'postgres') {
                  checkCmd = ['pg_isready', '-U', 'postgres'];
                } else if (db.type === 'mongodb') {
                  checkCmd = ['mongosh', '--eval', "db.adminCommand('ping')"];
                }
                
                if (checkCmd.length > 0) {
                  const checkOut = await runDbExec(checkCmd, 5000);
                  if (db.type === 'mysql' && checkOut.toLowerCase().includes('alive')) {
                    ready = true;
                    break;
                  } else if (db.type === 'postgres' && checkOut.toLowerCase().includes('accepting connections')) {
                    ready = true;
                    break;
                  } else if (db.type === 'mongodb' && checkOut.includes('ok')) {
                    ready = true;
                    break;
                  }
                }
              } catch (_) {}
              await new Promise(r => setTimeout(r, 1000));
            }
            
            if (ready) {
              try {
                const initScript = deployment.dbInitScript;
                let scriptFile = '';
                if (db.type === 'mysql') {
                  scriptFile = '/tmp/init.sql';
                } else if (db.type === 'postgres') {
                  scriptFile = '/tmp/init.sql';
                } else if (db.type === 'mongodb') {
                  scriptFile = '/tmp/init.js';
                }
                
                if (scriptFile !== '') {
                  // Write script to container file
                  const delimiter = '__INIT_EOF__';
                  let writeCmd = ['sh', '-c', `cat << '${delimiter}' > ${scriptFile}\n${initScript}\n${delimiter}`];
                  await runDbExec(writeCmd, 10000);
                  
                  let runCmd = [];
                  if (db.type === 'mysql') {
                    runCmd = ['mysql', '-u', 'root', '-e', `CREATE DATABASE IF NOT EXISTS \`${detectedDbName}\`; USE \`${detectedDbName}\`; source ${scriptFile};`];
                  } else if (db.type === 'postgres') {
                    runCmd = ['psql', '-U', 'postgres', '-d', detectedDbName, '-f', scriptFile];
                  } else if (db.type === 'mongodb') {
                    runCmd = ['mongosh', detectedDbName, scriptFile];
                  }
                  
                  const runOut = await runDbExec(runCmd, 15000);
                  await logPreview(deploymentId, jobId, `[PREVIEW] Database initialization complete. Output:\n${runOut}`);
                }
              } catch (initErr) {
                await logPreview(deploymentId, jobId, `[PREVIEW] [WARNING] Database initialization failed: ${initErr.message}`);
              }
            } else {
              await logPreview(deploymentId, jobId, `[PREVIEW] [WARNING] Database server not ready in time. Skipping initialization script.`);
            }
          }
        }
      } catch (dbErr) {
        await logPreview(deploymentId, jobId, `[PREVIEW] [WARNING] Failed to set up database container network: ${dbErr.message}. Falling back to host databases.`);
        networkName = 'bridge';
      }
    }

    const finalEnv = (() => {
      const containerEnv = [
        `PORT=${port}`,
        `SERVER_PORT=${port}`,
        `NODE_ENV=production`
      ];
      const FRONTEND_URL_VARS = new Set([
        'FRONTEND_URL', 'CLIENT_URL', 'APP_URL', 'CORS_ORIGIN', 'ALLOWED_ORIGIN',
        'REACT_APP_URL', 'VUE_APP_URL', 'NEXT_PUBLIC_URL', 'VITE_APP_URL',
        'FRONTEND_BASE_URL', 'CLIENT_BASE_URL', 'WEB_URL', 'WEBAPP_URL',
      ]);
      
      const dbHostMap = {};
      for (const db of requiredDbs) {
        dbHostMap[db.port] = `devops-db-${db.type}-${jobId}`;
      }

      for (const [key, value] of Object.entries(envFileVars)) {
        if (key !== 'PORT' && key !== 'SERVER_PORT' && key !== 'NODE_ENV') {
          let val = value;
          const isClientVar = key.startsWith('VITE_') || key.startsWith('REACT_APP_') || key.startsWith('NEXT_PUBLIC_') || key.startsWith('PUBLIC_');
          if (!FRONTEND_URL_VARS.has(key) && !isClientVar && typeof val === 'string') {
            let rewritten = false;
            for (const [dbPort, dbHost] of Object.entries(dbHostMap)) {
              const regex = new RegExp(`(localhost|127\\.0\\.0\\.1|host\\.docker\\.internal):${dbPort}`, 'i');
              if (regex.test(val)) {
                val = val.replace(regex, `${dbHost}:${dbPort}`);
                rewritten = true;
              }
            }
            if (!rewritten && requiredDbs.length > 0) {
              const isHostKey = key.toUpperCase().includes('HOST') || key.toUpperCase().includes('SERVER') || key.toUpperCase().includes('URL') || key.toUpperCase().includes('URI');
              if (isHostKey && (val.toLowerCase() === 'localhost' || val === '127.0.0.1' || val.toLowerCase() === 'host.docker.internal')) {
                val = `devops-db-${requiredDbs[0].type}-${jobId}`;
                rewritten = true;
              }
            }
            if (!rewritten) {
              val = val.replace(/^(https?:\/\/|mongodb(?:\+srv)?:\/\/|postgres(?:ql)?:\/\/|mysql:\/\/|redis:\/\/)(?:localhost|127\.0\.0\.1)(:\d+)?(.*)?$/i, '$1host.docker.internal$2$3');
            }
          }
          containerEnv.push(`${key}=${val}`);
        }
      }
      return containerEnv;
    })();

    await logPreview(deploymentId, jobId, `[DOCKER-ENV-DEBUG] Generated Env: ${JSON.stringify(finalEnv)}`);

    activeDocker.createContainer({
      Image: previewImage,
      Cmd: containerCmd,
      name: containerName,
      HostConfig: {
        Binds: [containerBind],
        PortBindings: {
          [`${port}/tcp`]: [{ HostPort: String(port) }]
        },
        ExtraHosts: ['host.docker.internal:host-gateway'],
        NetworkMode: networkName
      },
      ExposedPorts: {
        [`${port}/tcp`]: {}
      },
      Env: finalEnv,
      WorkingDir: containerWorkDir
    }, async (err, container) => {
      if (err) {
        await logPreview(deploymentId, jobId, `[PREVIEW] Failed to create preview container: ${err.message}. Falling back to host mode.`);
        await spawnHostPreview(jobId, deploymentId, workDir, framework, port);
        return;
      }

      container.attach({ stream: true, stdout: true, stderr: true }, (err, stream) => {
        if (!err && stream) {
          let buffer = '';
          stream.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop();
            lines.forEach(line => {
              const clean = line.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
              if (clean) logPreview(deploymentId, jobId, `[APP] ${clean}`);
            });
          });
        }
      });

      container.start(async (err) => {
        if (err) {
          await logPreview(deploymentId, jobId, `[PREVIEW] Failed to start preview container: ${err.message}. Falling back to host mode.`);
          try { await container.remove(); } catch (_) {}
          await spawnHostPreview(jobId, deploymentId, workDir, framework, port);
          return;
        }

        runningPreviews.set(jobId, {
          type: 'container',
          container: container,
          port,
          deploymentId
        });

        await Deployment.findByIdAndUpdate(deploymentId, {
          previewPort: port,
          previewPid: 9999, // placeholder PID for container
          previewStatus: 'running',
        });

        // Wait for the containerised app to serve HTTP before declaring live
        const health = await waitForHttpReady(port, deploymentId, jobId);
        if (health.ok) {
          await Deployment.findByIdAndUpdate(deploymentId, { status: 'deployed' });
          try {
            const io = getIO();
            io.to(`pipeline:${jobId}`).emit('preview:ready', {
              jobId,
              port,
              url: `http://localhost:${port}`,
            });
          } catch (_) {}
        } else {
          await logPreview(deploymentId, jobId, `[PREVIEW] ❌ App failed health check — marking as failed.`);
          await Deployment.findByIdAndUpdate(deploymentId, { status: 'failed', previewStatus: 'stopped' });
          try {
            const io = getIO();
            io.to(`pipeline:${jobId}`).emit('preview:stopped', { jobId });
          } catch (_) {}
        }

        // Wait for container to exit in the background.
        // Wrap everything in try-catches to be completely crash-safe.
        container.wait(async () => {
          runningPreviews.delete(jobId);
          await logPreview(deploymentId, jobId, `[PREVIEW] Preview container exited/stopped.`);
          await Deployment.findByIdAndUpdate(deploymentId, { previewStatus: 'stopped', previewPid: null });
          try {
            const io = getIO();
            io.to(`pipeline:${jobId}`).emit('preview:stopped', { jobId });
          } catch (_) {}

          // Lifecycle garbage collection: clean up database containers and isolated network
          const activeDocker = await getDockerInstance();
          if (activeDocker) {
            await cleanupDockerResources(activeDocker, jobId);
          }

          // Run log diagnostics on container exit
          try {
            const logsBuffer = await container.logs({ stdout: true, stderr: true, tail: 100 });
            // Demux docker logs multiplexed format
            let logsText = '';
            let offset = 0;
            while (offset < logsBuffer.length) {
              if (offset + 8 > logsBuffer.length) break;
              const size = logsBuffer.readUInt32BE(offset + 4);
              if (offset + 8 + size > logsBuffer.length) break;
              logsText += logsBuffer.toString('utf8', offset + 8, offset + 8 + size);
              offset += 8 + size;
            }
            if (!logsText) logsText = logsBuffer.toString('utf8');

            const diagnoses = analyzeLogsAndDiagnose(logsText);
            if (diagnoses.length > 0) {
              await logPreview(deploymentId, jobId, `\n[DIAGNOSTICS] DevOps Smart Diagnosis Engine identified potential issues:`);
              for (const d of diagnoses) {
                await logPreview(deploymentId, jobId, `  ↪ ❌ ${d.error}:`);
                await logPreview(deploymentId, jobId, `    👉 Solution: ${d.solution}`);
              }
              await logPreview(deploymentId, jobId, `\n`);
            }
          } catch (logErr) {
            console.error('Failed to parse container exit logs for diagnostics:', logErr);
          }
        });
      });
    });
  } else {
    // 2. Fallback to host process mode
    await spawnHostPreview(jobId, deploymentId, workDir, framework, port);
  }
};

/**
 * Kills/stops the running preview process or container for a jobId.
 */
const stopPreview = async (jobId) => {
  const entry = runningPreviews.get(jobId);
  
  // Lifecycle garbage collection: clean up database containers and isolated network immediately
  const activeDocker = await getDockerInstance();
  if (activeDocker) {
    await cleanupDockerResources(activeDocker, jobId);
  }

  // Graceful fallback: If it's not in our map but the database shows it running, update it in DB anyway
  if (!entry) {
    await Deployment.findOneAndUpdate({ jobId }, { previewStatus: 'stopped', previewPid: null });
    return true;
  }

  if (entry && entry.type === 'container') {
    await logPreview(entry.deploymentId, jobId, `[PREVIEW] Shutting down preview container...`);
    try {
      await entry.container.stop().catch(() => {});
    } catch (_) {}
  } else {
    const pid = entry.process.pid;
    if (pid) {
      if (process.platform === 'win32') {
        try {
          exec(`taskkill /pid ${pid} /T /F`);
        } catch (_) {}
      } else {
        try {
          exec(`pkill -P ${pid}`, () => {
            try {
              entry.process.kill('SIGKILL');
            } catch (_) {}
          });
        } catch (_) {
          entry.process.kill('SIGTERM');
        }
      }
    }
  }

  runningPreviews.delete(jobId);
  await Deployment.findOneAndUpdate({ jobId }, { previewStatus: 'stopped', previewPid: null });
  return true;
};

/**
 * Returns list of all currently running previews.
 */
const getRunningPreviews = () => {
  const result = [];
  for (const [jobId, entry] of runningPreviews.entries()) {
    result.push({ jobId, port: entry.port, deploymentId: entry.deploymentId });
  }
  return result;
};

module.exports = { spawnPreview, stopPreview, getRunningPreviews, suggestPort };
