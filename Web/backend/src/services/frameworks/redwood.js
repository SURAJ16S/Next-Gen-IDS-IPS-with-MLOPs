const fs = require('fs');
const path = require('path');

/**
 * RedwoodJS Framework Plugin (full-stack React + GraphQL framework)
 * Detects Redwood by the presence of "@redwoodjs/core" in package.json dependencies.
 * Build: yarn install && yarn rw build
 * Preview: yarn rw serve (serves both API and web sides)
 */
module.exports = {
  id: 'redwood',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!deps['@redwoodjs/core'];
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  runCommand: 'yarn install && yarn rw build',
  getPreviewCommand: (workDir) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf8'));
      if (pkg.scripts && pkg.scripts.serve) {
        return { cmd: 'yarn', args: ['rw', 'serve'], env: { NODE_ENV: 'production' } };
      }
    } catch (_) {}
    // Standard Redwood production serve command
    return { cmd: 'yarn', args: ['rw', 'serve'], env: { NODE_ENV: 'production' } };
  },
  getConfig: (targetDir) => {
    // Prefer yarn (Redwood's recommended package manager)
    const hasYarnLock = fs.existsSync(path.join(targetDir, 'yarn.lock'));
    if (hasYarnLock) {
      return { buildImage: 'node:20-alpine', runCommand: 'yarn install && yarn rw build' };
    }
    return { buildImage: 'node:20-alpine', runCommand: 'npm install && npx rw build' };
  }
};
