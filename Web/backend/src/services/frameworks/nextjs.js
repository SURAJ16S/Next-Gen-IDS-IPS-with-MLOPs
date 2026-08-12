const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'nextjs',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return !!(pkg.dependencies && pkg.dependencies.next);
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  runCommand: 'npm install && npm run build',
  getPreviewCommand: (workDir) => {
    return { cmd: 'npm', args: ['run', 'start'], env: {} };
  }
};
