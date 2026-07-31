const express = require('express');
const router = express.Router();
const { ingestDetections, ingestConnections, ingestFlows } = require('../controllers/agent.controller');
const { agentAuth } = require('../middleware/agent.middleware');

router.use(agentAuth); 

router.post('/telemetry/detections', ingestDetections);
router.post('/telemetry/connections', ingestConnections);
router.post('/telemetry/flows', ingestFlows);

module.exports = router;
