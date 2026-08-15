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

    socket.on('disconnect', () => {
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