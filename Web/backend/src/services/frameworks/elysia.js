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
    try {
      const pkgPath = path.join(workDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        
        // 1. Check for startup scripts in order of preference
        if (pkg.scripts) {
          const scriptsPriority = ['start', 'start:prod', 'preview', 'dev'];
          for (const s of scriptsPriority) {
            if (pkg.scripts[s]) {
              return { cmd: 'bun', args: ['run', s], env: { NODE_ENV: 'production' } };
            }
          }
        }
        
        // 2. Check the "main" entry point from package.json
        if (pkg.main && fs.existsSync(path.join(workDir, pkg.main))) {
          return { cmd: 'bun', args: ['run', pkg.main], env: { NODE_ENV: 'production' } };
        }
      }
    } catch (_) {}

    // 3. Scan common candidate entry points including TypeScript / Bun native files, compiled outputs, and standard JS paths
    const candidates = [
      'src/index.ts', 'src/index.js', 'src/index.mjs', 'src/index.cjs',
      'index.ts', 'index.js', 'index.mjs', 'index.cjs',
      'src/server.ts', 'src/server.js', 'src/server.mjs', 'src/server.cjs',
      'src/app.ts', 'src/app.js', 'src/app.mjs', 'src/app.cjs',
      'server.ts', 'server.js', 'server.mjs', 'server.cjs',
      'app.ts', 'app.js', 'app.mjs', 'app.cjs',
      'dist/index.js', 'dist/server.js', 'dist/app.js',
      'bin/www'
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(workDir, c))) {
        return { cmd: 'bun', args: ['run', c], env: { NODE_ENV: 'production' } };
      }
    }

    // Default fallback
    return { cmd: 'bun', args: ['run', 'src/index.ts'], env: { NODE_ENV: 'production' } };
  },
  getConfig: (targetDir) => {
    const hasBunLock = fs.existsSync(path.join(targetDir, 'bun.lockb'));
    const hasBunfig = fs.existsSync(path.join(targetDir, 'bunfig.toml'));
    let installCmd = 'bun install';
    let fallbackInstallCmd = 'bun install || npm install';

    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        // If a build script is present (e.g. compiling/bundling), run it during compilation
        if (pkg.scripts && pkg.scripts.build) {
          installCmd = 'bun install && bun run build';
          fallbackInstallCmd = '(bun install && bun run build) || (npm install && npm run build)';
        }
      }
    } catch (_) {}

    if (hasBunLock || hasBunfig) {
      return { buildImage: 'oven/bun:latest', previewImage: 'oven/bun:latest', runCommand: installCmd };
    }
    return { buildImage: 'oven/bun:latest', previewImage: 'oven/bun:latest', runCommand: fallbackInstallCmd };
  },
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
