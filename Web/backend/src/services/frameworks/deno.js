const fs = require('fs');
const path = require('path');

/**
 * Deno (generic) Framework Plugin
 * Detects any Deno project by presence of deno.json or deno.jsonc.
 * Must be registered AFTER deno-fresh (which is more specific).
 * Build: deno cache <entry>
 * Preview: deno run -A <entry>
 */

/** Finds the primary entry point for a Deno project */
const findDenoEntry = (workDir) => {
  const candidates = ['main.ts', 'server.ts', 'app.ts', 'index.ts', 'mod.ts', 'src/main.ts', 'src/server.ts', 'src/index.ts'];
  for (const c of candidates) {
    if (fs.existsSync(path.join(workDir, c))) return c;
  }
  return 'main.ts';
};

module.exports = {
  id: 'deno',
  detect: (targetDir) => {
    try {
      return (
        fs.existsSync(path.join(targetDir, 'deno.json')) ||
        fs.existsSync(path.join(targetDir, 'deno.jsonc'))
      );
    } catch (_) {}
    return false;
  },
  buildImage: 'denoland/deno:alpine',
  previewImage: 'denoland/deno:alpine',
  runCommand: 'deno cache $(find . -maxdepth 2 -name "*.ts" | head -5 | tr "\\n" " ")',
  getPreviewCommand: (workDir) => {
    const entry = findDenoEntry(workDir);
    // Check deno.json for task scripts
    const denoJsonPath = fs.existsSync(path.join(workDir, 'deno.json'))
      ? path.join(workDir, 'deno.json')
      : path.join(workDir, 'deno.jsonc');
    try {
      const content = JSON.parse(fs.readFileSync(denoJsonPath, 'utf8'));
      if (content.tasks) {
        const taskPriority = ['start', 'serve', 'prod', 'run'];
        for (const t of taskPriority) {
          if (content.tasks[t]) {
            return {
              cmd: 'deno',
              args: ['task', t],
              env: { PORT: '${PORT:-8000}' }
            };
          }
        }
      }
    } catch (_) {}
    return {
      cmd: 'deno',
      args: ['run', '-A', entry],
      env: { PORT: '${PORT:-8000}' }
    };
  },
  getConfig: (targetDir) => {
    return {
      buildImage: 'denoland/deno:alpine',
      previewImage: 'denoland/deno:alpine',
      runCommand: 'deno cache $(find . -maxdepth 2 -name "*.ts" | head -5 | tr "\\n" " ") 2>/dev/null || true'
    };
  },
  detectGui: () => false,
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
