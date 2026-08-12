const fs = require('fs');
const path = require('path');

/**
 * FastAPI Framework Plugin (Python async)
 * Detects FastAPI by presence of "fastapi" or "uvicorn" in requirements.txt or pyproject.toml.
 * Venv Persistence: Creates .venv in workspace and installs pip dependencies.
 * Preview: .venv/bin/uvicorn main:app --host 0.0.0.0 --port <PORT>
 */

/** Reads requirements.txt lines, lowercased */
const readRequirements = (dir) => {
  const reqPath = path.join(dir, 'requirements.txt');
  if (!fs.existsSync(reqPath)) return [];
  return fs.readFileSync(reqPath, 'utf8').split('\n').map(l => l.toLowerCase().trim());
};

/** Checks pyproject.toml content for a package name */
const pyprojectHas = (dir, pkg) => {
  const p = path.join(dir, 'pyproject.toml');
  if (!fs.existsSync(p)) return false;
  return fs.readFileSync(p, 'utf8').toLowerCase().includes(pkg);
};

/** Discovers the FastAPI app module (looks for main.py, app.py, api.py, run.py, etc.) */
const findAppModule = (workDir) => {
  const candidates = [
    { file: 'main.py', module: 'main:app' },
    { file: 'app.py', module: 'app:app' },
    { file: 'api.py', module: 'api:app' },
    { file: 'run.py', module: 'run:app' },
    { file: 'server.py', module: 'server:app' },
    { file: 'application.py', module: 'application:app' },
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(workDir, c.file))) return c.module;
    // Also check src/ subdirectory
    if (fs.existsSync(path.join(workDir, 'src', c.file))) return `src.${c.module}`;
  }
  return 'main:app'; // Default fallback
};

module.exports = {
  id: 'fastapi',
  detect: (targetDir) => {
    try {
      const reqs = readRequirements(targetDir);
      const hasReqs = reqs.some(l => l.startsWith('fastapi') || l.startsWith('uvicorn'));
      if (hasReqs) return true;
      if (pyprojectHas(targetDir, 'fastapi') || pyprojectHas(targetDir, 'uvicorn')) return true;
    } catch (_) {}
    return false;
  },
  buildImage: 'python:3.12-slim',
  // Default runCommand (overridden via getConfig)
  runCommand: 'python -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -r requirements.txt',
  getPreviewCommand: (workDir) => {
    // Prefer local venv for isolation and speed (packages already cached)
    const unixUvicorn = path.join(workDir, '.venv', 'bin', 'uvicorn');
    const winUvicorn = path.join(workDir, '.venv', 'Scripts', 'uvicorn.exe');
    const appModule = findAppModule(workDir);

    let uvicornCmd = 'uvicorn';
    if (fs.existsSync(unixUvicorn)) {
      uvicornCmd = '.venv/bin/uvicorn';
    } else if (fs.existsSync(winUvicorn)) {
      uvicornCmd = '.venv/Scripts/uvicorn';
    }

    return {
      cmd: uvicornCmd,
      args: [appModule, '--host', '0.0.0.0', '--port', '${PORT:-8000}'],
      env: { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' }
    };
  },
  getConfig: (targetDir) => {
    const hasReqs = fs.existsSync(path.join(targetDir, 'requirements.txt'));
    const hasPyproject = fs.existsSync(path.join(targetDir, 'pyproject.toml'));

    let installCmd = '';
    if (hasReqs) {
      installCmd = 'python -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -r requirements.txt';
    } else if (hasPyproject) {
      installCmd = 'python -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install .';
    } else {
      installCmd = 'python -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install fastapi uvicorn';
    }

    return { buildImage: 'python:3.12-slim', runCommand: installCmd };
  },
  detectGui: (targetDir) => {
    // FastAPI is an API framework, it will never launch GUI apps
    return false;
  }
};
