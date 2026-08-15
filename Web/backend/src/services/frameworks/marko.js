const fs = require('fs');
const path = require('path');

/**
 * Marko Framework Plugin (streaming HTML templating framework)
 * Detects Marko by the presence of "marko" in package.json dependencies.
 * Build: npm install && npm run build
 * Preview: npm run start > node server.js > node index.js
 */
module.exports = {
  id: 'marko',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!deps['marko'];
      }
    } catch (_) {}
    // Also check for .marko files
    try {
      const files = fs.readdirSync(targetDir);
      if (files.some(f => f.endsWith('.marko'))) return true;
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
    const candidates = ['server.js', 'index.js', 'app.js', 'src/server.js'];
    for (const c of candidates) {
      if (fs.existsSync(path.join(workDir, c))) {
        return { cmd: 'node', args: [c], env: { NODE_ENV: 'production' } };
      }
    }
    return { cmd: 'npm', args: ['run', 'start'], env: { NODE_ENV: 'production' } };
  },
  getConfig: (targetDir) => ({
    buildImage: 'node:20-alpine',
    runCommand: 'npm install && npm run build'
  })
};
