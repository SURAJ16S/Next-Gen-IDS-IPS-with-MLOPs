module.exports = {
  id: 'generic',
  detect: () => true, // Fallback, always returns true
  buildImage: 'alpine:latest',
  runCommand: 'echo "No build manifest found. Generic app build completed."',
  getPreviewCommand: () => {
    return { cmd: 'echo', args: ['No preview runtime command configured for this framework.'], env: {} };
  }
};
