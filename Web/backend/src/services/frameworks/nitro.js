const fs = require('fs');
const path = require('path');

/**
 * Nitro Framework Plugin (Nuxt engine / unjs server toolkit)
 * Detects Nitro by the presence of "nitropack" in package.json dependencies.
 * Build: npm install && npm run build
 * Preview: node .output/server/index.mjs (or npm run preview)
 */
module.exports = {
  id: 'nitro',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        // Detect standalone Nitro, but skip if it's also a full Nuxt project
        return !!deps['nitropack'] && !deps['nuxt'];
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  runCommand: 'npm install && npm run build',
  getPreviewCommand: (workDir) => {
    // Nitro outputs to .output/server/index.mjs by default
    const outputServer = path.join(workDir, '.output', 'server', 'index.mjs');
    if (fs.existsSync(outputServer)) {
      return { cmd: 'node', args: ['.output/server/index.mjs'], env: { NODE_ENV: 'production' } };
    }
    // Check for preview script in package.json
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf8'));
      if (pkg.scripts && pkg.scripts.preview) {
        return { cmd: 'npm', args: ['run', 'preview'], env: { NODE_ENV: 'production' } };
      }
    } catch (_) {}
    return { cmd: 'node', args: ['.output/server/index.mjs'], env: { NODE_ENV: 'production' } };
  },
  getConfig: (targetDir) => ({
    buildImage: 'node:20-alpine',
    runCommand: 'npm install && npm run build'
  })
};
