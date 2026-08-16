const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const Deployment = require('../models/Deployment');
const FixtureReview = require('../models/FixtureReview');
const upload = require('../middleware/upload.middleware');
const { runPipeline } = require('../services/pipeline-runner.service');
const { suggestPort, stopPreview, getRunningPreviews } = require('../services/process-manager.service');

// ─── Existing handlers ────────────────────────────────────────────────────────

const getDeployments = async (req, res) => {
  try {
    const deployments = await Deployment.find({}, '-envFiles.content')
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
    res.json({
      id: deployment._id,
      projectName: deployment.projectName,
      techStackDetected: deployment.techStackDetected,
      architectureDetected: deployment.architectureDetected,
      status: deployment.status,
      vulnerabilitiesFound: deployment.vulnerabilitiesFound,
      buildLogs: deployment.buildLogs,
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
      const writeAndRunCmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/run.sql\n${query}\n${delimiter}\nmysql -u root -D "${dbName}" < /tmp/run.sql`];
      output = await runExecWithTimeout(writeAndRunCmd, 15000);
    } else if (dbType === 'postgres') {
      const writeAndRunCmd = ['sh', '-c', `cat << '${delimiter}' > /tmp/run.sql\n${query}\n${delimiter}\npsql -U postgres -d "${dbName}" < /tmp/run.sql`];
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
};