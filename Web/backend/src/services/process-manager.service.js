const { spawn, exec } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const Docker = require('dockerode');
const Deployment = require('../models/Deployment');
const { getIO } = require('../websocket/socket');
const { detectFramework } = require('./framework-detector.service');

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

// ── Emerging & Other Stack ───────────────────────────────────────────────
const nitro = require('./frameworks/nitro');
const blitz = require('./frameworks/blitz');
const redwood = require('./frameworks/redwood');
const qwik = require('./frameworks/qwik');
const solidstart = require('./frameworks/solidstart');
const marko = require('./frameworks/marko');
const preact = require('./frameworks/preact');
const staticAssets = require('./frameworks/static');

const plugins = [
  mern, spring, django, rust,
  angular, astro, cra, eleventy, gatsby, hugo, nextjs, nuxt, remix, sveltekit, vite, vuecli,
  fastapi, flask,
  fastify, elysia, hono, koa, h3, express,
  nitro, blitz, redwood, qwik, solidstart, marko, preact,
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

  let finalArgs = args.map(a => (a === '0' ? `0.0.0.0:${port}` : a));

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

    activeDocker.createContainer({
      Image: previewImage,
      Cmd: [cmd, ...args],
      name: containerName,
      HostConfig: {
        Binds: [bind],
        PortBindings: {
          [`${port}/tcp`]: [{ HostPort: String(port) }]
        }
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
        for (const [key, value] of Object.entries(envFileVars)) {
          if (key !== 'PORT' && key !== 'SERVER_PORT' && key !== 'NODE_ENV') {
            containerEnv.push(`${key}=${value}`);
          }
        }
        return containerEnv;
      })(),
      WorkingDir: '/workspace'
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
          
          // Do not delete container entirely on exit so it stays in stopped mode.
          // This allows users to start/stop the same container repeatedly without recreating conflicts.
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
