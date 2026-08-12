const fs = require('fs');
const path = require('path');

/**
 * Elysia Framework Plugin (Bun-native)
 * Detects Elysia by the presence of "elysia" in package.json dependencies.
 * Build Image: oven/bun:latest (preferred) with node:20-alpine fallback.
 * Build: bun install (or npm install fallback).
 * Preview: bun run src/index.ts > bun run index.ts > node index.js
 */
module.exports = {
  id: 'elysia',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!deps['elysia'];
      }
    } catch (_) {}
    return false;
  },
  // Dual image support: build on Bun, preview on Bun
  buildImage: 'oven/bun:latest',
  previewImage: 'oven/bun:latest',
  runCommand: 'bun install',
  getPreviewCommand: (workDir) => {
    // Prioritize TypeScript entry points (Bun handles TS natively)
    const tsCandidates = ['src/index.ts', 'index.ts', 'src/app.ts', 'app.ts'];
    for (const c of tsCandidates) {
      if (fs.existsSync(path.join(workDir, c))) {
        return { cmd: 'bun', args: ['run', c], env: { NODE_ENV: 'production' } };
      }
    }
    // Try package.json scripts
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf8'));
      if (pkg.scripts && pkg.scripts.start) {
        return { cmd: 'bun', args: ['run', 'start'], env: { NODE_ENV: 'production' } };
      }
    } catch (_) {}
    // JS fallbacks
    const jsCandidates = ['index.js', 'server.js', 'src/index.js'];
    for (const c of jsCandidates) {
      if (fs.existsSync(path.join(workDir, c))) {
        return { cmd: 'bun', args: ['run', c], env: { NODE_ENV: 'production' } };
      }
    }
    return { cmd: 'bun', args: ['run', 'src/index.ts'], env: { NODE_ENV: 'production' } };
  },
  getConfig: (targetDir) => {
    // Check if bun.lockb or bunfig.toml exist to confirm Bun is preferred
    const hasBunLock = fs.existsSync(path.join(targetDir, 'bun.lockb'));
    const hasBunfig = fs.existsSync(path.join(targetDir, 'bunfig.toml'));
    if (hasBunLock || hasBunfig) {
      return { buildImage: 'oven/bun:latest', previewImage: 'oven/bun:latest', runCommand: 'bun install' };
    }
    return { buildImage: 'oven/bun:latest', previewImage: 'oven/bun:latest', runCommand: 'bun install || npm install' };
  }
};
