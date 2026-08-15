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

/** Discovers the FastAPI app module (looks for main.py, app.py, api.py, run.py, etc. and dynamically resolves the FastAPI instance variable name) */
const findAppModule = (workDir) => {
  const candidates = [
    { file: 'main.py', base: 'main' },
    { file: 'app.py', base: 'app' },
    { file: 'api.py', base: 'api' },
    { file: 'run.py', base: 'run' },
    { file: 'server.py', base: 'server' },
    { file: 'application.py', base: 'application' },
  ];

  for (const c of candidates) {
    let filePath = path.join(workDir, c.file);
    let modulePrefix = '';
    if (!fs.existsSync(filePath)) {
      filePath = path.join(workDir, 'src', c.file);
      modulePrefix = 'src.';
    }

    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        // Regex to search for custom instance names like `my_api = FastAPI(...)` or `app = fastapi.FastAPI(...)`
        const match = content.match(/([a-zA-Z0-9_]+)\s*=\s*(?:[a-zA-Z0-9_]+\.)?FastAPI\s*\(/);
        if (match && match[1]) {
          return `${modulePrefix}${c.base}:${match[1]}`;
        }
      } catch (_) {}
      return `${modulePrefix}${c.base}:app`; // default fallback for that file
    }
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

    const hasPoetry = fs.existsSync(path.join(workDir, 'poetry.lock'));
    const hasPipfile = fs.existsSync(path.join(workDir, 'Pipfile'));
    
    let cmd = uvicornCmd;
    let args = [appModule, '--host', '0.0.0.0', '--port', '${PORT:-8000}'];
    
    if (hasPoetry && fs.existsSync(path.join(workDir, '.venv', 'bin', 'poetry'))) {
      cmd = '.venv/bin/poetry';
      args = ['run', 'uvicorn', ...args];
    } else if (hasPipfile && fs.existsSync(path.join(workDir, '.venv', 'bin', 'pipenv'))) {
      cmd = '.venv/bin/pipenv';
      args = ['run', 'uvicorn', ...args];
    }

    return {
      cmd,
      args,
      env: { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' }
    };
  },
  getConfig: (targetDir) => {
    const hasReqs = fs.existsSync(path.join(targetDir, 'requirements.txt'));
    const hasPyproject = fs.existsSync(path.join(targetDir, 'pyproject.toml'));
    const hasPoetry = fs.existsSync(path.join(targetDir, 'poetry.lock'));
    const hasPipfile = fs.existsSync(path.join(targetDir, 'Pipfile'));

    let installCmd = 'python -m venv .venv && .venv/bin/pip install --upgrade pip';
    
    if (hasPoetry) {
      installCmd += ' && .venv/bin/pip install poetry && .venv/bin/poetry install';
    } else if (hasPipfile) {
      installCmd += ' && .venv/bin/pip install pipenv && .venv/bin/pipenv install --deploy';
    } else if (hasReqs) {
      installCmd += ' && .venv/bin/pip install -r requirements.txt';
    } else if (hasPyproject) {
      installCmd += ' && .venv/bin/pip install .';
    } else {
      installCmd += ' && .venv/bin/pip install fastapi uvicorn';
    }

    return { buildImage: 'python:3.12-slim', runCommand: installCmd };
  },
  detectGui: (targetDir) => {
    // FastAPI is an API framework, it will never launch GUI apps
    return false;
  },
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};

