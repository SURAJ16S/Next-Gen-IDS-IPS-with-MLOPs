const fs = require('fs');
const path = require('path');

/**
 * Bun Native Framework Plugin (Bun.serve() — no framework)
 * Detects by presence of bun.lockb AND no recognized framework deps in package.json.
 * Must be registered AFTER elysia (more specific Bun framework).
 * Build: bun install
 * Preview: bun run <entry>
 */

const KNOWN_FRAMEWORK_DEPS = [
  'elysia', 'hono', 'express', 'fastify', 'koa', 'next', 'nuxt', 'astro',
  'svelte', '@sveltejs/kit', 'remix', '@remix-run/node', 'solid-js', '@solidjs/start',
  '@builder.io/qwik', 'gatsby', 'react-scripts', 'vue', '@vue/cli-service',
  '@angular/core', '@analogjs/platform', '@tanstack/react-start', 'nitropack',
  'marko', 'preact', 'blitz', '@redwoodjs/core'
];

const findBunEntry = (workDir) => {
  const candidates = ['index.ts', 'src/index.ts', 'server.ts', 'src/server.ts', 'main.ts', 'app.ts', 'index.js', 'src/index.js'];
  for (const c of candidates) {
    if (fs.existsSync(path.join(workDir, c))) return c;
  }
  return 'index.ts';
};

module.exports = {
  id: 'bun-native',
  detect: (targetDir) => {
    try {
      if (!fs.existsSync(path.join(targetDir, 'bun.lockb'))) return false;
      const pkgPath = path.join(targetDir, 'package.json');
      if (!fs.existsSync(pkgPath)) return true; // bun.lockb with no package.json → pure Bun
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      // If none of the known framework deps are present, this is a plain Bun app
      return !KNOWN_FRAMEWORK_DEPS.some(d => deps[d]);
    } catch (_) {}
    return false;
  },
  buildImage: 'oven/bun:latest',
  previewImage: 'oven/bun:latest',
  runCommand: 'bun install',
  getPreviewCommand: (workDir) => {
    const pkgPath = path.join(workDir, 'package.json');
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts) {
          const priority = ['start', 'serve', 'preview', 'dev'];
          for (const s of priority) {
            if (pkg.scripts[s]) {
              return { cmd: 'bun', args: ['run', s], env: { PORT: '${PORT:-3000}' } };
            }
          }
        }
        if (pkg.main) {
          return { cmd: 'bun', args: ['run', pkg.main], env: { PORT: '${PORT:-3000}' } };
        }
      }
    } catch (_) {}
    const entry = findBunEntry(workDir);
    return { cmd: 'bun', args: ['run', entry], env: { PORT: '${PORT:-3000}' } };
  },
  getConfig: (targetDir) => {
    return {
      buildImage: 'oven/bun:latest',
      previewImage: 'oven/bun:latest',
      runCommand: 'bun install'
    };
  },
  detectGui: () => false,
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
