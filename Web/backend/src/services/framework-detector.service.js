const fs = require('fs');
const path = require('path');

// ── Core / Full-Stack ────────────────────────────────────────────────────────
const mern = require('./frameworks/mern');
const spring = require('./frameworks/spring');
const django = require('./frameworks/django');
const rust = require('./frameworks/rust');
const php = require('./frameworks/php');

// ── New: Java Ecosystem ──────────────────────────────────────────────────────
const quarkus = require('./frameworks/quarkus');

// ── New: .NET / C# Ecosystem ─────────────────────────────────────────────────
const blazor = require('./frameworks/blazor');
const dotnet = require('./frameworks/dotnet');

// ── New: Elixir ──────────────────────────────────────────────────────────────
const phoenix = require('./frameworks/phoenix');

// ── New: Ruby Ecosystem ──────────────────────────────────────────────────────
const rails = require('./frameworks/rails');
const sinatra = require('./frameworks/sinatra');

// ── New: PHP Full-Stack ──────────────────────────────────────────────────────
const symfony = require('./frameworks/symfony');

// ── New: Deno Ecosystem ──────────────────────────────────────────────────────
const denoFresh = require('./frameworks/deno-fresh');
const deno = require('./frameworks/deno');

// ── New: Go Ecosystem ────────────────────────────────────────────────────────
const gin = require('./frameworks/gin');
const fiber = require('./frameworks/fiber');
const echoGo = require('./frameworks/echo-go');

// ── Frontend & Full-Stack ────────────────────────────────────────────────────
const nextjs = require('./frameworks/nextjs');
const sveltekit = require('./frameworks/sveltekit');
const svelte = require('./frameworks/svelte');
const nuxt = require('./frameworks/nuxt');
const astro = require('./frameworks/astro');
const remix = require('./frameworks/remix');
const vite = require('./frameworks/vite');
const cra = require('./frameworks/cra');
const gatsby = require('./frameworks/gatsby');
const angular = require('./frameworks/angular');
const vuecli = require('./frameworks/vuecli');
const hugo = require('./frameworks/hugo');
const eleventy = require('./frameworks/eleventy');

// ── New: Modern React Meta-Frameworks ────────────────────────────────────────
const tanstackStart = require('./frameworks/tanstack-start');
const analog = require('./frameworks/analog');

// ── Backend Stack ────────────────────────────────────────────────────────────
const fastapi = require('./frameworks/fastapi');
const flask = require('./frameworks/flask');
const fastify = require('./frameworks/fastify');
const elysia = require('./frameworks/elysia');
const hono = require('./frameworks/hono');
const koa = require('./frameworks/koa');
const h3 = require('./frameworks/h3');
const express = require('./frameworks/express');

// ── New: Bun Native ──────────────────────────────────────────────────────────
const bunNative = require('./frameworks/bun-native');

// ── Emerging & Other Stack ───────────────────────────────────────────────────
const nitro = require('./frameworks/nitro');
const blitz = require('./frameworks/blitz');
const redwood = require('./frameworks/redwood');
const qwik = require('./frameworks/qwik');
const solidstart = require('./frameworks/solidstart');
const marko = require('./frameworks/marko');
const preact = require('./frameworks/preact');
const staticAssets = require('./frameworks/static');

/**
 * Plugin execution order is CRITICAL.
 * More-specific plugins MUST come before broader catch-alls to avoid false positives.
 */
const plugins = [
  // ── Java (Quarkus before Spring — Quarkus also has pom.xml) ──
  quarkus, spring,
  // ── Other compiled languages ──
  rust,
  // ── .NET (Blazor before dotnet — Blazor is more specific csproj) ──
  blazor, dotnet,
  // ── Elixir ──
  phoenix,
  // ── Ruby (Rails before Sinatra) ──
  rails, sinatra,
  // ── PHP (Symfony before generic php) ──
  symfony, php,
  // ── Deno (Fresh before generic deno) ──
  denoFresh, deno,
  // ── Python backends (ordered: most-specific first) ──
  fastapi, flask, django,
  // ── Bun-native (elysia first, then plain bun) ──
  elysia, bunNative,
  // ── Modern React meta-frameworks ──
  tanstackStart, analog,
  // ── Full-Stack meta-frameworks (check before generic backends) ──
  nextjs, sveltekit, nuxt, astro, remix, blitz, redwood, solidstart,
  // ── Svelte standalone (after sveltekit — sveltekit is more specific) ──
  svelte,
  // ── Emerging / Component frameworks ──
  qwik, nitro, marko, preact,
  // ── Bundler-based frontends ──
  gatsby, cra, vite, angular, vuecli,
  // ── Static Site Generators ──
  hugo, eleventy,
  // ── Go backends (after all JS/TS frameworks) ──
  gin, fiber, echoGo,
  // ── Node.js backends (ordered: most-specific first) ──
  fastify, hono, koa, h3, express,
  // ── Full-stack Node (generic MERN — widest JS catch-all) ──
  mern,
  // ── Static HTML/CSS/JS (last framework check before generic fallback) ──
  staticAssets
];
const generic = require('./frameworks/generic');

/**
 * Scans directories, manifests, and package dependencies to differentiate
 * between monolithic and microservice architectures.
 */
const detectGeneralArchitecture = (targetDir) => {
  try {
    // 1. Check for docker-compose or kubernetes configuration defining multiple services
    const composePath = path.join(targetDir, 'docker-compose.yml');
    const composePathYaml = path.join(targetDir, 'docker-compose.yaml');
    if (fs.existsSync(composePath) || fs.existsSync(composePathYaml)) {
      return 'microservice';
    }
    const k8sPath = path.join(targetDir, 'k8s');
    if (fs.existsSync(k8sPath) && fs.statSync(k8sPath).isDirectory()) {
      return 'microservice';
    }

    // 2. Check for monorepos or multiple project roots
    const items = fs.readdirSync(targetDir);
    let serviceCount = 0;
    for (const item of items) {
      const fullPath = path.join(targetDir, item);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        if (item === 'node_modules' || item === '.git' || item === '.venv') continue;
        const subPkg = path.join(fullPath, 'package.json');
        const subReqs = path.join(fullPath, 'requirements.txt');
        const subCargo = path.join(fullPath, 'Cargo.toml');
        const subPom = path.join(fullPath, 'pom.xml');
        if (fs.existsSync(subPkg) || fs.existsSync(subReqs) || fs.existsSync(subCargo) || fs.existsSync(subPom)) {
          serviceCount++;
        }
      }
    }
    if (serviceCount > 1) {
      return 'microservice';
    }

    // 3. Scan package.json for microservice libraries
    const pkgPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      
      const microserviceDeps = [
        'amqplib', 'kafkajs', '@grpc/grpc-js', 'cote', 'hemera', 'seneca', 
        '@nestjs/microservices', 'eureka-js-client', 'redis', 'ioredis',
        'lerna', 'nx', 'turbo'
      ];
      
      if (microserviceDeps.some(d => deps[d])) {
        return 'microservice';
      }
      if (pkg.workspaces) {
        return 'microservice';
      }
    }

    // 4. Scan requirements.txt for python microservice libraries
    const reqPath = path.join(targetDir, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      const content = fs.readFileSync(reqPath, 'utf8').toLowerCase();
      const microservicePyDeps = ['celery', 'pika', 'kafka-python', 'aiokafka', 'grpcio', 'nameko'];
      if (microservicePyDeps.some(dep => content.includes(dep))) {
        return 'microservice';
      }
    }

    // 5. Scan Cargo.toml for rust microservice libraries
    const cargoPath = path.join(targetDir, 'Cargo.toml');
    if (fs.existsSync(cargoPath)) {
      const content = fs.readFileSync(cargoPath, 'utf8').toLowerCase();
      if (content.includes('tonic') || content.includes('rdkafka') || content.includes('lapin')) {
        return 'microservice';
      }
    }

    // 6. Scan pom.xml for java microservice libraries
    const pomPath = path.join(targetDir, 'pom.xml');
    if (fs.existsSync(pomPath)) {
      const content = fs.readFileSync(pomPath, 'utf8').toLowerCase();
      if (content.includes('spring-cloud') || content.includes('eureka') || content.includes('consul') || content.includes('zookeeper') || content.includes('grpc')) {
        return 'microservice';
      }
    }

    // 7. Check for gateway / proxy filenames
    for (const item of items) {
      if (item.toLowerCase().includes('gateway') || item.toLowerCase().includes('proxy')) {
        return 'microservice';
      }
    }
  } catch (_) {}
  
  return 'monolithic';
};

/**
 * Helper to check if a directory matches any modular plugin manifest.
 * Returns the framework details if found, otherwise null.
 */
const checkFrameworkManifests = (targetDir) => {
  for (const plugin of plugins) {
    if (plugin.detect(targetDir)) {
      const extraConfig = plugin.getConfig ? plugin.getConfig(targetDir) : {};
      const isGuiApp = plugin.detectGui ? plugin.detectGui(targetDir) : false;

      // Determine architecture
      let architecture = 'monolithic';
      if (plugin.detectArchitecture) {
        try {
          architecture = plugin.detectArchitecture(targetDir);
        } catch (_) {}
      } else {
        architecture = detectGeneralArchitecture(targetDir);
      }

      return {
        framework: plugin.id,
        architecture,
        buildImage: extraConfig.buildImage || plugin.buildImage,
        previewImage: extraConfig.previewImage || plugin.previewImage,
        runCommand: extraConfig.runCommand || plugin.runCommand,
        targetDir,
        isGuiApp
      };
    }
  }
  return null;
};

/**
 * Detects framework type from an extracted directory.
 * Looks for specific manifest files at the root level, custom target subfolder, or auto-scanned subdirectories.
 * 
 * @param {string} dirPath - Path to the extracted folder
 * @param {string} [targetSubfolder] - Optional relative subfolder to look into first
 * @returns {Object} { framework: string, buildImage: string, runCommand: string, targetDir: string }
 */
// ─── Framework Detection ──────────────────────────────────────────────────────
const detectFramework = (dirPath, targetSubfolder = '') => {
  let targetDir = dirPath;

  // 1. If user explicitly provided a target subdirectory, use it
  if (targetSubfolder && targetSubfolder.trim() !== '') {
    const customPath = path.join(dirPath, targetSubfolder.trim());
    if (fs.existsSync(customPath) && fs.statSync(customPath).isDirectory()) {
      targetDir = customPath;
      const detected = checkFrameworkManifests(targetDir);
      if (detected) {
        detected.mobileDetected = detectMobileComponent(dirPath);
        return detected;
      }
    }
  }

  // 2. If the directory only contains a single subdirectory and no files, inspect inside it
  try {
    const items = fs.readdirSync(dirPath);
    if (items.length === 1) {
      const subPath = path.join(dirPath, items[0]);
      if (fs.statSync(subPath).isDirectory()) {
        targetDir = subPath;
      }
    }
  } catch (err) {
    console.error('Error reading single subdirectory for framework detection:', err);
  }

  // 3. Check for manifests in the resolved root targetDir
  const rootDetected = checkFrameworkManifests(targetDir);
  if (rootDetected) {
    rootDetected.mobileDetected = detectMobileComponent(dirPath);
    return rootDetected;
  }

  // 4. Auto-Detection Fallback: Scan immediate subdirectories for stack manifests (e.g. monorepo client/server split)
  try {
    const items = fs.readdirSync(dirPath);
    // Sort directories to prioritize common backend names (backend, server, api, app)
    const prioritySubdirs = ['backend', 'server', 'api', 'app', 'src'];
    const subdirs = items
      .map(item => path.join(dirPath, item))
      .filter(itemPath => fs.existsSync(itemPath) && fs.statSync(itemPath).isDirectory())
      .sort((a, b) => {
        const nameA = path.basename(a).toLowerCase();
        const nameB = path.basename(b).toLowerCase();
        const scoreA = prioritySubdirs.indexOf(nameA) !== -1 ? prioritySubdirs.indexOf(nameA) : 99;
        const scoreB = prioritySubdirs.indexOf(nameB) !== -1 ? prioritySubdirs.indexOf(nameB) : 99;
        return scoreA - scoreB;
      });

    for (const subdir of subdirs) {
      const subdirDetected = checkFrameworkManifests(subdir);
      if (subdirDetected) {
        console.log(`[Auto-Detect] Found framework manifest inside subdirectory: ${subdirDetected.targetDir}`);
        subdirDetected.mobileDetected = detectMobileComponent(dirPath);
        return subdirDetected;
      }
    }
  } catch (err) {
    console.error('Error scanning subdirectories for framework detection:', err);
  }

  // 5. Fallback if nothing found
  return {
    framework: generic.id,
    architecture: detectGeneralArchitecture(targetDir),
    buildImage: generic.buildImage,
    previewImage: generic.previewImage,
    runCommand: generic.runCommand,
    targetDir,
    isGuiApp: false,
    mobileDetected: detectMobileComponent(dirPath)
  };
};

const detectMobileComponent = (dirPath) => {
  try {
    const items = fs.readdirSync(dirPath);
    const mobileDirs = new Set(['mobile', 'android', 'ios', 'cordova', 'phonegap']);
    if (items.some(item => mobileDirs.has(item.toLowerCase()))) {
      return true;
    }
    
    const pkgPath = path.join(dirPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['react-native'] || deps['expo'] || deps['cordova'] || deps['@capacitor/core']) {
        return true;
      }
    }
    
    for (const item of items) {
      const subPath = path.join(dirPath, item);
      if (fs.existsSync(subPath) && fs.statSync(subPath).isDirectory()) {
        if (item === 'node_modules' || item === '.git') continue;
        const subPkg = path.join(subPath, 'package.json');
        if (fs.existsSync(subPkg)) {
          const pkg = JSON.parse(fs.readFileSync(subPkg, 'utf8'));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (deps['react-native'] || deps['expo']) return true;
        }
      }
    }
  } catch (_) {}
  return false;
};

module.exports = { detectFramework, detectGeneralArchitecture };
