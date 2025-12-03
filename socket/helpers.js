// backend/socket/helpers.js
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

function normId(v) {
  if (!v && v !== 0) return null;
  try {
    return String(v);
  } catch {
    return null;
  }
}

function computeBaseUrl() {
  return (
    process.env.BACKEND_BASE_URL ||
    `http://localhost:${process.env.PORT || 4000}`
  );
}

function ensureAvatarAbs(u) {
  try {
    if (!u || typeof u !== "object") return u;
    const base = computeBaseUrl();
    const rel = u.avatarUrl || u.avatar || null;
    if (!rel) {
      if (u.avatarUrlAbsolute) return u;
      u.avatarUrl = null;
      u.avatarUrlAbsolute = null;
      return u;
    }
    if (String(rel).startsWith("http")) {
      u.avatarUrlAbsolute = rel;
      u.avatarUrl = rel;
    } else {
      u.avatarUrlAbsolute = `${base}${rel}`;
      u.avatarUrl = rel;
    }
    return u;
  } catch (e) {
    return u;
  }
}

function mapPlayerForEmit(p) {
  const base = computeBaseUrl();
  const u = p.user || {};
  const rel = u.avatarUrl || u.avatar || null;
  const avatarUrlAbsolute =
    u.avatarUrlAbsolute ||
    (rel && String(rel).startsWith("http")
      ? rel
      : rel
      ? `${base}${rel}`
      : null);

  return {
    id: p.id,
    color: p.color,
    online: !!p.online,
    disconnectedAt: p.disconnectedAt || null,
    user: {
      id: u.id || u._id || null,
      username: u.username || null,
      displayName: u.displayName || null,
      avatarUrl: rel,
      avatarUrlAbsolute,
      country: u.country || null,
    },
  };
}

function normalizeAndValidateRoomCode(raw) {
  if (!raw || typeof raw !== "string")
    return { ok: false, error: "Missing code" };
  const t = String(raw).trim();
  if (!t) return { ok: false, error: "Missing code" };
  const code = t.toUpperCase();
  const re = /^[A-Z0-9]{4,12}$/;
  if (!re.test(code)) {
    return {
      ok: false,
      code,
      error:
        "Invalid code. Use 4–12 characters: letters and numbers only (A-Z, 0-9).",
    };
  }
  return { ok: true, code };
}

function normalizePromotionChar(p) {
  if (!p) return null;
  try {
    const s = String(p).trim().toLowerCase();
    if (!s) return null;
    if (s === "q" || s.includes("queen")) return "q";
    if (s === "r" || s.includes("rook")) return "r";
    if (s === "n" || s.includes("knight") || s === "k") return "n";
    if (
      s === "b" ||
      s.includes("bishop") ||
      s.includes("eleph") ||
      s.includes("elephant")
    )
      return "b";
    const first = s[0];
    if (["q", "r", "n", "b"].includes(first)) return first;
    return null;
  } catch (e) {
    return null;
  }
}

function verifyToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded;
  } catch (e) {
    return null;
  }
}

// markUserActiveRoom & clearActiveRoomForUsers & clearActiveRoomForRoom
// These mirror your original functions exactly (kept behavior)
async function markUserActiveRoom(userId, roomId) {
  try {
    if (!userId) return;
    const User = require("../models/User");
    await User.findByIdAndUpdate(
      String(userId),
      { $set: { activeRoom: roomId, status: "playing" } },
      { new: true, upsert: false }
    ).exec();
  } catch (err) {
    console.error("markUserActiveRoom error", err);
  }
}

async function clearActiveRoomForUsers(userIds = []) {
  try {
    if (!userIds || !Array.isArray(userIds)) return;
    const ids = (userIds || []).filter(Boolean).map(String);
    if (!ids.length) return;
    const objectIds = ids
      .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
      .map((id) => new mongoose.Types.ObjectId(String(id)));
    if (objectIds.length === 0) return;
    const User = require("../models/User");
    await User.updateMany(
      { _id: { $in: objectIds } },
      { $set: { activeRoom: null, status: "idle" } }
    ).exec();
  } catch (err) {
    console.error("clearActiveRoomForUsers error", err);
  }
}

async function clearActiveRoomForRoom(room) {
  try {
    if (!room || !Array.isArray(room.players)) return;
    const ids = room.players
      .filter((p) => p.color === "w" || p.color === "b")
      .map((p) => p?.user?.id || p?.user?._id)
      .filter(Boolean);
    if (ids.length) await clearActiveRoomForUsers(ids);
  } catch (err) {
    console.error("clearActiveRoomForRoom error", err);
  }
}

module.exports = {
  normId,
  computeBaseUrl,
  ensureAvatarAbs,
  mapPlayerForEmit,
  normalizeAndValidateRoomCode,
  normalizePromotionChar,
  verifyToken,
  markUserActiveRoom,
  clearActiveRoomForUsers,
  clearActiveRoomForRoom,
};
