const mongoose = require('mongoose');
require('dotenv').config();

const Node = require('./src/models/Node');
const SystemLog = require('./src/models/SystemLog');
const Threat = require('./src/models/Threat');
const NetworkEvent = require('./src/models/NetworkEvent');
const SecurityEvent = require('./src/models/SecurityEvent');
const Deployment = require('./src/models/Deployment');

async function clearData() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    // Remove the old dummy nodes
    const res = await Node.deleteMany({ ipAddress: "127.0.0.1", osVersion: "Linux" });
    console.log(`Deleted ${res.deletedCount} old dummy nodes (kali 127.0.0.1)`);

    // Remove all old mock data so the dashboard is clean
    await Threat.deleteMany({});
    await NetworkEvent.deleteMany({});
    await SecurityEvent.deleteMany({});
    await SystemLog.deleteMany({});
    await Deployment.deleteMany({});
    console.log("Cleared all mock dashboard data and logs");

  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

clearData();
