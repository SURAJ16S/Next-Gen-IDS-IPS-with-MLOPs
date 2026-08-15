const fs = require('fs');
const path = require('path');

/**
 * Qwik Framework Plugin (resumable React-like framework by Builder.io)
 * Detects Qwik by the presence of "@builder.io/qwik" in package.json dependencies.
 * Build: npm install && npm run build
 * Preview: npm run preview OR node entry.preview.js
 */
module.exports = {
  id: 'qwik',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!deps['@builder.io/qwik'] || !!deps['@builder.io/qwik-city'];
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
      if (pkg.scripts && pkg.scripts.serve) {
        return { cmd: 'npm', args: ['run', 'serve'], env: { NODE_ENV: 'production' } };
      }
    } catch (_) {}
    // Qwik City SSR output: dist/server/entry.preview.js or server/entry.preview.mjs
    const ssrCandidates = [
      'dist/server/entry.preview.js',
      'server/entry.preview.mjs',
      'dist/entry.preview.js'
    ];
    for (const c of ssrCandidates) {
      if (fs.existsSync(path.join(workDir, c))) {
        return { cmd: 'node', args: [c], env: { NODE_ENV: 'production' } };
      }
    }
    return { cmd: 'npm', args: ['run', 'preview'], env: { NODE_ENV: 'production' } };
  },
  getConfig: (targetDir) => ({
    buildImage: 'node:20-alpine',
    runCommand: 'npm install && npm run build'
  })
};
