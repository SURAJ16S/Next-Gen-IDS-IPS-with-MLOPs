const fs = require('fs');
const path = require('path');

/**
 * TanStack Start Framework Plugin
 * Detects by presence of @tanstack/react-start or @tanstack/start in package.json.
 * Build: npm install && npm run build
 * Preview: npm run start
 */
module.exports = {
  id: 'tanstack-start',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!(deps['@tanstack/react-start'] || deps['@tanstack/start']);
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  previewImage: 'node:20-alpine',
  runCommand: 'npm install && npm run build',
  getPreviewCommand: (workDir) => {
    const pkgPath = path.join(workDir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scriptsPriority = ['start', 'serve', 'preview'];
      for (const s of scriptsPriority) {
        if (pkg.scripts && pkg.scripts[s]) {
          return { cmd: 'npm', args: ['run', s], env: { NODE_ENV: 'production', PORT: '${PORT:-3000}' } };
        }
      }
    } catch (_) {}
    return { cmd: 'npm', args: ['run', 'start'], env: { NODE_ENV: 'production', PORT: '${PORT:-3000}' } };
  },
  getConfig: (targetDir) => {
    const hasBunLock = fs.existsSync(path.join(targetDir, 'bun.lockb'));
    const hasPnpmLock = fs.existsSync(path.join(targetDir, 'pnpm-lock.yaml'));
    const hasYarnLock = fs.existsSync(path.join(targetDir, 'yarn.lock'));
    let installCmd = 'npm install';
    if (hasBunLock) installCmd = 'bun install';
    else if (hasPnpmLock) installCmd = 'npm install -g pnpm && pnpm install';
    else if (hasYarnLock) installCmd = 'yarn install';
    return {
      buildImage: hasBunLock ? 'oven/bun:latest' : 'node:20-alpine',
      previewImage: hasBunLock ? 'oven/bun:latest' : 'node:20-alpine',
      runCommand: `${installCmd} && npm run build`
    };
  },
  detectGui: () => false,
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
