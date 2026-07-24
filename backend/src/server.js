const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('./config/database');
const { initSocket } = require('./websocket/socket');
const requestLogger = require('./middleware/requestLogger');

connectDB();

const app = express();

app.use(cors());
app.use(express.json());
app.use(requestLogger);

app.get('/', (req, res) => {
  res.send('IDPS Backend API Running');
});

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/dashboard', require('./routes/dashboard.routes'));
app.use('/api/threats', require('./routes/threat.routes'));
app.use('/api/network', require('./routes/network.routes'));
app.use('/api/logs', require('./routes/logs.routes'));
app.use('/api/analytics', require('./routes/analytics.routes'));
app.use('/api/devops', require('./routes/devops.routes'));

const server = http.createServer(app);
initSocket(server);

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});