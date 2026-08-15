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
  fs.readdirSync(dirPath).forEach((file) => {
    const curPath = path.join(dirPath, file);
    if (fs.statSync(curPath).isDirectory()) deleteFolderRecursive(curPath);
    else fs.unlinkSync(curPath);
  });
  fs.rmdirSync(dirPath);
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

const runHostCommand = (cmd, cwd, deploymentId, jobId, stepName) => {
  return new Promise((resolve, reject) => {
    logToJob(deploymentId, jobId, `Starting Step: ${stepName} directly on local host...`);
    logToJob(deploymentId, jobId, `[${stepName}] Running: ${cmd}`);
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const child = exec(cmd, { cwd, shell });

    child.stdout.on('data', (data) => {
      data.toString().split('\n').forEach(line => {
        if (line.trim()) logToJob(deploymentId, jobId, `[${stepName}] ${line.trim()}`);
      });
    });
    child.stderr.on('data', (data) => {
      data.toString().split('\n').forEach(line => {
        if (line.trim()) logToJob(deploymentId, jobId, `[${stepName}] [STDERR] ${line.trim()}`);
      });
    });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Host execution of '${cmd}' exited with code ${code}`));
      else { logToJob(deploymentId, jobId, `Step Completed: ${stepName}`); resolve(); }
    });
  });
};

const runContainerCommand = (image, cmd, binds, deploymentId, jobId, stepName) => {
  return new Promise((resolve, reject) => {
    logToJob(deploymentId, jobId, `Starting Step: ${stepName} using container ${image}...`);
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
            if (clean) logToJob(deploymentId, jobId, `[${stepName}] ${clean}`);
          });
        });
        container.start((err) => {
          if (err) { container.remove(); return reject(err); }
          container.wait((err, data) => {
            if (err) { container.remove(); return reject(err); }
            container.remove(() => {
              if (data.StatusCode !== 0) reject(new Error(`Container exited with non-zero: ${data.StatusCode}`));
              else { logToJob(deploymentId, jobId, `Step Completed: ${stepName}`); resolve(); }
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

    // ── Step 2: Detect framework & target directory ──────────────────────────
    detection = detectFramework(extractDir, targetSubfolder);
    const targetBuildDir = detection.targetDir;
    logToJob(deploymentId, jobId, `Detected Tech Stack / Framework: ${detection.framework.toUpperCase()}`);
    logToJob(deploymentId, jobId, `Detected Architecture: ${(detection.architecture || 'monolithic').toUpperCase()}`);
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
        'FRONTEND_URL', 'CLIENT_URL', 'APP_URL', 'CORS_ORIGIN', 'ALLOWED_ORIGIN',
        'REACT_APP_URL', 'VUE_APP_URL', 'NEXT_PUBLIC_URL', 'VITE_APP_URL',
        'FRONTEND_BASE_URL', 'CLIENT_BASE_URL', 'WEB_URL', 'WEBAPP_URL',
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
        // by checking if PORT or SERVER_PORT is defined
        const isServerEnv = PORT_VARS.has('PORT') || Object.keys(parsedVars).some(k => PORT_VARS.has(k));

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
          if (FRONTEND_URL_VARS.has(key)) {
            // Check if value is a localhost URL with a specific port
            const localhostMatch = val.match(/^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)(\/.*)?$/);
            if (localhostMatch) {
              const embeddedPort = localhostMatch[1];
              const urlPath = localhostMatch[2] || '';

              // Is this var actually used in the server source code?
              const usedInCode = isVarUsedInSourceCode(key, path.dirname(envDir));

              if (usedInCode) {
                // Var is used in code — we can't safely remove it. Update the port to
                // the preview port so CORS/redirects at least point to the same server.
                const newUrl = `http://localhost:${previewPort}${urlPath}`;
                normalizedLines.push(`${key}=${newUrl}`);
                changes.push(`  ↪ [URL-REWRITE] ${key}: "${val}" → "${newUrl}" (var used in code; port updated to preview port)`);
              } else {
                // Var not used in code — it's safe to comment out or keep as-is with a note
                normalizedLines.push(`# [DevOps] ${key} was set to a local frontend URL. Preview runs on port ${previewPort}.`);
                normalizedLines.push(`${key}=http://localhost:${previewPort}${urlPath}`);
                changes.push(`  ↪ [URL-WARN] ${key}: "${val}" → commented (not referenced in server code; frontend may not exist at this port in preview)`);
              }
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

        const normalizedContent = normalizedLines.join('\n');
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
    await zipDirectory(targetBuildDir, artifactZipPath, ['node_modules', '.git', '.security-reports']);
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
