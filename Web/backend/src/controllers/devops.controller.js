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
    const deployments = await Deployment.find({}, '-envFiles.content -buildLogs')
      .populate('deployedBy', 'firstName lastName email role')
      .sort({ createdAt: -1 });
    res.json(deployments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createDeployment = async (req, res) => {
  try {
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
      const jobId = crypto.randomUUID();
      const projectName = req.body.projectName || path.basename(req.file.originalname, '.zip');
      const sessionId = req.body.sessionId || '';

      // Parse preview port — default to 3001 if not provided or invalid
      let previewPort = parseInt(req.body.previewPort, 10);
      if (!previewPort || previewPort < 1024 || previewPort > 65535) {
        previewPort = await suggestPort() || 3001;
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
    const port = await suggestPort();
    if (!port) return res.status(503).json({ message: 'No available ports in range 3001-3999.' });
    res.json({ port });
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

    // Get or allocate port
    let previewPort = deployment.previewPort;
    if (!previewPort) {
      previewPort = await suggestPort() || 3001;
      deployment.previewPort = previewPort;
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
      await stopPreview(deployment.jobId);
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
    await stopPreview(deployment.jobId);

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
          content = content.replace(/(PORT|SERVER_PORT|APP_PORT|HTTP_PORT)=\d+/gi, `$1=${newPort}`);
          
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
  } catch (error) {
    console.error('Error changing port:', error);
    res.status(500).json({ message: error.message });
  }
};


const executeDeploymentDbQuery = async (req, res) => {
  const { id } = req.params;
  const { query, dbType } = req.body;
  
  console.log(`[QUERY RUNNER] Running query against DB ${dbType} for deployment ${id}`);
  
  try {
    const deployment = await Deployment.findById(id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const jobId = deployment.jobId;
    const dbContainerName = `devops-db-${dbType}-${jobId}`;

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
    if (dbType === 'mysql') {
      const wrappedQuery = `START TRANSACTION;\n${query}\nCOMMIT;`;
      const writeAndRunCmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/run.sql\n${wrappedQuery}\n${delimiter}\nmysql -u root --bail -D "${dbName}" < /tmp/run.sql`];
      output = await runExecWithTimeout(writeAndRunCmd, 15000);
    } else if (dbType === 'postgres') {
      const writeAndRunCmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/run.sql\n${query}\n${delimiter}\npsql -U postgres -d "${dbName}" --single-transaction < /tmp/run.sql`];
      output = await runExecWithTimeout(writeAndRunCmd, 15000);
    } else if (dbType === 'mongodb') {
      const writeAndRunCmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/run.js\n${query}\n${delimiter}\nmongosh "${dbName}" --quiet /tmp/run.js`];
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
        if (file === 'node_modules' || file === '.git' || file === 'dist' || file === 'build') continue;
        const fullPath = path.join(dirPath, file);
        const relPath = path.join(relativeDir, file).replace(/\\/g, '/');
        const isDir = fs.statSync(fullPath).isDirectory();
        
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
      const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true });
      const stream = await exec.start();
      return new Promise((resolve) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', () => resolve(output.trim()));
        stream.on('error', () => resolve(''));
      });
    };
    
    const dbName = 'preview_db';
    if (dbType === 'mongodb') {
      const delimiter = '__DB_QUERY_EOF__';
      const query = `printjson(db.getCollectionNames())`;
      const cmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/collections.js\n${query}\n${delimiter}\nmongosh "${dbName}" --quiet /tmp/collections.js`];
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
      const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true });
      const stream = await exec.start();
      return new Promise((resolve) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', () => resolve(output.trim()));
        stream.on('error', () => resolve(''));
      });
    };
    
    const dbName = 'preview_db';
    if (dbType === 'mongodb') {
      const delimiter = '__DB_QUERY_EOF__';
      const query = `printjson(db.${collection}.find().limit(50).toArray())`;
      const cmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/docs.js\n${query}\n${delimiter}\nmongosh "${dbName}" --quiet /tmp/docs.js`];
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
      const query = `SELECT json_agg(t) FROM (SELECT * FROM "${collection}" LIMIT 50) t;`;
      const cmd = ['psql', '-U', 'postgres', '-d', dbName, '-t', '-c', query];
      const output = await runExec(cmd);
      try {
        const data = JSON.parse(output);
        return res.json(maskPIIData(data || []));
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
      const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true });
      const stream = await exec.start();
      return new Promise((resolve) => {
        let output = '';
        stream.on('data', chunk => { output += chunk.toString(); });
        stream.on('end', () => resolve(output.trim()));
        stream.on('error', () => resolve(''));
      });
    };
    
    const dbName = 'preview_db';

    try {
      await validateDbRecord(container, dbType, dbName, collection, record);
    } catch (valErr) {
      return res.status(400).json({ message: `Validation Failed: ${valErr.message}` });
    }

    if (dbType === 'mongodb') {
      const delimiter = '__DB_QUERY_EOF__';
      const query = `printjson(db.${collection}.insertOne(${JSON.stringify(record)}))`;
      const cmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/insert.js\n${query}\n${delimiter}\nmongosh "${dbName}" --quiet /tmp/insert.js`];
      const output = await runExec(cmd);
      return res.json({ success: true, output });
    } else if (dbType === 'mysql' || dbType === 'mariadb' || dbType === 'postgres' || dbType === 'sqlite') {
      const keys = Object.keys(record);
      const values = Object.values(record).map(val => {
        if (val === null) return 'NULL';
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
      if (['node_modules', '.git', 'dist', 'build', '.security-reports'].includes(file)) continue;
      const fullPath = path.join(dirPath, file);
      const relPath = path.join(relativeDir, file).replace(/\\/g, '/');
      if (fs.statSync(fullPath).isDirectory()) {
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
    
    const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
    const extractDir = path.join(WORKSPACE_DIR, 'DevOps', 'builds', deployment.jobId);
    
    const { message, chatId } = req.body;
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

    // Read package.json to understand workspace dependencies
    let pkgDetails = 'No package.json found';
    try {
      const pkgPath = path.join(extractDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        pkgDetails = fs.readFileSync(pkgPath, 'utf8');
      } else {
        const serverPkgPath = path.join(extractDir, 'server', 'package.json');
        if (fs.existsSync(serverPkgPath)) {
          pkgDetails = fs.readFileSync(serverPkgPath, 'utf8');
        }
      }
    } catch (_) {}

    const axios = require('axios');
    const flatFilesList = getFlatWorkspaceFiles(extractDir);
    const systemPrompt = `You are a DevOps AI Developer Assistant inside a container workspace environment.
You help developers write code, design databases, and perform operational tasks like database seeding, record insertion, or workspace script execution.

Current context:
- Project Tech Stack: ${deployment.techStackDetected || 'MERN'}
- Database type: ${deployment.dbInitType || 'mongodb'}
- Project Package Details:
${pkgDetails}

Current Workspace Files Structure:
${flatFilesList.map(f => ` - ${f}`).join('\n')}

YOUR DYNAMIC ABILITIES:
1. File patches: You can create or modify files inside the container's workspace. Wrap the full content inside a <patch file="relative/path/to/file">...</patch> tag. Make sure the relative path is correct.
2. Executing scripts/commands: You can run terminal commands directly inside the active preview container. Wrap the command inside an <exec command="command" /> tag.
   - Example: To read a model schema file, use <exec command="cat server/models/Product.js" /> to print the schema content to the terminal output before writing seed scripts.
   - Example: To install an npm package, use <exec command="npm install package" />
3. TOKEN EFFICIENCY & COMPATIBILITY REQUIREMENT: If the user asks you to insert database data, do NOT write massive JS loops or hardcode queries inside application controllers. Instead, create a standalone seeding script (e.g. seed.js) using a <patch> tag, and trigger it using an <exec> tag.
   - CRITICAL WARNING & RUNTIME CONSTRAINTS: 
     * Node.js (node, npm) is INSTALLED and AVAILABLE inside the container.
     * Python (python, python3) is NOT INSTALLED inside the container.
     * Under no circumstances should you generate Python scripts or run python commands inside this container. If you need to seed the database, write helper scripts, or execute operations, ALWAYS write them in plain JavaScript (e.g. seed.js) and run them with 'node seed.js'.
     * The preview container does NOT have 'ts-node' installed. Do not output typescript scripts to run via ts-node.
     * CRITICAL DATABASE RESOLUTION: The database server is NOT running on localhost inside this container. To connect to the database inside your scripts (e.g. seed.js), ALWAYS read the environment variables (like MONGODB_URI, DB_HOST, PGHOST, etc.) which are already configured with the correct network hostname, or use the container network hostname:
       - MongoDB: \`mongodb://devops-db-mongodb-${deployment.jobId}:27017/preview_db\`
       - PostgreSQL: \`postgresql://postgres@devops-db-postgres-${deployment.jobId}:5432/preview_db\`
       - MySQL: \`mysql://root@devops-db-mysql-${deployment.jobId}:3306/preview_db\`
4. HIDING REASONING IN THE UI:
   If you want to brainstorm, write down steps, think, or reason before outputting your final answer, you MUST wrap that entire thinking process inside a <thought>...</thought> block (or <thinking>...</thinking> block).
   Only write the final, user-facing instructions, markdown explanations, and executable tags (<exec> or <patch>) outside of the thought blocks.
5. AUTONOMOUS FILE SEARCH & PROACTIVE READ OPERATIONS:
   - When a user asks you to locate, view, read, show, or check a file (e.g. "show me nodemon.json" or "find nodemon.json"), you must NOT tell the user how to do it or write down regex explanations.
   - Instead, you MUST immediately output an <exec command="..." /> tag to search the filesystem (using command keywords like \`find . -name "nodemon.json"\` or \`find /workspace -name "*nodemon*"\` or \`grep -r "pattern" .\`) or print the file content (\`cat <path>\`).
   - If a file is not in the initial workspace file listing, use search commands autonomously. Read operations are always allowed on this sandbox, so search and inspect files proactively to solve tasks!

Explain clearly what changes you have made and summarize any execution stdout/stderr results.`;

    const userPrompt = `User Prompt: ${message}`;
    
    let url = '';
    let headers = { 'Content-Type': 'application/json' };
    let model = '';
    let isOllama = false;

    const groqKey = process.env.GROQ_API_KEY;
    const hfKey = process.env.HUGGINGFACE_API_KEY;

    if (groqKey && groqKey.trim() !== '') {
      url = 'https://api.groq.com/openai/v1/chat/completions';
      headers['Authorization'] = `Bearer ${groqKey}`;
      model = process.env.GROQ_MODEL || 'qwen-2.5-coder-32b';
    } else if (hfKey && hfKey.trim() !== '') {
      url = 'https://api-inference.huggingface.co/v1/chat/completions';
      headers['Authorization'] = `Bearer ${hfKey}`;
      model = process.env.HUGGINGFACE_MODEL || 'Qwen/Qwen2.5-Coder-32B-Instruct';
    } else {
      const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
      url = `${ollamaHost}/v1/chat/completions`;
      model = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
      isOllama = true;
    }

    // Convert persistent message logs to Chat Completion context history
    const formattedHistory = chatSession.messages.map(m => ({
      role: m.role === 'agent' ? 'assistant' : 'user',
      content: m.text
    })).slice(-15);

    const payload = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...formattedHistory,
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2
    };

    if (isOllama) {
      payload.options = { num_ctx: 32768 };
    }

    const response = await axios.post(url, payload, { headers, timeout: 90000 });
    const assistantText = response.data.choices[0].message.content;

    // Parse and apply <patch> tags
    const patches = [];
    const blockedPatches = [];
    const patchRegex = /<patch\s+file="([^"]+)">([\s\S]*?)<\/patch>/g;
    let match;
    const { scanContentForCredentials } = require('../services/credential-scanner.service');
    while ((match = patchRegex.exec(assistantText)) !== null) {
      const relPath = match[1];
      const code = match[2];
      const targetAbsPath = path.resolve(extractDir, relPath);
      if (targetAbsPath.startsWith(path.resolve(extractDir))) {
        const findings = scanContentForCredentials(code, relPath);
        if (findings.length > 0) {
          blockedPatches.push({ file: relPath, findings });
          continue;
        }
        fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
        fs.writeFileSync(targetAbsPath, code, 'utf8');
        patches.push(relPath);
      }
    }

    let patchesReport = '';
    if (patches.length > 0) {
      patchesReport += `\n\n**[AI Agent applied patches to files]:**\n${patches.map(p => ` - \`${p}\``).join('\n')}`;
    }
    if (blockedPatches.length > 0) {
      patchesReport += `\n\n⚠️ **[AI Agent Security Notice - Secret Leak Blocked]:**\nPatches to the following files were blocked because they contained hardcoded secrets/credentials:\n${blockedPatches.map(bp => ` - \`${bp.file}\` (Detected: ${bp.findings.map(f => f.type).join(', ')})`).join('\n')}\nPlease use environment variables instead.`;
    }

    const execRegex = /<exec\s+command="([^"]+)"\s*\/>/g;
    const commandsToRun = [];
    while ((match = execRegex.exec(assistantText)) !== null) {
      commandsToRun.push(match[1]);
    }

    const unsafeCommands = [];
    const safeCommandsToRun = [];
    for (const cmd of commandsToRun) {
      if (isCommandSafe(cmd)) {
        safeCommandsToRun.push(cmd);
      } else {
        unsafeCommands.push(cmd);
      }
    }

    let guardrailReport = '';
    if (unsafeCommands.length > 0) {
      guardrailReport += `\n\n⚠️ **[AI Agent Security Notice - Execution Blocked]:**\nThe following commands were blocked by Outbound Guardrails as they contained potentially unsafe operations:\n${unsafeCommands.map(c => ` - \`${c}\``).join('\n')}`;
    }

    // Push user query to DB first
    chatSession.messages.push({
      role: 'user',
      text: message
    });

    const readOnlyCommands = [];
    const cudCommands = [];
    for (const cmd of safeCommandsToRun) {
      if (isReadOnlyCommand(cmd)) {
        readOnlyCommands.push(cmd);
      } else {
        cudCommands.push(cmd);
      }
    }

    // Run read-only commands automatically
    let readLogs = '';
    if (readOnlyCommands.length > 0) {
      const Docker = require('dockerode');
      const activeDocker = new Docker();
      const targetContainerName = `devops-preview-${deployment.jobId}`;
      const container = activeDocker.getContainer(targetContainerName);
      
      let isContainerRunning = false;
      try {
        const inspect = await container.inspect();
        isContainerRunning = inspect.State.Running;
      } catch (_) {}

      for (const cmd of readOnlyCommands) {
        readLogs += `\n$ ${cmd}\n`;
        if (isContainerRunning) {
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
          readLogs += out;
        } else {
          readLogs += `Execution blocked: Preview container is offline.\n`;
        }
      }
    }

    let currentMessage = assistantText + patchesReport + guardrailReport;
    if (readLogs) {
      currentMessage += `\n\n**[AI Agent Terminal Output]:**\n\`\`\`bash${readLogs}\`\`\``;
    }

    const execPermission = deployment.execPermission || 'ask';

    if (cudCommands.length > 0) {
      if (execPermission === 'never') {
        const finalMessage = currentMessage + `\n\n**[AI Agent Terminal Output]:**\n\`\`\`bash\n[Execution blocked: User has disabled command execution for this agent]\n\`\`\``;
        
        chatSession.messages.push({
          role: 'agent',
          text: finalMessage
        });
        await chatSession.save();

        return res.json({ 
          message: finalMessage, 
          pendingExec: false, 
          commands: [], 
          patches,
          chatId: chatSession._id
        });
      }

      if (execPermission === 'ask') {
        chatSession.messages.push({
          role: 'agent',
          text: currentMessage,
          pendingAction: { commands: cudCommands }
        });
        await chatSession.save();

        return res.json({ 
          message: currentMessage, 
          pendingExec: true, 
          commands: cudCommands, 
          patches,
          chatId: chatSession._id
        });
      }
    }

    // Default to running if permission is 'always' or no CUD commands
    let cudLogs = '';
    if (cudCommands.length > 0 && execPermission === 'always') {
      const Docker = require('dockerode');
      const activeDocker = new Docker();
      const targetContainerName = `devops-preview-${deployment.jobId}`;
      const container = activeDocker.getContainer(targetContainerName);
      
      let isContainerRunning = false;
      try {
        const inspect = await container.inspect();
        isContainerRunning = inspect.State.Running;
      } catch (_) {}

      for (const cmd of cudCommands) {
        cudLogs += `\n$ ${cmd}\n`;
        if (isContainerRunning) {
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
          cudLogs += out;
        } else {
          cudLogs += `Execution blocked: Preview container is offline. Please restart the sandbox from the DevOps Dashboard before executing commands.\n`;
        }
      }
    }

    let finalMessage = currentMessage;
    if (cudLogs) {
      finalMessage += `\n\n**[AI Agent Terminal Output]:**\n\`\`\`bash${cudLogs}\`\`\``;
    }

    chatSession.messages.push({
      role: 'agent',
      text: finalMessage
    });
    await chatSession.save();

    res.json({ message: finalMessage, pendingExec: false, commands: [], patches, chatId: chatSession._id });
  } catch (error) {
    console.error('Error in agent chat:', error);
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

const executePendingCommands = async (req, res) => {
  try {
    const deployment = await Deployment.findById(req.params.id);
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    
    const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
    const extractDir = path.join(WORKSPACE_DIR, 'DevOps', 'builds', deployment.jobId);
    
    const { commands, chatId } = req.body;
    if (!commands || !Array.isArray(commands)) {
      return res.status(400).json({ message: 'Commands array is required' });
    }
    
    const Docker = require('dockerode');
    const activeDocker = new Docker();
    const targetContainerName = `devops-preview-${deployment.jobId}`;
    const container = activeDocker.getContainer(targetContainerName);
    
    let execLogs = '';
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

    // Append logs to the specific message inside MongoDB chat session
    if (chatId) {
      const chatSession = await DevOpsChat.findById(chatId);
      if (chatSession) {
        const msg = chatSession.messages.find(m => m.pendingAction && m.pendingAction.commands && m.pendingAction.commands.length > 0);
        if (msg) {
          msg.text += `\n\n**[AI Agent Terminal Output]:**\n\`\`\`bash${execLogs}\`\`\``;
          msg.pendingAction = undefined; // clear pending action
          await chatSession.save();
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
          text: 'Hello! I am your container DevOps AI Agent. I can help you seed the database, edit workspace code in real-time, or run Python/Shell scripts inside the preview container. Try clicking "Quick Prompts" below!'
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

const validateDbRecord = async (container, dbType, dbName, collection, record) => {
  const runExec = async (cmd) => {
    const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true });
    const stream = await exec.start();
    return new Promise((resolve) => {
      let output = '';
      stream.on('data', chunk => { output += chunk.toString(); });
      stream.on('end', () => resolve(output.trim()));
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
    const query = `SELECT json_agg(t) FROM (SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${collection}') t;`;
    const cmd = ['psql', '-U', 'postgres', '-d', dbName, '-t', '-c', query];
    const output = await runExec(cmd);
    try {
      const cols = JSON.parse(output);
      if (!Array.isArray(cols) || cols.length === 0) return null;
      for (const col of cols) {
        const val = record[col.column_name];
        if (col.is_nullable === 'NO' && (val === undefined || val === null)) {
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
    const delimiter = '__DB_QUERY_EOF__';
    const query = `printjson(db.${collection}.find().limit(5).toArray())`;
    const cmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/infer.js\n${query}\n${delimiter}\nmongosh "${dbName}" --quiet /tmp/infer.js`];
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
  executeAgentChat,
  updateAgentPermission,
  executePendingCommands,
  getChats,
  createChat,
  getChatMessages,
};