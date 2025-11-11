// backend/src/middleware/upload.js
const path = require("path");
const fs = require("fs");
const multer = require("multer");

// Uploads directory (same location as before: backend/uploads)
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const safe = file.originalname
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_.-]/g, "");
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({ storage });

module.exports = { upload, UPLOADS_DIR };
