const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Ensure tmp directory exists
const uploadDir = path.join(os.tmpdir(), 'devops-uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate a unique filename using jobId if present or timestamp
    const jobId = req.body.jobId || `job-${Date.now()}`;
    cb(null, `${jobId}.zip`);
  }
});

const fileFilter = (req, file, cb) => {
  const filetypes = /zip/;
  const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed';

  if (mimetype && extname) {
    return cb(null, true);
  } else {
    cb(new Error('Only ZIP files are allowed!'), false);
  }
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB
  fileFilter: fileFilter
}).single('zipFile');

module.exports = upload;
