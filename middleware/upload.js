// backend/src/middleware/upload.js
const path = require("path");
const fs = require("fs");
const multer = require("multer");

// Uploads directory (same location as before: backend/uploads)
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Use memory storage so we can upload buffer to ImageKit (or write to disk as fallback)
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB default limit (adjust if you want)
  },
});

module.exports = { upload, UPLOADS_DIR };
