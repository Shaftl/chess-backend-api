// backend/services/notificationSync.js
// Small shared helper to mark notifications referencing the same data key/value
// and emit updated notification payloads to owners (best-effort).

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
  const e = new Error(`tryRequire: none resolved: ${paths.join(", ")}`);
  e.code = "MODULE_NOT_FOUND";
  throw e;
}

let Notification = null;
try {
  Notification = tryRequire([
    "../models/Notification",
    "../../models/Notification",
    "../src/models/Notification",
    "../../src/models/Notification",
  ]);
} catch (e) {
  Notification = null;
}

let roomManager = null;
try {
  roomManager = tryRequire([
    "../roomManager",
    "../../roomManager",
    "../src/roomManager",
    "../../src/roomManager",
  ]);
} catch (e) {
  roomManager = null;
}

/**
 * Best-effort emit helper to a user
 */
function emitToUser(userId, ev, payload) {
  try {
    if (!roomManager) return;
    if (typeof roomManager.notifyUser === "function") {
      try {
        roomManager.notifyUser(String(userId), ev, payload);
        return;
      } catch (e) {}
    }
    if (roomManager.io && typeof roomManager.io.to === "function") {
      const sids = roomManager.getSocketsForUserId
        ? roomManager.getSocketsForUserId(String(userId))
        : [];
      if (Array.isArray(sids) && sids.length > 0) {
        sids.forEach((sid) => {
          try {
            roomManager.io.to(sid).emit(ev, payload);
          } catch (e) {}
        });
        return;
      }
      try {
        roomManager.io.to(`user:${String(userId)}`).emit(ev, payload);
      } catch (e) {}
    }
  } catch (e) {
    // ignore
  }
}

/**
 * markAndEmitNotification(noteId, targetUserId, fields)
 * Update a single notification and emit it to owner.
 */
async function markAndEmitNotification(noteId, targetUserId, fields = {}) {
  try {
    if (!Notification) return null;
    const setObj = { ...fields, updatedAt: Date.now() };
    const updated = await Notification.findOneAndUpdate(
      { _id: noteId, userId: String(targetUserId) },
      { $set: setObj },
      { new: true }
    ).lean();

    if (!updated) return null;

    const payload = {
      id: String(updated._id),
      _id: String(updated._id),
      userId: updated.userId,
      type: updated.type,
      title: updated.title,
      body: updated.body,
      data: updated.data,
      read: !!updated.read,
      status: updated.status || null,
      createdAt: updated.createdAt,
    };

    try {
      emitToUser(String(updated.userId), "notification", payload);
    } catch (e) {}

    return updated;
  } catch (e) {
    console.error("notificationSync.markAndEmitNotification error", e);
    return null;
  }
}

/**
 * markAndEmitNotificationsByDataKey(key, value, status)
 * Finds notification docs where data.<key> === value, marks them read and optionally sets status,
 * saves, and emits updates to owners (best-effort). Non-blocking.
 */
async function markAndEmitNotificationsByDataKey(key, value, status) {
  if (!key || typeof value === "undefined" || value === null) return;
  if (!Notification) return;
  try {
    const q = {};
    q[`data.${key}`] = value;
    const docs = await Notification.find(q).exec();
    for (const d of docs) {
      try {
        d.read = true;
        if (typeof status !== "undefined" && status !== null) d.status = status;
        d.updatedAt = Date.now();
        await d.save().catch(() => {});
        const payload = {
          id: String(d._id),
          _id: String(d._id),
          userId: d.userId,
          type: d.type,
          title: d.title,
          body: d.body,
          data: d.data,
          read: !!d.read,
          status: d.status || null,
          createdAt: d.createdAt,
        };
        emitToUser(String(d.userId), "notification", payload);
      } catch (e) {
        // continue
      }
    }
  } catch (e) {
    console.error(
      "notificationSync.markAndEmitNotificationsByDataKey error",
      e
    );
  }
}

module.exports = {
  markAndEmitNotification,
  markAndEmitNotificationsByDataKey,
  emitToUser,
};
