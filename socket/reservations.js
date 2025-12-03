// backend/socket/reservations.js
// tryReserveActiveRoom & releaseActiveRoom (exact logic moved from your original file)

const mongoose = require("mongoose");
const User = require("../models/User");

async function tryReserveActiveRoom(userId, roomId) {
  try {
    if (!userId) return { ok: true, set: false };
    const uid = String(userId);
    const updated = await User.findOneAndUpdate(
      { _id: uid, $or: [{ activeRoom: null }, { activeRoom: "" }] },
      { $set: { activeRoom: roomId, status: "playing" } },
      { new: true }
    )
      .lean()
      .exec();
    if (updated) return { ok: true, set: true };
    return { ok: true, set: false };
  } catch (e) {
    return { ok: false, error: e };
  }
}

async function releaseActiveRoom(userId, roomId) {
  try {
    if (!userId) return { ok: true, released: false };
    const uid = String(userId);
    const query = roomId
      ? { _id: uid, activeRoom: String(roomId) }
      : { _id: uid };
    const updated = await User.findOneAndUpdate(
      query,
      { $set: { activeRoom: null, status: "idle" } },
      { new: true }
    )
      .lean()
      .exec();
    if (updated) return { ok: true, released: true };
    return { ok: true, released: false };
  } catch (e) {
    return { ok: false, error: e };
  }
}

module.exports = { tryReserveActiveRoom, releaseActiveRoom };
