const fs = require('fs');
const path = require('path');

/**
 * Analog Framework Plugin (Angular SSR meta-framework)
 * Detects by presence of @analogjs/platform in package.json.
 * Build: npm install && npm run build
 * Preview: node dist/analog/server/server.mjs
 */
module.exports = {
  id: 'analog',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!(deps['@analogjs/platform'] || deps['@analogjs/router']);
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  previewImage: 'node:20-alpine',
  runCommand: 'npm install && npm run build',
  getPreviewCommand: (workDir) => {
    // Try to find the server output
    const serverCandidates = [
      'dist/analog/server/server.mjs',
      'dist/server/server.mjs',
      'dist/analog/server/index.mjs',
      '.output/server/index.mjs'
    ];
    for (const c of serverCandidates) {
      if (fs.existsSync(path.join(workDir, c))) {
        return {
          cmd: 'node',
          args: [c],
          env: { NODE_ENV: 'production', PORT: '${PORT:-3000}', HOST: '0.0.0.0' }
        };
      }
    }
    // Fallback: run start script
    return {
      cmd: 'npm',
      args: ['run', 'start'],
      env: { NODE_ENV: 'production', PORT: '${PORT:-3000}' }
    };
  },
  getConfig: (targetDir) => {
    return {
      buildImage: 'node:20-alpine',
      previewImage: 'node:20-alpine',
      runCommand: 'npm install && npm run build'
    };
  },
  detectGui: () => false,
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
