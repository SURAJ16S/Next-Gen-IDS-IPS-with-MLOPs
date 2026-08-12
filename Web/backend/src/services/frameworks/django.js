const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'django',
  detect: (targetDir) => {
    return (
      fs.existsSync(path.join(targetDir, 'requirements.txt')) ||
      fs.existsSync(path.join(targetDir, 'manage.py')) ||
      fs.existsSync(path.join(targetDir, 'pyproject.toml'))
    );
  },
  buildImage: 'python:3.12-slim',
  runCommand: 'pip install -r requirements.txt && python manage.py migrate', // Default global fallback
  getPreviewCommand: (workDir) => {
    // Check for local virtual environment Python first to ensure dependencies are loaded
    const unixVenv = path.join(workDir, '.venv', 'bin', 'python');
    const winVenv = path.join(workDir, '.venv', 'Scripts', 'python.exe');
    
    let pythonCmd = 'python';
    if (fs.existsSync(unixVenv)) {
      pythonCmd = '.venv/bin/python'; // Relative Unix path inside container
    } else if (fs.existsSync(winVenv)) {
      pythonCmd = '.venv/Scripts/python'; // Relative Windows path
    }

    if (fs.existsSync(path.join(workDir, 'manage.py'))) {
      return { cmd: pythonCmd, args: ['manage.py', 'runserver', '0'], env: {} };
    }
    return { cmd: 'echo', args: ['Django manage.py not found.'], env: {} };
  },
  getConfig: (targetDir) => {
    return {
      buildImage: 'python:3.12-slim',
      // Create a local virtual environment in the workspace to persist installed pip packages
      runCommand: 'python -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -r requirements.txt && .venv/bin/python manage.py migrate'
    };
  },
  detectGui: (targetDir) => {
    const detectPythonGui = (dir) => {
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          const full = path.join(dir, f);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            if (f === '.venv' || f === 'venv' || f === '.git' || f === 'node_modules') continue;
            if (detectPythonGui(full)) return true;
          } else if (f.endsWith('.py')) {
            const content = fs.readFileSync(full, 'utf8');
            if (
              content.includes('tkinter') || 
              content.includes('PyQt') || 
              content.includes('PySide') || 
              content.includes('wxPython') || 
              content.includes('kivy') ||
              content.includes('customtkinter')
            ) {
              return true;
            }
          }
        }
      } catch (_) {}
      return false;
    };
    return detectPythonGui(targetDir);
  }
};
