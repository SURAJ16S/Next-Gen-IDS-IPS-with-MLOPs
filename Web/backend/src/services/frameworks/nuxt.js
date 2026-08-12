const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'nuxt',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return !!(
          (pkg.dependencies && pkg.dependencies.nuxt) ||
          (pkg.devDependencies && pkg.devDependencies.nuxt)
        );
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  runCommand: 'npm install && npm run build',
  getPreviewCommand: (workDir) => {
    const serverPath = path.join(workDir, '.output', 'server', 'index.mjs');
    if (fs.existsSync(serverPath)) {
      return { cmd: 'node', args: ['.output/server/index.mjs'], env: {} };
    }
    return { cmd: 'npm', args: ['run', 'start'], env: {} };
  }
};
