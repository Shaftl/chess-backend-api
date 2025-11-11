// backend/services/notificationService.js
// Persists notifications and emits them. Additionally synchronises related notifications
// for draw/rematch/challenge flows so UI everywhere updates.

const Notification = require("../models/Notification");

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
  throw new Error(`tryRequire: none resolved: ${paths.join(", ")}`);
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

let notificationSync = null;
try {
  notificationSync = tryRequire([
    "./notificationSync",
    "../services/notificationSync",
    "../../services/notificationSync",
    "../src/services/notificationSync",
  ]);
} catch (e) {
  notificationSync = null;
}

/**
 * createNotification(userId, type, title, body, data={}, opts={emit:true})
 * Saves notification to DB and emits realtime 'notification' to user sockets (best-effort).
 * Additionally: for certain action types (draw/rematch/challenge) it will mark & emit related
 * notifications that reference the same resource (roomId, drawId, challengeId, reqId, fromUserId).
 */
async function createNotification(
  userId,
  type,
  title,
  body,
  data = {},
  opts = { emit: true }
) {
  try {
    if (!userId) throw new Error("Missing userId");
    const doc = new Notification({
      userId: String(userId),
      type: String(type || "generic"),
      title: title || null,
      body: body || null,
      data: data || {},
      fromUserId: data && data.fromUserId ? String(data.fromUserId) : null,
      read: false,
      createdAt: Date.now(),
    });
    await doc.save();

    // payload sent over socket - include both id and _id and status
    const payload = {
      id: doc._id?.toString(),
      _id: doc._id?.toString(),
      userId: doc.userId,
      type: doc.type,
      title: doc.title,
      body: doc.body,
      data: doc.data,
      read: doc.read,
      status: doc.status || null,
      createdAt: doc.createdAt,
    };

    // Try to emit to recipient
    if (opts.emit !== false) {
      try {
        if (roomManager && typeof roomManager.notifyUser === "function") {
          try {
            roomManager.notifyUser(String(userId), "notification", payload);
            doc.deliveredAt = Date.now();
            await doc.save().catch(() => {});
          } catch (e) {
            // fallthrough to other emission strategies
          }
        }
      } catch (e) {}

      // fallback: try io -> user:<id> room
      if (
        !doc.deliveredAt &&
        roomManager &&
        roomManager.io &&
        typeof roomManager.io.to === "function"
      ) {
        try {
          roomManager.io
            .to(`user:${String(userId)}`)
            .emit("notification", payload);
          doc.deliveredAt = Date.now();
          await doc.save().catch(() => {});
        } catch (e) {}
      }

      // last-resort try to require roomManager again
      if (!doc.deliveredAt) {
        try {
          const rm = require("../roomManager");
          if (rm && typeof rm.notifyUser === "function") {
            rm.notifyUser(String(userId), "notification", payload);
            doc.deliveredAt = Date.now();
            await doc.save().catch(() => {});
          } else if (rm && rm.io && typeof rm.io.to === "function") {
            rm.io.to(`user:${String(userId)}`).emit("notification", payload);
            doc.deliveredAt = Date.now();
            await doc.save().catch(() => {});
          }
        } catch (e) {}
      }
    }

    // --- SYNCHRONISATION LOGIC ---
    // When system creates action notifications related to draw/rematch/challenge/friend,
    // mark other notifications referencing the same data key/value so UI updates everywhere.

    try {
      if (
        notificationSync &&
        typeof notificationSync.markAndEmitNotificationsByDataKey === "function"
      ) {
        // Draw accepted/declined -> mark related notifications by roomId / drawId
        if (doc.type === "draw_accepted") {
          if (doc.data?.roomId) {
            await notificationSync.markAndEmitNotificationsByDataKey(
              "roomId",
              String(doc.data.roomId),
              "accepted"
            );
          }
          if (doc.data?.drawId) {
            await notificationSync.markAndEmitNotificationsByDataKey(
              "drawId",
              String(doc.data.drawId),
              "accepted"
            );
          }
        } else if (doc.type === "draw_declined") {
          if (doc.data?.roomId) {
            await notificationSync.markAndEmitNotificationsByDataKey(
              "roomId",
              String(doc.data.roomId),
              "declined"
            );
          }
          if (doc.data?.drawId) {
            await notificationSync.markAndEmitNotificationsByDataKey(
              "drawId",
              String(doc.data.drawId),
              "declined"
            );
          }
        }

        // Rematch offered / started / declined -> mark by roomId accordingly
        else if (
          doc.type === "rematch_started" ||
          doc.type === "rematch_accepted"
        ) {
          if (doc.data?.roomId) {
            await notificationSync.markAndEmitNotificationsByDataKey(
              "roomId",
              String(doc.data.roomId),
              "accepted"
            );
          }
        } else if (doc.type === "rematch_declined") {
          if (doc.data?.roomId) {
            await notificationSync.markAndEmitNotificationsByDataKey(
              "roomId",
              String(doc.data.roomId),
              "declined"
            );
          }
        }

        // Challenge accepted/declined -> mark by challengeId/roomId
        else if (doc.type === "challenge_accepted") {
          if (doc.data?.challengeId) {
            await notificationSync.markAndEmitNotificationsByDataKey(
              "challengeId",
              String(doc.data.challengeId),
              "accepted"
            );
          }
          if (doc.data?.roomId) {
            await notificationSync.markAndEmitNotificationsByDataKey(
              "roomId",
              String(doc.data.roomId),
              "accepted"
            );
          }
        } else if (doc.type === "challenge_declined") {
          if (doc.data?.challengeId) {
            await notificationSync.markAndEmitNotificationsByDataKey(
              "challengeId",
              String(doc.data.challengeId),
              "declined"
            );
          }
        }

        // Friend request responses: mark by reqId / fromUserId
        else if (doc.type === "friend_request_accepted") {
          if (doc.data?.reqId) {
            await notificationSync.markAndEmitNotificationsByDataKey(
              "reqId",
              String(doc.data.reqId),
              "accepted"
            );
          }
          if (doc.data?.by?.id) {
            await notificationSync.markAndEmitNotificationsByDataKey(
              "fromUserId",
              String(doc.data.by.id),
              "accepted"
            );
          }
        } else if (doc.type === "friend_request_declined") {
          if (doc.data?.reqId) {
            await notificationSync.markAndEmitNotificationsByDataKey(
              "reqId",
              String(doc.data.reqId),
              "declined"
            );
          }
          if (doc.data?.by?.id) {
            await notificationSync.markAndEmitNotificationsByDataKey(
              "fromUserId",
              String(doc.data.by.id),
              "declined"
            );
          }
        }
      }
    } catch (e) {
      // non-fatal: sync best-effort
      // console.error("notificationService: sync error", e);
    }

    return doc;
  } catch (err) {
    console.error("notificationService.createNotification error:", err);
    throw err;
  }
}

/**
 * fetchNotifications(userId, {limit, skip})
 */
async function fetchNotifications(userId, opts = {}) {
  try {
    const limit = Math.max(1, Math.min(200, Number(opts.limit || 50)));
    const skip = Math.max(0, Number(opts.skip || 0));
    const rows = await Notification.find({ userId: String(userId) })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
    return rows || [];
  } catch (err) {
    console.error("notificationService.fetchNotifications error", err);
    return [];
  }
}

async function markRead(notificationId, userId) {
  try {
    const q = { _id: notificationId, userId: String(userId) };
    const doc = await Notification.findOneAndUpdate(
      q,
      { $set: { read: true, updatedAt: Date.now() } },
      { new: true }
    ).lean();
    return doc;
  } catch (err) {
    console.error("notificationService.markRead error", err);
    return null;
  }
}

async function markAllRead(userId) {
  try {
    await Notification.updateMany(
      { userId: String(userId), read: false },
      { $set: { read: true, updatedAt: Date.now() } }
    ).exec();
    return true;
  } catch (err) {
    console.error("notificationService.markAllRead error", err);
    return false;
  }
}

module.exports = {
  createNotification,
  fetchNotifications,
  markRead,
  markAllRead,
};
