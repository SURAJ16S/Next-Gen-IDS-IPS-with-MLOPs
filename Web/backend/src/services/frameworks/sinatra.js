const fs = require('fs');
const path = require('path');

/**
 * Sinatra Framework Plugin (Ruby lightweight web)
 * Detects Sinatra by presence of Gemfile containing "gem 'sinatra'" or "gem \"sinatra\"".
 * Build: bundle install
 * Preview: bundle exec ruby app.rb -p ${PORT:-4567} -o 0.0.0.0
 */

const readGemfile = (dir) => {
  const gemfilePath = path.join(dir, 'Gemfile');
  if (!fs.existsSync(gemfilePath)) return '';
  return fs.readFileSync(gemfilePath, 'utf8').toLowerCase();
};

/** Find the main Sinatra entry point (app.rb, server.rb, main.rb, config.ru, etc.) */
const findSinatraEntry = (workDir) => {
  const candidates = ['app.rb', 'server.rb', 'main.rb', 'application.rb', 'config.ru'];
  for (const c of candidates) {
    if (fs.existsSync(path.join(workDir, c))) return c;
  }
  return 'app.rb';
};

module.exports = {
  id: 'sinatra',
  detect: (targetDir) => {
    try {
      const gemfile = readGemfile(targetDir);
      if (!gemfile) return false;
      return gemfile.includes("gem 'sinatra'") || gemfile.includes('gem "sinatra"');
    } catch (_) {}
    return false;
  },
  buildImage: 'ruby:3.3-slim',
  previewImage: 'ruby:3.3-slim',
  runCommand: 'apt-get update -qq && apt-get install -y --no-install-recommends build-essential && bundle install',
  getPreviewCommand: (workDir) => {
    const entry = findSinatraEntry(workDir);
    const isRackup = entry === 'config.ru';
    if (isRackup) {
      return {
        cmd: 'bundle',
        args: ['exec', 'rackup', 'config.ru', '-p', '${PORT:-4567}', '-o', '0.0.0.0'],
        env: { RACK_ENV: 'production' }
      };
    }
    return {
      cmd: 'bundle',
      args: ['exec', 'ruby', entry, '-p', '${PORT:-4567}', '-o', '0.0.0.0'],
      env: { RACK_ENV: 'production' }
    };
  },
  getConfig: (targetDir) => {
    return {
      buildImage: 'ruby:3.3-slim',
      previewImage: 'ruby:3.3-slim',
      runCommand: 'apt-get update -qq && apt-get install -y --no-install-recommends build-essential && bundle install'
    };
  },
  detectGui: () => false,
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
