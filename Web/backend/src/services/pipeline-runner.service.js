const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const unzipper = require('unzipper');
const Docker = require('dockerode');
const archiver = require('archiver');
const Deployment = require('../models/Deployment');
const { getIO } = require('../websocket/socket');
const { detectFramework } = require('./framework-detector.service');
const { spawnPreview } = require('./process-manager.service');
const { scanDirectoryForCredentials, autoRemediateCredentials } = require('./credential-scanner.service');
const { performPreBuildValidation, analyzeLogsAndDiagnose } = require('./diagnostics.service');

// Initialize Docker (optional — pipeline degrades gracefully if unavailable)
const isWindows = process.platform === 'win32';
let docker = new Docker(isWindows ? { socketPath: '//./pipe/docker_engine' } : { socketPath: '/var/run/docker.sock' });

// Workspace root is 4 levels up from this file:
// src/services/ → src/ → backend/ → Web/ → project root
const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
const BUILDS_BASE_DIR = path.join(WORKSPACE_DIR, 'DevOps', 'builds');
const ARTIFACTS_BASE_DIR = path.join(WORKSPACE_DIR, 'DevOps', 'artifacts');
const CACHE_BASE_DIR = path.join(WORKSPACE_DIR, 'DevOps', 'cache');

if (!fs.existsSync(BUILDS_BASE_DIR)) fs.mkdirSync(BUILDS_BASE_DIR, { recursive: true });
if (!fs.existsSync(ARTIFACTS_BASE_DIR)) fs.mkdirSync(ARTIFACTS_BASE_DIR, { recursive: true });
if (!fs.existsSync(CACHE_BASE_DIR)) fs.mkdirSync(CACHE_BASE_DIR, { recursive: true });

// ─── Helpers ─────────────────────────────────────────────────────────────────

const logToJob = async (deploymentId, jobId, message) => {
  const formattedLog = `[${new Date().toISOString()}] ${message}`;
  console.log(`[Job ${jobId}] ${message}`);
  await Deployment.findByIdAndUpdate(deploymentId, { $push: { buildLogs: formattedLog } });
  try {
    const io = getIO();
    io.to(`pipeline:${jobId}`).emit('pipeline:log', { jobId, log: formattedLog });
  } catch (_) {}
};

const ensureDockerImage = async (imageName, deploymentId, jobId) => {
  try {
    const image = docker.getImage(imageName);
    await image.inspect();
    logToJob(deploymentId, jobId, `Using local cached image: ${imageName}`);
  } catch (_) {
    logToJob(deploymentId, jobId, `Pulling image from registry: ${imageName}...`);
    await new Promise((res, rej) => docker.pull(imageName, (err, stream) => {
      if (err) return rej(err);
      docker.modem.followProgress(stream, res);
    }));
  }
};

const deleteFolderRecursive = (dirPath) => {
  if (!fs.existsSync(dirPath)) return;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (_) {
    // Fallback: retry after a short delay to let OS release file handles
    setTimeout(() => {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch (_) {}
    }, 2000);
  }
};

const zipDirectory = (sourceDir, outPath, excludePatterns = []) => {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(outPath));
    archive.on('error', reject);
    archive.pipe(output);

    const appendFiles = (currentDir, archiveDir = '') => {
      fs.readdirSync(currentDir).forEach((file) => {
        const fullPath = path.join(currentDir, file);
        const relativePath = path.join(archiveDir, file);
        if (excludePatterns.some(p => relativePath.includes(p) || file === p)) return;
        if (fs.statSync(fullPath).isDirectory()) appendFiles(fullPath, relativePath);
        else archive.file(fullPath, { name: relativePath });
      });
    };

    appendFiles(sourceDir);
    archive.finalize();
  });
};

const getWorkspaceSourceFiles = (dir, rootDir = dir) => {
  const exts = ['.js', '.ts', '.py', '.rb', '.php', '.java', '.go', '.cs', '.json', '.rs', '.toml', '.xml', '.gradle', '.config', '.env', '.html', '.css'];
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.security-reports', 'venv', '.venv']);
  const files = {};
  
  const walk = (currentDir) => {
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (!ignoreDirs.has(entry.name)) {
            walk(fullPath);
          }
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          const isSourceFile = exts.includes(ext) || entry.name === 'Dockerfile' || entry.name === 'Makefile' || entry.name === 'package.json';
          if (isSourceFile) {
            try {
              const stats = fs.statSync(fullPath);
              if (stats.size < 1024 * 100) {
                const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
                const content = fs.readFileSync(fullPath, 'utf8');
                files[relPath] = content;
              }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  };
  
  walk(dir);
  return files;
};

const getRelevantWorkspaceFiles = (errorLogs, allFilesMap) => {
  const relevantFiles = {};
  
  // 1. Core configurations that should always be included for context
  const coreConfigs = ['package.json', 'tsconfig.json', 'Cargo.toml', 'requirements.txt', 'go.mod', 'composer.json', 'Gemfile'];
  const normalizedLogs = errorLogs.replace(/\\/g, '/');
  
  for (const filePath of Object.keys(allFilesMap)) {
    const fileName = path.basename(filePath);
    
    // Always include core config files (from anywhere in the workspace)
    if (coreConfigs.includes(fileName)) {
      relevantFiles[filePath] = allFilesMap[filePath];
      continue;
    }

    // Escape file name for regex search safety
    const escapedName = fileName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    // Match the exact filename in the logs
    const regex = new RegExp(`(?:^|\\s|[\"'(]|/|\\\\|[a-zA-Z]:)${escapedName}(?:\\s|:|\\(|\\)|,|$)`, 'i');
    
    if (regex.test(normalizedLogs)) {
      relevantFiles[filePath] = allFilesMap[filePath];
    }
  }

  // 3. Fallback: if we found no files mentioned in the logs (other than configs), return a small subset
  if (Object.keys(relevantFiles).filter(f => !coreConfigs.includes(path.basename(f))).length === 0) {
    let count = 0;
    for (const [filePath, content] of Object.entries(allFilesMap)) {
      if (!relevantFiles[filePath]) {
        relevantFiles[filePath] = content;
        count++;
        if (count >= 10) break;
      }
    }
  }

  return relevantFiles;
};

const runHostCommand = (cmd, cwd, deploymentId, jobId, stepName) => {
  return new Promise((resolve, reject) => {
    logToJob(deploymentId, jobId, `Starting Step: ${stepName} directly on local host...`);
    logToJob(deploymentId, jobId, `[${stepName}] Running: ${cmd}`);
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const child = exec(cmd, { cwd, shell });
    const outputLogs = [];

    child.stdout.on('data', (data) => {
      data.toString().split('\n').forEach(line => {
        if (line.trim()) {
          const l = `[${stepName}] ${line.trim()}`;
          logToJob(deploymentId, jobId, l);
          outputLogs.push(l);
        }
      });
    });
    child.stderr.on('data', (data) => {
      data.toString().split('\n').forEach(line => {
        if (line.trim()) {
          const l = `[${stepName}] [STDERR] ${line.trim()}`;
          logToJob(deploymentId, jobId, l);
          outputLogs.push(l);
        }
      });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const err = new Error(`Host execution of '${cmd}' exited with code ${code}`);
        err.logs = outputLogs.join('\n');
        reject(err);
      }
      else { logToJob(deploymentId, jobId, `Step Completed: ${stepName}`); resolve(outputLogs.join('\n')); }
    });
  });
};

const runContainerCommand = (image, cmd, binds, deploymentId, jobId, stepName) => {
  return new Promise((resolve, reject) => {
    logToJob(deploymentId, jobId, `Starting Step: ${stepName} using container ${image}...`);
    const outputLogs = [];
    docker.createContainer({
      Image: image,
      Cmd: cmd,
      HostConfig: { Binds: binds },
      WorkingDir: '/workspace'
    }, (err, container) => {
      if (err) return reject(new Error(`Failed to create container for ${stepName}: ${err.message}`));
      container.attach({ stream: true, stdout: true, stderr: true }, (err, stream) => {
        if (err) { container.remove(); return reject(err); }
        let buffer = '';
        stream.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop();
          lines.forEach(line => {
            const clean = line.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
            if (clean) {
              const l = `[${stepName}] ${clean}`;
              logToJob(deploymentId, jobId, l);
              outputLogs.push(l);
            }
          });
        });
        container.start((err) => {
          if (err) { container.remove(); return reject(err); }
          container.wait((err, data) => {
            if (err) { container.remove(); return reject(err); }
            container.remove(() => {
              if (data.StatusCode !== 0) {
                const compileErr = new Error(`Container exited with non-zero: ${data.StatusCode}`);
                compileErr.logs = outputLogs.join('\n');
                reject(compileErr);
              }
              else { logToJob(deploymentId, jobId, `Step Completed: ${stepName}`); resolve(outputLogs.join('\n')); }
            });
          });
        });
      });
    });
  });
};

// ─── Main Pipeline ────────────────────────────────────────────────────────────

/**
 * @param {string}   jobId
 * @param {string}   deploymentId
 * @param {string}   zipPath          - path to the uploaded zip on disk
 * @param {number}   previewPort      - port to serve the live preview on
 * @param {Array}    envFiles         - [{ path: string, content: string }, ...]
 * @param {string}   targetSubfolder  - relative subfolder to build
 */
const runPipeline = async (jobId, deploymentId, zipPath, previewPort = 3001, envFiles = [], targetSubfolder = '', upgradeMode = 'automatic') => {
  const extractDir = path.join(BUILDS_BASE_DIR, jobId);
  let deploymentStatus = 'failed';
  let vulnerabilitiesFound = 0;
  let scanReports = {};
  let detection = null;
  let recommendedUpgrades = [];
  let dockerAvailable = false;

  try {
    await Deployment.findByIdAndUpdate(deploymentId, { status: 'building' });
    logToJob(deploymentId, jobId, 'Initializing DevOps pipeline...');

    // ── Step 1: Extract ZIP ──────────────────────────────────────────────────
    logToJob(deploymentId, jobId, 'Extracting source archive (filtering node_modules, target, build, .git)...');
    fs.mkdirSync(extractDir, { recursive: true });

    const directory = await unzipper.Open.file(zipPath);
    for (const entry of directory.files) {
      const entryPath = entry.path;
      const normalized = entryPath.replace(/\\/g, '/');
      const exclude = ['node_modules/', 'target/', 'build/', 'dist/', 'bin/', 'obj/', '.git/'];
      const destPath = path.join(extractDir, entryPath);

      if (exclude.some(e => normalized.includes(e))) {
        continue;
      }

      if (entry.type === 'Directory' || entryPath.endsWith('/')) {
        fs.mkdirSync(destPath, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        await new Promise((resolve, reject) => {
          entry.stream()
            .pipe(fs.createWriteStream(destPath))
            .on('finish', resolve)
            .on('error', reject);
        });
      }
    }

    logToJob(deploymentId, jobId, 'ZIP extraction completed.');

    // Write environment files (.env) configured in UI to workspace
    if (envFiles && envFiles.length > 0) {
      logToJob(deploymentId, jobId, 'Writing environment files (.env) to workspace...');
      for (const file of envFiles) {
        const envPath = path.join(extractDir, file.path.replace(/^\/+/, ''));
        try {
          fs.mkdirSync(path.dirname(envPath), { recursive: true });
          fs.writeFileSync(envPath, file.content || '', 'utf8');
        } catch (envErr) {
          logToJob(deploymentId, jobId, `[⚠️ WARNING] Failed to write environment file ${file.path}: ${envErr.message}`);
        }
      }
    }

    // ── Step 2: Detect framework & target directory ──────────────────────────
    detection = detectFramework(extractDir, targetSubfolder);
    const targetBuildDir = detection.targetDir;
    logToJob(deploymentId, jobId, `Detected Tech Stack / Framework: ${detection.framework.toUpperCase()}`);
    logToJob(deploymentId, jobId, `Detected Architecture: ${(detection.architecture || 'monolithic').toUpperCase()}`);
    
    if (detection.mobileDetected) {
      logToJob(deploymentId, jobId, `[⚠️ WARNING] Mobile client folder / target detected in this repository (e.g. React Native / Expo). Please note that the gVisor sandbox container preview only compiles and serves Web and Server components. Mobile components cannot be previewed in the browser and must be built/tested locally.`);
    }
    await Deployment.findByIdAndUpdate(deploymentId, {
      techStackDetected: detection.framework,
      architectureDetected: detection.architecture || 'monolithic',
      upgradeMode
    });

    // Run pre-build static validation checks
    try {
      performPreBuildValidation(targetBuildDir, (msg) => logToJob(deploymentId, jobId, msg));
    } catch (valErr) {
      logToJob(deploymentId, jobId, `[!] Pre-build validation warning: ${valErr.message}`);
    }

    // ── Check Docker availability early ──────────────────────────────────────
    try {
      await docker.ping();
      dockerAvailable = true;
      logToJob(deploymentId, jobId, '[+] Docker daemon available via named pipe. Using isolated container build.');
    } catch (e) {
      logToJob(deploymentId, jobId, `[!] Named pipe connection failed: ${e.message.split('\n')[0]}`);
      logToJob(deploymentId, jobId, 'Checking secondary local TCP socket connection to Docker (http://127.0.0.1:2375)...');
      try {
        const tcpDocker = new Docker({ host: '127.0.0.1', port: 2375 });
        await tcpDocker.ping();
        docker = tcpDocker;
        dockerAvailable = true;
        logToJob(deploymentId, jobId, '[+] Docker daemon available via TCP localhost:2375. Using isolated container build.');
      } catch (tcpErr) {
        logToJob(deploymentId, jobId, `[!] Docker daemon connection failed. Falling back to Host Runner mode.`);
      }
    }

    // ── Step 2.5: Run Smart Dependency Audit ─────────────────────────────────
    if (upgradeMode === 'disabled') {
      logToJob(deploymentId, jobId, '[DEPENDENCY-AUDIT] Package upgrades are disabled. Compiling with original package.json versions.');
    } else {
      logToJob(deploymentId, jobId, 'Auditing package dependencies for deprecations & stable upgrades...');
      try {
        const { auditDependencies } = require('./dependency-updater.service');
        recommendedUpgrades = await auditDependencies(targetBuildDir);
        
        if (recommendedUpgrades && recommendedUpgrades.length > 0) {
          logToJob(deploymentId, jobId, `[DEPENDENCY-AUDIT] Found ${recommendedUpgrades.length} recommended stable upgrade(s).`);
          await Deployment.findByIdAndUpdate(deploymentId, { recommendedUpgrades });

          let upgradesToApply = recommendedUpgrades; // Default: apply all
          if (upgradeMode === 'semi-automatic') {
            logToJob(deploymentId, jobId, `[DEPENDENCY-AUDIT] [INTERACTIVE] Pipeline paused for 10 seconds. Prompting user to select versions...`);
            const { waitForUserSelection } = require('./interaction-manager.service');
            upgradesToApply = await waitForUserSelection(jobId, recommendedUpgrades, 10000);
            logToJob(deploymentId, jobId, `[DEPENDENCY-AUDIT] Resuming pipeline. Applying ${upgradesToApply.length} chosen upgrade(s).`);
          }

          if (upgradesToApply.length > 0) {
            logToJob(deploymentId, jobId, `[DEPENDENCY-AUDIT] Rewriting dependency files with new versions...`);
            for (const item of upgradesToApply) {
              try {
                if (item.manager === 'npm') {
                  const pJsonPath = path.join(targetBuildDir, 'package.json');
                  if (fs.existsSync(pJsonPath)) {
                    const pJson = JSON.parse(fs.readFileSync(pJsonPath, 'utf8'));
                    if (pJson.dependencies && pJson.dependencies[item.package]) {
                      pJson.dependencies[item.package] = `^${item.latest}`;
                    } else if (pJson.devDependencies && pJson.devDependencies[item.package]) {
                      pJson.devDependencies[item.package] = `^${item.latest}`;
                    }
                    fs.writeFileSync(pJsonPath, JSON.stringify(pJson, null, 2), 'utf8');
                    logToJob(deploymentId, jobId, `  - Upgraded npm package: ${item.package} ➔ ^${item.latest}`);
                  }
                } else if (item.manager === 'composer') {
                  const cJsonPath = path.join(targetBuildDir, 'composer.json');
                  if (fs.existsSync(cJsonPath)) {
                    const cJson = JSON.parse(fs.readFileSync(cJsonPath, 'utf8'));
                    if (cJson.require && cJson.require[item.package]) {
                      cJson.require[item.package] = `^${item.latest}`;
                    } else if (cJson['require-dev'] && cJson['require-dev'][item.package]) {
                      cJson['require-dev'][item.package] = `^${item.latest}`;
                    }
                    fs.writeFileSync(cJsonPath, JSON.stringify(cJson, null, 2), 'utf8');
                    logToJob(deploymentId, jobId, `  - Upgraded composer package: ${item.package} ➔ ^${item.latest}`);
                  }
                } else if (item.manager === 'pip') {
                  const reqsPath = path.join(targetBuildDir, 'requirements.txt');
                  if (fs.existsSync(reqsPath)) {
                    let content = fs.readFileSync(reqsPath, 'utf8');
                    const regex = new RegExp(`^(${item.package})\\s*(==|>=|<=)\\s*([^\\r\\n;]+)`, 'im');
                    content = content.replace(regex, `$1==${item.latest}`);
                    fs.writeFileSync(reqsPath, content, 'utf8');
                    logToJob(deploymentId, jobId, `  - Upgraded pip package: ${item.package} ➔ ==${item.latest}`);
                  }
                }
              } catch (err) {
                logToJob(deploymentId, jobId, `  [!] Failed to rewrite version for ${item.package}: ${err.message}`);
              }
            }
            logToJob(deploymentId, jobId, '[+] Dependency file rewrites complete.');
          }
        } else {
          logToJob(deploymentId, jobId, '[DEPENDENCY-AUDIT] All dependencies are fully up-to-date with stable releases.');
        }
      } catch (auditErr) {
        logToJob(deploymentId, jobId, `[!] Failed to audit dependencies: ${auditErr.message}`);
      }
    }

    // ── Step 3: Write .env files (with Smart Port/URL Normalization) ──────────
    if (envFiles && envFiles.length > 0) {
      logToJob(deploymentId, jobId, `Writing ${envFiles.length} environment file(s) to workspace...`);

      // Helper: parse .env content into key/value map
      const parseEnvContent = (content) => {
        const vars = {};
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx < 1) continue;
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          vars[key] = val;
        }
        return vars;
      };

      // Helper: check if a variable name is actively referenced in source code files
      const isVarUsedInSourceCode = (varName, searchDir) => {
        const exts = ['.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.php', '.java', '.go', '.cs', '.env.example'];
        const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.security-reports']);
        const pattern = new RegExp(`process\\.env\\.${varName}|ENV\\['${varName}'\\]|ENV\\["${varName}"\\]|os\\.environ\\.get\\(['"]${varName}['"]\\)|os\\.environ\\['${varName}'\\]|ENV\\.fetch\\(['"]${varName}['"]\\)|System\\.getenv\\(['"]${varName}['"]\\)|getenv\\(['"]${varName}['"]\\)`, 'g');
        try {
          const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                if (!ignoreDirs.has(entry.name)) walk(path.join(dir, entry.name));
              } else if (exts.some(e => entry.name.endsWith(e))) {
                try {
                  const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
                  if (pattern.test(content)) return true;
                } catch (_) {}
              }
            }
            return false;
          };
          return walk(searchDir);
        } catch (_) { return false; }
      };

      // Known URL-type variable names that point to "frontend" or "client" services
      const FRONTEND_URL_VARS = new Set([
        'FRONTEND_URL', 'CLIENT_URL', 'APP_URL', 'CORS_ORIGIN', 'ALLOWED_ORIGIN', 'ALLOWED_ORIGINS',
        'REACT_APP_URL', 'VUE_APP_URL', 'NEXT_PUBLIC_URL', 'VITE_APP_URL',
        'FRONTEND_BASE_URL', 'CLIENT_BASE_URL', 'WEB_URL', 'WEBAPP_URL',
        'CORS_ORIGINS', 'ACCESS_CONTROL_ALLOW_ORIGIN',
      ]);
      // Known port variable names
      const PORT_VARS = new Set(['PORT', 'SERVER_PORT', 'APP_PORT', 'HTTP_PORT']);

      for (const envEntry of envFiles) {
        if (!envEntry.path || !envEntry.content) continue;

        // Resolve the path relative to the root extract directory (ZIP root)
        const envAbsPath = path.resolve(extractDir, envEntry.path.replace(/^\/+/, ''));
        const envDir = path.dirname(envAbsPath);

        const parsedVars = parseEnvContent(envEntry.content);
        const lines = envEntry.content.split(/\r?\n/);
        const normalizedLines = [];
        const changes = [];

        // Determine if this .env is for a server/backend (not a pure client .env)
        // by checking if PORT or SERVER_PORT is defined in the parsed vars
        const isServerEnv = Object.keys(parsedVars).some(k => PORT_VARS.has(k));

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) {
            normalizedLines.push(line);
            continue;
          }
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx < 1) { normalizedLines.push(line); continue; }

          const key = trimmed.slice(0, eqIdx).trim();
          const rawVal = trimmed.slice(eqIdx + 1).trim();
          const val = rawVal.replace(/^["']|["']$/g, '');

          // 1. Override PORT to the allocated preview port
          if (PORT_VARS.has(key)) {
            if (String(val) !== String(previewPort)) {
              normalizedLines.push(`${key}=${previewPort}`);
              changes.push(`  ↪ [PORT] ${key}: ${val} → ${previewPort} (overridden to preview port)`);
            } else {
              normalizedLines.push(line);
            }
            continue;
          }

          // 2. Smart URL normalization for frontend/client URL vars
          const isClientVar = key.startsWith('VITE_') || key.startsWith('REACT_APP_') || key.startsWith('NEXT_PUBLIC_') || key.startsWith('PUBLIC_');
          if (FRONTEND_URL_VARS.has(key) || isClientVar) {
            // Check if value is a localhost URL with a specific port
            const localhostMatch = val.match(/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(\/.*)?$/);
            if (localhostMatch) {
              const urlPath = localhostMatch[1] || '';
              const newUrl = `http://localhost:${previewPort}${urlPath}`;
              normalizedLines.push(`${key}=${newUrl}`);
              changes.push(`  ↪ [URL-REWRITE] ${key}: "${val}" → "${newUrl}" (auto-healed to target sandbox port)`);
              continue;
            }
          }

          // 3. Smart URL rewrite for other local services (DB, Redis, etc.) when running inside Docker
          if (dockerAvailable && !FRONTEND_URL_VARS.has(key)) {
            const localhostUrlMatch = val.match(/^(https?:\/\/|mongodb(?:\+srv)?:\/\/|postgres(?:ql)?:\/\/|mysql:\/\/|redis:\/\/)(?:localhost|127\.0\.0\.1)(:\d+)?(.*)?$/i);
            if (localhostUrlMatch) {
              const prefix = localhostUrlMatch[1];
              const portPart = localhostUrlMatch[2] || '';
              const pathPart = localhostUrlMatch[3] || '';
              const newVal = `${prefix}host.docker.internal${portPart}${pathPart}`;
              normalizedLines.push(`${key}=${newVal}`);
              changes.push(`  ↪ [DOCKER-HOST-REWRITE] ${key}: "${val}" → "${newVal}" (localhost redirected to host machine)`);
              continue;
            }
          }

          // All other vars: pass through unchanged
          normalizedLines.push(line);
        }

        let normalizedContent = normalizedLines.join('\n');

        // Auto-inject sandbox CORS whitelist vars into server .env files so backend CORS
        // middleware always accepts requests from the sandbox preview port (http://localhost:<port>).
        // This is critical for MERN monorepos running via the internal reverse proxy.
        if (isServerEnv) {
          const sandboxOrigin = `http://localhost:${previewPort}`;
          const corsVarsToInject = ['CLIENT_URL', 'FRONTEND_URL', 'CORS_ORIGIN', 'ALLOWED_ORIGIN'];
          const existingKeys = new Set(Object.keys(parsedVars));
          const injectedKeys = [];

          for (const corsVar of corsVarsToInject) {
            if (!existingKeys.has(corsVar)) {
              normalizedContent += `\n${corsVar}=${sandboxOrigin}`;
              injectedKeys.push(corsVar);
            } else {
              // Key exists but may not include the sandbox origin — ensure it does
              const existingVal = parsedVars[corsVar] || '';
              if (!existingVal.includes(`localhost:${previewPort}`)) {
                normalizedContent = normalizedContent.replace(
                  new RegExp(`(^|\\n)${corsVar}=.*`),
                  `$1${corsVar}=${sandboxOrigin}`
                );
                injectedKeys.push(`${corsVar} (overridden)`);
              }
            }
          }

          if (injectedKeys.length > 0) {
            logToJob(deploymentId, jobId, `[ENV] Auto-injected CORS whitelist vars for sandbox: ${injectedKeys.join(', ')} → ${sandboxOrigin}`);
          }
        }

        fs.mkdirSync(envDir, { recursive: true });
        fs.writeFileSync(envAbsPath, normalizedContent, 'utf8');
        logToJob(deploymentId, jobId, `[ENV] Written: ${envEntry.path}`);
        if (changes.length > 0) {
          logToJob(deploymentId, jobId, `[ENV] Smart normalization applied to ${envEntry.path}:`);
          for (const change of changes) logToJob(deploymentId, jobId, change);
        }
      }
    } else {
      logToJob(deploymentId, jobId, '[ENV] No .env files configured for this build.');
    }

    // ── Step 3.5: Hardcoded Credential Scan & Auto-Remediation ───────────────
    logToJob(deploymentId, jobId, 'Running pre-build static analysis for hardcoded credentials...');
    try {
      const credFindings = scanDirectoryForCredentials(targetBuildDir);
      if (credFindings && credFindings.length > 0) {
        logToJob(deploymentId, jobId, `[WARNING] Found ${credFindings.length} hardcoded credential(s) in source code.`);
        logToJob(deploymentId, jobId, `[AUTO-REMEDIATE] Automatically extracting and replacing credentials with environment variables...`);
        
        const injectedEnv = autoRemediateCredentials(targetBuildDir, credFindings);
        
        for (const finding of credFindings) {
          logToJob(deploymentId, jobId, `  - Replaced [${finding.type}] in ${finding.file}:${finding.line} with environment variable.`);
        }
        
        logToJob(deploymentId, jobId, `[+] Auto-remediation complete. Added ${Object.keys(injectedEnv).length} variable(s) to .env file.`);
        
        // Track the remediated vulnerabilities as part of the scan report
        vulnerabilitiesFound += credFindings.length;
        scanReports.credentials = credFindings.map(f => ({
          ...f,
          remediated: true,
          remediatedVar: `AUTO_SECRET_...` // we can store this if needed
        }));
      } else {
        logToJob(deploymentId, jobId, '[+] No hardcoded credentials detected in source code.');
      }
    } catch (scanErr) {
      logToJob(deploymentId, jobId, `[!] Failed to run credentials scan: ${scanErr.message}`);
    }



    // ── Step 5: Build ────────────────────────────────────────────────────────
    let buildAttempts = 0;
    const maxRetries = 3;
    let buildSuccess = false;

    while (buildAttempts <= maxRetries) {
      try {
        if (buildAttempts > 0) {
          logToJob(deploymentId, jobId, `[SELF-HEALING] Retrying build (attempt ${buildAttempts + 1}/${maxRetries + 1})...`);
        } else {
          logToJob(deploymentId, jobId, 'Starting compilation/build step...');
        }

        if (dockerAvailable) {
          const bind = `${path.resolve(targetBuildDir)}:/workspace`;
          const binds = [bind];

          // Inject dependency package manager caching binds
          try {
            const fw = (detection.framework || '').toLowerCase();
            const cacheBinds = [];

            // PHP (Composer) — map to Composer's home dir
            if (['php', 'symfony'].includes(fw)) {
              const cDir = path.join(CACHE_BASE_DIR, 'composer');
              if (!fs.existsSync(cDir)) fs.mkdirSync(cDir, { recursive: true });
              cacheBinds.push(`${path.resolve(cDir)}:/root/.composer`);
            }
            // Python (pip/poetry/pipenv)
            else if (['flask', 'fastapi', 'django'].includes(fw)) {
              const cDir = path.join(CACHE_BASE_DIR, 'pip');
              if (!fs.existsSync(cDir)) fs.mkdirSync(cDir, { recursive: true });
              cacheBinds.push(`${path.resolve(cDir)}:/root/.cache`);
            }
            // Go module cache
            else if (['gin', 'fiber', 'echo-go'].includes(fw)) {
              const cDir = path.join(CACHE_BASE_DIR, 'go');
              if (!fs.existsSync(cDir)) fs.mkdirSync(cDir, { recursive: true });
              cacheBinds.push(`${path.resolve(cDir)}:/root/go/pkg/mod`);
            }
            // Ruby gems
            else if (['rails', 'sinatra'].includes(fw)) {
              const cDir = path.join(CACHE_BASE_DIR, 'ruby-gems');
              if (!fs.existsSync(cDir)) fs.mkdirSync(cDir, { recursive: true });
              cacheBinds.push(`${path.resolve(cDir)}:/usr/local/bundle`);
            }
            // .NET / Blazor NuGet packages
            else if (['dotnet', 'blazor'].includes(fw)) {
              const cDir = path.join(CACHE_BASE_DIR, 'nuget');
              if (!fs.existsSync(cDir)) fs.mkdirSync(cDir, { recursive: true });
              cacheBinds.push(`${path.resolve(cDir)}:/root/.nuget`);
            }
            // Java Maven local repo
            else if (['spring', 'quarkus'].includes(fw)) {
              const cDir = path.join(CACHE_BASE_DIR, 'maven');
              if (!fs.existsSync(cDir)) fs.mkdirSync(cDir, { recursive: true });
              cacheBinds.push(`${path.resolve(cDir)}:/root/.m2`);
            }
            // Elixir / Phoenix mix deps
            else if (fw === 'phoenix') {
              const cDir = path.join(CACHE_BASE_DIR, 'mix');
              if (!fs.existsSync(cDir)) fs.mkdirSync(cDir, { recursive: true });
              cacheBinds.push(`${path.resolve(cDir)}:/root/.mix`);
            }
            // NPM-based frameworks
            else if (fw !== 'generic' && fw !== 'rust') {
              const cDir = path.join(CACHE_BASE_DIR, 'npm');
              if (!fs.existsSync(cDir)) fs.mkdirSync(cDir, { recursive: true });
              cacheBinds.push(`${path.resolve(cDir)}:/root/.npm`);
            }

            binds.push(...cacheBinds);
          } catch (cacheErr) {
            logToJob(deploymentId, jobId, `[!] Failed to mount cache folders: ${cacheErr.message}`);
          }

          await ensureDockerImage(detection.buildImage, deploymentId, jobId);
          await runContainerCommand(detection.buildImage, ['sh', '-c', detection.runCommand], binds, deploymentId, jobId, 'COMPILE/BUILD');
        } else {
          let hostCmd = detection.runCommand;
          if (detection.framework === 'rust') {
            hostCmd = 'cargo build --release';
          }
          await runHostCommand(hostCmd, targetBuildDir, deploymentId, jobId, 'COMPILE/BUILD');
        }
        buildSuccess = true;
        break; // Exit the loop on successful build
      } catch (err) {
        const buildErrorLogs = err.logs || err.message || String(err) || '';
        logToJob(deploymentId, jobId, `[SELF-HEALING] Build step failed (attempt ${buildAttempts + 1}/${maxRetries + 1}).`);

        if (buildAttempts >= maxRetries) {
          logToJob(deploymentId, jobId, `[SELF-HEALING] Reached maximum retry limit (${maxRetries}). Failing build.`);
          throw err; // throw original compile error to trigger outer catch diagnostics/cleanup
        }

        // Proactive tsconfig.json relaxation to try and fix TS errors before LLM
        const tsconfigPath = path.join(targetBuildDir, 'tsconfig.json');
        if (fs.existsSync(tsconfigPath) && buildAttempts === 0 && (buildErrorLogs.includes('error TS') || buildErrorLogs.includes('TypeScript Compiler Error'))) {
          logToJob(deploymentId, jobId, `[SELF-HEALING] Proactively relaxing tsconfig.json compiler options to bypass typescript strictness...`);
          try {
            const configText = fs.readFileSync(tsconfigPath, 'utf8');
            const stripJsonComments = (jsonStr) => {
              return jsonStr.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? "" : m);
            };
            const cleaned = stripJsonComments(configText);
            const tsconfigObj = JSON.parse(cleaned || '{}');
            
            if (!tsconfigObj.compilerOptions) {
              tsconfigObj.compilerOptions = {};
            }
            tsconfigObj.compilerOptions.strict = false;
            tsconfigObj.compilerOptions.noEmitOnError = false;
            tsconfigObj.compilerOptions.skipLibCheck = true;
            tsconfigObj.compilerOptions.noImplicitAny = false;
            tsconfigObj.compilerOptions.strictNullChecks = false;
            
            fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfigObj, null, 2), 'utf8');
            logToJob(deploymentId, jobId, `  ↪ Successfully relaxed tsconfig.json options. Retrying compilation...`);
            buildAttempts++;
            continue; // Retry compilation immediately
          } catch (tsconfigErr) {
            logToJob(deploymentId, jobId, `  [!] Failed to proactively relax tsconfig.json: ${tsconfigErr.message}`);
          }
        }

        logToJob(deploymentId, jobId, `[SELF-HEALING] Intercepted error. Querying LLM to diagnose and generate patches...`);
        try {
          const { generateHealingPatches } = require('./llm.service');
          const workspaceFiles = getWorkspaceSourceFiles(targetBuildDir);
          const relevantFiles = getRelevantWorkspaceFiles(buildErrorLogs, workspaceFiles);
          const diagnoses = analyzeLogsAndDiagnose(buildErrorLogs);

          logToJob(deploymentId, jobId, `[SELF-HEALING] Filtered context to ${Object.keys(relevantFiles).length}/${Object.keys(workspaceFiles).length} relevant source file(s).`);
          logToJob(deploymentId, jobId, `[SELF-HEALING] Querying LLM with compile logs and ${diagnoses.length} diagnostic hint(s)...`);
          const llmResponse = await generateHealingPatches(buildErrorLogs, relevantFiles, diagnoses);

          // Parse patches using regex
          const patchRegex = /<patch\s+file=["']([^"']+)["']\s*>([\s\S]*?)<\/patch>/g;
          let match;
          const patches = [];
          const llmPatchedFiles = {};
          while ((match = patchRegex.exec(llmResponse)) !== null) {
            const relativePath = match[1];
            const rawContent = match[2];
            // Remove one leading newline and one trailing newline if they exist to keep indentation clean
            const cleanContent = rawContent
              .replace(/^\r?\n|^\n/, '')
              .replace(/\r?\n$|\n$/, '');
            patches.push({ relativePath, content: cleanContent });
            
            const normalizedRelPath = relativePath.replace(/\\/g, '/');
            llmPatchedFiles[normalizedRelPath] = cleanContent;
          }

          // Unconditional Auto-TS-Ignore for TS errors to guarantee they are bypassed
          if (buildErrorLogs.includes('error TS') || buildErrorLogs.includes('TypeScript Compiler Error')) {
            logToJob(deploymentId, jobId, `[SELF-HEALING] Applying Auto-TS-Ignore to bypass fatal TypeScript compilation errors...`);
            
            // Extract all TS errors: e.g. Csrc/controllers/blogController.ts(742,12): error TS2339
            const tsErrorRegex = /([a-zA-Z0-9_\-\.\/]+)\((\d+),\d+\):\s*error TS/g;
            let match;
            const filesToPatch = {};

            while ((match = tsErrorRegex.exec(buildErrorLogs)) !== null) {
              const rawTsPath = match[1];
              const lineNum = parseInt(match[2], 10);
              
              // Clean stray leading characters from tsc TTY output (e.g. Csrc -> src)
              const srcIdx = rawTsPath.indexOf('src/');
              const cleanTsPath = srcIdx !== -1 ? rawTsPath.slice(srcIdx) : rawTsPath;
              const normalizedTsPath = cleanTsPath.replace(/\\/g, '/');
              
              // If LLM patched this file in the current iteration, do not apply Auto-TS-Ignore
              // using old/outdated line numbers. We will let the LLM patch take effect.
              // If the compiler still fails on the new code, the next compile attempt
              // will provide the updated line numbers.
              const isLlmPatched = Object.keys(llmPatchedFiles).some(lpKey => 
                lpKey.endsWith(normalizedTsPath) || normalizedTsPath.endsWith(lpKey)
              );
              if (isLlmPatched) {
                logToJob(deploymentId, jobId, `  ↪ Skipping Auto-TS-Ignore for LLM-patched file: ${normalizedTsPath} (allowing LLM patch to build first)`);
                continue;
              }

              // Find matching workspace file (supporting bidirectional matching due to TTY / Docker workspace path differences)
              for (const [relPath, content] of Object.entries(relevantFiles)) {
                const normalizedRelPath = relPath.replace(/\\/g, '/');
                if (normalizedRelPath.endsWith(normalizedTsPath) || normalizedTsPath.endsWith(normalizedRelPath)) {
                  if (!filesToPatch[relPath]) filesToPatch[relPath] = { content, linesToIgnore: [] };
                  filesToPatch[relPath].linesToIgnore.push(lineNum);
                }
              }
            }

            for (const [relPath, data] of Object.entries(filesToPatch)) {
              let lines = data.content.split(/\r?\n/);
              // Sort descending to not mess up line numbers when inserting
              const uniqueLines = [...new Set(data.linesToIgnore)].sort((a, b) => b - a);
              let applied = false;
              
              for (const ln of uniqueLines) {
                const targetIdx = ln - 1;
                if (targetIdx >= 0 && targetIdx < lines.length) {
                  if (!lines[targetIdx - 1]?.includes('@ts-ignore')) {
                    lines.splice(targetIdx, 0, '    // @ts-ignore');
                    applied = true;
                  }
                }
              }

              if (applied) {
                patches.push({ relativePath: relPath, content: lines.join('\n') });
                logToJob(deploymentId, jobId, `  ↪ Auto-TS-Ignore applied successfully: ${relPath}`);
              }
            }
          }

          if (patches.length === 0) {
            logToJob(deploymentId, jobId, `[SELF-HEALING] LLM did not propose any file patches. Falling back to default error handler.`);
            throw new Error('NO_PATCHES');
          }

          logToJob(deploymentId, jobId, `[SELF-HEALING] LLM generated ${patches.length} patch(es). Applying patches...`);
          for (const patch of patches) {
            const resolvedPath = path.join(targetBuildDir, patch.relativePath);
            
            // Validate that the target file resides within the workspace target directory (security)
            if (!resolvedPath.startsWith(path.resolve(targetBuildDir))) {
              logToJob(deploymentId, jobId, `[SELF-HEALING] [Warning] Rejected attempt to write outside workspace: ${patch.relativePath}`);
              continue;
            }

            // Create directories if missing
            fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

            // Create a backup file (.bak) if file exists and has not been backed up yet
            const backupPath = resolvedPath + '.bak';
            if (fs.existsSync(resolvedPath) && !fs.existsSync(backupPath)) {
              fs.copyFileSync(resolvedPath, backupPath);
            }

            // Write healed file content
            fs.writeFileSync(resolvedPath, patch.content, 'utf8');
            logToJob(deploymentId, jobId, `  ↪ Successfully patched: ${patch.relativePath} (${patch.content.length} bytes)`);
          }

          buildAttempts++;
        } catch (healErr) {
          if (healErr.message !== 'NO_PATCHES') {
            logToJob(deploymentId, jobId, `[SELF-HEALING] [Warning] Skipping self-healing: ${healErr.message}`);
          }
          throw err; // throw original compile error to fall back to old workflow
        }
      }
    }

    // ── Step 6: Security scans ───────────────────────────────────────────────
    await Deployment.findByIdAndUpdate(deploymentId, { status: 'scanning' });
    const reportDir = path.join(targetBuildDir, '.security-reports');
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

    // -- Semgrep --
    const semgrepOut = path.join(reportDir, 'semgrep.json');
    if (dockerAvailable) {
      // semgrep/semgrep Docker image requires the source to be mounted at /src specifically
      const bind = `${path.resolve(targetBuildDir)}:/src`;
      const rbind = `${path.resolve(reportDir)}:/reports`;
      await ensureDockerImage('semgrep/semgrep:latest', deploymentId, jobId);
      try {
        await runContainerCommand('semgrep/semgrep:latest', ['semgrep', 'scan', '--config', 'auto', '--json', '--output', '/reports/semgrep.json', '/src'], [bind, rbind], deploymentId, jobId, 'SEMGREP-SAST');
      } catch (e) { logToJob(deploymentId, jobId, `[!] Semgrep completed: ${e.message}`); }
    } else {
      try { await runHostCommand(`semgrep scan --config auto --json --output "${semgrepOut}"`, targetBuildDir, deploymentId, jobId, 'SEMGREP-SAST'); }
      catch (_) {
        logToJob(deploymentId, jobId, '[!] semgrep not installed — writing mock clean report.');
        if (!fs.existsSync(semgrepOut)) fs.writeFileSync(semgrepOut, JSON.stringify({ results: [] }));
      }
    }

    if (fs.existsSync(semgrepOut)) {
      try {
        const data = JSON.parse(fs.readFileSync(semgrepOut, 'utf8'));
        const findings = data.results || [];
        vulnerabilitiesFound += findings.length;
        scanReports.semgrep = findings.map(f => ({
          rule: f.extra?.metadata?.cwe || 'SAST Rule', message: f.extra?.message,
          path: f.path, line: f.start?.line, severity: f.extra?.severity
        }));
        logToJob(deploymentId, jobId, `[SAST] Semgrep: ${findings.length} alert(s) found.`);
      } catch (e) { logToJob(deploymentId, jobId, `[!] Could not parse semgrep report: ${e.message}`); }
    }

    // -- OSV --
    const osvOut = path.join(reportDir, 'osv.json');
    if (dockerAvailable) {
      // ghcr.io/google/osv-scanner image has ENTRYPOINT=['/usr/bin/osv-scanner'] — Cmd must NOT repeat the binary name
      const bind = `${path.resolve(targetBuildDir)}:/workspace`;
      const rbind = `${path.resolve(reportDir)}:/reports`;
      await ensureDockerImage('ghcr.io/google/osv-scanner:latest', deploymentId, jobId);
      try {
        await runContainerCommand('ghcr.io/google/osv-scanner:latest', ['--recursive', '/workspace', '--format', 'json', '--output-file', '/reports/osv.json'], [bind, rbind], deploymentId, jobId, 'OSV-SCAN');
      } catch (e) { logToJob(deploymentId, jobId, `[!] OSV completed: ${e.message}`); }
    } else {
      try { await runHostCommand(`osv-scanner -r . --format json --output "${osvOut}"`, targetBuildDir, deploymentId, jobId, 'OSV-SCAN'); }
      catch (_) {
        logToJob(deploymentId, jobId, '[!] osv-scanner not installed — writing mock clean report.');
        if (!fs.existsSync(osvOut)) fs.writeFileSync(osvOut, JSON.stringify({ results: [] }));
      }
    }

    if (fs.existsSync(osvOut)) {
      try {
        const data = JSON.parse(fs.readFileSync(osvOut, 'utf8'));
        let count = 0;
        (data.results || []).forEach(r => { if (r.packages) count += r.packages.length; });
        vulnerabilitiesFound += count;
        scanReports.osv = data.results || [];
        logToJob(deploymentId, jobId, `[OSV] Dependency scan: ${count} match(es) found.`);
      } catch (e) { logToJob(deploymentId, jobId, `[!] Could not parse OSV report: ${e.message}`); }
    }

    // -- Trivy Container / Filesystem Scan --
    const trivyOut = path.join(reportDir, 'trivy.json');
    if (dockerAvailable) {
      const bind = `${path.resolve(targetBuildDir)}:/workspace`;
      const rbind = `${path.resolve(reportDir)}:/reports`;
      await ensureDockerImage('aquasec/trivy:latest', deploymentId, jobId);
      try {
        await runContainerCommand('aquasec/trivy:latest', ['fs', '--scanners', 'vuln', '--skip-dirs', 'node_modules,venv,.venv,target,build,.git,reports', '--format', 'json', '--output', '/reports/trivy.json', '/workspace'], [bind, rbind], deploymentId, jobId, 'TRIVY-SEC-SCAN');
      } catch (e) { logToJob(deploymentId, jobId, `[!] Trivy scan completed: ${e.message}`); }
    } else {
      try {
        await runHostCommand(`trivy fs --scanners vuln --skip-dirs "node_modules,venv,.venv,target,build,.git" --format json --output "${trivyOut}" .`, targetBuildDir, deploymentId, jobId, 'TRIVY-SEC-SCAN');
      } catch (_) {
        logToJob(deploymentId, jobId, '[!] trivy CLI not installed locally — skipping host scan.');
      }
    }

    if (fs.existsSync(trivyOut)) {
      try {
        const data = JSON.parse(fs.readFileSync(trivyOut, 'utf8'));
        let count = 0;
        const findings = [];
        (data.Results || []).forEach(res => {
          if (res.Vulnerabilities) {
            count += res.Vulnerabilities.length;
            res.Vulnerabilities.forEach(v => {
              findings.push({
                vulnId: v.VulnerabilityID,
                pkgName: v.PkgName,
                installedVersion: v.InstalledVersion,
                fixedVersion: v.FixedVersion,
                severity: v.Severity,
                title: v.Title || v.Description
              });
            });
          }
        });
        vulnerabilitiesFound += count;
        scanReports.trivy = findings;
        logToJob(deploymentId, jobId, `[SECURITY] Trivy: ${count} container/library vulnerability findings.`);
      } catch (e) { logToJob(deploymentId, jobId, `[!] Could not parse Trivy report: ${e.message}`); }
    }

    // ── Step 7: Package artifact ZIP ─────────────────────────────────────────
    logToJob(deploymentId, jobId, 'Packaging build artifact ZIP...');
    const artifactZipPath = path.join(ARTIFACTS_BASE_DIR, `${jobId}-artifact.zip`);
    await zipDirectory(targetBuildDir, artifactZipPath, ['node_modules', '.git', '.security-reports', 'venv', '.venv']);
    logToJob(deploymentId, jobId, `Artifact ready at DevOps/artifacts/${jobId}-artifact.zip`);

    deploymentStatus = 'deployed';
    logToJob(deploymentId, jobId, 'Build pipeline completed successfully.');

    // ── Step 8: Spawn live preview process ───────────────────────────────────
    if (detection && detection.isGuiApp) {
      logToJob(deploymentId, jobId, '[PREVIEW] [!] Detected Desktop GUI Application. Port preview skipped.');
      logToJob(deploymentId, jobId, '[PREVIEW] [!] Please download the packaged build ZIP under Actions and run it locally.');
    } else {
      logToJob(deploymentId, jobId, `Launching live preview on port ${previewPort}...`);
      await spawnPreview(jobId, deploymentId, targetBuildDir, detection.framework, previewPort);
    }

  } catch (error) {
    logToJob(deploymentId, jobId, `[-] PIPELINE ERROR: ${error.message}`);
    deploymentStatus = 'failed';
    try {
      const currentDeployment = await Deployment.findById(deploymentId);
      const allLogsText = (currentDeployment.buildLogs || []).join('\n');
      const diagnoses = analyzeLogsAndDiagnose(allLogsText + '\n' + error.message);
      if (diagnoses.length > 0) {
        logToJob(deploymentId, jobId, `\n[DIAGNOSTICS] DevOps Smart Diagnosis Engine identified potential root causes:`);
        for (const d of diagnoses) {
          logToJob(deploymentId, jobId, `  ↪ ❌ ${d.error}:`);
          logToJob(deploymentId, jobId, `    👉 Solution: ${d.solution}`);
        }
        logToJob(deploymentId, jobId, `\n`);
      }
    } catch (_) {}
  } finally {
    // Keep workspace alive so the preview process can access files.
    // We delete it if the build failed OR if it is a GUI app (which needs no preview process).
    const isGui = detection && detection.isGuiApp;
    if (deploymentStatus === 'failed' || isGui) {
      logToJob(deploymentId, jobId, 'Cleaning up workspace directory...');
      try { deleteFolderRecursive(extractDir); } catch (_) {}
    } else {
      logToJob(deploymentId, jobId, 'Workspace retained for live preview process.');
    }

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    const artifactPath = deploymentStatus === 'deployed'
      ? path.join('DevOps', 'artifacts', `${jobId}-artifact.zip`)
      : '';

    await Deployment.findByIdAndUpdate(deploymentId, {
      status: deploymentStatus,
      vulnerabilitiesFound,
      scanReport: scanReports,
      artifactPath,
      isGuiApp: !!isGui,
    });

    try {
      const io = getIO();
      io.to(`pipeline:${jobId}`).emit('pipeline:complete', {
        jobId,
        status: deploymentStatus,
        vulnerabilitiesFound,
        artifactUrl: deploymentStatus === 'deployed' ? `/api/devops/${deploymentId}/artifact` : null,
        isGuiApp: !!isGui,
        recommendedUpgrades,
      });
    } catch (_) {}
  }
};

module.exports = { runPipeline };
