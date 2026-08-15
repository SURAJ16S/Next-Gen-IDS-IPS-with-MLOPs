const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'rust',
  detect: (targetDir) => {
    return fs.existsSync(path.join(targetDir, 'Cargo.toml'));
  },
  buildImage: 'rust:1.85-slim',
  runCommand: 'export CARGO_TARGET_DIR=/tmp/target && cargo build --release && mkdir -p target/release && find /tmp/target/release/ -maxdepth 1 -type f -executable -exec cp {} target/release/ \\;',
  getPreviewCommand: (workDir) => {
    const releaseDir = path.join(workDir, 'target', 'release');
    if (fs.existsSync(releaseDir)) {
      try {
        const bins = fs.readdirSync(releaseDir).filter(f => {
          const full = path.join(releaseDir, f);
          const stat = fs.statSync(full);
          return stat.isFile() && !f.includes('.') && (process.platform === 'win32' || (stat.mode & 0o111));
        });
        if (bins.length > 0) {
          return { cmd: `./target/release/${bins[0]}`, args: [], env: {} };
        }
      } catch (_) {}
    }
    return { cmd: 'echo', args: ['Rust target release binary not found.'], env: {} };
  },
  detectGui: (targetDir) => {
    try {
      if (fs.existsSync(path.join(targetDir, 'Cargo.toml'))) {
        const content = fs.readFileSync(path.join(targetDir, 'Cargo.toml'), 'utf8');
        if (
          content.includes('egui') || 
          content.includes('iced') || 
          content.includes('slint') || 
          content.includes('druid') || 
          content.includes('relm4')
        ) {
          return true;
        }
      }
    } catch (_) {}
    return false;
  },
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
