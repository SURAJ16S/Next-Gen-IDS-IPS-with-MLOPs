const fs = require('fs');
const path = require('path');

/**
 * Fastify Framework Plugin
 * Detects Fastify by the presence of "fastify" in package.json dependencies.
 * Build: npm install
 * Preview: npm run start > node server.js > node index.js > node app.js
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
      const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf8'));
      if (pkg.scripts) {
        if (pkg.scripts.start) return { cmd: 'npm', args: ['run', 'start'], env: { NODE_ENV: 'production' } };
        if (pkg.scripts['start:prod']) return { cmd: 'npm', args: ['run', 'start:prod'], env: { NODE_ENV: 'production' } };
      }
    } catch (_) {}
    // Fallback: scan common entry points
    const candidates = ['server.js', 'index.js', 'app.js', 'src/server.js', 'src/index.js'];
    for (const c of candidates) {
      if (fs.existsSync(path.join(workDir, c))) {
        return { cmd: 'node', args: [c], env: { NODE_ENV: 'production' } };
      }
    }
    return { cmd: 'npm', args: ['run', 'start'], env: { NODE_ENV: 'production' } };
  },
  getConfig: (targetDir) => ({
    buildImage: 'node:20-alpine',
    runCommand: 'npm install'
  })
};
