const fs = require('fs');
const path = require('path');

/**
 * Express.js Framework Plugin
 * Detects Express by the presence of "express" in package.json dependencies.
 * Build: npm install
 * Preview: npm run start > node index.js > node server.js > node app.js
 */
module.exports = {
  id: 'express',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        // Detect express but explicitly exclude other overlapping frameworks
        const hasExpress = !!deps['express'];
        const hasNextjs = !!deps['next'];
        const hasNuxt = !!deps['nuxt'];
        const hasRemix = !!deps['@remix-run/react'] || !!deps['@remix-run/node'];
        const hasFastify = !!deps['fastify'];
        const hasKoa = !!deps['koa'];
        const hasMern = !!deps['mongoose']; // Often paired with express in MERN
        return hasExpress && !hasNextjs && !hasNuxt && !hasRemix && !hasFastify && !hasKoa && !hasMern;
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
    // Fallback: try common entry points
    const candidates = ['index.js', 'server.js', 'app.js', 'src/index.js', 'src/server.js'];
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
