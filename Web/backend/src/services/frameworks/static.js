const fs = require('fs');
const path = require('path');

/**
 * Static Assets Plugin (HTML/CSS/JS only)
 * Detects plain static sites by the presence of index.html without any other
 * framework config files. Serves dynamically using `npx serve`.
 */

/** Framework indicator files that signal a proper framework is present */
const FRAMEWORK_INDICATORS = [
  'package.json',    // Any Node-based framework
  'requirements.txt', // Python framework
  'pyproject.toml',   // Python (modern)
  'Cargo.toml',       // Rust
  'pom.xml',          // Maven/Spring
  'build.gradle',     // Gradle/Spring
  'manage.py',        // Django
  'go.mod',           // Go
  'Gemfile',          // Ruby on Rails
  'composer.json',    // PHP
];

module.exports = {
  id: 'static',
  detect: (targetDir) => {
    // Must have index.html
    if (!fs.existsSync(path.join(targetDir, 'index.html'))) return false;
    // Must NOT have any framework indicator files
    for (const indicator of FRAMEWORK_INDICATORS) {
      if (fs.existsSync(path.join(targetDir, indicator))) return false;
    }
    return true;
  },
  buildImage: 'node:20-alpine',
  runCommand: 'echo "Static site – no build required."',
  getPreviewCommand: (workDir) => {
    // Serve the directory at the root using npx serve
    return {
      cmd: 'npx',
      args: ['serve', '-s', '.', '-l', '${PORT:-3000}', '--no-clipboard'],
      env: { NODE_ENV: 'production' }
    };
  },
  getConfig: (targetDir) => ({
    buildImage: 'node:20-alpine',
    runCommand: 'echo "Static site – no build required."'
  })
};
