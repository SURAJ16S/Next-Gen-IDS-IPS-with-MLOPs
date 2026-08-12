const fs = require('fs');
const path = require('path');

/**
 * Hono Framework Plugin (standards-based, multi-runtime)
 * Detects Hono by the presence of "hono" in package.json dependencies.
 * Build: npm install (or bun install if bun.lockb exists)
 * Preview: npm run start > bun run src/index.ts > node index.js
 */
module.exports = {
  id: 'hono',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!deps['hono'];
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  previewImage: 'node:20-alpine',
  runCommand: 'npm install',
  getPreviewCommand: (workDir) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf8'));
      if (pkg.scripts && pkg.scripts.start) {
        return { cmd: 'npm', args: ['run', 'start'], env: { NODE_ENV: 'production' } };
      }
    } catch (_) {}
    // Hono often uses TypeScript with Bun - check for bun lockfile
    const hasBunLock = fs.existsSync(path.join(workDir, 'bun.lockb'));
    if (hasBunLock) {
      const tsCandidates = ['src/index.ts', 'index.ts', 'src/app.ts'];
      for (const c of tsCandidates) {
        if (fs.existsSync(path.join(workDir, c))) {
          return { cmd: 'bun', args: ['run', c], env: { NODE_ENV: 'production' } };
        }
      }
    }
    const candidates = ['src/index.js', 'index.js', 'src/server.js', 'server.js'];
    for (const c of candidates) {
      if (fs.existsSync(path.join(workDir, c))) {
        return { cmd: 'node', args: [c], env: { NODE_ENV: 'production' } };
      }
    }
    return { cmd: 'node', args: ['index.js'], env: { NODE_ENV: 'production' } };
  },
  getConfig: (targetDir) => {
    const hasBunLock = fs.existsSync(path.join(targetDir, 'bun.lockb'));
    if (hasBunLock) {
      return { buildImage: 'oven/bun:latest', previewImage: 'oven/bun:latest', runCommand: 'bun install' };
    }
    return { buildImage: 'node:20-alpine', runCommand: 'npm install' };
  }
};
