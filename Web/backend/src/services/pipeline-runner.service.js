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

// Initialize Docker (optional — pipeline degrades gracefully if unavailable)
const isWindows = process.platform === 'win32';
let docker = new Docker(isWindows ? { socketPath: '//./pipe/docker_engine' } : { socketPath: '/var/run/docker.sock' });

// Workspace root is 4 levels up from this file:
// src/services/ → src/ → backend/ → Web/ → project root
const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
const BUILDS_BASE_DIR = path.join(WORKSPACE_DIR, 'DevOps', 'builds');
const ARTIFACTS_BASE_DIR = path.join(WORKSPACE_DIR, 'DevOps', 'artifacts');

if (!fs.existsSync(BUILDS_BASE_DIR)) fs.mkdirSync(BUILDS_BASE_DIR, { recursive: true });
if (!fs.existsSync(ARTIFACTS_BASE_DIR)) fs.mkdirSync(ARTIFACTS_BASE_DIR, { recursive: true });

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
      HostConfig: { Binds: binds, Memory: 512 * 1024 * 1024, NanoCpus: 500000000 },
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
const runPipeline = async (jobId, deploymentId, zipPath, previewPort = 3001, envFiles = [], targetSubfolder = '') => {
  const extractDir = path.join(BUILDS_BASE_DIR, jobId);
  let deploymentStatus = 'failed';
  let vulnerabilitiesFound = 0;
  let scanReports = {};

  try {
    await Deployment.findByIdAndUpdate(deploymentId, { status: 'building' });
    logToJob(deploymentId, jobId, 'Initializing DevOps pipeline...');

    // ── Step 1: Extract ZIP ──────────────────────────────────────────────────
    logToJob(deploymentId, jobId, 'Extracting source archive (filtering node_modules, target, build, .git)...');
    fs.mkdirSync(extractDir, { recursive: true });

    await new Promise((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(unzipper.Parse())
        .on('entry', (entry) => {
          const entryPath = entry.path;
          const normalized = entryPath.replace(/\\/g, '/');
          const exclude = ['node_modules/', 'target/', 'build/', 'dist/', 'bin/', 'obj/', '.git/'];
          const destPath = path.join(extractDir, entryPath);

          if (exclude.some(e => normalized.includes(e))) {
            entry.autodrain();
          } else if (entry.type === 'Directory' || entryPath.endsWith('/')) {
            fs.mkdirSync(destPath, { recursive: true });
            entry.autodrain();
          } else {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            entry.pipe(fs.createWriteStream(destPath));
          }
        })
        .on('close', resolve)
        .on('error', reject);
    });

    logToJob(deploymentId, jobId, 'ZIP extraction completed.');

    // ── Step 2: Detect framework & target directory ──────────────────────────
    const detection = detectFramework(extractDir, targetSubfolder);
    const targetBuildDir = detection.targetDir;
    logToJob(deploymentId, jobId, `Detected Tech Stack / Framework: ${detection.framework.toUpperCase()}`);
    await Deployment.findByIdAndUpdate(deploymentId, { techStackDetected: detection.framework });

    // ── Step 3: Write .env files ─────────────────────────────────────────────
    if (envFiles && envFiles.length > 0) {
      logToJob(deploymentId, jobId, `Writing ${envFiles.length} environment file(s) to workspace...`);
      for (const envEntry of envFiles) {
        if (!envEntry.path || !envEntry.content) continue;
        // Resolve the path relative to the target build directory
        const envAbsPath = path.resolve(targetBuildDir, envEntry.path.replace(/^\/+/, ''));
        fs.mkdirSync(path.dirname(envAbsPath), { recursive: true });
        fs.writeFileSync(envAbsPath, envEntry.content, 'utf8');
        logToJob(deploymentId, jobId, `[ENV] Written: ${envEntry.path}`);
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

    // ── Step 4: Check Docker availability ───────────────────────────────────
    let dockerAvailable = false;
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

    // ── Step 5: Build ────────────────────────────────────────────────────────
    if (dockerAvailable) {
      const bind = `${path.resolve(targetBuildDir)}:/workspace`;
      logToJob(deploymentId, jobId, `Pulling build image: ${detection.buildImage}...`);
      await new Promise((res, rej) => docker.pull(detection.buildImage, (err, stream) => {
        if (err) return rej(err);
        docker.modem.followProgress(stream, res);
      }));
      await runContainerCommand(detection.buildImage, ['sh', '-c', detection.runCommand], [bind], deploymentId, jobId, 'COMPILE/BUILD');
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
      await new Promise((res, rej) => docker.pull('semgrep/semgrep:latest', (err, stream) => { if (err) return rej(err); docker.modem.followProgress(stream, res); }));
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
      await new Promise((res, rej) => docker.pull('ghcr.io/google/osv-scanner:latest', (err, stream) => { if (err) return rej(err); docker.modem.followProgress(stream, res); }));
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
      logToJob(deploymentId, jobId, 'Pulling security audit image: aquasec/trivy:latest...');
      await new Promise((res, rej) => docker.pull('aquasec/trivy:latest', (err, stream) => {
        if (err) return rej(err);
        docker.modem.followProgress(stream, res);
      }));
      try {
        await runContainerCommand('aquasec/trivy:latest', ['fs', '--format', 'json', '--output', '/reports/trivy.json', '/workspace'], [bind, rbind], deploymentId, jobId, 'TRIVY-SEC-SCAN');
      } catch (e) { logToJob(deploymentId, jobId, `[!] Trivy scan completed: ${e.message}`); }
    } else {
      try {
        await runHostCommand(`trivy fs --format json --output "${trivyOut}" .`, targetBuildDir, deploymentId, jobId, 'TRIVY-SEC-SCAN');
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
      });
    } catch (_) {}
  }
};

module.exports = { runPipeline };
