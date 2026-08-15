const fs = require('fs');
const path = require('path');

/**
 * Fastify Framework Plugin
 * Detects Fastify by the presence of "fastify" in package.json dependencies.
 */
module.exports = {
  id: 'fastify',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!deps['fastify'];
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  runCommand: 'npm install',
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
              return { cmd: 'npm', args: ['run', s], env: { NODE_ENV: 'production' } };
            }
          }
        }
        
        // 2. Check the "main" entry point from package.json
        if (pkg.main && fs.existsSync(path.join(workDir, pkg.main))) {
          return { cmd: 'node', args: [pkg.main], env: { NODE_ENV: 'production' } };
        }
      }
    } catch (_) {}

    // 3. Scan common candidate entry points including compiled paths and root/src folders
    const candidates = [
      'index.js', 'index.mjs', 'index.cjs',
      'server.js', 'server.mjs', 'server.cjs',
      'app.js', 'app.mjs', 'app.cjs',
      'src/index.js', 'src/index.mjs', 'src/index.cjs',
      'src/server.js', 'src/server.mjs', 'src/server.cjs',
      'src/app.js', 'src/app.mjs', 'src/app.cjs',
      'dist/index.js', 'dist/server.js', 'dist/app.js',
      'bin/www'
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(workDir, c))) {
        return { cmd: 'node', args: [c], env: { NODE_ENV: 'production' } };
      }
    }

    // Default fallback
    return { cmd: 'npm', args: ['run', 'start'], env: { NODE_ENV: 'production' } };
  },
  getConfig: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        // If a build script is present (e.g. compiling TypeScript/bundling), run it during compilation
        if (pkg.scripts && pkg.scripts.build) {
          return {
            buildImage: 'node:20-alpine',
            runCommand: 'npm install && npm run build'
          };
        }
      }
    } catch (_) {}
    return {
      buildImage: 'node:20-alpine',
      runCommand: 'npm install'
    };
  },
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};

