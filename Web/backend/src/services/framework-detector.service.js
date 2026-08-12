const fs = require('fs');
const path = require('path');

// ── Core / Full-Stack ────────────────────────────────────────────────────────
const mern = require('./frameworks/mern');
const spring = require('./frameworks/spring');
const django = require('./frameworks/django');
const rust = require('./frameworks/rust');

// ── Frontend & Full-Stack ────────────────────────────────────────────────────
const nextjs = require('./frameworks/nextjs');
const sveltekit = require('./frameworks/sveltekit');
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

// ── Backend Stack ────────────────────────────────────────────────────────────
const fastapi = require('./frameworks/fastapi');
const flask = require('./frameworks/flask');
const fastify = require('./frameworks/fastify');
const elysia = require('./frameworks/elysia');
const hono = require('./frameworks/hono');
const koa = require('./frameworks/koa');
const h3 = require('./frameworks/h3');
const express = require('./frameworks/express');

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
 * e.g. FastAPI before Django (both detect requirements.txt), Fastify/Koa before Express.
 */
const plugins = [
  // ── Core / Language-specific (highest specificity) ──
  spring, rust,
  // ── Python backends (ordered: most-specific first) ──
  fastapi, flask, django,
  // ── Bun-native backends ──
  elysia,
  // ── Full-Stack meta-frameworks (check before generic backends) ──
  nextjs, sveltekit, nuxt, astro, remix, blitz, redwood, solidstart,
  // ── Emerging / Component frameworks ──
  qwik, nitro, marko, preact,
  // ── Bundler-based frontends ──
  gatsby, cra, vite, angular, vuecli,
  // ── Static Site Generators ──
  hugo, eleventy,
  // ── Node.js backends (ordered: most-specific first) ──
  fastify, hono, koa, h3, express,
  // ── Full-stack Node (generic MERN — widest JS catch-all) ──
  mern,
  // ── Static HTML/CSS/JS (last framework check before generic fallback) ──
  staticAssets
];
const generic = require('./frameworks/generic');

/**
 * Helper to check if a directory matches any modular plugin manifest.
 * Returns the framework details if found, otherwise null.
 */
const checkFrameworkManifests = (targetDir) => {
  for (const plugin of plugins) {
    if (plugin.detect(targetDir)) {
      const extraConfig = plugin.getConfig ? plugin.getConfig(targetDir) : {};
      const isGuiApp = plugin.detectGui ? plugin.detectGui(targetDir) : false;
      return {
        framework: plugin.id,
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
const detectFramework = (dirPath, targetSubfolder = '') => {
  let targetDir = dirPath;

  // 1. If user explicitly provided a target subdirectory, use it
  if (targetSubfolder && targetSubfolder.trim() !== '') {
    const customPath = path.join(dirPath, targetSubfolder.trim());
    if (fs.existsSync(customPath) && fs.statSync(customPath).isDirectory()) {
      targetDir = customPath;
      const detected = checkFrameworkManifests(targetDir);
      if (detected) return detected;
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
  if (rootDetected) return rootDetected;

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
        return subdirDetected;
      }
    }
  } catch (err) {
    console.error('Error scanning subdirectories for framework detection:', err);
  }

  // 5. Fallback if nothing found
  return {
    framework: generic.id,
    buildImage: generic.buildImage,
    runCommand: generic.runCommand,
    targetDir,
    isGuiApp: false
  };
};

module.exports = { detectFramework };
