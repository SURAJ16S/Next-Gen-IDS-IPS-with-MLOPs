const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'mern',
  detect: (targetDir) => {
    return fs.existsSync(path.join(targetDir, 'package.json'));
  },
  buildImage: 'node:20-alpine',
  runCommand: 'npm install && npm run build',
  getPreviewCommand: (workDir) => {
    // Check if package.json has a "start" script
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf8'));
      if (pkg.scripts && pkg.scripts.start) {
        return { cmd: 'npm', args: ['start'], env: {} };
      }
    } catch (_) {}
    // Fallback: find index.js
    const candidates = ['src/index.js', 'index.js', 'server.js', 'app.js'];
    for (const c of candidates) {
      if (fs.existsSync(path.join(workDir, c))) {
        return { cmd: 'node', args: [c], env: {} };
      }
    }
    return { cmd: 'npm', args: ['start'], env: {} };
  }
};
