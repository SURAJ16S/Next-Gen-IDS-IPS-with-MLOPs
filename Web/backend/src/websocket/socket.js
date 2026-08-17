const { Server } = require('socket.io');
const Node = require('../models/Node');
const bcrypt = require('bcryptjs');

let io;

const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.use(async (socket, next) => {
    const nodeId = socket.handshake.headers['x-node-id'];
    const secret = socket.handshake.headers['x-node-secret'];
    
    if (nodeId && secret) {
      const node = await Node.findOne({ nodeId, status: 'active' });
      if (node && await bcrypt.compare(secret, node.nodeSecretKey)) {
        socket.isAgent = true;
        socket.nodeId = nodeId;
        return next();
      }
      return next(new Error('Agent authentication error'));
    }
    next();
  });

  io.on('connection', (socket) => {
    if (socket.isAgent) {
      socket.join(`agent_${socket.nodeId}`);
      console.log(`Agent connected: ${socket.nodeId}`);
    } else {
      console.log(`Dashboard client connected: ${socket.id}`);
    }

    // Subscribe dashboard client to real-time pipeline log streams by jobId
    socket.on('subscribe:pipeline', ({ jobId }) => {
      socket.join(`pipeline:${jobId}`);
      console.log(`Socket ${socket.id} subscribed to pipeline:${jobId}`);
    });

    socket.on('unsubscribe:pipeline', ({ jobId }) => {
      socket.leave(`pipeline:${jobId}`);
      console.log(`Socket ${socket.id} unsubscribed from pipeline:${jobId}`);
    });

    socket.on('pipeline:submit-upgrades', ({ jobId, selectedUpgrades }) => {
      console.log(`[Socket] Received upgrade choices for job ${jobId}`);
      const { submitUserSelection } = require('../services/interaction-manager.service');
      const resumed = submitUserSelection(jobId, selectedUpgrades);
      if (resumed) {
        console.log(`[Socket] Successfully resumed pipeline for job ${jobId}`);
      }
    });

    let terminalStream = null;
    socket.on('terminal:init', async ({ jobId }) => {
      console.log(`[Terminal] Client initialized terminal for job ${jobId}`);
      
      const Docker = require('dockerode');
      const activeDocker = new Docker();
      const targetContainerName = `devops-preview-${jobId}`;
      const container = activeDocker.getContainer(targetContainerName);
      
      try {
        const inspect = await container.inspect();
        if (!inspect.State.Running) {
          socket.emit('terminal:data', '\r\n\x1b[31m[Error] Preview container is offline. Please start/restart the preview sandbox first!\x1b[0m\r\n');
          return;
        }

        const exec = await container.exec({
          Cmd: ['sh'],
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true
        });

        terminalStream = await exec.start({ hijack: true, stdin: true });
        
        terminalStream.on('data', (chunk) => {
          socket.emit('terminal:data', chunk.toString('utf8'));
        });

        terminalStream.on('end', () => {
          socket.emit('terminal:data', '\r\n\x1b[33m[Shell connection closed]\x1b[0m\r\n');
          terminalStream = null;
        });

        terminalStream.on('error', (err) => {
          socket.emit('terminal:data', `\r\n\x1b[31m[Shell Error] ${err.message}\x1b[0m\r\n`);
          terminalStream = null;
        });

      } catch (err) {
        socket.emit('terminal:data', `\r\n\x1b[31m[Error launching shell] ${err.message}\x1b[0m\r\n`);
      }
    });

    socket.on('terminal:input', (data) => {
      if (terminalStream) {
        terminalStream.write(data);
      }
    });

    socket.on('disconnect', () => {
      if (terminalStream) {
        try { terminalStream.destroy(); } catch(_) {}
        terminalStream = null;
      }
      if (socket.isAgent) {
        console.log(`Agent disconnected: ${socket.nodeId}`);
      } else {
        console.log(`Client disconnected: ${socket.id}`);
      }
    });
  });

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
};

module.exports = { initSocket, getIO };