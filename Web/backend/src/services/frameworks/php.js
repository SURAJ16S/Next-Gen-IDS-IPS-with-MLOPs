const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'php',
  name: 'PHP (Laravel / Symfony / Slim / Vanilla)',

  /**
   * Detects PHP framework types.
   */
  detect: (workDir) => {
    const artisanPath = path.join(workDir, 'artisan');
    const composerPath = path.join(workDir, 'composer.json');
    const indexPhp = path.join(workDir, 'index.php');
    const publicIndexPhp = path.join(workDir, 'public', 'index.php');

    if (fs.existsSync(artisanPath)) {
      return true;
    }

    if (fs.existsSync(composerPath)) {
      try {
        const composer = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
        const deps = { ...composer.require, ...composer['require-dev'] };
        if (deps['laravel/framework']) {
          return true;
        }
        if (deps['symfony/framework-bundle'] || deps['symfony/symfony']) {
          return true;
        }
        if (deps['slim/slim']) {
          return true;
        }
      } catch (_) {}
    }

    if (fs.existsSync(indexPhp) || fs.existsSync(publicIndexPhp)) {
      return true;
    }

    return false;
  },

  buildImage: 'composer:latest',
  runCommand: 'echo "No build required"',

  /**
   * Configures image building and Composer package compiling tools.
   */
  getConfig: (targetDir) => {
    const composerPath = path.join(targetDir, 'composer.json');
    const hasComposer = fs.existsSync(composerPath);

    return {
      buildImage: 'composer:latest',
      runCommand: hasComposer
        ? 'composer config process-timeout 0 && composer config policy.advisories.block false && composer install --no-interaction --ignore-platform-reqs --optimize-autoloader'
        : 'echo "No composer.json found; skipping package compilation."',
      previewImage: 'php:8.2-cli',
      scanImage: 'aquasec/trivy:latest',
      scanCmd: 'fs --scanners vuln --skip-dirs node_modules,vendor,tests --format json --output /workspace/reports/trivy-report.json /workspace'
    };
  },

  getPreviewCommand: async (workDir) => {
    const artisanPath = path.join(workDir, 'artisan');
    const isLaravel = fs.existsSync(artisanPath);

    if (isLaravel) {
      return {
        cmd: 'php',
        args: ['artisan', 'serve', '--host=0.0.0.0', '--port=${PORT:-8000}'],
        env: {
          APP_ENV: 'local',
          APP_DEBUG: 'true'
        }
      };
    }

    const publicDir = path.join(workDir, 'public');
    const hasPublicDir = fs.existsSync(publicDir);
    const args = ['-S', '0.0.0.0:${PORT:-8000}'];

    if (hasPublicDir) {
      args.push('-t', 'public');
    }

    return {
      cmd: 'php',
      args: args,
      env: {}
    };
  }
};
