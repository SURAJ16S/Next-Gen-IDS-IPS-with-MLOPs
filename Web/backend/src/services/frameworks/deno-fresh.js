const fs = require('fs');
const path = require('path');

/**
 * Deno Fresh Framework Plugin (full-stack SSR framework for Deno)
 * Detects Fresh by presence of deno.json/deno.jsonc + fresh.gen.ts marker file.
 * Must be registered BEFORE generic deno plugin.
 * Build: deno cache main.ts
 * Preview: deno run -A main.ts
 */

module.exports = {
  id: 'deno-fresh',
  detect: (targetDir) => {
    try {
      const hasFreshGen = fs.existsSync(path.join(targetDir, 'fresh.gen.ts'));
      const hasDenoJson =
        fs.existsSync(path.join(targetDir, 'deno.json')) ||
        fs.existsSync(path.join(targetDir, 'deno.jsonc'));

      if (hasFreshGen && hasDenoJson) return true;

      // Also detect by deno.json imports containing "fresh"
      if (hasDenoJson) {
        const denoJsonPath =
          fs.existsSync(path.join(targetDir, 'deno.json'))
            ? path.join(targetDir, 'deno.json')
            : path.join(targetDir, 'deno.jsonc');
        try {
          const content = fs.readFileSync(denoJsonPath, 'utf8');
          if (content.includes('"fresh"') || content.includes('jsr:@fresh/')) return true;
        } catch (_) {}
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'denoland/deno:alpine',
  previewImage: 'denoland/deno:alpine',
  runCommand: 'deno cache main.ts 2>/dev/null || deno cache $(find . -maxdepth 1 -name "*.ts" | head -1)',
  getPreviewCommand: (workDir) => {
    const entry = fs.existsSync(path.join(workDir, 'main.ts')) ? 'main.ts' : 'dev.ts';
    return {
      cmd: 'deno',
      args: ['run', '-A', '--unstable', entry],
      env: { PORT: '${PORT:-8000}' }
    };
  },
  getConfig: (targetDir) => {
    return {
      buildImage: 'denoland/deno:alpine',
      previewImage: 'denoland/deno:alpine',
      runCommand: 'deno cache main.ts 2>/dev/null || deno cache $(find . -maxdepth 1 -name "*.ts" | head -1)'
    };
  },
  detectGui: () => false,
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
