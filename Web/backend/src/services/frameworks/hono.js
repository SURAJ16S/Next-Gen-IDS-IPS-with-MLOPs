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
    const hasBunLock = fs.existsSync(path.join(workDir, 'bun.lockb'));
    const pkgPath = path.join(workDir, 'package.json');
    const runner = hasBunLock ? 'bun' : 'node';
    const runPrefix = hasBunLock ? 'bun' : 'npm';
    
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        
        // 1. Check for startup scripts in order of preference
        if (pkg.scripts) {
          const scriptsPriority = ['start', 'start:prod', 'preview', 'dev'];
          for (const s of scriptsPriority) {
            if (pkg.scripts[s]) {
              return { cmd: runPrefix, args: ['run', s], env: { NODE_ENV: 'production' } };
            }
          }
        }
        
        // 2. Check the "main" entry point from package.json
        if (pkg.main && fs.existsSync(path.join(workDir, pkg.main))) {
          return { cmd: runner, args: [pkg.main], env: { NODE_ENV: 'production' } };
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
        const isTS = c.endsWith('.ts');
        if (isTS && !hasBunLock) {
          return { cmd: 'npx', args: ['ts-node', c], env: { NODE_ENV: 'production' } };
        }
        return { cmd: runner, args: [c], env: { NODE_ENV: 'production' } };
      }
    }

    // Default fallback
    return { cmd: runner, args: ['index.js'], env: { NODE_ENV: 'production' } };
  },
  getConfig: (targetDir) => {
    const hasBunLock = fs.existsSync(path.join(targetDir, 'bun.lockb'));
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const hasBuildScript = pkg.scripts && pkg.scripts.build;
        if (hasBunLock) {
          return {
            buildImage: 'oven/bun:latest',
            previewImage: 'oven/bun:latest',
            runCommand: hasBuildScript ? 'bun install && bun run build' : 'bun install'
          };
        } else {
          return {
            buildImage: 'node:20-alpine',
            previewImage: 'node:20-alpine',
            runCommand: hasBuildScript ? 'npm install && npm run build' : 'npm install'
          };
        }
      }
    } catch (_) {}

    if (hasBunLock) {
      return { buildImage: 'oven/bun:latest', previewImage: 'oven/bun:latest', runCommand: 'bun install' };
    }
    return { buildImage: 'node:20-alpine', runCommand: 'npm install' };
  },
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
