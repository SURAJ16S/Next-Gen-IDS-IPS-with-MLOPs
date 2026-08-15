const fs = require('fs');
const path = require('path');

/**
 * Koa.js Framework Plugin (Node.js next-generation middleware)
 * Detects Koa by the presence of "koa" in package.json dependencies.
 * Build: npm install
 * Preview: npm run start > node app.js > node index.js > node server.js
 */
module.exports = {
  id: 'koa',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!deps['koa'];
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  runCommand: 'npm install',
  getPreviewCommand: (workDir) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf8'));
      if (pkg.scripts && pkg.scripts.start) {
        return { cmd: 'npm', args: ['run', 'start'], env: { NODE_ENV: 'production' } };
      }
    } catch (_) {}
    // Fallback: koa conventionally uses app.js as the entry point
    const candidates = ['app.js', 'index.js', 'server.js', 'src/app.js', 'src/index.js'];
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
  }),
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
