const fs = require('fs');
const path = require('path');

/**
 * Svelte (standalone, non-SvelteKit) Framework Plugin
 * Detects by presence of "svelte" in package.json deps WITHOUT "@sveltejs/kit".
 * Must be registered AFTER sveltekit (more specific).
 * Build: npm install && npm run build
 * Preview: npx serve dist -l ${PORT:-5000}
 */
module.exports = {
  id: 'svelte',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!(deps['svelte']) && !deps['@sveltejs/kit'];
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  previewImage: 'node:20-alpine',
  runCommand: 'npm install && npm run build',
  getPreviewCommand: (workDir) => {
    // Svelte + Vite output goes to dist/ by default
    const distDir = fs.existsSync(path.join(workDir, 'dist')) ? 'dist' : 'public';
    const pkgPath = path.join(workDir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.start) {
        return { cmd: 'npm', args: ['run', 'start'], env: { PORT: '${PORT:-5000}' } };
      }
      if (pkg.scripts && pkg.scripts.preview) {
        return { cmd: 'npm', args: ['run', 'preview', '--', '--host', '0.0.0.0', '--port', '${PORT:-5000}'] , env: {} };
      }
    } catch (_) {}
    // Fallback: serve the static dist
    return {
      cmd: 'npx',
      args: ['serve', distDir, '-l', '${PORT:-5000}', '--single'],
      env: {}
    };
  },
  getConfig: (targetDir) => {
    const hasBunLock = fs.existsSync(path.join(targetDir, 'bun.lockb'));
    const hasPnpmLock = fs.existsSync(path.join(targetDir, 'pnpm-lock.yaml'));
    let installCmd = 'npm install';
    if (hasBunLock) installCmd = 'bun install';
    else if (hasPnpmLock) installCmd = 'npm install -g pnpm && pnpm install';
    return {
      buildImage: hasBunLock ? 'oven/bun:latest' : 'node:20-alpine',
      previewImage: 'node:20-alpine',
      runCommand: `${installCmd} && npm run build`
    };
  },
  detectGui: () => false,
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
