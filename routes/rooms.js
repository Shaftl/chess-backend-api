const express = require("express");
const router = express.Router();
const roomManager = require("../roomManager");
const Room = require("../models/Room");

/**
 * escapeRegex(str)
 * Safely escape a string for use inside a RegExp.
 */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * GET /api/rooms/:roomId
 * Returns 200 + basic room info if room exists (players, settings),
 * otherwise 404. If in-memory room not present, try persistent Room collection.
 */
router.get("/:roomId", async (req, res) => {
  try {
    const raw = String(req.params.roomId || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing roomId" });

    // canonical forms to check:
    const roomId = raw;
    const prefix = roomId.split("-")[0];

    // First prefer in-memory rooms (try exact then prefix)
    let room = roomManager.rooms[roomId] || roomManager.rooms[prefix];
    if (room) {
      const info = {
        roomId: roomId in roomManager.rooms ? roomId : prefix,
        players: (room.players || []).map((p) => ({
          id: p.user?.id || p.id,
          username: (p.user && p.user.username) || null,
          color: p.color || null,
          online: !!p.online,
        })),
        settings: room.settings || null,
        finished: !!room.finished,
        createdAt:
          room.settings && room.settings.createdAt
            ? room.settings.createdAt
            : null,
      };
      return res.json(info);
    }

    // Fallback to persisted Room collection.
    // First try exact match.
    let doc = await Room.findOne({ roomId }).lean().exec();
    if (!doc && prefix !== roomId) {
      // If the requested roomId included a suffix (like "-<ts>"), try matching by prefix.
      // This will match documents where roomId === prefix OR roomId starts with prefix + '-'
      const re = new RegExp(`^${escapeRegex(prefix)}(?:-|$)`);
      doc = await Room.findOne({ roomId: { $regex: re } })
        .lean()
        .exec();
    }

    if (!doc) {
      return res.status(404).json({ error: "Not found" });
    }

    const info = {
      roomId: doc.roomId,
      players: (doc.players || []).map((p) => ({
        id: p.id || null,
        username: (p.user && p.user.username) || null,
        color: p.color || null,
        online: !!p.online,
      })),
      settings: doc.settings || null,
      finished: !!doc.finished,
      createdAt: doc.createdAt || null,
    };

    return res.json(info);
  } catch (err) {
    console.error("GET /api/rooms/:roomId error", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
