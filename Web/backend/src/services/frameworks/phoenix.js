const fs = require('fs');
const path = require('path');

/**
 * Elixir / Phoenix Framework Plugin
 * Detects Phoenix by presence of mix.exs containing "phoenix".
 * Build: mix local.hex --force && mix deps.get && mix compile
 * Preview: mix phx.server
 *
 * NOTE: Example app uses an in-memory/no-DB setup to avoid DB config.
 * For production use, configure DATABASE_URL in environment.
 */

const readMixExs = (dir) => {
  const mixPath = path.join(dir, 'mix.exs');
  if (!fs.existsSync(mixPath)) return '';
  return fs.readFileSync(mixPath, 'utf8').toLowerCase();
};

module.exports = {
  id: 'phoenix',
  detect: (targetDir) => {
    try {
      const content = readMixExs(targetDir);
      return content.includes('phoenix') || fs.existsSync(path.join(targetDir, 'mix.exs'));
    } catch (_) {}
    return false;
  },
  buildImage: 'elixir:1.17-otp-26-alpine',
  previewImage: 'elixir:1.17-otp-26-alpine',
  runCommand: [
    'apk add --no-cache build-base nodejs npm git',
    'mix local.hex --force',
    'mix local.rebar --force',
    'MIX_ENV=prod mix deps.get --only prod',
    'MIX_ENV=prod mix compile',
    // Compile assets if assets directory exists (Phoenix LiveView)
    'if [ -d assets ]; then npm install --prefix assets && MIX_ENV=prod mix assets.deploy 2>/dev/null || true; fi'
  ].join(' && '),
  getPreviewCommand: (workDir) => {
    // Check if this is a Phoenix app with phx.server or a plain Elixir mix app
    const mixContent = readMixExs(workDir);
    const isPhoenix = mixContent.includes('phoenix');
    if (isPhoenix) {
      return {
        cmd: 'mix',
        args: ['phx.server'],
        env: {
          MIX_ENV: 'prod',
          PHX_HOST: '0.0.0.0',
          PORT: '${PORT:-4000}',
          SECRET_KEY_BASE: 'devops-preview-phoenix-secret-key-base-not-for-production-use-only'
        }
      };
    }
    return {
      cmd: 'mix',
      args: ['run', '--no-halt'],
      env: { MIX_ENV: 'prod' }
    };
  },
  getConfig: (targetDir) => {
    return {
      buildImage: 'elixir:1.17-otp-26-alpine',
      previewImage: 'elixir:1.17-otp-26-alpine',
      runCommand: [
        'apk add --no-cache build-base nodejs npm git',
        'mix local.hex --force',
        'mix local.rebar --force',
        'MIX_ENV=prod mix deps.get --only prod',
        'MIX_ENV=prod mix compile',
        'if [ -d assets ]; then npm install --prefix assets && MIX_ENV=prod mix assets.deploy 2>/dev/null || true; fi'
      ].join(' && ')
    };
  },
  detectGui: () => false,
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
