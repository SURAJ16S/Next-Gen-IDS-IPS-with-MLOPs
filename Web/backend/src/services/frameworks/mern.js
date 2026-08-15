const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'mern',
  detect: (targetDir) => {
    return fs.existsSync(path.join(targetDir, 'package.json'));
  },
  buildImage: 'node:20-alpine',
  runCommand: 'npm install',
  getConfig: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts && pkg.scripts.build) {
          return { runCommand: 'npm install && npm run build' };
        }
      }
    } catch (_) {}
    return { runCommand: 'npm install' };
  },
  getPreviewCommand: (workDir) => {
    // Detect MERN monorepo: server/ + client/ directories
    const hasMernServer = fs.existsSync(path.join(workDir, 'server', 'package.json'));
    const hasMernClient = fs.existsSync(path.join(workDir, 'client', 'package.json'));

    if (hasMernServer && hasMernClient) {
      // Multi-package monorepo: the workDir is the root.
      // The container startup script (in process-manager) will handle building client first.
      // Here we just return the server start command.
      const serverPkg = JSON.parse(fs.readFileSync(path.join(workDir, 'server', 'package.json'), 'utf8'));
      if (serverPkg.scripts && serverPkg.scripts.start) {
        return { cmd: 'npm', args: ['--prefix', '/workspace/server', 'start'], env: {} };
      }
      const candidates = ['src/index.js', 'index.js', 'server.js', 'app.js'];
      for (const c of candidates) {
        if (fs.existsSync(path.join(workDir, 'server', c))) {
          return { cmd: 'node', args: [`/workspace/server/${c}`], env: {} };
        }
      }
    }

    // Check if package.json at root has a "start" script
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
  },
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
