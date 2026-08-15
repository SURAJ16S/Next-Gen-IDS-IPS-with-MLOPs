const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'eleventy',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return !!(
          (pkg.dependencies && pkg.dependencies['@11ty/eleventy']) ||
          (pkg.devDependencies && pkg.devDependencies['@11ty/eleventy'])
        );
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  runCommand: 'npm install && npx @11ty/eleventy',
  getPreviewCommand: (workDir) => {
    return { cmd: 'npx', args: ['serve', '-s', '_site', '-l', '0'], env: {} };
  }
};
