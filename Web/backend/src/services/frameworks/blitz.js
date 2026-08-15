const fs = require('fs');
const path = require('path');

/**
 * Blitz.js Framework Plugin (full-stack React framework built on Next.js)
 * Detects Blitz by the presence of "blitz" in package.json dependencies.
 * Build: npm install && npm run build
 * Preview: npm run start
 */
module.exports = {
  id: 'blitz',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!deps['blitz'];
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  runCommand: 'npm install && npm run build',
  getPreviewCommand: (workDir) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf8'));
      if (pkg.scripts && pkg.scripts.start) {
        return { cmd: 'npm', args: ['run', 'start'], env: { NODE_ENV: 'production' } };
      }
    } catch (_) {}
    // Blitz builds into .next like Next.js
    return { cmd: 'npx', args: ['blitz', 'start', '--port', '${PORT:-3000}'], env: { NODE_ENV: 'production' } };
  },
  getConfig: (targetDir) => ({
    buildImage: 'node:20-alpine',
    runCommand: 'npm install && npm run build'
  })
};
