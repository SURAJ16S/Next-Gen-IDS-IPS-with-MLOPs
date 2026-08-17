const fs = require('fs');
const path = require('path');
const Deployment = require('../models/Deployment');

const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..', '..');
const BUILDS_BASE_DIR = path.join(WORKSPACE_DIR, 'DevOps', 'builds');

const PRUNE_FOLDERS_MAP = {
  // Node / JS / MERN / Frontend
  mern: ['node_modules'],
  nextjs: ['node_modules', '.next'],
  nuxt: ['node_modules', '.nuxt'],
  sveltekit: ['node_modules', '.svelte-kit'],
  astro: ['node_modules', '.astro'],
  remix: ['node_modules', '.cache', 'build'],
  vite: ['node_modules', 'dist'],
  cra: ['node_modules', 'build'],
  angular: ['node_modules', 'dist'],
  vuecli: ['node_modules', 'dist'],
  svelte: ['node_modules', 'dist'],
  preact: ['node_modules', 'dist'],
  analog: ['node_modules', '.nitro', 'dist'],
  tanstackStart: ['node_modules', '.vinxi', 'dist'],

  // Python
  flask: ['.venv', '__pycache__'],
  fastapi: ['.venv', '__pycache__'],
  django: ['.venv', '__pycache__'],

  // Java
  spring: ['target'],
  quarkus: ['target', '.quarkus'],

  // PHP
  php: ['vendor'],
  symfony: ['vendor', 'var/cache'],

  // Other Ecosystems
  ruby: ['.bundle', 'vendor/bundle'],
  rails: ['.bundle', 'vendor/bundle', 'tmp/cache'],
  sinatra: ['.bundle', 'vendor/bundle'],
  rust: ['target'],
  phoenix: ['_build', 'deps', 'assets/node_modules']
};

const { exec } = require('child_process');

const deleteFolderCmd = (dirPath) => {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? `rmdir /s /q "${dirPath}"`
      : `rm -rf "${dirPath}"`;
    exec(cmd, (err) => {
      resolve(!err);
    });
  });
};

/**
 * Strips heavy directories for a given deployment's build workspace.
 */
const pruneDeploymentWorkspace = async (deployment) => {
  const buildDir = path.join(BUILDS_BASE_DIR, deployment.jobId);
  if (!fs.existsSync(buildDir)) {
    console.log(`[PRUNER] Build directory not found on disk for Job ${deployment.jobId}. Setting status only.`);
    deployment.isPruned = true;
    await deployment.save();
    return;
  }

  const stack = deployment.techStackDetected || 'generic';
  const foldersToPrune = PRUNE_FOLDERS_MAP[stack] || ['node_modules', '.venv', 'target', 'vendor']; // fallback default

  console.log(`[PRUNER] Pruning Job ${deployment.jobId} (Stack: ${stack}) at ${buildDir}...`);

  let spaceReclaimed = 0;
  for (const folder of foldersToPrune) {
    const folderPath = path.join(buildDir, folder);
    if (fs.existsSync(folderPath)) {
      try {
        // Measure size before deletion
        const getDirSize = (dir) => {
          let size = 0;
          try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
              const filePath = path.join(dir, file);
              const stat = fs.lstatSync(filePath);
              if (stat.isDirectory()) {
                size += getDirSize(filePath);
              } else {
                size += stat.size;
              }
            }
          } catch (_) {}
          return size;
        };
        const sizeBytes = getDirSize(folderPath);
        
        await deleteFolderCmd(folderPath);
        spaceReclaimed += sizeBytes;
        console.log(`[PRUNER] Deleted folder: ${folder} (~${(sizeBytes / 1024 / 1024).toFixed(2)} MB)`);
      } catch (err) {
        console.error(`[PRUNER] Failed to delete folder ${folder}:`, err.message);
      }
    }
  }

  // Write a physical marker file
  try {
    fs.writeFileSync(path.join(buildDir, '.pruned'), `Pruned at ${new Date().toISOString()}`, 'utf8');
  } catch (_) {}

  // Update Database
  deployment.isPruned = true;
  await deployment.save();

  console.log(`[PRUNER] Job ${deployment.jobId} pruned successfully. Reclaimed ~${(spaceReclaimed / 1024 / 1024).toFixed(2)} MB.`);
};

/**
 * Runs a check cycle over all deployed, stopped previews to prune inactive ones.
 */
const runPruningCycle = async () => {
  console.log(`[PRUNER] Starting database sweep for inactive builds...`);
  try {
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago

    // Deployments that are completed, not running preview, and not yet pruned
    const deployments = await Deployment.find({
      status: 'deployed',
      previewStatus: { $in: ['stopped', 'none'] },
      isPruned: false,
      $or: [
        { lastPreviewedAt: { $lt: cutoffTime } },
        { lastPreviewedAt: { $exists: false }, createdAt: { $lt: cutoffTime } }
      ]
    });

    console.log(`[PRUNER] Found ${deployments.length} candidate deployment(s) for dependency pruning.`);
    for (const d of deployments) {
      await pruneDeploymentWorkspace(d);
    }
  } catch (err) {
    console.error(`[PRUNER] Pruning cycle error:`, err);
  }
};

/**
 * Starts the pruning background scheduler.
 */
const startPruningScheduler = () => {
  // Trigger a check 10 seconds after server startup
  setTimeout(() => {
    runPruningCycle();
  }, 10000);

  // Repeat every hour
  setInterval(() => {
    runPruningCycle();
  }, 3600000);

  console.log(`[PRUNER] Staged Dependency Pruning background scheduler initialized (TTL: 24h).`);
};

module.exports = {
  startPruningScheduler,
  runPruningCycle,
  pruneDeploymentWorkspace
};
