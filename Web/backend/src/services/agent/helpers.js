const path = require('path');
const fs = require('fs');
const Docker = require('dockerode');

// Utility to clean docker stream output
const cleanDockerOutput = (rawBuffer) => {
  if (!Buffer.isBuffer(rawBuffer)) {
    rawBuffer = Buffer.from(rawBuffer);
  }
  let offset = 0;
  let cleanText = '';
  
  while (offset < rawBuffer.length) {
    if (offset + 8 <= rawBuffer.length) {
      const type = rawBuffer[offset];
      if (type === 1 || type === 2) {
        const size = rawBuffer.readUInt32BE(offset + 4);
        if (size > 0 && offset + 8 + size <= rawBuffer.length) {
          cleanText += rawBuffer.toString('utf8', offset + 8, offset + 8 + size);
          offset += 8 + size;
          continue;
        }
      }
    }
    cleanText += rawBuffer.toString('utf8', offset, offset + 1);
    offset += 1;
  }
  return cleanText;
};

// Flatten workspace files
const getFlatWorkspaceFiles = (dirPath, relativeDir = '') => {
  let list = [];
  if (!fs.existsSync(dirPath)) return list;
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      if (['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.security-reports'].includes(file)) continue;
      const fullPath = path.join(dirPath, file);
      const relPath = path.join(relativeDir, file).replace(/\\/g, '/');
      
      let isDir;
      try {
        isDir = fs.statSync(fullPath).isDirectory();
      } catch (err) {
        continue;
      }
      
      if (isDir) {
        list = list.concat(getFlatWorkspaceFiles(fullPath, relPath));
      } else {
        list.push(relPath);
      }
    }
  } catch (_) {}
  return list;
};

// Security check for commands
const isCommandSafe = (command) => {
  if (!command || typeof command !== 'string') return false;
  const cmd = command.toLowerCase().trim();
  if (/\brm\s+-[a-z]*r[a-z]*\s+(\/($|\s|\*)|(\.\.)($|\s)|\*)/.test(cmd)) return false;
  if (/\b(nc|netcat|ncat)\b/.test(cmd)) return false;
  if (cmd.includes('/dev/tcp') || cmd.includes('/dev/udp')) return false;
  if (cmd.includes('bash -i') || cmd.includes('sh -i')) return false;
  if (cmd.includes('docker ') || cmd.includes('docker.sock')) return false;
  if (/\b(mkfs|dd|fdisk|parted)\b/.test(cmd) && (cmd.includes('/dev/') || cmd.includes('of='))) return false;
  if (cmd.includes('/etc/passwd') || cmd.includes('/etc/shadow') || cmd.includes('/etc/gshadow') || cmd.includes('/etc/group')) return false;
  if (cmd.includes(':(){') || cmd.includes(':|:&')) return false;
  return true;
};

// Read-only checker
const isReadOnlyCommand = (command) => {
  if (!command || typeof command !== 'string') return false;
  const cmd = command.toLowerCase().trim();
  if (/[><]/.test(cmd)) return false;
  const subParts = cmd.split(/[;&|]/).map(s => s.trim()).filter(Boolean);
  if (subParts.length === 0) return false;
  
  const readKeywords = ['cat', 'ls', 'find', 'grep', 'pwd', 'head', 'tail', 'echo', 'printenv', 'file', 'stat', 'which', 'type', 'du', 'df'];
  for (const part of subParts) {
    const firstWord = part.split(/\s+/)[0];
    if (!readKeywords.includes(firstWord)) {
      return false;
    }
  }
  return true;
};

/**
 * Execute a command inside the DevOps preview container
 */
const runCommandInContainer = async (containerName, cmd) => {
  try {
    const activeDocker = new Docker();
    const container = activeDocker.getContainer(containerName);
    
    let isRunning = false;
    try {
      const inspect = await container.inspect();
      isRunning = inspect.State.Running;
    } catch (_) {}

    if (!isRunning) {
      return `Execution blocked: Preview container "${containerName}" is offline.\n`;
    }

    const exec = await container.exec({ 
      Cmd: ['sh', '-c', `cd /project 2>/dev/null || cd /workspace 2>/dev/null || true; ${cmd}`], 
      AttachStdout: true, 
      AttachStderr: true 
    });
    
    const stream = await exec.start();
    return await new Promise((resolve) => {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const fullBuffer = Buffer.concat(chunks);
        resolve(cleanDockerOutput(fullBuffer));
      });
      stream.on('error', () => resolve(''));
    });
  } catch (err) {
    return `Error executing command: ${err.message}\n`;
  }
};

module.exports = {
  getFlatWorkspaceFiles,
  isCommandSafe,
  isReadOnlyCommand,
  runCommandInContainer
};
