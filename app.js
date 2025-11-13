// app.js
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

let ImageKit = null;
let imagekitClient = null;
// initialize ImageKit client if env vars present
if (
  process.env.IMAGEKIT_PUBLIC_KEY &&
  process.env.IMAGEKIT_PRIVATE_KEY &&
  process.env.IMAGEKIT_URL_ENDPOINT
) {
  try {
    ImageKit = require("imagekit");
    imagekitClient = new ImageKit({
      publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
      privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
      urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
    });
    console.log("ImageKit initialized.");
  } catch (err) {
    console.error("Failed to initialize ImageKit:", err);
    imagekitClient = null;
  }
}

const app = express();

// --- START: improved origins parsing (supports comma-separated values, filters empties) ---
function parseOrigins(envVal) {
  if (!envVal) return [];
  return envVal
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Backwards-compatible default (your production origin)
const DEFAULT_ORIGINS = ["https://chess-alyas.vercel.app"];

// Always include localhost during development (convenience)
const DEV_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

// Build allowed origins from env + sensible defaults, removing duplicates and empties
const fromEnv = parseOrigins(process.env.SOCKET_ORIGIN);
const ALLOWED_ORIGINS = Array.from(
  new Set([
    ...fromEnv,
    ...DEFAULT_ORIGINS,
    ...(process.env.NODE_ENV === "production" ? [] : DEV_ORIGINS),
  ])
).filter(Boolean);
// --- END: improved origins parsing ---

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

      // If ImageKit is configured, upload there first
      if (imagekitClient) {
        try {
          const safeName = (req.file.originalname || "avatar")
            .replace(/\s+/g, "_")
            .replace(/[^a-zA-Z0-9_.-]/g, "");
          const fileName = `${Date.now()}_${safeName}`;

          // convert buffer to base64 string for imagekit
          const base64 = req.file.buffer.toString("base64");

          // optional: put avatars inside a folder
          const folder =
            process.env.IMAGEKIT_AVATAR_FOLDER || "/Chess-app-avaters";

          const uploadResult = await imagekitClient.upload({
            file: base64,
            fileName,
            folder,
          });

          // store absolute URL returned by ImageKit (this keeps absoluteAvatarUrl behavior consistent)
          u.avatarUrl = uploadResult.url; // absolute URL
          await u.save();

          res.json({
            avatarUrl: u.avatarUrl,
            avatarUrlAbsolute: u.avatarUrl,
          });
          return;
        } catch (ikErr) {
          console.error(
            "ImageKit upload failed, falling back to local save:",
            ikErr
          );
          // continue to fallback local save below
        }
      }

      // FALLBACK: Save to local disk (keeps previous behavior)
      const safe = (req.file.originalname || "avatar")
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9_.-]/g, "");
      const filename = `${Date.now()}_${safe}`;
      const outPath = path.join(UPLOADS_DIR, filename);

      // write buffer to disk
      fs.writeFileSync(outPath, req.file.buffer);

      const rel = `/uploads/${filename}`;
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

// socket.on("webrtc-offer", ({ roomId, toSocketId, offer }) => {
//   try {
//     const payload = { fromSocketId: socket.id, offer };

//     if (toSocketId) {
//       relayToSocketOrUser(toSocketId, "webrtc-offer", payload);
//       return;
//     }

//     if (roomId && rooms[roomId]) {
//       const opponent = (rooms[roomId].players || []).find(
//         (p) => p.id !== socket.id && (p.color === "w" || p.color === "b")
//       );
//       if (opponent && opponent.id) {
//         relayToSocketOrUser(opponent.id, "webrtc-offer", payload);
//       }
//     }
//   } catch (e) {
//     console.error("webrtc-offer relay error:", e);
//   }
// });
