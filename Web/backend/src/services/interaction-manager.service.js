const pendingInteractions = new Map();

/**
 * Pauses the pipeline and awaits user selection for recommended dependency upgrades.
 * Falls back to auto-applying all upgrades if the timeout expires.
 * 
 * @param {string} jobId      - The active pipeline Job ID
 * @param {Array}  upgrades   - The array of audited upgrades
 * @param {number} timeoutMs  - Timeout duration in milliseconds (default: 10000)
 * @returns {Promise<Array>}  - Resolves with the array of upgrades to apply
 */
const waitForUserSelection = (jobId, upgrades, timeoutMs = 10000) => {
  return new Promise((resolve) => {
    // 1. Define automatic timeout fallback
    const timeoutId = setTimeout(() => {
      if (pendingInteractions.has(jobId)) {
        pendingInteractions.delete(jobId);
        // By default, apply all recommended upgrades if timeout expires
        resolve(upgrades);
      }
    }, timeoutMs);

    // 2. Register callbacks in state map
    pendingInteractions.set(jobId, {
      resolve,
      timeoutId,
      upgrades
    });

    // 3. Emit interactive prompt to frontend client
    const { getIO } = require('../websocket/socket');
    try {
      const io = getIO();
      io.to(`pipeline:${jobId}`).emit('pipeline:interactive-upgrades', {
        jobId,
        upgrades,
        timeoutMs
      });
    } catch (err) {
      console.error('[!] Failed to emit interactive upgrades event:', err.message);
    }
  });
};

/**
 * Resumes a paused pipeline with the upgrades chosen by the user.
 * 
 * @param {string} jobId            - The active pipeline Job ID
 * @param {Array}  selectedUpgrades - Selected upgrade objects to apply
 * @returns {boolean}               - True if successfully resumed, false if timed out or missing
 */
const submitUserSelection = (jobId, selectedUpgrades) => {
  if (pendingInteractions.has(jobId)) {
    const { resolve, timeoutId } = pendingInteractions.get(jobId);
    clearTimeout(timeoutId);
    pendingInteractions.delete(jobId);
    resolve(selectedUpgrades || []);
    return true;
  }
  return false;
};

module.exports = {
  waitForUserSelection,
  submitUserSelection
};
