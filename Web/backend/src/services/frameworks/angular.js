const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'angular',
  detect: (targetDir) => {
    try {
      const pkgPath = path.join(targetDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return !!(
          (pkg.dependencies && pkg.dependencies['@angular/core']) ||
          (pkg.devDependencies && pkg.devDependencies['@angular/core'])
        );
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'node:20-alpine',
  runCommand: 'npm install && npx ng build --configuration=production',
  getPreviewCommand: (workDir) => {
    const distPath = path.join(workDir, 'dist');
    let serveDir = 'dist';
    try {
      if (fs.existsSync(distPath)) {
        const items = fs.readdirSync(distPath);
        if (items.length > 0) {
          serveDir = path.join('dist', items[0]);
        }
      }
    } catch (_) {}
    // Serve production static folder on custom port
    return { cmd: 'npx', args: ['serve', '-s', serveDir, '-l', '0'], env: {} };
  }
};
