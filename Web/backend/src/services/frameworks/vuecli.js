const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'vuecli',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return !!(
          (pkg.dependencies && pkg.dependencies['@vue/cli-service']) ||
          (pkg.devDependencies && pkg.devDependencies['@vue/cli-service'])
        );
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  runCommand: 'npm install && npm run build',
  getPreviewCommand: (workDir) => {
    return { cmd: 'npx', args: ['serve', '-s', 'dist', '-l', '0'], env: {} };
  }
};
