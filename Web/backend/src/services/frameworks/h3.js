const fs = require('fs');
const path = require('path');

/**
 * H3 Framework Plugin (unjs universal server)
 * Detects H3 by the presence of "h3" in package.json dependencies.
 * Build: npm install
 * Preview: npm run start > node server.js > node index.js > node src/index.js
 */
module.exports = {
  id: 'h3',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        // h3 is also a nitro dependency, so exclude nitropack projects
        return !!deps['h3'] && !deps['nitropack'];
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
    const candidates = ['server.js', 'index.js', 'src/index.js', 'src/server.js'];
    for (const c of candidates) {
      if (fs.existsSync(path.join(workDir, c))) {
        return { cmd: 'node', args: [c], env: { NODE_ENV: 'production' } };
      }
    }
    return { cmd: 'node', args: ['index.js'], env: { NODE_ENV: 'production' } };
  },
  getConfig: (targetDir) => ({
    buildImage: 'node:20-alpine',
    runCommand: 'npm install'
  })
};
