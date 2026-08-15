const fs = require('fs');
const path = require('path');

/**
 * Gin Framework Plugin (Go HTTP Router)
 * Detects Gin by presence of go.mod containing "gin-gonic/gin".
 * Build: go build -o /workspace/app ./...
 * Preview: ./app
 */
module.exports = {
  id: 'gin',
  detect: (targetDir) => {
    try {
      const goModPath = path.join(targetDir, 'go.mod');
      if (fs.existsSync(goModPath)) {
        const content = fs.readFileSync(goModPath, 'utf8');
        return content.includes('gin-gonic/gin');
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'golang:1.22-alpine',
  previewImage: 'golang:1.22-alpine',
  runCommand: 'go env -w GOPATH=/root/go && go build -o /workspace/app ./...',
  getPreviewCommand: (workDir) => {
    return {
      cmd: '/workspace/app',
      args: [],
      env: { GIN_MODE: 'release' }
    };
  },
  getConfig: (targetDir) => {
    return {
      buildImage: 'golang:1.22-alpine',
      previewImage: 'golang:1.22-alpine',
      runCommand: 'go env -w GOPATH=/root/go && go build -o /workspace/app ./...'
    };
  },
  detectGui: (targetDir) => {
    try {
      const goModPath = path.join(targetDir, 'go.mod');
      if (fs.existsSync(goModPath)) {
        const content = fs.readFileSync(goModPath, 'utf8');
        return content.includes('fyne.io/fyne') || content.includes('therecipe/qt') || content.includes('gioui.org');
      }
    } catch (_) {}
    return false;
  },
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
