const fs = require('fs');
const path = require('path');

/**
 * Flask Framework Plugin (Python micro-framework)
 * Detects Flask by presence of "flask" in requirements.txt or pyproject.toml.
 * Venv Persistence: Creates .venv in workspace and installs pip dependencies.
 * Preview: .venv/bin/flask run --host=0.0.0.0 --port=<PORT>
 *          OR .venv/bin/python -m flask run --host=0.0.0.0 --port=<PORT>
 */

/** Reads requirements.txt and checks if a package name is present */
const requirementsHas = (dir, pkg) => {
  const reqPath = path.join(dir, 'requirements.txt');
  if (!fs.existsSync(reqPath)) return false;
  return fs.readFileSync(reqPath, 'utf8').toLowerCase().includes(pkg);
};

/** Checks pyproject.toml content for a package name */
const pyprojectHas = (dir, pkg) => {
  const p = path.join(dir, 'pyproject.toml');
  if (!fs.existsSync(p)) return false;
  return fs.readFileSync(p, 'utf8').toLowerCase().includes(pkg);
};

/** Discovers the Flask app module for FLASK_APP env variable */
const findFlaskApp = (workDir) => {
  const candidates = ['app.py', 'main.py', 'run.py', 'application.py', 'server.py', 'wsgi.py'];
  for (const c of candidates) {
    if (fs.existsSync(path.join(workDir, c))) return c;
  }
  // Check src/ subdirectory
  for (const c of candidates) {
    if (fs.existsSync(path.join(workDir, 'src', c))) return `src/${c}`;
  }
  return 'app.py'; // Default fallback
};

module.exports = {
  id: 'flask',
  detect: (targetDir) => {
    try {
      // Detect Flask but not FastAPI (to avoid overlap)
      const hasFlask = requirementsHas(targetDir, 'flask') || pyprojectHas(targetDir, 'flask');
      const hasFastAPI = requirementsHas(targetDir, 'fastapi') || requirementsHas(targetDir, 'uvicorn');
      return hasFlask && !hasFastAPI;
    } catch (_) {}
    return false;
  },
  buildImage: 'python:3.12-slim',
  runCommand: 'python -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -r requirements.txt',
  getPreviewCommand: (workDir) => {
    const unixPython = path.join(workDir, '.venv', 'bin', 'python');
    const winPython = path.join(workDir, '.venv', 'Scripts', 'python.exe');
    const flaskApp = findFlaskApp(workDir);

    let pythonCmd = 'python';
    if (fs.existsSync(unixPython)) {
      pythonCmd = '.venv/bin/python';
    } else if (fs.existsSync(winPython)) {
      pythonCmd = '.venv/Scripts/python';
    }

    return {
      cmd: pythonCmd,
      args: ['-m', 'flask', 'run', '--host=0.0.0.0', '--port=${PORT:-5000}'],
      env: {
        FLASK_APP: flaskApp,
        FLASK_ENV: 'production',
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1'
      }
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
      installCmd = 'python -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install flask';
    }

    return { buildImage: 'python:3.12-slim', runCommand: installCmd };
  },
  detectGui: (targetDir) => {
    // Flask is a web framework, but check for embedded tkinter/GUI imports in Python files
    const detectPythonGui = (dir) => {
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          const full = path.join(dir, f);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            if (f === '.venv' || f === 'venv' || f === '.git' || f === '__pycache__') continue;
            if (detectPythonGui(full)) return true;
          } else if (f.endsWith('.py')) {
            const content = fs.readFileSync(full, 'utf8');
            if (content.includes('tkinter') || content.includes('PyQt') || content.includes('PySide')) {
              return true;
            }
          }
        }
      } catch (_) {}
      return false;
    };
    return detectPythonGui(targetDir);
  },
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
