const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'vite',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        // General Vite detection (excluding SvelteKit)
        const hasVite = !!(
          (pkg.dependencies && pkg.dependencies.vite) ||
          (pkg.devDependencies && pkg.devDependencies.vite)
        );
        const isSvelteKit = !!(
          (pkg.dependencies && pkg.dependencies['@sveltejs/kit']) ||
          (pkg.devDependencies && pkg.devDependencies['@sveltejs/kit'])
        );
        return hasVite && !isSvelteKit;
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  runCommand: 'npm install && npm run build',
  getPreviewCommand: (workDir) => {
    return { cmd: 'npx', args: ['vite', 'preview', '--port', '${PORT}', '--host', '0.0.0.0'], env: {} };
  }
};
