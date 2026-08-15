const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'cra',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return !!(pkg.dependencies && pkg.dependencies['react-scripts']);
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  runCommand: 'npm install && npm run build',
  getPreviewCommand: (workDir) => {
    // Serve static build directory of CRA
    return { cmd: 'npx', args: ['serve', '-s', 'build', '-l', '0'], env: {} };
  }
};
