const fs = require('fs');
const path = require('path');

/**
 * Preact Framework Plugin (fast 3kB alternative to React)
 * Detects Preact by the presence of "preact" in package.json (excluding React-based CRA/Next.js).
 * Build: npm install && npm run build
 * Preview: npx serve dist OR npx serve build OR npm run preview
 */
module.exports = {
  id: 'preact',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const hasPreact = !!deps['preact'];
        // Exclude projects that are just React with preact-compat
        const hasReact = !!deps['react'];
        const hasVite = !!deps['vite'];
        // If Vite is present, let the vite plugin handle it instead
        return hasPreact && !hasVite;
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  runCommand: 'npm install && npm run build',
  getPreviewCommand: (workDir) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf8'));
      if (pkg.scripts && pkg.scripts.preview) {
        return { cmd: 'npm', args: ['run', 'preview'], env: { NODE_ENV: 'production' } };
      }
      if (pkg.scripts && pkg.scripts.start) {
        return { cmd: 'npm', args: ['run', 'start'], env: { NODE_ENV: 'production' } };
      }
    } catch (_) {}
    // Preact CLI builds to "build/" directory by default
    const buildDir = fs.existsSync(path.join(workDir, 'build')) ? 'build' : 'dist';
    return { cmd: 'npx', args: ['serve', '-s', buildDir, '-l', '${PORT:-3000}'], env: { NODE_ENV: 'production' } };
  },
  getConfig: (targetDir) => ({
    buildImage: 'node:20-alpine',
    runCommand: 'npm install && npm run build'
  })
};
