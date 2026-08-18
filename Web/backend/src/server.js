const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const path = require('path');
const helmet = require('helmet');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('./config/database');
const { initSocket } = require('./websocket/socket');
const requestLogger = require('./middleware/requestLogger');

connectDB();

const app = express();

// ─── Security Headers (Helmet) ────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: false, // handled by frontend if needed
    crossOriginEmbedderPolicy: false,
  })
);

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// ─── Body Parsing (capped at 10kb to prevent payload DoS) ────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ─── Request Logger ───────────────────────────────────────────────────────────
app.use(requestLogger);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'IDPS Backend API Running', timestamp: new Date() });
});

// ─── Prometheus Metrics Scraping ──────────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  try {
    const { register } = require('./services/agent/metrics');
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/dashboard', require('./routes/dashboard.routes'));
app.use('/api/threats', require('./routes/threat.routes'));
app.use('/api/network', require('./routes/network.routes'));
app.use('/api/logs', require('./routes/logs.routes'));
app.use('/api/analytics', require('./routes/analytics.routes'));
app.use('/api/devops', require('./routes/devops.routes'));
app.use('/api/nodes', require('./routes/node.routes'));
app.use('/api/agent', require('./routes/agent.routes'));

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.originalUrl} not found` });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('UNHANDLED ERROR:', err);
  res.status(err.status || 500).json({ message: err.message || 'Internal Server Error' });
});

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(app);
initSocket(server);

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`🔒 Helmet security headers: enabled`);
  console.log(`📡 Environment: ${process.env.NODE_ENV}`);
  try {
    const { startPruningScheduler } = require('./services/pruning.service');
    startPruningScheduler();
  } catch (err) {
    console.error('Failed to start pruning scheduler:', err);
  }
});