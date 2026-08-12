const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'hugo',
  detect: (targetDir) => {
    return (
      fs.existsSync(path.join(targetDir, 'config.toml')) ||
      fs.existsSync(path.join(targetDir, 'config.yaml')) ||
      fs.existsSync(path.join(targetDir, 'hugo.toml'))
    );
  },
  buildImage: 'klakegg/hugo:ext-alpine',
  previewImage: 'node:20-alpine', // Uses Node container to host the static files preview
  runCommand: 'hugo --destination public',
  getPreviewCommand: (workDir) => {
    return { cmd: 'npx', args: ['serve', '-s', 'public', '-l', '0'], env: {} };
  }
};
