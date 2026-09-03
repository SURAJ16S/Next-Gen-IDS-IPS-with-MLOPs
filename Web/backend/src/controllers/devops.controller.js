const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const Deployment = require('../models/Deployment');
const DevOpsChat = require('../models/DevOpsChat');
const FixtureReview = require('../models/FixtureReview');
const upload = require('../middleware/upload.middleware');
const { runPipeline } = require('../services/pipeline-runner.service');
const { suggestPort, stopPreview, getRunningPreviews } = require('../services/process-manager.service');

const cleanDockerOutput = (rawBuffer) => {
  if (!Buffer.isBuffer(rawBuffer)) {
    rawBuffer = Buffer.from(rawBuffer);
  }
  let offset = 0;
  let cleanText = '';
  
  while (offset < rawBuffer.length) {
    if (offset + 8 <= rawBuffer.length) {
      const type = rawBuffer[offset];
      if (type === 1 || type === 2) {
        const size = rawBuffer.readUInt32BE(offset + 4);
        if (size > 0 && offset + 8 + size <= rawBuffer.length) {
          cleanText += rawBuffer.toString('utf8', offset + 8, offset + 8 + size);
          offset += 8 + size;
          continue;
        }
      }
    }
    cleanText += rawBuffer.toString('utf8', offset, offset + 1);
    offset += 1;
  }
  return cleanText;
};

// ─── Existing handlers ────────────────────────────────────────────────────────

const getDeployments = async (req, res) => {
  try {
    const query = {
      $or: [
        { deployedBy: req.user._id },
        {
          deploymentType: 'github',
          collaborators: req.user.githubUsername || '__NO_USERNAME__',
          'githubPermissions.allowCollaboratorVisibility': { $ne: false }
        }
      ]
    };

    const deployments = await Deployment.find(query, '-envFiles.content -buildLogs')
      .populate('deployedBy', 'firstName lastName email role')
      .sort({ createdAt: -1 });
    res.json(deployments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createDeployment = async (req, res) => {
  try {
    const { getThresholds } = require('../utils/thresholds');
    const threshold = await getThresholds('devops');
    const userBuildCount = await Deployment.countDocuments({ deployedBy: req.user._id });
    if (userBuildCount >= threshold.maxBuildsPerUser) {
      return res.status(403).json({ message: `Max builds limit of ${threshold.maxBuildsPerUser} reached. Please delete old builds or contact your administrator.` });
    }

    const deployment = await Deployment.create(req.body);
    res.status(201).json(deployment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateDeploymentStatus = async (req, res) => {
  try {
    const deployment = await Deployment.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    res.json(deployment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const uploadZip = (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });
    if (!req.file) return res.status(400).json({ message: 'Please upload a ZIP file.' });

    try {
      const { getThresholds } = require('../utils/thresholds');
      const threshold = await getThresholds('devops');

      // Check max builds limit
      const userBuildCount = await Deployment.countDocuments({ deployedBy: req.user._id });
      if (userBuildCount >= threshold.maxBuildsPerUser) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({ message: `Max builds limit of ${threshold.maxBuildsPerUser} reached. Please delete old builds or contact your administrator.` });
      }

      const jobId = crypto.randomUUID();
      const projectName = req.body.projectName || path.basename(req.file.originalname, '.zip');
      const sessionId = req.body.sessionId || '';

      // Validate or suggest port inside allowed admin range
      let previewPort = parseInt(req.body.previewPort, 10);
      const minPort = threshold.allowedPortRangeMin || 3000;
      const maxPort = threshold.allowedPortRangeMax || 4000;
      
      const net = require('net');
      const isPortAvailable = (p) => new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.on('error', () => resolve(false));
        server.listen(p, '127.0.0.1', () => server.close(() => resolve(true)));
      });

      if (!previewPort || previewPort < minPort || previewPort > maxPort) {
        previewPort = null;
        for (let p = minPort; p <= maxPort; p++) {
          if (await isPortAvailable(p)) {
            previewPort = p;
            break;
          }
        }
        if (!previewPort) previewPort = minPort; // fallback
      }

      // Parse env files — must be valid JSON array
      let envFiles = [];
      if (req.body.envFiles) {
        try {
          envFiles = JSON.parse(req.body.envFiles);
          if (!Array.isArray(envFiles)) envFiles = [];
        } catch (_) {
          envFiles = [];
        }
      }

      const targetSubfolder = req.body.targetSubfolder || '';
      const upgradeMode = req.body.upgradeMode || 'automatic';
      const useTempDb = req.body.useTempDb === 'true' || req.body.useTempDb === true;
      const dbInitScript = req.body.dbInitScript || '';
      const dbInitType = req.body.dbInitType || 'none';

      // Create deployment record in MongoDB
      const deployment = await Deployment.create({
        projectName,
        status: 'pending',
        jobId,
        deployedBy: req.user ? req.user._id : null,
        sessionId,
        previewPort,
        previewStatus: 'none',
        envFiles,
        targetSubfolder,
        upgradeMode,
        useTempDb,
        dbInitScript,
        dbInitType,
        deploymentType: 'zip',
      });

      // Run pipeline in background
      runPipeline(jobId, deployment._id, req.file.path, previewPort, envFiles, targetSubfolder, upgradeMode);

      res.status(202).json({
        message: 'Deployment upload accepted. Pipeline started.',
        jobId,
        deploymentId: deployment._id,
        previewPort,
      });
    } catch (error) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ message: error.message });
    }
  });
};

const getDeploymentStatus = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    let buildLogs = [];
    try {
      const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
      const logFilePath = path.join(WORKSPACE_DIR, 'DevOps', 'builds', deployment.jobId, 'pipeline.log');
      if (fs.existsSync(logFilePath)) {
        const fileContent = fs.readFileSync(logFilePath, 'utf8');
        buildLogs = fileContent.split('\n').filter(Boolean);
      }
    } catch (_) {}

    res.json({
      id: deployment._id,
      projectName: deployment.projectName,
      techStackDetected: deployment.techStackDetected,
      architectureDetected: deployment.architectureDetected,
      status: deployment.status,
      vulnerabilitiesFound: deployment.vulnerabilitiesFound,
      buildLogs: buildLogs.length > 0 ? buildLogs : (deployment.buildLogs || []),
      scanReport: deployment.scanReport,
      previewPort: deployment.previewPort,
      previewStatus: deployment.previewStatus,
      recommendedUpgrades: deployment.recommendedUpgrades || [],
      upgradeMode: deployment.upgradeMode || 'automatic',
      createdAt: deployment.createdAt,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const downloadArtifact = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    if (deployment.status !== 'deployed' || !deployment.artifactPath) {
      return res.status(400).json({ message: 'No compiled build artifact available for this deployment.' });
    }

    const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
    const absolutePath = path.resolve(WORKSPACE_DIR, deployment.artifactPath);

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ message: 'Artifact file not found on disk.' });
    }

    res.download(absolutePath, `${deployment.projectName}-build.zip`);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── New handlers ─────────────────────────────────────────────────────────────

/**
 * GET /api/devops/suggest-port
 * Returns the next available port in range 3001-3999.
 */
const getSuggestedPort = async (req, res) => {
  try {
    const { getThresholds } = require('../utils/thresholds');
    const threshold = await getThresholds('devops');
    const minPort = threshold.allowedPortRangeMin || 3000;
    const maxPort = threshold.allowedPortRangeMax || 4000;

    const net = require('net');
    const isPortAvailable = (p) => new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.on('error', () => resolve(false));
      server.listen(p, '127.0.0.1', () => server.close(() => resolve(true)));
    });

    let suggested = null;
    for (let p = minPort; p <= maxPort; p++) {
      if (await isPortAvailable(p)) {
        suggested = p;
        break;
      }
    }

    if (!suggested) {
      return res.status(503).json({ message: `No available ports in range ${minPort}-${maxPort}.` });
    }
    res.json({ port: suggested });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * GET /api/devops/previews
 * Lists all currently running preview processes.
 */
const getActivePreviews = (req, res) => {
  try {
    const previews = getRunningPreviews();
    res.json(previews);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * POST /api/devops/:id/stop-preview
 * Kills the running preview process for a deployment.
 */
const stopDeploymentPreview = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found.' });

    const stopped = await stopPreview(deployment.jobId);
    if (!stopped) {
      return res.status(400).json({ message: 'No active preview found for this deployment.' });
    }

    res.json({ message: `Preview on port ${deployment.previewPort} has been stopped.` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * POST /api/devops/:id/start-preview
 * Manually starts the preview process for a past deployment.
 */
const startDeploymentPreview = async (req, res) => {
  try {
    const { getThresholds } = require('../utils/thresholds');
    const threshold = await getThresholds('devops');

    // Check max concurrent container limit
    const runningContainersCount = await Deployment.countDocuments({
      deployedBy: req.user._id,
      previewStatus: 'running'
    });
    if (runningContainersCount >= threshold.maxConcurrentContainers) {
      return res.status(403).json({ message: `Max concurrent running container previews limit (${threshold.maxConcurrentContainers}) reached. Please stop a preview first.` });
    }

    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found.' });

    const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
    const extractDir = path.join(WORKSPACE_DIR, 'DevOps', 'builds', deployment.jobId);

    if (!fs.existsSync(extractDir)) {
      return res.status(400).json({ message: 'Workspace folder not found on disk. Re-upload and compile project to preview.' });
    }

    // Detect framework & target directory inside workspace
    const { detectFramework } = require('../services/framework-detector.service');
    const { spawnPreview } = require('../services/process-manager.service');
    
    const targetSubfolder = deployment.targetSubfolder || '';
    const detection = detectFramework(extractDir, targetSubfolder);
    const targetBuildDir = detection.targetDir;

    // Validate or suggest port inside allowed admin range
    const minPort = threshold.allowedPortRangeMin || 3000;
    const maxPort = threshold.allowedPortRangeMax || 4000;
    
    const net = require('net');
    const isPortAvailable = (p) => new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.on('error', () => resolve(false));
      server.listen(p, '127.0.0.1', () => server.close(() => resolve(true)));
    });

    let previewPort = deployment.previewPort;
    if (!previewPort || previewPort < minPort || previewPort > maxPort) {
      previewPort = null;
      for (let p = minPort; p <= maxPort; p++) {
        if (await isPortAvailable(p)) {
          previewPort = p;
          break;
        }
      }
      if (!previewPort) previewPort = minPort; // fallback
      deployment.previewPort = previewPort;
      await deployment.save();
    }

    // Spawn preview process
    await spawnPreview(deployment.jobId, deployment._id, targetBuildDir, detection.framework, previewPort);

    res.json({ message: `Preview starting on port ${previewPort}`, port: previewPort });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * DELETE /api/devops/:id
 * Stops any preview, cleans up build workspaces and artifact ZIP files, and deletes DB entry.
 */
const deleteDeployment = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found.' });

    // 1. Stop any running preview container/process
    const { stopPreview } = require('../services/process-manager.service');
    try {
      await stopPreview(deployment.jobId, true);
    } catch (_) {}

    const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');

    // 2. Clean up build extraction folder on disk
    const extractDir = path.join(WORKSPACE_DIR, 'DevOps', 'builds', deployment.jobId);
    try {
      if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error(`Failed to delete build directory ${extractDir}:`, err);
    }

    // 3. Clean up packaged build ZIP on disk
    if (deployment.artifactPath) {
      const artifactZip = path.resolve(WORKSPACE_DIR, deployment.artifactPath);
      try {
        if (fs.existsSync(artifactZip)) {
          fs.unlinkSync(artifactZip);
        }
      } catch (err) {
        console.error(`Failed to delete artifact ZIP ${artifactZip}:`, err);
      }
    }

    // 4. Delete database document
    await Deployment.findByIdAndDelete(req.params.id);

    res.json({ message: 'Deployment deleted successfully and workspace cleaned up.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const FIXTURES_LIST = [
  { id: 'microservices', name: 'Microservices Monorepo (Node.js)', type: 'Backend', description: 'API Gateway (Express), Auth Service (Koa), and Threat Service (Hono) running concurrently in a monorepo workspace.' },
  { id: 'express', name: 'Express.js (Node.js)', type: 'Backend', description: 'Structured REST API with mock users/threat database and a beautiful dark status console.' },
  { id: 'fastify', name: 'Fastify (Node.js)', type: 'Backend', description: 'Cyan-themed, high-performance mock API service with memory/CPU health metrics.' },
  { id: 'elysia', name: 'Elysia (Bun/Node)', type: 'Backend', description: 'Elysia web-standards application with Bun-native runtime & live duration statistics.' },
  { id: 'h3', name: 'H3 (Node.js Universal)', type: 'Backend', description: 'Universal unjs server application built with modern modular HTTP event handler.' },
  { id: 'hono', name: 'Hono (Node.js)', type: 'Backend', description: 'Lightweight standards-based node server demonstration.' },
  { id: 'fastapi', name: 'FastAPI (Python)', type: 'Backend', description: 'FastAPI async microservice featuring uvicorn serving and venv persistence caching.' },
  { id: 'flask', name: 'Flask (Python)', type: 'Backend', description: 'Classic Python Flask web microservice template with wsgi environment parameters.' },
  { id: 'koa', name: 'Koa (Node.js)', type: 'Backend', description: 'Next-generation Koa middleware server with standard async/await routing.' },
  { id: 'django', name: 'Django (Python)', type: 'Backend', description: 'High performance Django application with SQLite database and customized admin views.' },
  { id: 'mern', name: 'MERN / Node.js Express', type: 'Backend', description: 'Full-featured Node.js and Express.js REST application.' },
  { id: 'rust', name: 'Rust (Axum)', type: 'Backend', description: 'Lightning-fast backend built in Rust using Tokio and Axum frameworks.' },
  { id: 'spring', name: 'Spring Boot (Java)', type: 'Backend', description: 'Enterprise-grade Java/Kotlin Spring Boot microservice with web starter.' },
  { id: 'php', name: 'PHP (Laravel Framework)', type: 'Backend', description: 'Structured Laravel application mocking Artisan commands, PDO database connectivity checks, and web router dashboard views.' },
  
  // Go Ecosystem
  { id: 'gin', name: 'Go (Gin)', type: 'Backend', description: 'High-performance HTTP API routing template built with Gin in Go.' },
  { id: 'fiber', name: 'Go (Fiber)', type: 'Backend', description: 'Express-inspired web framework for Go optimized for high throughput.' },
  { id: 'echo-go', name: 'Go (Echo)', type: 'Backend', description: 'Minimalist and extensible REST API template in Go.' },
  
  // Ruby Ecosystem
  { id: 'rails', name: 'Ruby on Rails', type: 'Backend', description: 'Full-stack Ruby MVC web framework with active-record emulation.' },
  { id: 'sinatra', name: 'Ruby (Sinatra)', type: 'Backend', description: 'Classically simple lightweight Ruby web API application.' },
  
  // .NET Ecosystem
  { id: 'dotnet', name: 'ASP.NET Core (.NET)', type: 'Backend', description: 'Enterprise C# Minimal API template with dynamic compilation.' },
  { id: 'blazor', name: 'Blazor WebAssembly', type: 'Backend', description: 'Interactive web UI template running C# in the client.' },
  
  // Elixir Ecosystem
  { id: 'phoenix', name: 'Elixir (Phoenix)', type: 'Backend', description: 'Real-time Elixir MVC framework showcasing extreme concurrency.' },
  
  // Deno Ecosystem
  { id: 'deno-fresh', name: 'Deno (Fresh)', type: 'Backend', description: 'Full-stack SSR web framework built specifically for Deno.' },
  { id: 'deno', name: 'Deno (Generic)', type: 'Backend', description: 'Modern TypeScript server runtime demonstrating native HTTP services.' },
  
  // PHP Ecosystem
  { id: 'symfony', name: 'Symfony (PHP)', type: 'Backend', description: 'Structured PHP web application with bundles and console component.' },
  
  // Java Ecosystem
  { id: 'quarkus', name: 'Quarkus (Java)', type: 'Backend', description: 'Supersonic Subatomic Java framework optimized for containerized microservices.' },
  
  // Bun Ecosystem
  { id: 'bun-native', name: 'Bun (Native HTTP)', type: 'Backend', description: 'Bun native serve HTTP router with no external JS dependencies.' },
  
  // Emerging
  { id: 'tanstack-start', name: 'TanStack Start', type: 'Emerging', description: 'Modern React full-stack meta-framework with file-based routing.' },
  { id: 'analog', name: 'Analog (Angular SSR)', type: 'Emerging', description: 'Angular meta-framework built on Vite with SSR and file routing.' },
  { id: 'svelte', name: 'Svelte (Standalone)', type: 'Emerging', description: 'Compiler-based modern frontend template built on Vite.' },
  { id: 'nitro', name: 'Nitro (Nuxt Engine)', type: 'Emerging', description: 'Nuxt engine standalone web server showcasing fast universal outputs.' },
  { id: 'blitz', name: 'Blitz.js', type: 'Emerging', description: 'React-based fullstack application template utilizing Blitz and Next.js layers.' },
  { id: 'redwood', name: 'RedwoodJS', type: 'Emerging', description: 'Yarn-based fullstack multi-workspace workspace simulation.' },
  { id: 'qwik', name: 'Qwik', type: 'Emerging', description: 'Qwik City SSR resumable web template.' },
  { id: 'solidstart', name: 'SolidStart', type: 'Emerging', description: 'SolidJS server-side rendering meta-framework template.' },
  { id: 'marko', name: 'Marko', type: 'Emerging', description: 'Streaming HTML component-driven framework template.' },
  { id: 'preact', name: 'Preact', type: 'Emerging', description: 'Preact client-side SPA demo serving custom static bundles.' },
  { id: 'static', name: 'Static Assets', type: 'Emerging', description: 'Tailwind/glassmorphic responsive static HTML/CSS template.' }
];

const listFixtures = async (req, res) => {
  try {
    const enrichedList = await Promise.all(FIXTURES_LIST.map(async (fixture) => {
      const reviews = await FixtureReview.find({ frameworkId: fixture.id });
      const reviewCount = reviews.length;
      const averageRating = reviewCount > 0 
        ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviewCount).toFixed(1)
        : 0;
      return {
        ...fixture,
        reviewCount,
        averageRating: Number(averageRating)
      };
    }));
    res.json(enrichedList);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const generateFixture = async (req, res) => {
  try {
    const { frameworkId } = req.body;
    if (!frameworkId) {
      return res.status(400).json({ message: 'Framework ID is required.' });
    }

    const { generateFixtureZip } = require('../services/fixture-generator.service');
    const zipPath = await generateFixtureZip(frameworkId);

    const jobId = crypto.randomUUID();
    const projectName = `Fixture - ${frameworkId.toUpperCase()}`;
    const previewPort = await suggestPort() || 3001;

    // Create deployment record in MongoDB
    const deployment = await Deployment.create({
      projectName,
      status: 'pending',
      jobId,
      deployedBy: req.user ? req.user._id : null,
      previewPort,
      previewStatus: 'none',
      envFiles: [],
      targetSubfolder: '',
      useTempDb: true,
    });

    // Run pipeline in background
    runPipeline(jobId, deployment._id, zipPath, previewPort, [], '');

    res.status(202).json({
      message: `Fixture generation & pipeline started for ${frameworkId}.`,
      jobId,
      deploymentId: deployment._id,
      previewPort,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const downloadPdfReport = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });

    const doc = new PDFDocument({ margin: 50, bufferPages: true });
    
    // Set headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${deployment.projectName.replace(/\s+/g, '_')}-security-report.pdf`);
    
    doc.pipe(res);
    
    // Header Style
    doc.fillColor('#0f172a').rect(0, 0, 612, 100).fill(); // Navy blue top bar
    doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold').text('NEXT-GEN SECURE DEVOPS', 50, 25);
    doc.fontSize(11).font('Helvetica').text('Automated Vulnerability & Compliance Report', 50, 55);
    
    // Report Summary
    doc.y = 130;
    doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold').text('Project Details Summary', 50, doc.y);
    doc.lineWidth(1).moveTo(50, doc.y + 20).lineTo(562, doc.y + 20).strokeColor('#cbd5e1').stroke();
    
    doc.y = 165;
    doc.fillColor('#334155').fontSize(10).font('Helvetica-Bold');
    doc.text('Project Name:', 50, doc.y).font('Helvetica').text(deployment.projectName, 170, doc.y);
    doc.y += 20;
    doc.font('Helvetica-Bold').text('Framework Detected:', 50, doc.y).font('Helvetica').text(deployment.techStackDetected || 'Not Detected', 170, doc.y);
    doc.y += 20;
    doc.font('Helvetica-Bold').text('Build Status:', 50, doc.y).font('Helvetica').text(deployment.status.toUpperCase(), 170, doc.y);
    doc.y += 20;
    doc.font('Helvetica-Bold').text('Scan Date:', 50, doc.y).font('Helvetica').text(new Date(deployment.createdAt).toLocaleString(), 170, doc.y);
    doc.y += 20;
    doc.font('Helvetica-Bold').text('Vulnerabilities Found:', 50, doc.y).font('Helvetica-Bold').fillColor(deployment.vulnerabilitiesFound > 0 ? '#ef4444' : '#10b981').text(deployment.vulnerabilitiesFound.toString(), 170, doc.y);
    
    doc.fillColor('#334155'); // Reset fill color
    
    // Vulnerability Sections
    const reports = deployment.scanReport || {};
    
    // 1. Credentials Scan Section
    if (reports.credentials && reports.credentials.length > 0) {
      doc.y += 40;
      if (doc.y > 600) doc.addPage();
      doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold').text('Hardcoded Credentials & Auto-Remediation', 50, doc.y);
      doc.lineWidth(1).moveTo(50, doc.y + 20).lineTo(562, doc.y + 20).strokeColor('#cbd5e1').stroke();
      
      doc.y += 30;
      reports.credentials.forEach((f, idx) => {
        if (doc.y > 600) doc.addPage();
        doc.fillColor('#475569').fontSize(10).font('Helvetica-Bold').text(`Finding #${idx + 1}: [${f.type}]`, 50, doc.y);
        doc.font('Helvetica').text(`File: ${f.file} (Line ${f.line})`, 50, doc.y + 15);
        doc.text(`Detected Pattern: ${f.match}`, 50, doc.y + 30);
        if (f.remediated) {
          doc.fillColor('#10b981').font('Helvetica-Bold').text(`Status: Remediation Successful (Extracted to Environment Variable)`, 50, doc.y + 45);
        } else {
          doc.fillColor('#ef4444').font('Helvetica-Bold').text(`Status: Hardcoded (Warning)`, 50, doc.y + 45);
        }
        doc.y += 65;
      });
    }

    // 2. Trivy Package/Library Vulnerabilities Scan Section
    if (reports.trivy && reports.trivy.length > 0) {
      doc.y += 40;
      if (doc.y > 600) doc.addPage();
      doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold').text('Software Composition Analysis (SCA) - Aquasec Trivy', 50, doc.y);
      doc.lineWidth(1).moveTo(50, doc.y + 20).lineTo(562, doc.y + 20).strokeColor('#cbd5e1').stroke();
      
      doc.y += 30;
      reports.trivy.forEach((v, idx) => {
        if (doc.y > 580) doc.addPage();
        const severityColor = v.severity === 'CRITICAL' || v.severity === 'HIGH' ? '#ef4444' : '#f59e0b';
        doc.fillColor('#475569').fontSize(10).font('Helvetica-Bold').text(`Vuln #${idx + 1}: ${v.vulnId || 'N/A'} - ${v.pkgName}`, 50, doc.y);
        doc.font('Helvetica-Bold').fillColor(severityColor).text(`Severity: ${v.severity}`, 50, doc.y + 15);
        doc.fillColor('#475569').font('Helvetica').text(`Installed: ${v.installedVersion} | Fixed: ${v.fixedVersion || 'N/A'}`, 50, doc.y + 30);
        doc.font('Helvetica-Oblique').text(`Description: ${v.title || 'No description available'}`, 50, doc.y + 45, { width: 512 });
        doc.y += 75;
      });
    }

    // Add page numbers
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const oldBottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fillColor('#94a3b8').fontSize(9).font('Helvetica').text(`Page ${i + 1} of ${range.count}`, 50, 760, { align: 'center' });
      doc.page.margins.bottom = oldBottomMargin;
    }

    doc.end();
  } catch (error) {
    console.error('Error generating PDF Report:', error);
    res.status(500).json({ message: 'Error generating security PDF report.' });
  }
};

const getFixtureReviews = async (req, res) => {
  try {
    const { frameworkId } = req.params;
    const reviews = await FixtureReview.find({ frameworkId }).sort({ createdAt: -1 });
    res.json(reviews);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createFixtureReview = async (req, res) => {
  try {
    const { frameworkId } = req.params;
    const { reviewerName, status, rating, comment } = req.body;
    
    if (!reviewerName || !status || !rating) {
      return res.status(400).json({ message: 'reviewerName, status, and rating are required.' });
    }

    const review = await FixtureReview.create({
      frameworkId,
      reviewerName,
      status,
      rating,
      comment
    });

    res.status(201).json(review);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * POST /api/devops/:id/change-port
 * Changes the preview port of an existing deployment, rewrites the DB and disk .env files,
 * stops the active container, and rebuilds/re-spawns it with the new configuration.
 */
const changeDeploymentPort = async (req, res) => {
  try {
    const { id } = req.params;
    const { previewPort } = req.body;
    if (!previewPort || isNaN(previewPort)) {
      return res.status(400).json({ message: 'Invalid preview port.' });
    }

    const deployment = await Deployment.findById(id);
    if (!deployment) {
      return res.status(404).json({ message: 'Deployment not found.' });
    }

    const oldPort = deployment.previewPort;
    const newPort = Number(previewPort);

    // Stop current preview if running
    const { stopPreview, spawnPreview } = require('../services/process-manager.service');
    await stopPreview(deployment.jobId, true);

    // Update DB
    deployment.previewPort = newPort;

    // Update .env files in the DB and on disk
    const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
    const extractDir = path.join(WORKSPACE_DIR, 'DevOps', 'builds', deployment.jobId);

    if (fs.existsSync(extractDir)) {
      // 1. Rewrite envFiles in DB
      if (deployment.envFiles && deployment.envFiles.length > 0) {
        deployment.envFiles = deployment.envFiles.map(envFile => {
          let content = envFile.content || '';
          
          // Replace port variable values
          content = content.replace(/\b(PORT|SERVER_PORT|APP_PORT|HTTP_PORT)=\d+/gi, `$1=${newPort}`);
          
          // Replace local URLs referring to the old port
          if (oldPort) {
            const oldPortRegex = new RegExp(`(localhost|127\\.0\\.0\\.1):${oldPort}`, 'gi');
            content = content.replace(oldPortRegex, `$1:${newPort}`);
          }
          
          // Also apply our standard URL normalization for the new port
          const lines = content.split(/\r?\n/);
          const normalizedLines = lines.map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx < 1) return line;
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
            
            const FRONTEND_URL_VARS = new Set([
              'FRONTEND_URL', 'CLIENT_URL', 'APP_URL', 'CORS_ORIGIN', 'ALLOWED_ORIGIN', 'ALLOWED_ORIGINS',
              'REACT_APP_URL', 'VUE_APP_URL', 'NEXT_PUBLIC_URL', 'VITE_APP_URL',
              'FRONTEND_BASE_URL', 'CLIENT_BASE_URL', 'WEB_URL', 'WEBAPP_URL',
              'CORS_ORIGINS', 'ACCESS_CONTROL_ALLOW_ORIGIN'
            ]);
            
            const isClientVar = key.startsWith('VITE_') || key.startsWith('REACT_APP_') || key.startsWith('NEXT_PUBLIC_') || key.startsWith('PUBLIC_');
            if (FRONTEND_URL_VARS.has(key) || isClientVar) {
              const localhostMatch = val.match(/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(\/.*)?$/);
              if (localhostMatch) {
                const urlPath = localhostMatch[1] || '';
                return `${key}=http://localhost:${newPort}${urlPath}`;
              }
            }
            return line;
          });
          
          return {
            path: envFile.path,
            content: normalizedLines.join('\n')
          };
        });
      }

      // 2. Rewrite env files on disk
      if (deployment.envFiles && deployment.envFiles.length > 0) {
        for (const envFile of deployment.envFiles) {
          const envAbsPath = path.resolve(extractDir, envFile.path.replace(/^\/+/, ''));
          if (fs.existsSync(envAbsPath)) {
            fs.writeFileSync(envAbsPath, envFile.content || '', 'utf8');
          }
        }
      }
    }

    await deployment.save();

    const isCurrentlyRunning = deployment.previewStatus === 'running';

    if (isCurrentlyRunning) {
      // 3. Trigger rebuild and restart the preview with the new configuration
      const { detectFramework } = require('../services/framework-detector.service');
      const targetSubfolder = deployment.targetSubfolder || '';
      const detection = detectFramework(extractDir, targetSubfolder);
      const targetBuildDir = detection.targetDir;

      // Trigger preview (compiles client/server in background)
      spawnPreview(deployment.jobId, deployment._id, targetBuildDir, detection.framework, newPort)
        .catch(err => {
          console.error(`Failed to restart preview for job ${deployment.jobId}:`, err);
        });

      res.json({ 
        message: 'Port updated successfully. Rebuilding and restarting preview...', 
        port: newPort,
        deployment 
      });
    } else {
      res.json({ 
        message: 'Port updated successfully in database and workspace config.', 
        port: newPort,
        deployment 
      });
    }
  } catch (error) {
    console.error('Error changing port:', error);
    res.status(500).json({ message: error.message });
  }
};

const getRemoteMongoUri = async (deployment) => {
  if (deployment && deployment.jobId) {
    try {
      const Docker = require('dockerode');
      const activeDocker = new Docker();
      const previewContainer = activeDocker.getContainer(`devops-preview-${deployment.jobId}`);
      const inspect = await previewContainer.inspect();
      const envVars = inspect.Config.Env || [];
      for (const env of envVars) {
        const match = env.match(/^MONGODB_URI=(.+)$/i);
        if (match) {
          const uri = match[1].trim();
          if (!uri.includes('localhost') && !uri.includes('127.0.0.1') && !uri.includes('devops-db-mongodb')) {
            return uri;
          }
        }
      }
    } catch (_) {}
  }

  if (!deployment || !deployment.envFiles || deployment.envFiles.length === 0) return null;
  const sortedEnvFiles = [...deployment.envFiles].sort((a, b) => {
    const aLower = (a.path || '').toLowerCase();
    const bLower = (b.path || '').toLowerCase();
    const aIsServer = aLower.includes('server') || aLower.includes('backend');
    const bIsServer = bLower.includes('server') || bLower.includes('backend');
    if (aIsServer && !bIsServer) return -1;
    if (!aIsServer && bIsServer) return 1;
    return 0;
  });

  for (const envFile of sortedEnvFiles) {
    if (!envFile.content) continue;
    const lines = envFile.content.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*MONGODB_URI\s*=\s*(.+)$/i);
      if (match) {
        let uri = match[1].trim();
        if ((uri.startsWith('"') && uri.endsWith('"')) || (uri.startsWith("'") && uri.endsWith("'"))) {
          uri = uri.slice(1, -1);
        }
        const commentIdx = uri.indexOf('#');
        if (commentIdx !== -1) {
          uri = uri.substring(0, commentIdx).trim();
        }
        if (uri.includes('localhost') || uri.includes('127.0.0.1') || uri.includes('devops-db-mongodb')) {
          continue;
        }
        return uri;
      }
    }
  }
  return null;
};


const executeDeploymentDbQuery = async (req, res) => {
  const { id } = req.params;
  const { query, dbType } = req.body;
  
  console.log(`[QUERY RUNNER] Running query against DB ${dbType} for deployment ${id}`);
  
  try {
    const deployment = await Deployment.findById(id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const jobId = deployment.jobId;
    const isSqlite = dbType === 'sqlite';
    const dbContainerName = isSqlite ? `devops-preview-${jobId}` : `devops-db-${dbType}-${jobId}`;

    const Docker = require('dockerode');
    const activeDocker = new Docker();
    const container = activeDocker.getContainer(dbContainerName);
    
    try {
      const inspect = await container.inspect();
      if (!inspect.State.Running) {
        return res.status(400).json({ message: 'Database container is not running. Please start the preview first!' });
      }
    } catch (_) {
      return res.status(400).json({ message: 'Database container does not exist or is offline. Please start the preview first!' });
    }

    const runExecWithTimeout = async (cmd, timeoutMs = 15000) => {
      return new Promise(async (resolve, reject) => {
        let resolved = false;
        let timer;
        try {
          const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
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
            reject(err);
          }
        }
      });
    };

    const dbName = 'preview_db';
    let output = '';

    const delimiter = '__DB_QUERY_EOF__';
    if (dbType === 'mysql' || dbType === 'mariadb') {
      const wrappedQuery = `START TRANSACTION;\n${query}\nCOMMIT;`;
      const writeAndRunCmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/run.sql\n${wrappedQuery}\n${delimiter}\nmysql -u root --bail -D "${dbName}" < /tmp/run.sql`];
      output = await runExecWithTimeout(writeAndRunCmd, 15000);
    } else if (dbType === 'postgres') {
      const writeAndRunCmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/run.sql\n${query}\n${delimiter}\npsql -U postgres -d "${dbName}" --single-transaction < /tmp/run.sql`];
      output = await runExecWithTimeout(writeAndRunCmd, 15000);
    } else if (dbType === 'mongodb') {
      const remoteUri = await getRemoteMongoUri(deployment);
      const connectionString = remoteUri || 'mongodb://localhost:27017';
      const wrappedQuery = `
        let targetDb = db;
        try {
          const dbs = db.getMongo().getDBNames().filter(d => d !== 'admin' && d !== 'config' && d !== 'local');
          for (const dName of dbs) {
            const currentDb = db.getSiblingDB(dName);
            const cols = currentDb.getCollectionNames();
            if (cols.length > 0) {
              targetDb = currentDb;
              break;
            }
          }
        } catch (_) {}
        db = targetDb;
        ${query}
      `;
      const writeAndRunCmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/run.js\n${wrappedQuery}\n${delimiter}\nmongosh "${connectionString}" --quiet /tmp/run.js`];
      output = await runExecWithTimeout(writeAndRunCmd, 15000);
    } else if (dbType === 'sqlite') {
      const writeAndRunCmd = ['sh', '-c', `sqliteFile=$(find /workspace -name "*.sqlite" -o -name "*.sqlite3" -o -name "*.db" | head -n 1); if [ -z "$sqliteFile" ]; then sqliteFile="/workspace/preview_db.sqlite3"; fi; sqlite3 "$sqliteFile" "${query.replace(/"/g, '\\"')}"`];
      output = await runExecWithTimeout(writeAndRunCmd, 15000);
    } else if (dbType === 'redis') {
      const writeAndRunCmd = ['sh', '-c', `redis-cli ${query}`];
      output = await runExecWithTimeout(writeAndRunCmd, 15000);
    } else if (dbType === 'mssql') {
      const writeAndRunCmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/run.sql\n${query}\n${delimiter}\n/opt/mssql-tools/bin/sqlcmd -S localhost -U sa -P Sa_password123 -C -d "${dbName}" -i /tmp/run.sql`];
      output = await runExecWithTimeout(writeAndRunCmd, 15000);
    } else if (dbType === 'oracle') {
      const writeAndRunCmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/run.sql\n${query}\n${delimiter}\nsqlplus -S system/oracle_password123@localhost/XE @/tmp/run.sql`];
      output = await runExecWithTimeout(writeAndRunCmd, 15000);
    } else if (dbType === 'cassandra') {
      const writeAndRunCmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/run.cql\n${query}\n${delimiter}\ncqlsh -f /tmp/run.cql`];
      output = await runExecWithTimeout(writeAndRunCmd, 15000);
    } else {
      return res.status(400).json({ message: `Unsupported database type: ${dbType}` });
    }

    res.json({ output });
  } catch (error) {
    console.error('Error running DB query:', error);
    res.status(500).json({ message: error.message });
  }
};

// ─── Workspace File Explorer Handlers ─────────────────────────────────────────

const getWorkspaceFiles = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
    const extractDir = path.join(WORKSPACE_DIR, 'DevOps', 'builds', deployment.jobId);
    
    if (!fs.existsSync(extractDir)) {
      return res.status(400).json({ message: 'Workspace folder not found on disk.' });
    }
    
    const getDirectoryTree = (dirPath, relativeDir = '') => {
      const tree = [];
      if (!fs.existsSync(dirPath)) return tree;
      
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        if (['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.security-reports'].includes(file)) continue;
        const fullPath = path.join(dirPath, file);
        const relPath = path.join(relativeDir, file).replace(/\\/g, '/');
        
        let isDir;
        try {
          isDir = fs.statSync(fullPath).isDirectory();
        } catch (err) {
          // If stat fails (e.g. permission error, broken symlink), skip this file
          continue;
        }
        
        tree.push({
          name: file,
          path: relPath,
          isDir,
          children: isDir ? getDirectoryTree(fullPath, relPath) : undefined
        });
      }
      return tree.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });
    };
    
    const tree = getDirectoryTree(extractDir);
    res.json(tree);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getWorkspaceFileContent = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
    const extractDir = path.join(WORKSPACE_DIR, 'DevOps', 'builds', deployment.jobId);
    
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ message: 'Path is required' });
    
    const resolvedPath = path.resolve(extractDir, filePath);
    if (!resolvedPath.startsWith(path.resolve(extractDir))) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ message: 'File not found' });
    }
    
    const content = fs.readFileSync(resolvedPath, 'utf8');
    res.json({ content });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const saveWorkspaceFile = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
    const extractDir = path.join(WORKSPACE_DIR, 'DevOps', 'builds', deployment.jobId);
    
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ message: 'Path is required' });
    
    const resolvedPath = path.resolve(extractDir, filePath);
    if (!resolvedPath.startsWith(path.resolve(extractDir))) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { scanContentForCredentials } = require('../services/credential-scanner.service');
    const findings = scanContentForCredentials(content || '', filePath);
    if (findings.length > 0) {
      return res.status(400).json({
        message: `Security Blocked: Potential credential/secret leak detected in ${filePath}.`,
        findings
      });
    }
    
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, content || '', 'utf8');
    
    res.json({ message: 'File saved successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Real-Time Database Management Handlers ───────────────────────────────────

const getDbCollections = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const dbType = req.query.dbType || deployment.dbInitType || 'none';
    if (dbType === 'none') return res.json([]);
    
    const jobId = deployment.jobId;
    const isSqlite = dbType === 'sqlite';
    const targetContainerName = isSqlite ? `devops-preview-${jobId}` : `devops-db-${dbType}-${jobId}`;
    
    const Docker = require('dockerode');
    const activeDocker = new Docker();
    const container = activeDocker.getContainer(targetContainerName);
    
    try {
      const inspect = await container.inspect();
      if (!inspect.State.Running) return res.json([]);
    } catch (_) {
      return res.json([]);
    }
    
    const runExec = async (cmd) => {
      const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
      const stream = await exec.start();
      return new Promise((resolve) => {
        const chunks = [];
        stream.on('data', chunk => { chunks.push(chunk); });
        stream.on('end', () => {
          const fullBuffer = Buffer.concat(chunks);
          resolve(cleanDockerOutput(fullBuffer).trim());
        });
        stream.on('error', () => resolve(''));
      });
    };
    
    const dbName = 'preview_db';
    if (dbType === 'mongodb') {
      const remoteUri = await getRemoteMongoUri(deployment);
      const connectionString = remoteUri || 'mongodb://localhost:27017';
      const delimiter = '__DB_QUERY_EOF__';
      const query = `
        let allColls = [];
        try {
          const dbs = db.getMongo().getDBNames().filter(d => d !== 'admin' && d !== 'config' && d !== 'local');
          for (const dName of dbs) {
            const currentDb = db.getSiblingDB(dName);
            const cols = currentDb.getCollectionNames();
            cols.forEach(c => allColls.push(cols.length > 0 && dbs.length > 1 ? \`\${dName}.\${c}\` : c));
          }
        } catch (_) {
          allColls = db.getCollectionNames();
        }
        printjson(allColls);
      `;
      const cmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/collections.js\n${query}\n${delimiter}\nmongosh "${connectionString}" --quiet /tmp/collections.js`];
      const output = await runExec(cmd);
      try {
        const collections = JSON.parse(output);
        return res.json(collections);
      } catch (_) {
        const lines = output.replace(/[\[\]']/g, '').split(',').map(s => s.trim()).filter(Boolean);
        return res.json(lines);
      }
    } else if (dbType === 'mysql' || dbType === 'mariadb') {
      const cmd = ['mysql', '-u', 'root', '-D', dbName, '-e', 'show tables;'];
      const output = await runExec(cmd);
      const lines = output.split('\n').slice(1).map(s => s.trim()).filter(Boolean);
      return res.json(lines);
    } else if (dbType === 'postgres') {
      const cmd = ['psql', '-U', 'postgres', '-d', dbName, '-t', '-c', "SELECT table_name FROM information_schema.tables WHERE table_schema='public';"];
      const output = await runExec(cmd);
      const lines = output.split('\n').map(s => s.trim()).filter(Boolean);
      return res.json(lines);
    } else if (dbType === 'sqlite') {
      const cmd = ['sh', '-c', `sqliteFile=$(find /workspace -name "*.sqlite" -o -name "*.sqlite3" -o -name "*.db" | head -n 1); if [ -z "$sqliteFile" ]; then sqliteFile="/workspace/preview_db.sqlite3"; fi; sqlite3 "$sqliteFile" ".tables"`];
      const output = await runExec(cmd);
      const tables = output.split(/\s+/).map(s => s.trim()).filter(Boolean);
      return res.json(tables);
    } else if (dbType === 'mssql') {
      const query = "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' FOR JSON PATH;";
      const cmd = ['/opt/mssql-tools/bin/sqlcmd', '-S', 'localhost', '-U', 'sa', '-P', 'Sa_password123', '-C', '-d', dbName, '-Q', query, '-y', '0'];
      const output = await runExec(cmd);
      try {
        const startIdx = output.indexOf('[');
        const endIdx = output.lastIndexOf(']');
        if (startIdx !== -1 && endIdx !== -1) {
          const arr = JSON.parse(output.substring(startIdx, endIdx + 1));
          return res.json(arr.map(t => t.TABLE_NAME));
        }
      } catch (_) {}
      const lines = output.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('---') && !s.startsWith('TABLE_NAME'));
      return res.json(lines);
    } else if (dbType === 'oracle') {
      const query = "SET PAGESIZE 0 FEEDBACK OFF HEADING OFF;\nSELECT table_name FROM user_tables;\nEXIT;";
      const delimiter = '__DB_QUERY_EOF__';
      const cmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/collections.sql\n${query}\n${delimiter}\nsqlplus -S system/oracle_password123@localhost/XE @/tmp/collections.sql`];
      const output = await runExec(cmd);
      const lines = output.split('\n').map(s => s.trim()).filter(Boolean);
      return res.json(lines);
    } else if (dbType === 'cassandra') {
      const query = `SELECT table_name FROM system_schema.tables WHERE keyspace_name = '${dbName}';`;
      const cmd = ['cqlsh', '-e', query];
      const output = await runExec(cmd);
      const lines = output.split('\n').slice(3).map(s => s.trim()).filter(s => s && !s.startsWith('---') && !s.startsWith('('));
      return res.json(lines);
    } else if (dbType === 'redis') {
      const cmd = ['redis-cli', 'KEYS', '*'];
      const output = await runExec(cmd);
      const lines = output.split('\n').map(s => s.trim()).filter(Boolean);
      return res.json(lines);
    }
    res.json([]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getDbCollectionData = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const dbType = req.query.dbType || deployment.dbInitType || 'none';
    const { collection } = req.params;
    if (dbType === 'none' || !collection) return res.json([]);
    
    const jobId = deployment.jobId;
    const isSqlite = dbType === 'sqlite';
    const targetContainerName = isSqlite ? `devops-preview-${jobId}` : `devops-db-${dbType}-${jobId}`;
    
    const Docker = require('dockerode');
    const activeDocker = new Docker();
    const container = activeDocker.getContainer(targetContainerName);
    
    try {
      const inspect = await container.inspect();
      if (!inspect.State.Running) return res.json([]);
    } catch (_) {
      return res.json([]);
    }
    
    const runExec = async (cmd) => {
      const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
      const stream = await exec.start();
      return new Promise((resolve) => {
        const chunks = [];
        stream.on('data', chunk => { chunks.push(chunk); });
        stream.on('end', () => {
          const fullBuffer = Buffer.concat(chunks);
          resolve(cleanDockerOutput(fullBuffer).trim());
        });
        stream.on('error', () => resolve(''));
      });
    };
    
    const dbName = 'preview_db';
    if (dbType === 'mongodb') {
      const remoteUri = await getRemoteMongoUri(deployment);
      const connectionString = remoteUri || dbName;
      const delimiter = '__DB_QUERY_EOF__';
      const query = `print(JSON.stringify(db.${collection}.find().limit(50).toArray()))`;
      const cmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/docs.js\n${query}\n${delimiter}\nmongosh "${connectionString}" --quiet /tmp/docs.js`];
      const output = await runExec(cmd);
      try {
        const docs = JSON.parse(output);
        return res.json(maskPIIData(docs));
      } catch (_) {
        return res.json([]);
      }
    } else if (dbType === 'mysql' || dbType === 'mariadb') {
      const cmd = ['mysql', '-u', 'root', '-D', dbName, '-e', `select * from \`${collection}\` limit 50;`];
      const output = await runExec(cmd);
      const lines = output.split('\n').filter(Boolean);
      if (lines.length === 0) return res.json([]);
      const headers = lines[0].split('\t');
      const rows = lines.slice(1).map(line => {
        const values = line.split('\t');
        const obj = {};
        headers.forEach((h, i) => { obj[h] = values[i] || null; });
        return obj;
      });
      return res.json(maskPIIData(rows));
    } else if (dbType === 'postgres') {
      const query = `SELECT COALESCE(json_agg(t), '[]'::json) FROM (SELECT * FROM "${collection}" LIMIT 50) t;`;
      const cmd = ['psql', '-U', 'postgres', '-d', dbName, '-t', '-A', '-c', query];
      const output = await runExec(cmd);
      try {
        const startIdx = output.indexOf('[');
        const endIdx = output.lastIndexOf(']');
        if (startIdx !== -1 && endIdx !== -1) {
          const data = JSON.parse(output.substring(startIdx, endIdx + 1));
          return res.json(maskPIIData(data || []));
        }
        return res.json([]);
      } catch (_) {
        return res.json([]);
      }
    } else if (dbType === 'sqlite') {
      const cmd = ['sh', '-c', `sqliteFile=$(find /workspace -name "*.sqlite" -o -name "*.sqlite3" -o -name "*.db" | head -n 1); if [ -z "$sqliteFile" ]; then sqliteFile="/workspace/preview_db.sqlite3"; fi; sqlite3 -header -json "$sqliteFile" "select * from \`${collection}\` limit 50;"`];
      const output = await runExec(cmd);
      try {
        return res.json(maskPIIData(JSON.parse(output) || []));
      } catch (_) {
        return res.json([]);
      }
    } else if (dbType === 'mssql') {
      const query = `SELECT TOP 50 * FROM [${collection}] FOR JSON PATH;`;
      const cmd = ['/opt/mssql-tools/bin/sqlcmd', '-S', 'localhost', '-U', 'sa', '-P', 'Sa_password123', '-C', '-d', dbName, '-Q', query, '-y', '0'];
      const output = await runExec(cmd);
      try {
        const startIdx = output.indexOf('[');
        const endIdx = output.lastIndexOf(']');
        if (startIdx !== -1 && endIdx !== -1) {
          const arr = JSON.parse(output.substring(startIdx, endIdx + 1));
          return res.json(maskPIIData(arr || []));
        }
      } catch (_) {}
      return res.json([]);
    } else if (dbType === 'oracle') {
      const query = `SET PAGESIZE 0 FEEDBACK OFF HEADING OFF;\nSELECT * FROM ${collection} FETCH FIRST 50 ROWS ONLY;\nEXIT;`;
      const delimiter = '__DB_QUERY_EOF__';
      const cmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/query.sql\n${query}\n${delimiter}\nsqlplus -S system/oracle_password123@localhost/XE @/tmp/query.sql`];
      const output = await runExec(cmd);
      const lines = output.split('\n').map(s => s.trim()).filter(Boolean);
      return res.json(lines.map(line => ({ record: line })));
    } else if (dbType === 'cassandra') {
      const query = `SELECT * FROM ${collection} LIMIT 50;`;
      const cmd = ['cqlsh', '-e', query];
      const output = await runExec(cmd);
      const lines = output.split('\n').filter(Boolean);
      if (lines.length <= 3) return res.json([]);
      const headers = lines[1].split('|').map(s => s.trim());
      const rows = lines.slice(3).map(line => {
        const values = line.split('|').map(s => s.trim());
        const obj = {};
        headers.forEach((h, i) => { obj[h] = values[i] || null; });
        return obj;
      });
      return res.json(maskPIIData(rows));
    } else if (dbType === 'redis') {
      const typeCmd = ['redis-cli', 'TYPE', collection];
      const type = await runExec(typeCmd);
      if (type === 'string') {
        const valCmd = ['redis-cli', 'GET', collection];
        const val = await runExec(valCmd);
        return res.json([{ key: collection, type: 'string', value: val }]);
      } else if (type === 'hash') {
        const valCmd = ['redis-cli', 'HGETALL', collection];
        const valOutput = await runExec(valCmd);
        const lines = valOutput.split('\n').map(s => s.trim()).filter(Boolean);
        const obj = {};
        for (let i = 0; i < lines.length; i += 2) {
          if (lines[i]) obj[lines[i]] = lines[i+1] || null;
        }
        return res.json([obj]);
      } else if (type === 'list') {
        const valCmd = ['redis-cli', 'LRANGE', collection, '0', '50'];
        const valOutput = await runExec(valCmd);
        const lines = valOutput.split('\n').map(s => s.trim()).filter(Boolean);
        return res.json(lines.map((val, idx) => ({ index: idx, value: val })));
      } else if (type === 'set') {
        const valCmd = ['redis-cli', 'SMEMBERS', collection];
        const valOutput = await runExec(valCmd);
        const lines = valOutput.split('\n').map(s => s.trim()).filter(Boolean);
        return res.json(lines.map(val => ({ value: val })));
      } else if (type === 'zset') {
        const valCmd = ['redis-cli', 'ZRANGE', collection, '0', '50', 'WITHSCORES'];
        const valOutput = await runExec(valCmd);
        const lines = valOutput.split('\n').map(s => s.trim()).filter(Boolean);
        const arr = [];
        for (let i = 0; i < lines.length; i += 2) {
          if (lines[i]) arr.push({ value: lines[i], score: lines[i+1] || null });
        }
        return res.json(arr);
      }
      return res.json([]);
    }
    res.json([]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const insertDbRecord = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const dbType = req.query.dbType || deployment.dbInitType || 'none';
    const { collection, record } = req.body;
    if (dbType === 'none' || !collection || !record) {
      return res.status(400).json({ message: 'Missing database, collection, or record details.' });
    }
    
    const jobId = deployment.jobId;
    const isSqlite = dbType === 'sqlite';
    const targetContainerName = isSqlite ? `devops-preview-${jobId}` : `devops-db-${dbType}-${jobId}`;
    
    const Docker = require('dockerode');
    const activeDocker = new Docker();
    const container = activeDocker.getContainer(targetContainerName);
    
    try {
      const inspect = await container.inspect();
      if (!inspect.State.Running) return res.status(400).json({ message: 'Database container is not running.' });
    } catch (_) {
      return res.status(400).json({ message: 'Database container does not exist.' });
    }
    
    const runExec = async (cmd) => {
      const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
      const stream = await exec.start();
      return new Promise((resolve) => {
        const chunks = [];
        stream.on('data', chunk => { chunks.push(chunk); });
        stream.on('end', () => {
          const fullBuffer = Buffer.concat(chunks);
          resolve(cleanDockerOutput(fullBuffer).trim());
        });
        stream.on('error', () => resolve(''));
      });
    };
    
    const dbName = 'preview_db';

    try {
      await validateDbRecord(container, dbType, dbName, collection, record, deployment);
    } catch (valErr) {
      return res.status(400).json({ message: `Validation Failed: ${valErr.message}` });
    }

    if (dbType === 'mongodb') {
      const remoteUri = await getRemoteMongoUri(deployment);
      const connectionString = remoteUri || dbName;
      const delimiter = '__DB_QUERY_EOF__';
      const query = `print(JSON.stringify(db.${collection}.insertOne(${JSON.stringify(record)})))`;
      const cmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/insert.js\n${query}\n${delimiter}\nmongosh "${connectionString}" --quiet /tmp/insert.js`];
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    } else if (dbType === 'mysql' || dbType === 'mariadb' || dbType === 'postgres' || dbType === 'sqlite') {
      // Filter out null values so auto-increment/serial columns can use their DB defaults
      const filteredEntries = Object.entries(record).filter(([, v]) => v !== null && v !== undefined);
      const keys = filteredEntries.map(([k]) => k);
      const values = filteredEntries.map(([, val]) => {
        if (typeof val === 'number') return val;
        return `'${String(val).replace(/'/g, "''")}'`;
      });
      const sql = `INSERT INTO \`${collection}\` (${keys.map(k => `\`${k}\``).join(', ')}) VALUES (${values.join(', ')});`;
      
      let cmd = [];
      if (dbType === 'mysql' || dbType === 'mariadb') {
        cmd = ['mysql', '-u', 'root', '-D', dbName, '-e', sql];
      } else if (dbType === 'postgres') {
        const pgSql = sql.replace(/`/g, '"');
        cmd = ['psql', '-U', 'postgres', '-d', dbName, '-c', pgSql];
      } else if (dbType === 'sqlite') {
        const liteSql = sql.replace(/`/g, '"');
        cmd = ['sh', '-c', `sqliteFile=$(find /workspace -name "*.sqlite" -o -name "*.sqlite3" -o -name "*.db" | head -n 1); if [ -z "$sqliteFile" ]; then sqliteFile="/workspace/preview_db.sqlite3"; fi; sqlite3 "$sqliteFile" "${liteSql}"`];
      }
      
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    } else if (dbType === 'mssql') {
      const keys = Object.keys(record);
      const values = Object.values(record).map(val => {
        if (val === null) return 'NULL';
        if (typeof val === 'number') return val;
        return `'${String(val).replace(/'/g, "''")}'`;
      });
      const sql = `INSERT INTO [${collection}] (${keys.map(k => `[${k}]`).join(', ')}) VALUES (${values.join(', ')});`;
      const cmd = ['/opt/mssql-tools/bin/sqlcmd', '-S', 'localhost', '-U', 'sa', '-P', 'Sa_password123', '-C', '-d', dbName, '-Q', sql];
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    } else if (dbType === 'oracle') {
      const keys = Object.keys(record);
      const values = Object.values(record).map(val => {
        if (val === null) return 'NULL';
        if (typeof val === 'number') return val;
        return `'${String(val).replace(/'/g, "''")}'`;
      });
      const sql = `INSERT INTO ${collection} (${keys.join(', ')}) VALUES (${values.join(', ')});\nCOMMIT;\nEXIT;`;
      const delimiter = '__DB_QUERY_EOF__';
      const cmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/insert.sql\n${sql}\n${delimiter}\nsqlplus -S system/oracle_password123@localhost/XE @/tmp/insert.sql`];
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    } else if (dbType === 'cassandra') {
      const keys = Object.keys(record);
      const values = Object.values(record).map(val => {
        if (val === null) return 'NULL';
        if (typeof val === 'number') return val;
        return `'${String(val).replace(/'/g, "''")}'`;
      });
      const sql = `INSERT INTO ${collection} (${keys.join(', ')}) VALUES (${values.join(', ')});`;
      const cmd = ['cqlsh', '-e', sql];
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    } else if (dbType === 'redis') {
      let cmd = [];
      const fields = Object.keys(record);
      if (fields.length === 1 && fields[0] === 'value') {
        cmd = ['redis-cli', 'SET', collection, String(record.value)];
      } else {
        cmd = ['redis-cli', 'HSET', collection];
        fields.forEach(f => {
          cmd.push(f, String(record[f]));
        });
      }
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    }
    
    res.status(400).json({ message: 'Unsupported database type' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateDbRecord = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const dbType = req.query.dbType || deployment.dbInitType || 'none';
    const { collection, pkColumn, pkValue, record } = req.body;
    if (dbType === 'none' || !collection || !record) {
      return res.status(400).json({ message: 'Missing database, collection, or record details.' });
    }
    
    const jobId = deployment.jobId;
    const isSqlite = dbType === 'sqlite';
    const targetContainerName = isSqlite ? `devops-preview-${jobId}` : `devops-db-${dbType}-${jobId}`;
    
    const Docker = require('dockerode');
    const activeDocker = new Docker();
    const container = activeDocker.getContainer(targetContainerName);
    
    try {
      const inspect = await container.inspect();
      if (!inspect.State.Running) return res.status(400).json({ message: 'Database container is not running.' });
    } catch (_) {
      return res.status(400).json({ message: 'Database container does not exist.' });
    }
    
    const runExec = async (cmd) => {
      const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
      const stream = await exec.start();
      return new Promise((resolve) => {
        const chunks = [];
        stream.on('data', chunk => { chunks.push(chunk); });
        stream.on('end', () => {
          const fullBuffer = Buffer.concat(chunks);
          resolve(cleanDockerOutput(fullBuffer).trim());
        });
        stream.on('error', () => resolve(''));
      });
    };
    
    const dbName = 'preview_db';

    if (dbType === 'mongodb') {
      const remoteUri = await getRemoteMongoUri(deployment);
      const connectionString = remoteUri || dbName;
      const delimiter = '__DB_QUERY_EOF__';
      const query = `
        let queryObj = { _id: "${pkValue}" };
        if ("${pkValue}".length === 24 && /^[0-9a-fA-F]+$/.test("${pkValue}")) {
          try { queryObj = { _id: ObjectId("${pkValue}") }; } catch(e) {}
        } else {
          const asNum = Number("${pkValue}");
          if (!isNaN(asNum)) {
            queryObj = { _id: asNum };
          }
        }
        print(JSON.stringify(db.${collection}.updateOne(queryObj, { $set: ${JSON.stringify(record)} })));
      `;
      const cmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/update.js\n${query}\n${delimiter}\nmongosh "${connectionString}" --quiet /tmp/update.js`];
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    } else if (dbType === 'mysql' || dbType === 'mariadb' || dbType === 'postgres' || dbType === 'sqlite') {
      const keys = Object.keys(record);
      const setClauses = keys.map(k => {
        const val = record[k];
        if (val === null || val === undefined) return `\`${k}\` = NULL`;
        if (typeof val === 'number') return `\`${k}\` = ${val}`;
        return `\`${k}\` = '${String(val).replace(/'/g, "''")}'`;
      }).join(', ');
      
      const pkValStr = typeof pkValue === 'number' || !isNaN(Number(pkValue)) ? pkValue : `'${String(pkValue).replace(/'/g, "''")}'`;
      const sql = `UPDATE \`${collection}\` SET ${setClauses} WHERE \`${pkColumn || 'id'}\` = ${pkValStr};`;
      
      let cmd = [];
      if (dbType === 'mysql' || dbType === 'mariadb') {
        cmd = ['mysql', '-u', 'root', '-D', dbName, '-e', sql];
      } else if (dbType === 'postgres') {
        const pgSql = sql.replace(/`/g, '"');
        cmd = ['psql', '-U', 'postgres', '-d', dbName, '-c', pgSql];
      } else if (dbType === 'sqlite') {
        const liteSql = sql.replace(/`/g, '"');
        cmd = ['sh', '-c', `sqliteFile=$(find /workspace -name "*.sqlite" -o -name "*.sqlite3" -o -name "*.db" | head -n 1); if [ -z "$sqliteFile" ]; then sqliteFile="/workspace/preview_db.sqlite3"; fi; sqlite3 "$sqliteFile" "${liteSql}"`];
      }
      
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    } else if (dbType === 'mssql') {
      const keys = Object.keys(record);
      const setClauses = keys.map(k => {
        const val = record[k];
        if (val === null || val === undefined) return `[${k}] = NULL`;
        if (typeof val === 'number') return `[${k}] = ${val}`;
        return `[${k}] = '${String(val).replace(/'/g, "''")}'`;
      }).join(', ');
      const pkValStr = typeof pkValue === 'number' || !isNaN(Number(pkValue)) ? pkValue : `'${String(pkValue).replace(/'/g, "''")}'`;
      const sql = `UPDATE [${collection}] SET ${setClauses} WHERE [${pkColumn || 'id'}] = ${pkValStr};`;
      const cmd = ['/opt/mssql-tools/bin/sqlcmd', '-S', 'localhost', '-U', 'sa', '-P', 'Sa_password123', '-C', '-d', dbName, '-Q', sql];
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    } else if (dbType === 'redis') {
      const typeCmd = ['redis-cli', 'TYPE', collection];
      const type = await runExec(typeCmd);
      let cmd = [];
      if (type === 'hash') {
        cmd = ['redis-cli', 'HSET', collection];
        Object.keys(record).forEach(f => {
          cmd.push(f, String(record[f]));
        });
      } else {
        cmd = ['redis-cli', 'SET', collection, String(record.value || JSON.stringify(record))];
      }
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    }
    
    res.status(400).json({ message: 'Unsupported database type' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteDbRecord = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const dbType = req.query.dbType || deployment.dbInitType || 'none';
    const { collection, pkColumn, pkValue } = req.body;
    if (dbType === 'none' || !collection || pkValue === undefined || pkValue === null) {
      return res.status(400).json({ message: 'Missing database, collection, or primary key details.' });
    }
    
    const jobId = deployment.jobId;
    const isSqlite = dbType === 'sqlite';
    const targetContainerName = isSqlite ? `devops-preview-${jobId}` : `devops-db-${dbType}-${jobId}`;
    
    const Docker = require('dockerode');
    const activeDocker = new Docker();
    const container = activeDocker.getContainer(targetContainerName);
    
    try {
      const inspect = await container.inspect();
      if (!inspect.State.Running) return res.status(400).json({ message: 'Database container is not running.' });
    } catch (_) {
      return res.status(400).json({ message: 'Database container does not exist.' });
    }
    
    const runExec = async (cmd) => {
      const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
      const stream = await exec.start();
      return new Promise((resolve) => {
        const chunks = [];
        stream.on('data', chunk => { chunks.push(chunk); });
        stream.on('end', () => {
          const fullBuffer = Buffer.concat(chunks);
          resolve(cleanDockerOutput(fullBuffer).trim());
        });
        stream.on('error', () => resolve(''));
      });
    };
    
    const dbName = 'preview_db';

    if (dbType === 'mongodb') {
      const remoteUri = await getRemoteMongoUri(deployment);
      const connectionString = remoteUri || dbName;
      const delimiter = '__DB_QUERY_EOF__';
      const query = `
        let queryObj = { _id: "${pkValue}" };
        if ("${pkValue}".length === 24 && /^[0-9a-fA-F]+$/.test("${pkValue}")) {
          try { queryObj = { _id: ObjectId("${pkValue}") }; } catch(e) {}
        } else {
          const asNum = Number("${pkValue}");
          if (!isNaN(asNum)) {
            queryObj = { _id: asNum };
          }
        }
        print(JSON.stringify(db.${collection}.deleteOne(queryObj)));
      `;
      const cmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/delete.js\n${query}\n${delimiter}\nmongosh "${connectionString}" --quiet /tmp/delete.js`];
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    } else if (dbType === 'mysql' || dbType === 'mariadb' || dbType === 'postgres' || dbType === 'sqlite') {
      const pkValStr = typeof pkValue === 'number' || !isNaN(Number(pkValue)) ? pkValue : `'${String(pkValue).replace(/'/g, "''")}'`;
      const sql = `DELETE FROM \`${collection}\` WHERE \`${pkColumn || 'id'}\` = ${pkValStr};`;
      
      let cmd = [];
      if (dbType === 'mysql' || dbType === 'mariadb') {
        cmd = ['mysql', '-u', 'root', '-D', dbName, '-e', sql];
      } else if (dbType === 'postgres') {
        const pgSql = sql.replace(/`/g, '"');
        cmd = ['psql', '-U', 'postgres', '-d', dbName, '-c', pgSql];
      } else if (dbType === 'sqlite') {
        const liteSql = sql.replace(/`/g, '"');
        cmd = ['sh', '-c', `sqliteFile=$(find /workspace -name "*.sqlite" -o -name "*.sqlite3" -o -name "*.db" | head -n 1); if [ -z "$sqliteFile" ]; then sqliteFile="/workspace/preview_db.sqlite3"; fi; sqlite3 "$sqliteFile" "${liteSql}"`];
      }
      
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    } else if (dbType === 'mssql') {
      const pkValStr = typeof pkValue === 'number' || !isNaN(Number(pkValue)) ? pkValue : `'${String(pkValue).replace(/'/g, "''")}'`;
      const sql = `DELETE FROM [${collection}] WHERE [${pkColumn || 'id'}] = ${pkValStr};`;
      const cmd = ['/opt/mssql-tools/bin/sqlcmd', '-S', 'localhost', '-U', 'sa', '-P', 'Sa_password123', '-C', '-d', dbName, '-Q', sql];
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    } else if (dbType === 'redis') {
      const cmd = ['redis-cli', 'DEL', collection];
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    }
    
    res.status(400).json({ message: 'Unsupported database type' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getFlatWorkspaceFiles = (dirPath, relativeDir = '') => {
  let list = [];
  if (!fs.existsSync(dirPath)) return list;
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      if (['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.security-reports'].includes(file)) continue;
      const fullPath = path.join(dirPath, file);
      const relPath = path.join(relativeDir, file).replace(/\\/g, '/');
      
      let isDir;
      try {
        isDir = fs.statSync(fullPath).isDirectory();
      } catch (err) {
        continue;
      }
      
      if (isDir) {
        list = list.concat(getFlatWorkspaceFiles(fullPath, relPath));
      } else {
        list.push(relPath);
      }
    }
  } catch (_) {}
  return list;
};

const isReadOnlyCommand = (command) => {
  if (!command || typeof command !== 'string') return false;
  const cmd = command.toLowerCase().trim();
  
  if (/[><]/.test(cmd)) return false;
  
  const subParts = cmd.split(/[;&|]/).map(s => s.trim()).filter(Boolean);
  if (subParts.length === 0) return false;
  
  const readKeywords = ['cat', 'ls', 'find', 'grep', 'pwd', 'head', 'tail', 'echo', 'printenv', 'file', 'stat', 'which', 'type', 'du', 'df'];
  for (const part of subParts) {
    const firstWord = part.split(/\s+/)[0];
    if (!readKeywords.includes(firstWord)) {
      return false;
    }
  }
  return true;
};

// ─── AI DevOps Agent Chat-Exec Handlers ────────────────────────────────────────

const executeAgentChat = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    if (['building', 'pending', 'scanning'].includes(deployment.status)) {
      return res.status(400).json({ 
        message: 'The build is currently running and monitoring the pipeline. Please wait until the build finishes or fails before asking the agent to update files.' 
      });
    }

    const { message, chatId, imageBase64, imageMimeType } = req.body;
    if (!message) return res.status(400).json({ message: 'Message is required' });
    
    let chatSession = null;
    if (chatId) {
      chatSession = await DevOpsChat.findById(chatId);
    }
    if (!chatSession) {
      chatSession = new DevOpsChat({
        deploymentId: deployment._id,
        title: message.substring(0, 30) + '...',
        messages: []
      });
      await chatSession.save();
    }

    // Run the ReAct agent chat loop
    const startTime = Date.now();
    const { runAgentChatLoop } = require('../services/agent-loop.service');
    const displayName = req.user
      ? (req.user.githubUsername
          ? `${req.user.email} (${req.user.githubUsername})`
          : req.user.email)
      : 'Anonymous';
    const result = await runAgentChatLoop(deployment, chatSession, message, null, displayName, imageBase64 || null, imageMimeType || 'image/jpeg');
    const durationSec = parseFloat(((Date.now() - startTime) / 1000).toFixed(1));

    // Save final response in database messages archive
    chatSession.messages.push({
      role: 'user',
      text: message
    });
    chatSession.messages.push({
      role: 'agent',
      text: result.message,
      pendingAction: result.pendingExec ? { commands: result.commands } : undefined,
      patches: result.patches,
      durationSec
    });
    await chatSession.save();

    res.json({ 
      message: result.message, 
      pendingExec: result.pendingExec, 
      commands: result.commands, 
      patches: result.patches, 
      chatId: result.chatId,
      durationSec
    });
  } catch (error) {
    console.error('Error in agent chat:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Rollback patches applied by the AI agent by restoring the previous file content.
 * Expects: { patches: [{ file, previousContent, isNewFile }], chatId, messageIndex }
 */
const rollbackAgentPatches = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });

    const { patches, chatId, messageIndex } = req.body;
    if (!patches || !Array.isArray(patches) || patches.length === 0) {
      return res.status(400).json({ message: 'Patches array is required' });
    }

    const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
    const extractDir = path.join(WORKSPACE_DIR, 'DevOps', 'builds', deployment.jobId);
    const rolledBack = [];
    const errors = [];

    for (const patch of patches) {
      const { file, previousContent, isNewFile } = patch;
      const targetAbsPath = path.resolve(extractDir, file);

      // Security: ensure path doesn't escape the build dir
      if (!targetAbsPath.startsWith(path.resolve(extractDir))) {
        errors.push({ file, error: 'Path traversal attempt blocked' });
        continue;
      }

      try {
        if (isNewFile) {
          // File was newly created — delete it on rollback
          if (fs.existsSync(targetAbsPath)) {
            fs.unlinkSync(targetAbsPath);
          }
        } else if (previousContent !== null && previousContent !== undefined) {
          // File was modified — restore previous content
          fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
          fs.writeFileSync(targetAbsPath, previousContent, 'utf8');
        }
        rolledBack.push(file);
      } catch (err) {
        errors.push({ file, error: err.message });
      }
    }

    // Persist rolled back state in database if chat context is provided
    if (chatId && messageIndex !== undefined) {
      const chatSession = await DevOpsChat.findById(chatId);
      if (chatSession && chatSession.messages[messageIndex]) {
        chatSession.messages[messageIndex].rolledBack = true;
        await chatSession.save();
      }
    }

    res.json({
      message: `Rolled back ${rolledBack.length} file(s)`,
      rolledBack,
      errors
    });
  } catch (error) {
    console.error('Error in rollback:', error);
    res.status(500).json({ message: error.message });
  }
};

const updateAgentPermission = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const { permission } = req.body;
    if (!['ask', 'always', 'never'].includes(permission)) {
      return res.status(400).json({ message: 'Invalid permission setting' });
    }
    
    deployment.execPermission = permission;
    await deployment.save();
    
    res.json({ message: 'Permission updated successfully', permission });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Rollback the chat history by deleting all messages starting from the specified index.
 * Automatically rolls back any files changed by the deleted messages.
 */
const undoChatMessages = async (req, res) => {
  try {
    const { chatId, messageIndex } = req.body;
    if (!chatId || messageIndex === undefined) {
      return res.status(400).json({ message: 'chatId and messageIndex are required' });
    }

    const chatSession = await DevOpsChat.findById(chatId);
    if (!chatSession) {
      return res.status(404).json({ message: 'Chat thread not found' });
    }

    const deployment = await Deployment.findById(chatSession.deploymentId);
    if (!deployment) {
      return res.status(404).json({ message: 'Associated deployment not found' });
    }

    if (messageIndex >= 0 && messageIndex < chatSession.messages.length) {
      // Find all agent messages to delete that have active patches
      const messagesToDelete = chatSession.messages.slice(messageIndex);
      const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
      const extractDir = path.join(WORKSPACE_DIR, 'DevOps', 'builds', deployment.jobId);

      for (const msg of messagesToDelete) {
        if (msg.role === 'agent' && msg.patches && msg.patches.length > 0 && !msg.rolledBack) {
          for (const patch of msg.patches) {
            const { file, previousContent, isNewFile } = patch;
            const targetAbsPath = path.resolve(extractDir, file);

            // Path traversal guard
            if (targetAbsPath.startsWith(path.resolve(extractDir))) {
              try {
                if (isNewFile) {
                  if (fs.existsSync(targetAbsPath)) {
                    fs.unlinkSync(targetAbsPath);
                  }
                } else if (previousContent !== null && previousContent !== undefined) {
                  fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
                  fs.writeFileSync(targetAbsPath, previousContent, 'utf8');
                }
              } catch (err) {
                console.error(`[UNDO] Failed to rollback file ${file}:`, err.message);
              }
            }
          }
        }
      }

      chatSession.messages = chatSession.messages.slice(0, messageIndex);
      await chatSession.save();
    }

    res.json({
      message: 'Chat history rolled back and files reverted successfully',
      messages: chatSession.messages
    });
  } catch (error) {
    console.error('Error in undo chat:', error);
    res.status(500).json({ message: error.message });
  }
};

const executePendingCommands = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const { commands, chatId } = req.body;
    if (!commands || !Array.isArray(commands)) {
      return res.status(400).json({ message: 'Commands array is required' });
    }
    
    const Docker = require('dockerode');
    const activeDocker = new Docker();
    const targetContainerName = `devops-preview-${deployment.jobId}`;
    const container = activeDocker.getContainer(targetContainerName);
    
    let isContainerRunning = false;
    try {
      const inspect = await container.inspect();
      isContainerRunning = inspect.State.Running;
    } catch (_) {}
    
    if (!isContainerRunning) {
      return res.status(400).json({ message: 'Preview container is offline. Please start/restart the preview sandbox first!' });
    }

    for (const cmd of commands) {
      if (!isCommandSafe(cmd)) {
        return res.status(400).json({ message: `Security Blocked: Command contains potentially dangerous patterns and was rejected by guardrails: "${cmd}"` });
      }
    }

    let execLogs = '';
    for (const cmd of commands) {
      execLogs += `\n$ ${cmd}\n`;
      const exec = await container.exec({ Cmd: ['sh', '-c', `cd /project 2>/dev/null || cd /workspace 2>/dev/null || true; ${cmd}`], AttachStdout: true, AttachStderr: true });
      const stream = await exec.start();
      const out = await new Promise((resolve) => {
        const chunks = [];
        stream.on('data', chunk => { chunks.push(chunk); });
        stream.on('end', () => {
          const fullBuffer = Buffer.concat(chunks);
          resolve(cleanDockerOutput(fullBuffer));
        });
        stream.on('error', () => resolve(''));
      });
      execLogs += out;
    }

    if (chatId) {
      const chatSession = await DevOpsChat.findById(chatId);
      if (chatSession) {
        // Clear the pending action on the user prompt or last message
        const msg = chatSession.messages.find(m => m.pendingAction && m.pendingAction.commands && m.pendingAction.commands.length > 0);
        if (msg) {
          msg.pendingAction = undefined;
          await chatSession.save();
        }

        // Check if there is a saved ReAct loop state to resume
        const { getWorkingMemory } = require('../services/agent-memory.service');
        const savedState = await getWorkingMemory(chatId, 'react_loop_state');
        
        if (savedState) {
          const { runAgentChatLoop } = require('../services/agent-loop.service');
          // Resume the loop using the execLogs as the new observations
          const resumeDisplayName = req.user
            ? (req.user.githubUsername
                ? `${req.user.email} (${req.user.githubUsername})`
                : req.user.email)
            : 'Anonymous';
          const result = await runAgentChatLoop(deployment, chatSession, '', execLogs, resumeDisplayName);
          
          chatSession.messages.push({
            role: 'agent',
            text: result.message,
            pendingAction: result.pendingExec ? { commands: result.commands } : undefined,
            patches: result.patches
          });
          await chatSession.save();

          return res.json({
            execLogs,
            message: result.message,
            pendingExec: result.pendingExec,
            commands: result.commands,
            patches: result.patches,
            chatId: result.chatId
          });
        } else {
          // Fallback: append logs to the last message if no loop state is present
          if (msg) {
            msg.text += `\n\n**[AI Agent Terminal Output]:**\n\`\`\`bash${execLogs}\`\`\``;
            await chatSession.save();
          }
        }
      }
    }
    
    res.json({ execLogs });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getChats = async (req, res) => {
  try {
    const chats = await DevOpsChat.find({ deploymentId: req.params.id })
      .select('title createdAt updatedAt')
      .sort({ updatedAt: -1 });
    res.json(chats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createChat = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const { title } = req.body;
    const newChat = new DevOpsChat({
      deploymentId: deployment._id,
      title: title || 'New Chat Thread',
      messages: [
        {
          role: 'agent',
          text: 'Hello! I am your container DevOps AI Agent. I can help you seed the database, edit workspace code in real-time, or run Node.js/Shell scripts inside the preview container. Try clicking "Quick Prompts" below!'
        }
      ]
    });
    
    await newChat.save();
    res.status(201).json(newChat);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getChatMessages = async (req, res) => {
  try {
    const chat = await DevOpsChat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ message: 'Chat thread not found' });
    
    res.json(chat);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const isCommandSafe = (command) => {
  if (!command || typeof command !== 'string') return false;
  
  const cmd = command.toLowerCase().trim();
  
  if (/\brm\s+-[a-z]*r[a-z]*\s+(\/($|\s|\*)|(\.\.)($|\s)|\*)/.test(cmd)) return false;
  
  if (/\b(nc|netcat|ncat)\b/.test(cmd)) return false;
  if (cmd.includes('/dev/tcp') || cmd.includes('/dev/udp')) return false;
  if (cmd.includes('bash -i') || cmd.includes('sh -i')) return false;
  
  if (cmd.includes('docker ') || cmd.includes('docker.sock')) return false;
  
  if (/\b(mkfs|dd|fdisk|parted)\b/.test(cmd) && (cmd.includes('/dev/') || cmd.includes('of='))) return false;
  
  if (cmd.includes('/etc/passwd') || cmd.includes('/etc/shadow') || cmd.includes('/etc/gshadow') || cmd.includes('/etc/group')) return false;
  
  if (cmd.includes(':(){') || cmd.includes(':|:&')) return false;

  return true;
};

const validateDbRecord = async (container, dbType, dbName, collection, record, deployment) => {
  const runExec = async (cmd) => {
    const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
    const stream = await exec.start();
    return new Promise((resolve) => {
      const chunks = [];
      stream.on('data', chunk => { chunks.push(chunk); });
      stream.on('end', () => {
        const fullBuffer = Buffer.concat(chunks);
        resolve(cleanDockerOutput(fullBuffer).trim());
      });
      stream.on('error', () => resolve(''));
    });
  };

  if (dbType === 'sqlite') {
    const cmd = ['sh', '-c', `sqliteFile=$(find /workspace -name "*.sqlite" -o -name "*.sqlite3" -o -name "*.db" | head -n 1); if [ -z "$sqliteFile" ]; then sqliteFile="/workspace/preview_db.sqlite3"; fi; sqlite3 -header -json "$sqliteFile" "PRAGMA table_info(\`${collection}\`);"`];
    const output = await runExec(cmd);
    try {
      const cols = JSON.parse(output);
      if (!Array.isArray(cols) || cols.length === 0) return null;
      for (const col of cols) {
        const val = record[col.name];
        if (col.notnull && (val === undefined || val === null) && col.dflt_value === null && !col.pk) {
          throw new Error(`Field '${col.name}' is required and cannot be null.`);
        }
        if (val !== undefined && val !== null) {
          const type = col.type.toUpperCase();
          if ((type.includes('INT') || type.includes('NUM') || type.includes('REAL') || type.includes('DOUBLE') || type.includes('FLOAT')) && isNaN(Number(val))) {
            throw new Error(`Invalid type for field '${col.name}': expected number, got "${typeof val}".`);
          }
        }
      }
    } catch (e) {
      if (e.message.includes('required') || e.message.includes('Invalid type')) throw e;
    }
  } else if (dbType === 'postgres') {
    const query = `SELECT json_agg(t) FROM (SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = '${collection}') t;`;
    const cmd = ['psql', '-U', 'postgres', '-d', dbName, '-t', '-c', query];
    const output = await runExec(cmd);
    try {
      const cols = JSON.parse(output);
      if (!Array.isArray(cols) || cols.length === 0) return null;
      for (const col of cols) {
        const val = record[col.column_name];
        // Skip NOT NULL check for serial/sequence columns (auto-generated PKs and sequences)
        const isSerial = col.column_default && col.column_default.includes('nextval(');
        if (col.is_nullable === 'NO' && !isSerial && (val === undefined || val === null)) {
          throw new Error(`Field '${col.column_name}' is required and cannot be null.`);
        }
        if (val !== undefined && val !== null) {
          const type = col.data_type.toLowerCase();
          if ((type.includes('int') || type.includes('decimal') || type.includes('numeric') || type.includes('double') || type.includes('real')) && isNaN(Number(val))) {
            throw new Error(`Invalid type for field '${col.column_name}': expected number, got "${typeof val}".`);
          }
        }
      }
    } catch (e) {
      if (e.message.includes('required') || e.message.includes('Invalid type')) throw e;
    }
  } else if (dbType === 'mysql' || dbType === 'mariadb') {
    const query = `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='${dbName}' AND TABLE_NAME='${collection}';`;
    const cmd = ['mysql', '-u', 'root', '-D', dbName, '-e', query, '-B'];
    const output = await runExec(cmd);
    const lines = output.split('\n').filter(Boolean);
    if (lines.length > 1) {
      const headers = lines[0].split('\t');
      const cols = lines.slice(1).map(line => {
        const values = line.split('\t');
        const obj = {};
        headers.forEach((h, i) => { obj[h] = values[i] || null; });
        return obj;
      });
      for (const col of cols) {
        const colName = col.COLUMN_NAME;
        const val = record[colName];
        if (col.IS_NULLABLE === 'NO' && (val === undefined || val === null)) {
          throw new Error(`Field '${colName}' is required and cannot be null.`);
        }
        if (val !== undefined && val !== null) {
          const type = col.DATA_TYPE.toLowerCase();
          if ((type.includes('int') || type.includes('decimal') || type.includes('float') || type.includes('double') || type.includes('numeric')) && isNaN(Number(val))) {
            throw new Error(`Invalid type for field '${colName}': expected number, got "${typeof val}".`);
          }
        }
      }
    }
  } else if (dbType === 'mongodb') {
    const remoteUri = deployment ? await getRemoteMongoUri(deployment) : null;
    const connectionString = remoteUri || dbName;
    const delimiter = '__DB_QUERY_EOF__';
    const query = `print(JSON.stringify(db.${collection}.find().limit(5).toArray()))`;
    const cmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/infer.js\n${query}\n${delimiter}\nmongosh "${connectionString}" --quiet /tmp/infer.js`];
    const output = await runExec(cmd);
    try {
      const docs = JSON.parse(output);
      if (Array.isArray(docs) && docs.length > 0) {
        const representativeDoc = docs[0];
        for (const [key, val] of Object.entries(record)) {
          if (representativeDoc[key] !== undefined && representativeDoc[key] !== null) {
            const expectedType = typeof representativeDoc[key];
            const actualType = typeof val;
            if (expectedType !== actualType && expectedType !== 'object' && actualType !== 'object') {
              throw new Error(`Invalid type for field '${key}': expected ${expectedType}, got ${actualType}.`);
            }
          }
        }
      }
    } catch (e) {
      if (e.message.includes('Invalid type')) throw e;
    }
  } else if (dbType === 'mssql') {
    const query = `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${collection}' FOR JSON PATH;`;
    const cmd = ['/opt/mssql-tools/bin/sqlcmd', '-S', 'localhost', '-U', 'sa', '-P', 'Sa_password123', '-C', '-d', dbName, '-Q', query, '-y', '0'];
    const output = await runExec(cmd);
    try {
      const startIdx = output.indexOf('[');
      const endIdx = output.lastIndexOf(']');
      if (startIdx !== -1 && endIdx !== -1) {
        const cols = JSON.parse(output.substring(startIdx, endIdx + 1));
        if (Array.isArray(cols)) {
          for (const col of cols) {
            const val = record[col.COLUMN_NAME];
            if (col.IS_NULLABLE === 'NO' && (val === undefined || val === null)) {
              throw new Error(`Field '${col.COLUMN_NAME}' is required and cannot be null.`);
            }
            if (val !== undefined && val !== null) {
              const type = col.DATA_TYPE.toLowerCase();
              if ((type.includes('int') || type.includes('decimal') || type.includes('numeric') || type.includes('float') || type.includes('double') || type.includes('real')) && isNaN(Number(val))) {
                throw new Error(`Invalid type for field '${col.COLUMN_NAME}': expected number, got "${typeof val}".`);
              }
            }
          }
        }
      }
    } catch (e) {
      if (e.message.includes('required') || e.message.includes('Invalid type')) throw e;
    }
  } else if (dbType === 'oracle') {
    const query = `SET PAGESIZE 0 FEEDBACK OFF HEADING OFF;\nSELECT column_name, data_type, nullable FROM user_tab_columns WHERE table_name = '${collection.toUpperCase()}';\nEXIT;`;
    const delimiter = '__DB_QUERY_EOF__';
    const cmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/infer.sql\n${query}\n${delimiter}\nsqlplus -S system/oracle_password123@localhost/XE @/tmp/infer.sql`];
    const output = await runExec(cmd);
    const lines = output.split('\n').map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 3) {
        const colName = parts[0];
        const dataType = parts[1].toLowerCase();
        const nullable = parts[2]; // 'Y' or 'N'
        const val = record[colName] || record[colName.toLowerCase()];
        if (nullable === 'N' && (val === undefined || val === null)) {
          throw new Error(`Field '${colName}' is required and cannot be null.`);
        }
        if (val !== undefined && val !== null) {
          if ((dataType.includes('number') || dataType.includes('float') || dataType.includes('double') || dataType.includes('numeric')) && isNaN(Number(val))) {
            throw new Error(`Invalid type for field '${colName}': expected number, got "${typeof val}".`);
          }
        }
      }
    }
  } else if (dbType === 'cassandra') {
    const query = `SELECT column_name, type FROM system_schema.columns WHERE keyspace_name = '${dbName}' AND table_name = '${collection}';`;
    const cmd = ['cqlsh', '-e', query];
    const output = await runExec(cmd);
    const lines = output.split('\n').filter(Boolean);
    if (lines.length > 3) {
      const cols = lines.slice(3).map(line => {
        const parts = line.split('|').map(s => s.trim());
        return { name: parts[0], type: parts[1] || '' };
      });
      for (const col of cols) {
        if (!col.name) continue;
        const val = record[col.name];
        if (val !== undefined && val !== null) {
          const type = col.type.toLowerCase();
          if ((type.includes('int') || type.includes('float') || type.includes('double') || type.includes('decimal') || type.includes('counter')) && isNaN(Number(val))) {
            throw new Error(`Invalid type for field '${col.name}': expected number, got "${typeof val}".`);
          }
        }
      }
    }
  }
};

const maskPIIData = (data) => {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) {
    return data.map(item => maskPIIData(item));
  }
  if (typeof data === 'object') {
    const masked = {};
    for (const [key, val] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (typeof val === 'string') {
        if (lowerKey.includes('email') || lowerKey.includes('mail')) {
          masked[key] = val.replace(/^([^@]+)@(.+)$/, (m, p1, p2) => {
            const visible = p1.substring(0, Math.min(2, p1.length));
            return visible + '***@' + p2;
          });
        } else if (lowerKey.includes('phone') || lowerKey.includes('telephone') || lowerKey.includes('mobile') || lowerKey.includes('cell')) {
          masked[key] = '[MASKED_PHONE]';
        } else if (lowerKey.includes('password') || lowerKey.includes('pwd') || lowerKey.includes('passwd')) {
          masked[key] = '[MASKED_PASSWORD]';
        } else if (lowerKey.includes('ssn') || lowerKey.includes('socialsecurity')) {
          masked[key] = '[MASKED_SSN]';
        } else if (lowerKey.includes('card') || lowerKey.includes('creditcard') || lowerKey.includes('cvv')) {
          masked[key] = '[MASKED_CARD]';
        } else if (
          lowerKey === 'name' || 
          lowerKey === 'firstname' || 
          lowerKey === 'lastname' || 
          lowerKey === 'fullname' || 
          lowerKey === 'username'
        ) {
          masked[key] = val.split(' ').map(part => {
            if (part.length <= 1) return part;
            return part[0] + '***';
          }).join(' ');
        } else if (
          lowerKey.includes('address') || 
          lowerKey.includes('street') || 
          lowerKey.includes('city') || 
          lowerKey.includes('zip') || 
          lowerKey.includes('postcode')
        ) {
          masked[key] = '[MASKED_ADDRESS]';
        } else {
          masked[key] = val;
        }
      } else if (typeof val === 'object' && val !== null) {
        masked[key] = maskPIIData(val);
      } else {
        masked[key] = val;
      }
    }
    return masked;
  }
  return data;
};

module.exports = {
  executeDeploymentDbQuery,
  getDeployments,
  createDeployment,
  updateDeploymentStatus,
  uploadZip,
  getDeploymentStatus,
  downloadArtifact,
  getSuggestedPort,
  getActivePreviews,
  stopDeploymentPreview,
  startDeploymentPreview,
  deleteDeployment,
  listFixtures,
  generateFixture,
  downloadPdfReport,
  getFixtureReviews,
  createFixtureReview,
  changeDeploymentPort,
  getWorkspaceFiles,
  getWorkspaceFileContent,
  saveWorkspaceFile,
  getDbCollections,
  getDbCollectionData,
  insertDbRecord,
  updateDbRecord,
  deleteDbRecord,
  executeAgentChat,
  rollbackAgentPatches,
  updateAgentPermission,
  undoChatMessages,
  executePendingCommands,
  getChats,
  createChat,
  getChatMessages,
};

const updateCollaboratorPermissions = async (req, res) => {
  try {
    const { id } = req.params;
    const { allowCollaboratorVisibility, allowCollaboratorBuild, allowCollaboratorEditPort, allowCollaboratorDelete, allowCollaboratorChat } = req.body;
    const deployment = await Deployment.findById(id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    // Only owner can update permissions
    if (!deployment.deployedBy || deployment.deployedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Only the project creator can modify collaborator permissions.' });
    }
    
    if (deployment.githubPermissions) {
      if (allowCollaboratorVisibility !== undefined) deployment.githubPermissions.allowCollaboratorVisibility = allowCollaboratorVisibility;
      if (allowCollaboratorBuild      !== undefined) deployment.githubPermissions.allowCollaboratorBuild      = allowCollaboratorBuild;
      if (allowCollaboratorEditPort   !== undefined) deployment.githubPermissions.allowCollaboratorEditPort   = allowCollaboratorEditPort;
      if (allowCollaboratorDelete     !== undefined) deployment.githubPermissions.allowCollaboratorDelete     = allowCollaboratorDelete;
      if (allowCollaboratorChat       !== undefined) deployment.githubPermissions.allowCollaboratorChat       = allowCollaboratorChat;
      deployment.markModified('githubPermissions');
    }
    
    await deployment.save();
    res.json({ message: 'Permissions updated successfully.', githubPermissions: deployment.githubPermissions });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const syncGithubCollaborators = async (req, res) => {
  try {
    const { id } = req.params;
    const deployment = await Deployment.findById(id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    if (deployment.deploymentType !== 'github' || !deployment.githubRepo) {
      return res.status(400).json({ message: 'Not a GitHub deployment.' });
    }
    
    const User = require('../models/User');
    const Admin = require('../models/Admin');
    let owner = await User.findById(deployment.deployedBy).select('+githubAccessToken');
    if (!owner) {
      owner = await Admin.findById(deployment.deployedBy).select('+githubAccessToken');
    }
    const token = owner?.githubAccessToken;
    if (!token) {
      return res.status(400).json({ message: 'GitHub link not found for the project creator.' });
    }
    
    const [repoOwner, repoName] = deployment.githubRepo.split('/');
    const axios = require('axios');
    const collabsRes = await axios.get(`https://api.github.com/repos/${repoOwner}/${repoName}/collaborators`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'IDPS-DevOps',
        Accept: 'application/vnd.github.v3+json',
      }
    });
    
    if (Array.isArray(collabsRes.data)) {
      deployment.collaborators = collabsRes.data.map(c => c.login);
      await deployment.save();
      return res.json({ message: 'Collaborators synced successfully.', collaborators: deployment.collaborators });
    }
    res.status(500).json({ message: 'Failed to fetch collaborators list.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const downloadSecureEnvPdf = async (req, res) => {
  try {
    const { id } = req.params;
    const deployment = await Deployment.findById(id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const password = `DevOps-Env-${deployment.jobId.slice(0, 6)}`;
    
    const doc = new PDFDocument({
      userPassword: password,
      ownerPassword: 'ownerSecretPassword123',
      permissions: {
        printing: 'lowResolution',
        modifying: 'none',
        copying: 'none'
      }
    });
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${deployment.projectName}-secure-env.pdf"`);
    doc.pipe(res);
    
    // Write PDF content
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#06b6d4').text('DevOps Secure Environment Variables', { align: 'center' });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).fillColor('#9ca3af').text(`Project: ${deployment.projectName}`, { align: 'center' });
    doc.text(`Job ID: ${deployment.jobId}`, { align: 'center' });
    doc.text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(1.5);
    
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#10b981').text('Decrypted Environment Variables');
    doc.moveDown(0.5);
    
    if (!deployment.envFiles || deployment.envFiles.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(11).fillColor('#ef4444').text('No environment variables found for this sandbox.');
    } else {
      for (const file of deployment.envFiles) {
        doc.font('Helvetica-Bold').fontSize(12).fillColor('#10b981').text(`File: ${file.path}`);
        doc.moveDown(0.2);
        
        const contentLines = (file.content || '').split('\n');
        doc.font('Courier').fontSize(10).fillColor('#1f2937');
        for (const line of contentLines) {
          doc.text(line);
        }
        doc.moveDown(1);
      }
    }
    
    doc.end();
  } catch (err) {
    console.error('Error generating secure env PDF:', err);
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  executeDeploymentDbQuery,
  getDeployments,
  createDeployment,
  updateDeploymentStatus,
  uploadZip,
  getDeploymentStatus,
  downloadArtifact,
  getSuggestedPort,
  getActivePreviews,
  stopDeploymentPreview,
  startDeploymentPreview,
  deleteDeployment,
  listFixtures,
  generateFixture,
  downloadPdfReport,
  getFixtureReviews,
  createFixtureReview,
  changeDeploymentPort,
  getWorkspaceFiles,
  getWorkspaceFileContent,
  saveWorkspaceFile,
  getDbCollections,
  getDbCollectionData,
  insertDbRecord,
  updateDbRecord,
  deleteDbRecord,
  executeAgentChat,
  rollbackAgentPatches,
  updateAgentPermission,
  undoChatMessages,
  executePendingCommands,
  getChats,
  createChat,
  getChatMessages,
  updateCollaboratorPermissions,
  syncGithubCollaborators,
  downloadSecureEnvPdf
};