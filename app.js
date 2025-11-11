const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");

const authRoutes = require("./routes/auth");
const gameRoutes = require("./routes/game");

// NEW: rooms route
const roomsRoutes = require("./routes/rooms");

// NEW: invites route (mount this so /api/invites works)
const invitesRoutes = require("./routes/invites");

const { upload, UPLOADS_DIR } = require("./middleware/upload");
const {
  restAuthMiddleware,
  detectClientIpFromReq,
  updateUserIpIfChangedFromReq,
} = require("./middleware/auth");

const app = express();

// Accept comma-separated origins (backwards compatible)
const ALLOWED_ORIGINS = process.env.SOCKET_ORIGIN
  ? process.env.SOCKET_ORIGIN.split(",").map((s) => s.trim())
  : ["http://localhost:3000"];

// allow credentials so cookies can be used from frontend
app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (e.g. mobile apps, curl, or same-origin requests)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return callback(null, true);
      // otherwise block
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// Ensure Access-Control-Allow-Credentials header (helps some proxies/browsers)
// Note: this is additive; cors({ credentials: true }) already sets this for normal responses.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  // help caching proxies vary by origin
  res.setHeader("Vary", "Origin");
  next();
});

app.use(express.json());

// IMPORTANT: trust proxy so req.ip/x-forwarded-for work when behind a proxy/load-balancer
app.set("trust proxy", true);

// ensure uploads dir exists (upload middleware already does but safe to ensure here too)
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Serve uploaded files from both /uploads and /api/uploads so frontends using either path work
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/api/uploads", express.static(UPLOADS_DIR));

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/game", gameRoutes);
app.use("/api/rooms", roomsRoutes); // <--- IMPORTANT: mount rooms endpoint

const friendsRoutes = require("./routes/friends");
app.use("/api/friends", friendsRoutes);

// Players (public list)
const playersRoutes = require("./routes/players");
app.use("/api/players", playersRoutes);

// --- NEW: mount invites routes so GET /api/invites and POST /api/invites work ---
app.use("/api/invites", invitesRoutes);

// add near other route mounts (e.g. after playersRoutes)
const notificationsRoutes = require("./routes/notifications");
app.use("/api/notifications", notificationsRoutes);

// connect mongoose
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://localhost:27017/chessapp")
  .then(async () => {
    console.log("MongoDB connected");

    // --- one-time index cleanup & patch for incomingFriendRequests.reqId ---
    try {
      const coll = mongoose.connection.db.collection("users");

      // 1) drop any index that targets incomingFriendRequests.reqId
      const indexes = await coll.indexes();
      const badIndex = indexes.find(
        (i) =>
          i.key &&
          Object.prototype.hasOwnProperty.call(
            i.key,
            "incomingFriendRequests.reqId"
          )
      );

      if (badIndex) {
        console.log("Found bad index:", badIndex.name, "- dropping it...");
        await coll.dropIndex(badIndex.name);
        console.log("Dropped bad index:", badIndex.name);
      } else {
        console.log("No bad index on incomingFriendRequests.reqId found.");
      }

      // 2) Fix existing user documents that may have null/empty/duplicate reqId values
      // Load the User model (require here to avoid any potential circular require at module load time)
      const User = require("./models/User");

      const users = await User.find({}).exec();
      let patched = 0;

      for (const u of users) {
        const arr = Array.isArray(u.incomingFriendRequests)
          ? u.incomingFriendRequests
          : [];
        let changed = false;
        const seen = new Set();

        for (let i = 0; i < arr.length; i++) {
          const fr = arr[i] || {};
          // If missing/empty/null reqId -> assign new ObjectId string
          if (
            !fr.reqId ||
            typeof fr.reqId !== "string" ||
            fr.reqId.trim() === ""
          ) {
            arr[i].reqId = new mongoose.Types.ObjectId().toString();
            changed = true;
          }
          // If duplicate reqId inside same user's array -> assign new id
          if (seen.has(arr[i].reqId)) {
            arr[i].reqId = new mongoose.Types.ObjectId().toString();
            changed = true;
          }
          seen.add(arr[i].reqId);
        }

        if (changed) {
          u.incomingFriendRequests = arr;
          await u.save();
          patched++;
        }
      }

      console.log(
        `Patched ${patched} user(s) with missing/duplicate incomingFriendRequests.reqId.`
      );
    } catch (err) {
      console.error("Index cleanup / patching failed:", err);
    }
    // --- end cleanup ---
  })
  .catch((err) => console.error("Mongo connect error", err));

// upload avatar endpoint (multipart/form-data, field name 'avatar')
app.post(
  "/api/auth/upload-avatar",
  restAuthMiddleware,
  upload.single("avatar"),
  async (req, res) => {
    try {
      const User = require("./models/User");
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const u = await User.findById(req.user.id);
      if (!u) return res.status(404).json({ error: "User not found" });
      // store relative URL
      const rel = `/uploads/${req.file.filename}`;
      u.avatarUrl = rel;
      await u.save();

      // return both relative (for DB) and absolute (helpful for clients)
      const base =
        process.env.BACKEND_BASE_URL ||
        `http://localhost:${process.env.PORT || 4000}`;
      const abs = `${base}${rel}`;

      res.json({ avatarUrl: rel, avatarUrlAbsolute: abs });
    } catch (err) {
      console.error("upload-avatar error", err);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

module.exports = app;
