const mongoose = require('mongoose');
const Deployment = require('../models/Deployment');

/**
 * Middleware to enforce login-based data isolation and GitHub collaborator permissions.
 * @param {'visibility'|'build'|'chat'} requiredPrivilege 
 */
const checkDeploymentAccess = (requiredPrivilege = 'visibility') => {
  return async (req, res, next) => {
    try {
      const { id } = req.params;
      
      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid deployment ID.' });
      }

      const deployment = await Deployment.findById(id);
      if (!deployment) {
        return res.status(404).json({ message: 'Deployment not found.' });
      }

      // 1. Author (creator) always has full access
      if (deployment.deployedBy && deployment.deployedBy.toString() === req.user._id.toString()) {
        return next();
      }

      // 2. For GitHub deployments, check if user is a verified collaborator
      if (deployment.deploymentType === 'github' && deployment.githubRepo) {
        const username = req.user.githubUsername;
        if (username && deployment.collaborators && deployment.collaborators.some(c => c.toLowerCase() === username.toLowerCase())) {
          const perms = deployment.githubPermissions || {};
          
          if (requiredPrivilege === 'visibility' && perms.allowCollaboratorVisibility !== false) {
            return next();
          }
          if (requiredPrivilege === 'build' && perms.allowCollaboratorBuild === true) {
            return next();
          }
          if (requiredPrivilege === 'chat' && perms.allowCollaboratorChat === true) {
            return next();
          }
          
          return res.status(403).json({ 
            message: `Collaborator access denied. The project owner has not granted '${requiredPrivilege}' privileges to collaborators.` 
          });
        }
      }

      // 3. Fallback: Forbidden
      return res.status(403).json({ 
        message: 'Access denied. You do not have permission to view or manage this deployment.' 
      });
    } catch (error) {
      console.error('Error in checkDeploymentAccess middleware:', error);
      res.status(500).json({ message: 'Internal server error verifying deployment access.' });
    }
  };
};

module.exports = {
  checkDeploymentAccess
};
