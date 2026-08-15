const mongoose = require('mongoose');

const fixtureReviewSchema = new mongoose.Schema(
  {
    frameworkId: { type: String, required: true },
    reviewerName: { type: String, required: true },
    status: { type: String, required: true, enum: ['Works', 'Buggy', 'Broken'] },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('FixtureReview', fixtureReviewSchema);
