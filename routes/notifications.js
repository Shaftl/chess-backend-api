const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

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

const Notification = tryRequire([
  "../models/Notification",
  "../../models/Notification",
  "../src/models/Notification",
  "../../src/models/Notification",
]);

const User = tryRequire([
  "../models/User",
  "../../models/User",
  "../src/models/User",
  "../../src/models/User",
]);

const RoomModel = tryRequire([
  "../models/Room",
  "../../models/Room",
  "../src/models/Room",
  "../../src/models/Room",
]);

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

let notificationService = null;
try {
  notificationService = tryRequire([
    "../services/notificationService",
    "../../services/notificationService",
    "../src/services/notificationService",
    "../../src/services/notificationService",
  ]);
} catch (e) {
  // optional; we will fallback to Notification model when needed
  notificationService = null;
}

// auth middleware (best-effort)
let restAuthMiddleware = null;
try {
  const authMod = tryRequire([
    "../middleware/auth",
    "../../middleware/auth",
    "../src/middleware/auth",
    "../../src/middleware/auth",
  ]);
  restAuthMiddleware =
    authMod.restAuthMiddleware || authMod.authMiddleware || null;
} catch (e) {
  restAuthMiddleware = null;
}

/**
 * Emit helper for sockets (best-effort)
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
    // ignore non-fatal
  }
}

/**
 * Helper: update a single notification doc and emit the updated payload to the user (best-effort).
 * Returns the updated notification (lean) or null.
 */
async function markAndEmitNotification(noteId, targetUserId, fields = {}) {
  try {
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

    // Emit to owner (best-effort)
    try {
      emitToUser(String(updated.userId), "notification", payload);
    } catch (e) {}

    return updated;
  } catch (e) {
    console.error("markAndEmitNotification error", e);
    return null;
  }
}

/**
 * Find & update any Notification docs which include a given data key/value (e.g. data.reqId === reqId),
 * mark them read and set status, save and emit updates to owners.
 *
 * This ensures the notification UI is updated (buttons removed / status changed) for all notifications
 * that reference the same underlying resource no matter where the action occurred.
 */
async function _markAndEmitNotificationsByDataKey(key, value, status) {
  if (!key || typeof value === "undefined" || value === null) return;
  try {
    if (!Notification) return;
    const q = {};
    q[`data.${key}`] = value;
    const docs = await Notification.find(q).exec();
    for (const d of docs) {
      try {
        d.read = true;
        if (status) d.status = status;
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
        // continue with other docs
      }
    }
  } catch (e) {
    console.error("_markAndEmitNotificationsByDataKey error", e);
  }
}

/**
 * GET /api/notifications
 * returns the current user's notifications (most recent first)
 */
router.get("/", restAuthMiddleware, async (req, res) => {
  try {
    const me = req.user;
    if (!me || !me.id) return res.status(401).json({ error: "Missing auth" });
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const skip = Math.max(0, Number(req.query.skip || 0));

    const rows = await (notificationService
      ? notificationService.fetchNotifications(me.id, { limit, skip })
      : Notification.find({ userId: String(me.id) })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean()
          .exec());
    return res.json(rows || []);
  } catch (err) {
    console.error("GET /api/notifications error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/notifications/:id/read
 */
router.post("/:id/read", restAuthMiddleware, async (req, res) => {
  try {
    const me = req.user;
    if (!me || !me.id) return res.status(401).json({ error: "Missing auth" });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Missing id" });

    const updated = await (notificationService
      ? notificationService.markRead(id, me.id)
      : Notification.findOneAndUpdate(
          { _id: id, userId: String(me.id) },
          { $set: { read: true, updatedAt: Date.now() } },
          { new: true }
        ).lean());

    // also emit updated notification for real-time clients
    try {
      await markAndEmitNotification(id, me.id, { read: true });
    } catch (e) {}

    return res.json({ ok: true, notification: updated || null });
  } catch (err) {
    console.error("POST /api/notifications/:id/read error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/notifications/:id/action
 * body: { action: "accept_friend" | "decline_friend" | "accept_rematch" | "decline_rematch" | "accept_draw" | "decline_draw" | "accept_challenge" | "decline_challenge" }
 *
 * This endpoint will perform the corresponding server-side action so users can respond via the notification UI.
 */
router.post("/:id/action", restAuthMiddleware, async (req, res) => {
  try {
    const me = req.user;
    if (!me || !me.id) return res.status(401).json({ error: "Missing auth" });
    const id = req.params.id;
    const { action } = req.body || {};
    if (!id || !action)
      return res.status(400).json({ error: "Missing id or action" });

    const note = await Notification.findById(id).lean();
    if (!note) return res.status(404).json({ error: "Notification not found" });
    if (String(note.userId) !== String(me.id))
      return res.status(403).json({ error: "Not authorized" });

    // Helper in-scope to notify via roomManager (kept local)
    function emitTo(userId, ev, payload) {
      try {
        emitToUser(userId, ev, payload);
      } catch (e) {}
    }

    // -------------------------------
    // FRIEND ACCEPT / DECLINE
    // -------------------------------
    if (action === "accept_friend" || action === "decline_friend") {
      const reqId = note.data?.reqId || null;
      const fromUserId = note.data?.fromUserId || note.fromUserId || null;

      if (!reqId && !fromUserId)
        return res
          .status(400)
          .json({ error: "Missing reqId/fromUserId in notification" });

      if (action === "accept_friend") {
        try {
          if (!fromUserId)
            return res.status(400).json({ error: "Missing fromUserId" });

          const fromUser = await User.findById(String(fromUserId)).exec();
          const toUser = await User.findById(String(me.id)).exec();
          if (!fromUser || !toUser)
            return res.status(404).json({ error: "User(s) not found" });

          // Remove the incomingFriendRequests entry (if exists)
          toUser.incomingFriendRequests = (
            toUser.incomingFriendRequests || []
          ).filter((r) =>
            reqId ? r.reqId !== reqId : r.fromUserId !== String(fromUserId)
          );
          await toUser.save().catch(() => {});

          // Add friends to both sides (use $addToSet to avoid duplicates)
          await User.updateOne(
            { _id: String(fromUserId) },
            {
              $addToSet: {
                friends: { id: String(me.id), username: toUser.username },
              },
            }
          ).exec();
          await User.updateOne(
            { _id: String(me.id) },
            {
              $addToSet: {
                friends: {
                  id: String(fromUserId),
                  username: fromUser.username,
                },
              },
            }
          ).exec();

          // emit to sender sockets
          emitTo(fromUserId, "friend-request-accepted", {
            reqId,
            by: { id: me.id, username: me.username || me.displayName || null },
          });

          // persist a notification to the sender (best-effort)
          try {
            if (notificationService) {
              await notificationService.createNotification(
                String(fromUserId),
                "friend_request_accepted",
                "Friend request accepted",
                `${me.username || "A player"} accepted your friend request.`,
                { reqId, by: { id: me.id, username: me.username } }
              );
            } else {
              const doc = new Notification({
                userId: String(fromUserId),
                type: "friend_request_accepted",
                title: "Friend request accepted",
                body: `${
                  me.username || "A player"
                } accepted your friend request.`,
                data: { reqId, by: { id: me.id, username: me.username } },
                fromUserId: String(me.id),
                read: false,
                createdAt: Date.now(),
              });
              await doc.save().catch(() => {});
              emitToUser(String(fromUserId), "notification", {
                id: String(doc._id),
                _id: String(doc._id),
                userId: doc.userId,
                type: doc.type,
                title: doc.title,
                body: doc.body,
                data: doc.data,
                read: doc.read,
                status: doc.status || null,
                createdAt: doc.createdAt,
              });
            }
          } catch (e) {
            // non-fatal
          }

          // mark the original notification read + status, emit updated
          const updatedNotification = await markAndEmitNotification(id, me.id, {
            read: true,
            status: "accepted",
          });

          // ---- IMPORTANT: also mark any other notifications that referenced this reqId
          // (so UI across different views will update)
          try {
            await _markAndEmitNotificationsByDataKey(
              "reqId",
              String(reqId),
              "accepted"
            );
            // also clear any notifications referencing fromUserId->toUser mapping
            await _markAndEmitNotificationsByDataKey(
              "fromUserId",
              String(fromUserId),
              "accepted"
            );
          } catch (e) {}

          return res.json({
            ok: true,
            accepted: true,
            notification: updatedNotification || null,
          });
        } catch (e) {
          console.error("notifications: accept_friend error", e);
          return res.status(500).json({ error: "Server error" });
        }
      } else {
        // decline_friend
        try {
          const fromUser = await User.findById(String(fromUserId)).exec();
          const toUser = await User.findById(String(me.id)).exec();
          if (!toUser) return res.status(404).json({ error: "User not found" });

          toUser.incomingFriendRequests = (
            toUser.incomingFriendRequests || []
          ).filter((r) =>
            reqId ? r.reqId !== reqId : r.fromUserId !== String(fromUserId)
          );
          await toUser.save().catch(() => {});

          if (fromUser) {
            emitTo(fromUserId, "friend-request-declined", {
              reqId,
              by: { id: me.id, username: me.username || null },
            });
            try {
              if (notificationService)
                await notificationService.createNotification(
                  String(fromUserId),
                  "friend_request_declined",
                  "Friend request declined",
                  `${me.username || "A player"} declined your friend request.`,
                  { reqId, by: { id: me.id, username: me.username } }
                );
              else {
                const doc = new Notification({
                  userId: String(fromUserId),
                  type: "friend_request_declined",
                  title: "Friend request declined",
                  body: `${
                    me.username || "A player"
                  } declined your friend request.`,
                  data: { reqId, by: { id: me.id, username: me.username } },
                  fromUserId: String(me.id),
                  read: false,
                  createdAt: Date.now(),
                });
                await doc.save().catch(() => {});
                emitToUser(String(fromUserId), "notification", {
                  id: String(doc._id),
                  _id: String(doc._id),
                  userId: doc.userId,
                  type: doc.type,
                  title: doc.title,
                  body: doc.body,
                  data: doc.data,
                  read: doc.read,
                  status: doc.status || null,
                  createdAt: doc.createdAt,
                });
              }
            } catch (e) {}
          }

          const updatedNotification = await markAndEmitNotification(id, me.id, {
            read: true,
            status: "declined",
          });

          // Also mark related notifications referencing reqId/fromUserId
          try {
            await _markAndEmitNotificationsByDataKey(
              "reqId",
              String(reqId),
              "declined"
            );
            await _markAndEmitNotificationsByDataKey(
              "fromUserId",
              String(fromUserId),
              "declined"
            );
          } catch (e) {}

          return res.json({
            ok: true,
            declined: true,
            notification: updatedNotification || null,
          });
        } catch (e) {
          console.error("notifications: decline_friend error", e);
          return res.status(500).json({ error: "Server error" });
        }
      }
    }

    // -------------------------------
    // REMATCH ACCEPT / DECLINE
    // -------------------------------
    if (action === "accept_rematch" || action === "decline_rematch") {
      try {
        const roomId = note.data?.roomId;
        if (!roomId)
          return res
            .status(400)
            .json({ error: "Missing roomId in notification" });
        const room =
          roomManager && roomManager.rooms ? roomManager.rooms[roomId] : null;
        if (!room) {
          const doc = await RoomModel.findOne({ roomId })
            .lean()
            .exec()
            .catch(() => null);
          if (!doc) return res.status(404).json({ error: "Room not found" });
          return res
            .status(400)
            .json({ error: "Room not active for rematch via HTTP" });
        }

        if (!room.rematch) {
          return res.status(400).json({ error: "No rematch pending" });
        }

        const relatedPlayers = (room.players || []).filter((p) => {
          const uid = p.user && (p.user.id || p.user._id);
          return uid && String(uid) === String(me.id);
        });

        if (relatedPlayers.length === 0) {
          return res
            .status(403)
            .json({ error: "You are not a participant to this room" });
        }

        room.rematch.acceptedBy = room.rematch.acceptedBy || {};
        for (const p of relatedPlayers) {
          room.rematch.acceptedBy[p.id] =
            action === "accept_rematch" ? true : false;
        }

        if (action === "decline_rematch") {
          const initiatorSocketId = room.rematch.initiatorSocketId;
          if (initiatorSocketId) {
            try {
              roomManager.io &&
                roomManager.io.to(initiatorSocketId).emit("rematch-declined", {
                  message: `Rematch declined by ${me.username || me.id}`,
                });
            } catch (e) {}
          }
          // clear rematch
          room.rematch = null;
          try {
            if (typeof roomManager.broadcastRoomState === "function")
              roomManager.broadcastRoomState(roomId);
          } catch (e) {}

          const updatedNotification = await markAndEmitNotification(id, me.id, {
            read: true,
            status: "declined",
          });

          // mark other notifications referencing this roomId as declined
          try {
            await _markAndEmitNotificationsByDataKey(
              "roomId",
              String(roomId),
              "declined"
            );
          } catch (e) {}

          return res.json({
            ok: true,
            declined: true,
            notification: updatedNotification || null,
          });
        }

        // accept -> check if all required accepted
        const coloredPlayers = (room.players || []).filter(
          (p) => p.color === "w" || p.color === "b"
        );
        const coloredIds = coloredPlayers.map((p) => p.id).filter(Boolean);

        let required = [];
        if (coloredIds.length === 2) {
          required = coloredIds;
        } else if (coloredIds.length === 1) {
          required = Array.from(
            new Set([room.rematch.initiatorSocketId, coloredIds[0]])
          ).filter(Boolean);
        } else {
          required = [room.rematch.initiatorSocketId].filter(Boolean);
        }

        const acceptedKeys = Object.keys(room.rematch.acceptedBy || {});
        const allAccepted =
          required.length > 0 &&
          required.every((id) => acceptedKeys.includes(id));

        if (allAccepted) {
          try {
            if (typeof roomManager.assignColorsForRematch === "function") {
              roomManager.assignColorsForRematch(room);
            }
            room.chess = new (require("chess.js").Chess)();
            room.fen = room.chess.fen();
            room.moves = [];
            room.lastIndex = -1;
            room.finished = null;
            room.pendingDrawOffer = null;
            room.paused = false;

            if (room.settings && room.settings.minutesMs) {
              const ms = room.settings.minutesMs;
              room.clocks = {
                w: ms,
                b: ms,
                running: room.chess.turn(),
                lastTick: Date.now(),
              };
            } else {
              room.clocks = room.clocks
                ? {
                    w: 5 * 60 * 1000,
                    b: 5 * 60 * 1000,
                    running: room.chess.turn(),
                    lastTick: Date.now(),
                  }
                : null;
            }

            room.rematch = null;
            try {
              if (typeof roomManager.broadcastRoomState === "function")
                roomManager.broadcastRoomState(roomId);
            } catch (e) {}
            try {
              roomManager.io &&
                roomManager.io.to(roomId).emit("play-again", {
                  ok: true,
                  started: true,
                  message: "Rematch started",
                });
            } catch (e) {}
            // persist notifications to participants
            try {
              if (notificationService) {
                for (const p of room.players) {
                  try {
                    const uid = (p.user && (p.user.id || p.user._id)) || null;
                    if (!uid) continue;
                    await notificationService.createNotification(
                      String(uid),
                      "rematch_started",
                      "Rematch started",
                      `Rematch started in room ${roomId}`,
                      { roomId }
                    );
                  } catch (e) {}
                }
              } else {
                // fallback: create Notification docs for each participant
                for (const p of room.players) {
                  try {
                    const uid = (p.user && (p.user.id || p.user._id)) || null;
                    if (!uid) continue;
                    const doc = new Notification({
                      userId: String(uid),
                      type: "rematch_started",
                      title: "Rematch started",
                      body: `Rematch started in room ${roomId}`,
                      data: { roomId },
                      read: false,
                      createdAt: Date.now(),
                    });
                    await doc.save().catch(() => {});
                    emitToUser(String(uid), "notification", {
                      id: String(doc._id),
                      _id: String(doc._id),
                      userId: doc.userId,
                      type: doc.type,
                      title: doc.title,
                      body: doc.body,
                      data: doc.data,
                      read: doc.read,
                      status: doc.status || null,
                      createdAt: doc.createdAt,
                    });
                  } catch (e) {}
                }
              }
            } catch (e) {}

            const updatedNotification = await markAndEmitNotification(
              id,
              me.id,
              { read: true, status: "accepted" }
            );

            // mark other notifications referencing this roomId as accepted
            try {
              await _markAndEmitNotificationsByDataKey(
                "roomId",
                String(roomId),
                "accepted"
              );
            } catch (e) {}

            return res.json({
              ok: true,
              rematch_started: true,
              notification: updatedNotification || null,
            });
          } catch (e) {
            console.error("notifications: accept_rematch start error", e);
            return res.status(500).json({ error: "Server error" });
          }
        } else {
          // not all accepted yet — persist accepted state and broadcast
          try {
            const updatedNotification = await markAndEmitNotification(
              id,
              me.id,
              { read: true, status: "accepted_partial" }
            );
            try {
              if (typeof roomManager.broadcastRoomState === "function")
                roomManager.broadcastRoomState(roomId);
            } catch (e) {}
            // also mark partial status on other notifications referencing roomId
            try {
              await _markAndEmitNotificationsByDataKey(
                "roomId",
                String(roomId),
                "accepted_partial"
              );
            } catch (e) {}

            return res.json({
              ok: true,
              accepted: true,
              awaiting: true,
              notification: updatedNotification || null,
            });
          } catch (e) {
            console.error(
              "notifications: accept_rematch partial update error",
              e
            );
            return res.status(500).json({ error: "Server error" });
          }
        }
      } catch (e) {
        console.error("notifications: accept/decline rematch error", e);
        return res.status(500).json({ error: "Server error" });
      }
    }

    // -------------------------------
    // DRAW ACCEPT / DECLINE
    // -------------------------------
    if (action === "accept_draw" || action === "decline_draw") {
      try {
        const roomId = note.data?.roomId;
        if (!roomId) return res.status(400).json({ error: "Missing roomId" });
        const room =
          roomManager && roomManager.rooms ? roomManager.rooms[roomId] : null;
        if (!room) return res.status(404).json({ error: "Room not found" });

        if (!room.pendingDrawOffer)
          return res.status(400).json({ error: "No draw pending" });
        const offer = room.pendingDrawOffer;
        let offerer = null;
        if (offer.fromUserId) {
          offerer = room.players.find(
            (p) => p.user && String(p.user.id) === String(offer.fromUserId)
          );
        }
        if (!offerer && offer.fromSocketId) {
          offerer = room.players.find((p) => p.id === offer.fromSocketId);
        }
        const acceptor = room.players.find(
          (p) => p.user && String(p.user.id) === String(me.id)
        );
        if (!acceptor)
          return res.status(403).json({ error: "You are not a participant" });
        if (!offerer) {
          room.pendingDrawOffer = null;
          try {
            if (typeof roomManager.broadcastRoomState === "function")
              roomManager.broadcastRoomState(roomId);
          } catch (e) {}
          return res.json({ ok: false, error: "Offerer not found" });
        }

        if (action === "decline_draw") {
          room.pendingDrawOffer = null;
          try {
            roomManager.io &&
              roomManager.io
                .to(offerer.id)
                .emit("draw-declined", { by: me.id || me.username });
          } catch (e) {}
          if (notificationService) {
            try {
              await notificationService.createNotification(
                String(offerer.user?.id || offerer.id),
                "draw_declined",
                "Draw declined",
                `${me.username || "Player"} declined your draw.`,
                { roomId }
              );
            } catch (e) {}
          } else {
            try {
              const doc = new Notification({
                userId: String(offerer.user?.id || offerer.id),
                type: "draw_declined",
                title: "Draw declined",
                body: `${me.username || "Player"} declined your draw.`,
                data: { roomId },
                read: false,
                createdAt: Date.now(),
              });
              await doc.save().catch(() => {});
              emitToUser(
                String(offerer.user?.id || offerer.id),
                "notification",
                {
                  id: String(doc._id),
                  _id: String(doc._id),
                  userId: doc.userId,
                  type: doc.type,
                  title: doc.title,
                  body: doc.body,
                  data: doc.data,
                  read: doc.read,
                  status: doc.status || null,
                  createdAt: doc.createdAt,
                }
              );
            } catch (e) {}
          }

          try {
            if (typeof roomManager.broadcastRoomState === "function")
              roomManager.broadcastRoomState(roomId);
          } catch (e) {}

          const updatedNotification = await markAndEmitNotification(id, me.id, {
            read: true,
            status: "declined",
          });

          // mark other notifications referencing this roomId/draw
          try {
            await _markAndEmitNotificationsByDataKey(
              "roomId",
              String(roomId),
              "declined"
            );
            // if there is a drawId
            if (note.data && note.data.drawId) {
              await _markAndEmitNotificationsByDataKey(
                "drawId",
                String(note.data.drawId),
                "declined"
              );
            }
          } catch (e) {}

          return res.json({
            ok: true,
            declined: true,
            notification: updatedNotification || null,
          });
        } else {
          // accept_draw -> finalize draw similar to socket accept-draw
          room.paused = true;
          if (room.clocks) {
            room.clocks.running = null;
            room.clocks.lastTick = null;
          }
          room.pendingDrawOffer = null;
          room.finished = {
            reason: "draw-agreed",
            result: "draw",
            message: "Game drawn by agreement",
            finishedAt: Date.now(),
          };
          try {
            roomManager.io &&
              roomManager.io.to(roomId).emit("game-over", { ...room.finished });
          } catch (e) {}
          try {
            if (typeof roomManager.broadcastRoomState === "function")
              roomManager.broadcastRoomState(roomId);
          } catch (e) {}
          try {
            if (typeof roomManager.saveFinishedGame === "function")
              await roomManager.saveFinishedGame(roomId);
          } catch (e) {}

          // persist notifications to both players
          try {
            if (notificationService) {
              for (const p of room.players) {
                const uid = p.user && (p.user.id || p.user._id);
                if (!uid) continue;
                await notificationService.createNotification(
                  String(uid),
                  "draw_accepted",
                  "Draw accepted",
                  `${me.username || "Player"} accepted a draw.`,
                  { roomId }
                );
              }
            } else {
              for (const p of room.players) {
                try {
                  const uid = p.user && (p.user.id || p.user._id);
                  if (!uid) continue;
                  const doc = new Notification({
                    userId: String(uid),
                    type: "draw_accepted",
                    title: "Draw accepted",
                    body: `${me.username || "Player"} accepted a draw.`,
                    data: { roomId },
                    read: false,
                    createdAt: Date.now(),
                  });
                  await doc.save().catch(() => {});
                  emitToUser(String(uid), "notification", {
                    id: String(doc._id),
                    _id: String(doc._id),
                    userId: doc.userId,
                    type: doc.type,
                    title: doc.title,
                    body: doc.body,
                    data: doc.data,
                    read: doc.read,
                    status: doc.status || null,
                    createdAt: doc.createdAt,
                  });
                } catch (e) {}
              }
            }
          } catch (e) {}

          const updatedNotification = await markAndEmitNotification(id, me.id, {
            read: true,
            status: "accepted",
          });

          // mark other notifications referencing roomId/drawId as accepted
          try {
            await _markAndEmitNotificationsByDataKey(
              "roomId",
              String(roomId),
              "accepted"
            );
            if (note.data && note.data.drawId) {
              await _markAndEmitNotificationsByDataKey(
                "drawId",
                String(note.data.drawId),
                "accepted"
              );
            }
          } catch (e) {}

          return res.json({
            ok: true,
            accepted: true,
            notification: updatedNotification || null,
          });
        }
      } catch (e) {
        console.error("notifications: accept/decline draw error", e);
        return res.status(500).json({ error: "Server error" });
      }
    }

    // -------------------------------
    // CHALLENGE ACCEPT / DECLINE
    // -------------------------------
    if (action === "accept_challenge" || action === "decline_challenge") {
      try {
        const challengeId = note.data?.challengeId || note.data?.challenge_id;
        if (!challengeId)
          return res.status(400).json({ error: "Missing challengeId" });

        const pendingChallenges =
          roomManager && roomManager.pendingChallenges
            ? roomManager.pendingChallenges
            : {};
        const pending = pendingChallenges[challengeId];
        if (!pending) {
          // mark this notification as handled anyway to avoid stale UI.
          await markAndEmitNotification(id, me.id, {
            read: true,
            status: "handled",
          }).catch(() => {});
          return res
            .status(404)
            .json({ error: "Challenge not found or already handled" });
        }

        const acceptorUserId = String(me.id);
        if (acceptorUserId !== String(pending.toUserId)) {
          return res
            .status(403)
            .json({ error: "Not authorized to accept this challenge" });
        }

        if (action === "decline_challenge") {
          try {
            if (roomManager && roomManager.io && pending.fromSocketId) {
              roomManager.io
                .to(pending.fromSocketId)
                .emit("challenge-declined", {
                  challengeId,
                  reason: "opponent-declined",
                });
            }
            if (notificationService)
              await notificationService.createNotification(
                String(pending.fromUserId),
                "challenge_declined",
                "Challenge declined",
                `${me.username || "Player"} declined your challenge.`,
                { challengeId }
              );
            else {
              const doc = new Notification({
                userId: String(pending.fromUserId),
                type: "challenge_declined",
                title: "Challenge declined",
                body: `${me.username || "Player"} declined your challenge.`,
                data: { challengeId },
                read: false,
                createdAt: Date.now(),
              });
              await doc.save().catch(() => {});
              emitToUser(String(pending.fromUserId), "notification", {
                id: String(doc._id),
                _id: String(doc._id),
                userId: doc.userId,
                type: doc.type,
                title: doc.title,
                body: doc.body,
                data: doc.data,
                read: doc.read,
                status: doc.status || null,
                createdAt: doc.createdAt,
              });
            }
          } catch (e) {}
          delete pendingChallenges[challengeId];

          const updatedNotification = await markAndEmitNotification(id, me.id, {
            read: true,
            status: "declined",
          });

          // mark other notifications referencing this challengeId
          try {
            await _markAndEmitNotificationsByDataKey(
              "challengeId",
              String(challengeId),
              "declined"
            );
          } catch (e) {}

          return res.json({
            ok: true,
            declined: true,
            notification: updatedNotification || null,
          });
        }

        // accept_challenge -> create a room
        try {
          let roomId =
            (roomManager &&
              roomManager.generateRoomCode &&
              roomManager.generateRoomCode(8)) ||
            `R${Date.now()}`;
          while (roomManager && roomManager.rooms && roomManager.rooms[roomId])
            roomId =
              (roomManager.generateRoomCode &&
                roomManager.generateRoomCode(8)) ||
              `R${Date.now()}-${Math.floor(Math.random() * 1000)}`;

          const minutes = Math.max(1, Math.floor(Number(pending.minutes) || 5));
          const minutesMs = minutes * 60 * 1000;
          const room = {
            players: [],
            moves: [],
            chess: new (require("chess.js").Chess)(),
            fen: null,
            lastIndex: -1,
            clocks: null,
            paused: false,
            disconnectTimers: {},
            firstMoveTimer: null,
            pendingDrawOffer: null,
            finished: null,
            settings: {
              minutes,
              minutesMs,
              creatorId: pending.fromUserId,
              colorPreference: pending.colorPreference || "random",
            },
            messages: [],
            rematch: null,
          };

          let initiatorUser = null;
          let acceptorUser = null;
          try {
            if (pending.fromUserId)
              initiatorUser = await User.findById(pending.fromUserId)
                .select("-passwordHash")
                .lean();
          } catch (e) {}
          try {
            if (pending.toUserId)
              acceptorUser = await User.findById(pending.toUserId)
                .select("-passwordHash")
                .lean();
          } catch (e) {}
          if (
            initiatorUser &&
            typeof roomManager.ensureAvatarAbs === "function"
          )
            initiatorUser = roomManager.ensureAvatarAbs(initiatorUser);
          if (acceptorUser && typeof roomManager.ensureAvatarAbs === "function")
            acceptorUser = roomManager.ensureAvatarAbs(acceptorUser);

          const initiatorPlayer = {
            id: pending.fromSocketId,
            user: initiatorUser || {
              id: pending.fromUserId,
              username: initiatorUser?.username || "guest",
            },
            color: "w",
            online: true,
            disconnectedAt: null,
          };
          const acceptorPlayer = {
            id: null,
            user: acceptorUser || {
              id: pending.toUserId,
              username: acceptorUser?.username || "guest",
            },
            color: "b",
            online: true,
            disconnectedAt: null,
          };

          let acceptorSocketId = null;
          if (
            roomManager &&
            typeof roomManager.getSocketsForUserId === "function"
          ) {
            const sids = roomManager.getSocketsForUserId(
              String(pending.toUserId)
            );
            if (Array.isArray(sids) && sids.length > 0)
              acceptorSocketId = sids[0];
          }
          if (!acceptorSocketId) {
            delete pendingChallenges[challengeId];
            const updatedNotification = await markAndEmitNotification(
              id,
              me.id,
              { read: true, status: "accepted" }
            );
            return res.status(400).json({
              ok: false,
              error: "Acceptor offline",
              notification: updatedNotification || null,
            });
          }
          acceptorPlayer.id = acceptorSocketId;

          if (pending.colorPreference === "white") {
            initiatorPlayer.color = "w";
            acceptorPlayer.color = "b";
          } else if (pending.colorPreference === "black") {
            initiatorPlayer.color = "b";
            acceptorPlayer.color = "w";
          } else {
            if (Math.random() < 0.5) {
              initiatorPlayer.color = "w";
              acceptorPlayer.color = "b";
            } else {
              initiatorPlayer.color = "b";
              acceptorPlayer.color = "w";
            }
          }

          room.players.push(initiatorPlayer);
          room.players.push(acceptorPlayer);

          room.clocks = {
            w: room.settings.minutesMs,
            b: room.settings.minutesMs,
            running: room.chess.turn(),
            lastTick: Date.now(),
          };

          if (!roomManager.rooms) roomManager.rooms = {};
          roomManager.rooms[roomId] = room;

          try {
            const initiatorSock =
              (pending.fromSocketId &&
                roomManager.io &&
                roomManager.io.sockets &&
                roomManager.io.sockets.sockets.get(pending.fromSocketId)) ||
              null;
            const acceptorSock =
              (acceptorSocketId &&
                roomManager.io &&
                roomManager.io.sockets &&
                roomManager.io.sockets.sockets.get(acceptorSocketId)) ||
              null;
            if (initiatorSock) initiatorSock.join(roomId);
            if (acceptorSock) acceptorSock.join(roomId);
          } catch (e) {}
          try {
            if (typeof roomManager.broadcastRoomState === "function")
              roomManager.broadcastRoomState(roomId);
          } catch (e) {}
          try {
            if (roomManager.io) {
              const payload = {
                ok: true,
                challengeId,
                roomId,
                message: "Challenge accepted — room created",
              };
              if (pending.fromSocketId)
                roomManager.io
                  .to(pending.fromSocketId)
                  .emit("challenge-accepted", payload);
              if (acceptorSocketId)
                roomManager.io
                  .to(acceptorSocketId)
                  .emit("challenge-accepted", payload);
            }
          } catch (e) {}

          try {
            if (notificationService) {
              await notificationService.createNotification(
                String(pending.fromUserId),
                "challenge_accepted",
                "Challenge accepted",
                `${me.username || "Player"} accepted your challenge.`,
                { challengeId, roomId }
              );
              await notificationService.createNotification(
                String(pending.toUserId),
                "challenge_joined",
                "Challenge joined",
                `You joined challenge — room ${roomId} created.`,
                { challengeId, roomId }
              );
            } else {
              const docA = new Notification({
                userId: String(pending.fromUserId),
                type: "challenge_accepted",
                title: "Challenge accepted",
                body: `${me.username || "Player"} accepted your challenge.`,
                data: { challengeId, roomId },
                read: false,
                createdAt: Date.now(),
              });
              await docA.save().catch(() => {});
              emitToUser(String(pending.fromUserId), "notification", {
                id: String(docA._id),
                _id: String(docA._id),
                userId: docA.userId,
                type: docA.type,
                title: docA.title,
                body: docA.body,
                data: docA.data,
                read: docA.read,
                status: docA.status || null,
                createdAt: docA.createdAt,
              });
              const docB = new Notification({
                userId: String(pending.toUserId),
                type: "challenge_joined",
                title: "Challenge joined",
                body: `You joined challenge — room ${roomId} created.`,
                data: { challengeId, roomId },
                read: false,
                createdAt: Date.now(),
              });
              await docB.save().catch(() => {});
              emitToUser(String(pending.toUserId), "notification", {
                id: String(docB._id),
                _id: String(docB._id),
                userId: docB.userId,
                type: docB.type,
                title: docB.title,
                body: docB.body,
                data: docB.data,
                read: docB.read,
                status: docB.status || null,
                createdAt: docB.createdAt,
              });
            }
          } catch (e) {}

          delete pendingChallenges[challengeId];

          const updatedNotification = await markAndEmitNotification(id, me.id, {
            read: true,
            status: "accepted",
          });

          // mark other notifications referencing this challengeId
          try {
            await _markAndEmitNotificationsByDataKey(
              "challengeId",
              String(challengeId),
              "accepted"
            );
            await _markAndEmitNotificationsByDataKey(
              "roomId",
              String(roomId),
              "accepted"
            );
          } catch (e) {}

          return res.json({
            ok: true,
            roomId,
            notification: updatedNotification || null,
          });
        } catch (e) {
          console.error(
            "notifications: accept_challenge implementation error",
            e
          );
          return res.status(500).json({ error: "Server error" });
        }
      } catch (e) {
        console.error("notifications: challenge action error", e);
        return res.status(500).json({ error: "Server error" });
      }
    }

    // unsupported action
    return res.status(400).json({ error: "Unsupported action" });
  } catch (err) {
    console.error("POST /api/notifications/:id/action error", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
