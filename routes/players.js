// backend/src/routes/players.js
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const { onlineUsers } = require("../roomManager");

/**
 * tryRequire(pathsArray)
 * Try multiple require() paths and return the first successful module.
 */
function tryRequire(paths) {
  for (const p of paths) {
    try {
      return require(p);
    } catch (err) {
      if (!(err && err.code && err.code === "MODULE_NOT_FOUND")) {
        throw err;
      }
    }
  }
  const msg = `tryRequire: none of the paths resolved: ${paths.join(", ")}`;
  const e = new Error(msg);
  e.code = "MODULE_NOT_FOUND";
  throw e;
}

// Load User model (try common locations)
const User = tryRequire([
  "../models/User",
  "../../models/User",
  "../src/models/User",
  "../../src/models/User",
]);

// Try to load verifyToken helper (used to reveal email to owner)
let verifyToken = null;
try {
  const authModule = tryRequire([
    "../middleware/auth",
    "../../src/middleware/auth",
    "../src/middleware/auth",
    "../middleware/auth",
  ]);
  verifyToken = authModule.verifyToken || null;
} catch (err) {
  verifyToken = null;
}

/**
 * Helper: absolute avatar URL
 */
function absoluteAvatarUrl(req, avatarUrl) {
  if (!avatarUrl) return null;
  if (/^https?:\/\//i.test(avatarUrl)) return avatarUrl;
  const base =
    process.env.BACKEND_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base.replace(/\/$/, "")}${
    avatarUrl.startsWith("/") ? "" : "/"
  }${avatarUrl}`;
}

/**
 * Helper: get token from Authorization header or cookie header
 */
function getTokenFromReq(req) {
  const authHeader =
    req.headers["authorization"] || req.headers["Authorization"];
  if (authHeader) {
    const parts = String(authHeader).split(" ");
    if (parts.length === 2) return parts[1];
  }
  const cookieHeader = req.headers && req.headers.cookie;
  if (cookieHeader) {
    const parts = cookieHeader.split(";");
    for (const p of parts) {
      const kv = p.split("=").map((s) => s.trim());
      if (kv[0] === "token") {
        return decodeURIComponent(kv[1] || "");
      }
    }
  }
  return null;
}

/**
 * Normalize a bot id (handles URL-encoded colons and trailing socket-suffix like ":1").
 * Examples:
 *  - "bot:stockfish:TX77HP" -> "bot:stockfish:TX77HP"
 *  - "bot:stockfish:TX77HP:1" -> "bot:stockfish:TX77HP"
 *  - "bot%3Astockfish%3ATX77HP%3A1" (URL-encoded) -> "bot:stockfish:TX77HP"
 */
function normalizeBotId(raw) {
  if (!raw || typeof raw !== "string") return raw;
  // decode URI component (in case Express didn't)
  let dec = raw;
  try {
    dec = decodeURIComponent(raw);
  } catch (e) {
    dec = raw;
  }
  const parts = dec.split(":");
  if (parts[0] !== "bot") return dec;
  // keep up to bot:engine:roomId (first three segments)
  if (parts.length >= 3) {
    return `${parts[0]}:${parts[1]}:${parts[2]}`;
  }
  return dec;
}

/**
 * GET /api/players
 * Public list — returns an ARRAY (same shape your frontend expects).
 * Supports optional search/pagination (q, limit, skip).
 */
router.get("/", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    let limit = parseInt(req.query.limit || "100", 10);
    let skip = parseInt(req.query.skip || "0", 10);
    if (!isFinite(limit)) limit = 100;
    if (!isFinite(skip)) skip = 0;
    limit = Math.max(1, Math.min(500, limit));
    skip = Math.max(0, skip);

    const filter = {};
    if (q) {
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(esc, "i");
      filter.$or = [{ username: re }, { displayName: re }];
    }

    const users = await User.find(filter)
      .sort({ cups: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("-passwordHash -__v")
      .lean();

    // Return an array (not wrapped object) to match existing frontend expectations
    const list = (users || []).map((u) => ({
      id: u._id?.toString(),
      username: u.username,
      displayName: u.displayName || null,
      avatarUrl: u.avatarUrl || null,
      avatarUrlAbsolute: u.avatarUrl
        ? absoluteAvatarUrl(req, u.avatarUrl)
        : null,
      backgroundUrl: u.backgroundUrl || null,
      backgroundUrlAbsolute: u.backgroundUrl
        ? absoluteAvatarUrl(req, u.backgroundUrl)
        : null,
      country: u.country || null,
      cups: u.cups || 0,
      createdAt: u.createdAt || null,
      lastIp: u.lastIp || null,
      online: !!onlineUsers[u._id?.toString()],
      friends: (u.friends || []).map((f) => ({
        id: f.id,
        username: f.username,
      })),
      incomingFriendRequests: (u.incomingFriendRequests || []).map((r) => ({
        reqId: r.reqId,
        fromUserId: r.fromUserId,
        fromUsername: r.fromUsername,
        status: r.status,
        ts: r.ts,
      })),
    }));

    // **Important**: return array directly to keep frontend code unchanged
    res.json(list);
  } catch (err) {
    console.error("GET /api/players error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/players/:id
 * Public profile by ObjectId, username, or bot id (bot:engine:roomId).
 * Includes email only when requester is authenticated and is the same user.
 */
router.get("/:id", async (req, res) => {
  try {
    const rawId = req.params.id || "";
    // decode param in case it contains URL-encoded characters
    let decodedId = rawId;
    try {
      decodedId = decodeURIComponent(rawId);
    } catch (e) {
      decodedId = rawId;
    }

    // ---- BOT SHORT-CIRCUIT ----
    if (String(decodedId).startsWith("bot:")) {
      const botId = normalizeBotId(decodedId);
      const parts = botId.split(":");
      const engine = (parts[1] || "jsengine").toString();
      const username =
        engine.charAt(0).toUpperCase() + engine.slice(1).toLowerCase();
      const displayName = username;

      // Shape matches the 'result' object below for real users (keeps frontend unchanged)
      const botResult = {
        id: botId,
        username,
        displayName,
        email: null,
        avatarUrl: null,
        avatarUrlAbsolute: null,
        backgroundUrl: null,
        backgroundUrlAbsolute: null,
        bio: null,
        country: null,
        cups: 0,
        createdAt: null,
        lastIp: null,
        online: true,
        dob: null,
        friends: [],
      };
      return res.json(botResult);
    }
    // ---- END BOT HANDLING ----

    let user = null;

    if (mongoose.Types.ObjectId.isValid(decodedId)) {
      user = await User.findById(decodedId).select("-passwordHash -__v").lean();
    }

    if (!user) {
      user = await User.findOne({ username: decodedId })
        .select("-passwordHash -__v")
        .lean();
    }

    if (!user) {
      return res.status(404).json({ error: "Player not found" });
    }

    // determine if requester is same user (so we can reveal email)
    let emailToReturn = null;
    try {
      const token = getTokenFromReq(req);
      if (token && verifyToken) {
        const decoded = verifyToken(token);
        if (decoded && String(decoded.id) === String(user._id)) {
          emailToReturn = user.email || null;
        }
      }
    } catch (err) {
      emailToReturn = null;
    }

    const result = {
      id: user._id?.toString(),
      username: user.username,
      displayName: user.displayName || null,
      email: emailToReturn, // null for anonymous viewers
      avatarUrl: user.avatarUrl || null,
      avatarUrlAbsolute: user.avatarUrl
        ? absoluteAvatarUrl(req, user.avatarUrl)
        : null,
      backgroundUrl: user.backgroundUrl || null,
      backgroundUrlAbsolute: user.backgroundUrl
        ? absoluteAvatarUrl(req, user.backgroundUrl)
        : null,
      bio: user.bio || null,
      country: user.country || null,
      cups: user.cups || 0,
      createdAt: user.createdAt || null,
      lastIp: user.lastIp || null,
      online: !!onlineUsers[user._id?.toString()],
      dob: user.dob ? user.dob.toISOString() : null,
      friends: (user.friends || []).map((f) => ({
        id: f.id,
        username: f.username,
      })),
    };

    res.json(result);
  } catch (err) {
    console.error("GET /api/players/:id error", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
