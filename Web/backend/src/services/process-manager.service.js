const { spawn, exec } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const Docker = require('dockerode');
const Deployment = require('../models/Deployment');
const { getIO } = require('../websocket/socket');
const { detectFramework } = require('./framework-detector.service');
const { analyzeLogsAndDiagnose } = require('./diagnostics.service');

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
  const envPath = path.join(workDir, '.env');
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

  try {
    const io = getIO();
    io.to(`pipeline:${jobId}`).emit('preview:ready', {
      jobId,
      port,
      url: `http://localhost:${port}`,
    });
  } catch (_) {}
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

    // Pre-emptively stop and remove any conflicting preview container of the same name.
    // Wrap in try/catch to make it completely crash-safe (prevents unhandled modem 404s)
    try {
      const conflictingContainer = activeDocker.getContainer(containerName);
      await conflictingContainer.stop().catch(() => {});
      await conflictingContainer.remove().catch(() => {});
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
      const serverStartCmd = [cmd, ...finalArgs].join(' ');
      containerCmd = [
        'sh', '-c',
        `cd ${absClientPath} && npm install --prefer-offline --no-audit --no-fund --ignore-scripts --include=dev && npm run build && cd ${absServerPath} && ${serverStartCmd}`
      ];
      await logPreview(deploymentId, jobId, `[PREVIEW] Detected MERN monorepo. Will build React client at ${absClientPath} before starting server at ${absServerPath}.`);
    }

    activeDocker.createContainer({
      Image: previewImage,
      Cmd: containerCmd,
      name: containerName,
      HostConfig: {
        Binds: [containerBind],
        PortBindings: {
          [`${port}/tcp`]: [{ HostPort: String(port) }]
        },
        ExtraHosts: ['host.docker.internal:host-gateway']
      },
      ExposedPorts: {
        [`${port}/tcp`]: {}
      },
      Env: (() => {
        const envFileVars = parseEnvFile(workDir);
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
        for (const [key, value] of Object.entries(envFileVars)) {
          if (key !== 'PORT' && key !== 'SERVER_PORT' && key !== 'NODE_ENV') {
            let val = value;
            if (!FRONTEND_URL_VARS.has(key) && typeof val === 'string') {
              val = val.replace(/^(https?:\/\/|mongodb(?:\+srv)?:\/\/|postgres(?:ql)?:\/\/|mysql:\/\/|redis:\/\/)(?:localhost|127\.0\.0\.1)(:\d+)?(.*)?$/i, '$1host.docker.internal$2$3');
            }
            containerEnv.push(`${key}=${val}`);
          }
        }
        return containerEnv;
      })(),
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

        try {
          const io = getIO();
          io.to(`pipeline:${jobId}`).emit('preview:ready', {
            jobId,
            port,
            url: `http://localhost:${port}`,
          });
        } catch (_) {}

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
  
  // Graceful fallback: If it's not in our map but the database shows it running, update it in DB anyway
  if (!entry) {
    await Deployment.findOneAndUpdate({ jobId }, { previewStatus: 'stopped', previewPid: null });
    
    // Also proactively check if there is an orphaned Docker container and terminate it
    const activeDocker = await getDockerInstance();
    if (activeDocker) {
      const containerName = `devops-preview-${jobId}`;
      try {
        const container = activeDocker.getContainer(containerName);
        await container.stop().catch(() => {});
      } catch (_) {}
    }
    return true;
  }

  if (entry.type === 'container') {
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
