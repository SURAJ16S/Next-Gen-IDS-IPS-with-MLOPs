const fs = require('fs');
const path = require('path');

/**
 * Symfony Framework Plugin (PHP full-stack framework)
 * Detects by composer.json containing "symfony/framework-bundle".
 * Must be registered BEFORE the generic php plugin.
 * Build: composer install --no-interaction --prefer-dist
 * Preview: php -S 0.0.0.0:${PORT:-8000} -t public/
 */

const readComposerJson = (dir) => {
  const composerPath = path.join(dir, 'composer.json');
  if (!fs.existsSync(composerPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(composerPath, 'utf8'));
  } catch (_) {}
  return null;
};

module.exports = {
  id: 'symfony',
  detect: (targetDir) => {
    try {
      const composer = readComposerJson(targetDir);
      if (!composer) return false;
      const allDeps = { ...composer.require, ...(composer['require-dev'] || {}) };
      return !!(
        allDeps['symfony/framework-bundle'] ||
        allDeps['symfony/symfony'] ||
        // Also detect Symfony flex by checking symfony.lock
        fs.existsSync(path.join(targetDir, 'symfony.lock'))
      );
    } catch (_) {}
    return false;
  },
  buildImage: 'composer:latest',
  previewImage: 'php:8.3-cli-alpine',
  runCommand: [
    'composer config process-timeout 0',
    'composer install --no-interaction --prefer-dist --no-scripts --optimize-autoloader',
    // Run Symfony post-install scripts safely
    'composer run-script post-install-cmd 2>/dev/null || true'
  ].join(' && '),
  getPreviewCommand: (workDir) => {
    // Check if Symfony CLI binary is available (symfony server:start)
    const publicDir = path.join(workDir, 'public');
    const hasPublicIndex = fs.existsSync(path.join(publicDir, 'index.php'));
    return {
      cmd: 'php',
      args: [
        '-S',
        '0.0.0.0:${PORT:-8000}',
        ...(hasPublicIndex ? ['-t', 'public'] : [])
      ],
      env: {
        APP_ENV: 'prod',
        APP_DEBUG: '0'
      }
    };
  },
  getConfig: (targetDir) => {
    const hasLock = fs.existsSync(path.join(targetDir, 'composer.lock'));
    return {
      buildImage: 'composer:latest',
      previewImage: 'php:8.3-cli-alpine',
      runCommand: [
        'composer config process-timeout 0',
        hasLock
          ? 'composer install --no-interaction --prefer-dist --no-scripts --optimize-autoloader'
          : 'composer install --no-interaction --prefer-dist --no-scripts',
        'composer run-script post-install-cmd 2>/dev/null || true',
        // Symfony cache warm
        'php bin/console cache:warmup --env=prod 2>/dev/null || true'
      ].join(' && ')
    };
  },
  detectGui: () => false,
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
