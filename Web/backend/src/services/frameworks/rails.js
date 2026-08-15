const fs = require('fs');
const path = require('path');

/**
 * Ruby on Rails Framework Plugin
 * Detects Rails by presence of Gemfile containing "gem 'rails'" or "gem \"rails\"".
 * Build: bundle install && bundle exec rails assets:precompile
 * Preview: bundle exec rails server -b 0.0.0.0 -p ${PORT:-3000}
 */

const readGemfile = (dir) => {
  const gemfilePath = path.join(dir, 'Gemfile');
  if (!fs.existsSync(gemfilePath)) return '';
  return fs.readFileSync(gemfilePath, 'utf8').toLowerCase();
};

module.exports = {
  id: 'rails',
  detect: (targetDir) => {
    try {
      const gemfile = readGemfile(targetDir);
      if (!gemfile) return false;
      return (
        gemfile.includes("gem 'rails'") ||
        gemfile.includes('gem "rails"') ||
        fs.existsSync(path.join(targetDir, 'config', 'application.rb'))
      );
    } catch (_) {}
    return false;
  },
  buildImage: 'ruby:3.3-slim',
  previewImage: 'ruby:3.3-slim',
  runCommand: [
    'apt-get update -qq && apt-get install -y --no-install-recommends build-essential libsqlite3-dev nodejs',
    'bundle install',
    'RAILS_ENV=production SECRET_KEY_BASE=devops-preview bundle exec rails assets:precompile 2>/dev/null || true'
  ].join(' && '),
  getPreviewCommand: (workDir) => {
    const hasRakeFile = fs.existsSync(path.join(workDir, 'Rakefile'));
    return {
      cmd: 'bundle',
      args: ['exec', 'rails', 'server', '-b', '0.0.0.0', '-p', '${PORT:-3000}', '-e', 'production'],
      env: {
        RAILS_ENV: 'production',
        SECRET_KEY_BASE: 'devops-preview-key-base-not-for-production',
        RAILS_SERVE_STATIC_FILES: '1',
        RAILS_LOG_TO_STDOUT: '1'
      }
    };
  },
  getConfig: (targetDir) => {
    const hasBundlerLock = fs.existsSync(path.join(targetDir, 'Gemfile.lock'));
    return {
      buildImage: 'ruby:3.3-slim',
      previewImage: 'ruby:3.3-slim',
      runCommand: [
        'apt-get update -qq && apt-get install -y --no-install-recommends build-essential libsqlite3-dev nodejs',
        hasBundlerLock ? 'bundle install --deployment' : 'bundle install',
        'RAILS_ENV=production SECRET_KEY_BASE=devops-preview bundle exec rails assets:precompile 2>/dev/null || true',
        'RAILS_ENV=production bundle exec rails db:create db:migrate 2>/dev/null || true'
      ].join(' && ')
    };
  },
  detectGui: () => false,
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
