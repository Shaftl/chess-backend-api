// backend/src/routes/game.js
const express = require("express");
const mongoose = require("mongoose");
const Game = require("../models/Game");
const router = express.Router();

/**
 * tryRequire(pathsArray)
 * Try multiple require() paths and return the first successful module.
 * (kept for compatibility with different project layouts)
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

// Try to load User model (some projects put it in ../models/User or ../../models/User)
const User = tryRequire([
  "../models/User",
  "../../models/User",
  "../src/models/User",
  "../../src/models/User",
]);

/**
 * absoluteAvatarUrl(req, avatarUrl)
 * Make avatarUrl absolute (if not already absolute) using BACKEND_BASE_URL or request host.
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
 * GET /api/game
 * - Without query: returns latest games (default limit 20)
 * - With ?userId=<id>: returns games where the given user participated (players.id or players.user.id or players.user.username)
 * - Optional ?limit=<n> to increase/decrease number returned (server caps to 1000)
 *
 * This route enriches returned games by resolving referenced user documents
 * and attaching avatarUrl / avatarUrlAbsolute into players[].user and messages[].user.
 */
router.get("/", async (req, res) => {
  try {
    const q = req.query || {};
    let filter = {};
    let limit = parseInt(q.limit || "20", 10);
    if (!isFinite(limit)) limit = 20;
    limit = Math.max(1, Math.min(1000, limit));

    const userId = q.userId ? String(q.userId).trim() : null;
    if (userId) {
      // match any player entry that references the provided id (players.id OR players.user.id OR players.user.username)
      filter = {
        $or: [
          { "players.id": userId },
          { "players.user.id": userId },
          { "players.user.username": userId },
        ],
      };
    }

    // fetch raw game documents
    const list = await Game.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();

    if (!Array.isArray(list) || list.length === 0) {
      return res.json(list || []);
    }

    // Collect candidate user ids from players and messages to batch-resolve users
    const userIdSet = new Set();
    for (const g of list) {
      const players = Array.isArray(g.players) ? g.players : [];
      for (const p of players) {
        // prefer p.user.id, fall back to p.id
        const id = (p && p.user && p.user.id) || p.id;
        if (id && mongoose.Types.ObjectId.isValid(id))
          userIdSet.add(String(id));
      }
      const messages = Array.isArray(g.messages) ? g.messages : [];
      for (const m of messages) {
        const mid = m && m.user && m.user.id;
        if (mid && mongoose.Types.ObjectId.isValid(mid))
          userIdSet.add(String(mid));
      }
    }

    // Batch query Users
    const userIds = Array.from(userIdSet);
    let usersById = {};
    if (userIds.length > 0) {
      const users = await User.find({ _id: { $in: userIds } })
        .select("username displayName avatarUrl country")
        .lean()
        .exec();
      usersById = users.reduce((acc, u) => {
        acc[String(u._id)] = u;
        return acc;
      }, {});
    }

    // Enrich each game doc with avatarUrlAbsolute where possible
    const enriched = list.map((g) => {
      const players = (g.players || []).map((p) => {
        const userObj = p.user || {};
        const candidateId =
          (userObj.id || p.id || null) && String(userObj.id || p.id);
        let resolvedUser = null;
        if (candidateId && usersById[candidateId])
          resolvedUser = usersById[candidateId];

        // prefer avatar coming from userObj, else resolvedUser.avatarUrl, else null
        const avatarRaw =
          (userObj && (userObj.avatarUrl || userObj.avatarUrlAbsolute)) ||
          (resolvedUser && resolvedUser.avatarUrl) ||
          null;

        const avatarUrlAbsolute = avatarRaw
          ? absoluteAvatarUrl(req, avatarRaw)
          : null;

        const displayName =
          (userObj && (userObj.displayName || userObj.username)) ||
          (resolvedUser &&
            (resolvedUser.displayName || resolvedUser.username)) ||
          userObj.username ||
          null;

        return {
          ...p,
          user: {
            id: (userObj && userObj.id) || p.id || null,
            username:
              (userObj && userObj.username) ||
              (resolvedUser && resolvedUser.username) ||
              null,
            displayName,
            avatarUrl: avatarRaw || null,
            avatarUrlAbsolute: avatarUrlAbsolute,
            country:
              (userObj && userObj.country) ||
              (resolvedUser && resolvedUser.country) ||
              null,
          },
        };
      });

      const messages = (g.messages || []).map((m) => {
        const mu = m.user || {};
        const mid = mu.id || null;
        const resolved = mid && usersById[mid] ? usersById[mid] : null;
        const avatarRaw =
          (mu && (mu.avatarUrl || mu.avatarUrlAbsolute)) ||
          (resolved && resolved.avatarUrl) ||
          null;
        const avatarUrlAbsolute = avatarRaw
          ? absoluteAvatarUrl(req, avatarRaw)
          : null;

        return {
          ...m,
          user: {
            id: mu.id || null,
            username: mu.username || (resolved && resolved.username) || null,
            displayName:
              mu.displayName || (resolved && resolved.displayName) || null,
            avatarUrl: mu.avatarUrl || (resolved && resolved.avatarUrl) || null,
            avatarUrlAbsolute,
          },
        };
      });

      return {
        ...g,
        players,
        messages,
      };
    });

    return res.json(enriched);
  } catch (err) {
    console.error("GET /api/game error", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/:roomId", async (req, res) => {
  try {
    const g = await Game.findOne({ roomId: req.params.roomId }).lean().exec();
    if (!g) return res.status(404).json({ error: "Not found" });

    // Enrich single game similarly (optional but helpful)
    const backendBase =
      process.env.BACKEND_BASE_URL || `${req.protocol}://${req.get("host")}`;

    // Try to resolve players' users in batch
    const playerUserIds = (g.players || [])
      .map((p) => (p.user && p.user.id) || p.id)
      .filter(Boolean)
      .filter((id) => mongoose.Types.ObjectId.isValid(String(id)));

    let usersById = {};
    if (playerUserIds.length > 0) {
      const uniq = Array.from(new Set(playerUserIds.map(String)));
      const users = await User.find({ _id: { $in: uniq } })
        .select("username displayName avatarUrl country")
        .lean()
        .exec();
      usersById = users.reduce((acc, u) => {
        acc[String(u._id)] = u;
        return acc;
      }, {});
    }

    const players = (g.players || []).map((p) => {
      const userObj = p.user || {};
      const candidateId = String(userObj.id || p.id || "");
      const resolvedUser = usersById[candidateId] || null;
      const avatarRaw =
        (userObj && (userObj.avatarUrl || userObj.avatarUrlAbsolute)) ||
        (resolvedUser && resolvedUser.avatarUrl) ||
        null;
      const avatarUrlAbsolute = avatarRaw
        ? absoluteAvatarUrl(req, avatarRaw)
        : null;

      return {
        ...p,
        user: {
          id: (userObj && userObj.id) || p.id || null,
          username:
            (userObj && userObj.username) ||
            (resolvedUser && resolvedUser.username) ||
            null,
          displayName:
            (userObj && (userObj.displayName || userObj.username)) ||
            (resolvedUser &&
              (resolvedUser.displayName || resolvedUser.username)) ||
            null,
          avatarUrl: avatarRaw || null,
          avatarUrlAbsolute,
        },
      };
    });

    const messages = (g.messages || []).map((m) => {
      const mu = m.user || {};
      const resolved = mu.id && usersById[mu.id] ? usersById[mu.id] : null;
      const avatarRaw =
        (mu && (mu.avatarUrl || mu.avatarUrlAbsolute)) ||
        (resolved && resolved.avatarUrl) ||
        null;
      const avatarUrlAbsolute = avatarRaw
        ? absoluteAvatarUrl(req, avatarRaw)
        : null;
      return {
        ...m,
        user: {
          id: mu.id || null,
          username: mu.username || (resolved && resolved.username) || null,
          displayName:
            mu.displayName || (resolved && resolved.displayName) || null,
          avatarUrl: mu.avatarUrl || (resolved && resolved.avatarUrl) || null,
          avatarUrlAbsolute,
        },
      };
    });

    const enriched = {
      ...g,
      players,
      messages,
    };

    res.json(enriched);
  } catch (err) {
    console.error("GET /api/game/:roomId error", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
