const Deployment = require('../models/Deployment');

const getDeployments = async (req, res) => {
  try {
    const deployments = await Deployment.find().sort({ createdAt: -1 });
    res.json(deployments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createDeployment = async (req, res) => {
  try {
    const deployment = await Deployment.create(req.body);
    res.status(201).json(deployment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateDeploymentStatus = async (req, res) => {
  try {
    const deployment = await Deployment.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );
    if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
    res.json(deployment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getDeployments, createDeployment, updateDeploymentStatus };