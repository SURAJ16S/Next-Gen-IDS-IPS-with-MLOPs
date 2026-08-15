const fs = require('fs');
const path = require('path');

/**
 * SolidStart Framework Plugin (Solid.js full-stack meta-framework)
 * Detects SolidStart by the presence of "@solidjs/start" in package.json dependencies.
 * Build: npm install && npm run build
 * Preview: npm run start OR node .output/server/index.js
 */
module.exports = {
  id: 'solidstart',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!deps['@solidjs/start'];
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
    // SolidStart with Nitro output
    const outputCandidates = ['.output/server/index.js', '.output/server/index.mjs'];
    for (const c of outputCandidates) {
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
