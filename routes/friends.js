const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

// Helpers to require modules from different possible locations (keeps compatibility)
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
  const e = new Error(
    `tryRequire: none of the paths resolved: ${paths.join(", ")}`
  );
  e.code = "MODULE_NOT_FOUND";
  throw e;
}

const User = tryRequire([
  "../models/User",
  "../../models/User",
  "../src/models/User",
  "../../src/models/User",
]);

// Try to load Notification model + notificationService (best-effort)
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

let notificationService = null;
try {
  notificationService = tryRequire([
    "../services/notificationService",
    "../../services/notificationService",
    "../src/services/notificationService",
    "../../src/services/notificationService",
  ]);
} catch (e) {
  notificationService = null;
}

// load auth middleware (restAuthMiddleware) from your middleware/auth
let restAuthMiddleware = null;
try {
  const authMod = tryRequire([
    "../middleware/auth",
    "../../src/middleware/auth",
    "../src/middleware/auth",
    "../../middleware/auth",
  ]);
  restAuthMiddleware =
    authMod.restAuthMiddleware || authMod.authMiddleware || null;
} catch (err) {
  restAuthMiddleware = null;
}

// Try to load roomManager for notifications / online map (best-effort)
let roomManager = null;
try {
  roomManager = tryRequire([
    "../roomManager",
    "../../roomManager",
    "../src/roomManager",
    "../../src/roomManager",
  ]);
} catch (err) {
  roomManager = null;
}

/**
 * Utility: send socket notification if roomManager exposes a notify/send function.
 * We try a few common names: notifyUser, sendToUser, emitToUser.
 */
function notifyUser(userId, event, payload) {
  try {
    if (!roomManager) return;
    const fn =
      roomManager.notifyUser ||
      roomManager.sendToUser ||
      roomManager.emitToUser ||
      roomManager.emitToSocket;
    if (typeof fn === "function") {
      fn(userId, event, payload);
    } else if (roomManager.io && typeof roomManager.io.to === "function") {
      try {
        roomManager.io.to(`user:${userId}`).emit(event, payload);
      } catch {}
    }
  } catch (err) {
    console.error("notifyUser error (non-fatal)", err);
  }
}

/**
 * Helper: mark & emit Notification docs that reference a given reqId
 * (best-effort; used to keep notifications in sync no matter where action happened).
 */
async function _markAndEmitNotificationsByReqId(reqId, status, actor) {
  if (!reqId) return;
  try {
    if (!Notification) return;
    // find notifications referencing this reqId
    const docs = await Notification.find({ "data.reqId": reqId }).exec();
    for (const d of docs) {
      try {
        d.read = true;
        d.status = status || "handled";
        d.updatedAt = Date.now();
        await d.save().catch(() => {}); // best-effort

        // emit payload to owner of the notification
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
        try {
          notifyUser(String(d.userId), "notification", payload);
        } catch (e) {}
      } catch (e) {
        // continue
      }
    }
  } catch (e) {
    console.error("_markAndEmitNotificationsByReqId error (non-fatal)", e);
  }
}

/**
 * Utility: find user by id or return null
 */
async function findUserById(id) {
  if (!id) return null;
  if (mongoose.Types.ObjectId.isValid(id)) {
    return await User.findById(id).exec();
  }
  return null;
}

/**
 * Utility: obtain a map-like object describing which userId is online.
 * This tries common shapes on roomManager so it works with a few implementations.
 */
function getOnlineUsersMap() {
  try {
    if (!roomManager) return {};
    // common possible shapes:
    if (roomManager.onlineUsers && typeof roomManager.onlineUsers === "object")
      return roomManager.onlineUsers;
    if (roomManager.online && typeof roomManager.online === "object")
      return roomManager.online;
    if (typeof roomManager.getOnlineUsers === "function") {
      const out = roomManager.getOnlineUsers();
      if (out && typeof out === "object") return out;
    }
    // fallback empty
    return {};
  } catch (err) {
    return {};
  }
}

/**
 * GET /api/friends
 * Return current user's friends array with enriched basic info for each friend.
 * Adds `online` boolean per friend using roomManager if available.
 */
router.get("/", restAuthMiddleware, async (req, res) => {
  try {
    const meId = req.user && req.user.id;
    if (!meId) return res.status(401).json({ error: "Missing auth" });

    const me = await User.findById(meId).lean();
    if (!me) return res.status(404).json({ error: "User not found" });

    // Build friend list with some user details
    const friendIds = (me.friends || []).map((f) => f.id).filter(Boolean);
    const friendsDocs = await User.find({ _id: { $in: friendIds } })
      .select("username displayName avatarUrl country cups lastIp createdAt")
      .lean();

    // Map by id for ordering like original list
    const byId = new Map(friendsDocs.map((d) => [String(d._id), d]));

    const onlineUsersMap = getOnlineUsersMap();

    const result = (me.friends || []).map((f) => {
      const doc = byId.get(String(f.id)) || null;
      const idStr = String(f.id);
      return {
        id: f.id,
        username: f.username,
        addedAt: f.addedAt || null,
        displayName: doc ? doc.displayName || null : null,
        avatarUrl: doc ? doc.avatarUrl || null : null,
        country: doc ? doc.country || null : null,
        cups: doc ? doc.cups || 0 : 0,
        lastIp: doc ? doc.lastIp || null : null,
        // <-- NEW: expose online boolean to clients (best-effort)
        online: !!(onlineUsersMap && onlineUsersMap[idStr]),
      };
    });

    res.json(result);
  } catch (err) {
    console.error("GET /api/friends error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/friends/requests
 * Return incoming friend requests for current user.
 * optional query: ?status=pending|accepted|declined
 */
router.get("/requests", restAuthMiddleware, async (req, res) => {
  try {
    const meId = req.user && req.user.id;
    if (!meId) return res.status(401).json({ error: "Missing auth" });

    const statusFilter =
      typeof req.query.status === "string" ? req.query.status : null;

    const me = await User.findById(meId).lean();
    if (!me) return res.status(404).json({ error: "User not found" });

    let arr = Array.isArray(me.incomingFriendRequests)
      ? me.incomingFriendRequests
      : [];
    if (statusFilter) {
      arr = arr.filter((r) => String(r.status) === String(statusFilter));
    }

    // Optionally enrich requester info
    const fromIds = [...new Set(arr.map((r) => r.fromUserId).filter(Boolean))];
    const fromDocs = fromIds.length
      ? await User.find({ _id: { $in: fromIds } })
          .select("username displayName avatarUrl country cups")
          .lean()
      : [];

    const byId = new Map(fromDocs.map((d) => [String(d._id), d]));

    const out = arr.map((r) => {
      const fd = byId.get(String(r.fromUserId)) || null;
      return {
        reqId: r.reqId,
        fromUserId: r.fromUserId,
        fromUsername: r.fromUsername,
        status: r.status,
        ts: r.ts,
        fromDisplayName: fd ? fd.displayName || null : null,
        fromAvatarUrl: fd ? fd.avatarUrl || null : null,
        fromCountry: fd ? fd.country || null : null,
      };
    });

    res.json(out);
  } catch (err) {
    console.error("GET /api/friends/requests error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/friends/request
 * body: { toUserId }
 *
 * Creates an incomingFriendRequests entry in target user.
 * Also creates a persisted Notification (best-effort) so notification UI can act on it.
 */
router.post("/request", restAuthMiddleware, async (req, res) => {
  try {
    const meId = req.user && req.user.id;
    const meUsername = req.user && req.user.username;
    if (!meId) return res.status(401).json({ error: "Missing auth" });

    const toUserId = req.body && (req.body.toUserId || req.body.toId);
    if (!toUserId) return res.status(400).json({ error: "Missing toUserId" });
    if (String(toUserId) === String(meId))
      return res.status(400).json({ error: "Cannot friend yourself" });

    const target = await User.findById(toUserId);
    if (!target)
      return res.status(404).json({ error: "Target user not found" });

    // Check already friends
    const alreadyFriend = (target.friends || []).some(
      (f) => String(f.id) === String(meId)
    );
    if (alreadyFriend)
      return res.status(400).json({ error: "Already friends" });

    // Check existing pending request (either direction)
    const existingIncoming = (target.incomingFriendRequests || []).find(
      (r) => String(r.fromUserId) === String(meId) && r.status === "pending"
    );
    if (existingIncoming)
      return res.status(400).json({ error: "Friend request already sent" });

    // Also check if target previously sent a request to me (then we can accept automatically or create mutual)
    const reciprocal = (await User.findById(meId)).incomingFriendRequests || [];
    const requestFromTargetToMe = reciprocal.find(
      (r) => String(r.fromUserId) === String(toUserId) && r.status === "pending"
    );

    if (requestFromTargetToMe) {
      // If target already requested me, accept both -> create friend entries
      await User.updateOne(
        {
          _id: meId,
          "incomingFriendRequests.reqId": requestFromTargetToMe.reqId,
        },
        { $set: { "incomingFriendRequests.$.status": "accepted" } }
      );

      await User.updateOne(
        { _id: meId },
        {
          $addToSet: {
            friends: { id: target._id.toString(), username: target.username },
          },
        }
      );
      await User.updateOne(
        { _id: target._id },
        {
          $addToSet: {
            friends: { id: meId.toString(), username: meUsername },
          },
        }
      );

      notifyUser(target._id.toString(), "friend-request-accepted", {
        by: { id: meId, username: meUsername },
      });
      notifyUser(meId, "friend-request-accepted", {
        by: { id: target._id.toString(), username: target.username },
      });

      // mark & emit any notification rows referencing the reciprocal reqId
      try {
        await _markAndEmitNotificationsByReqId(
          requestFromTargetToMe.reqId,
          "accepted",
          { by: meId }
        );
      } catch (e) {}

      // also persist notification to target that request accepted (best-effort)
      try {
        if (notificationService) {
          await notificationService.createNotification(
            String(target._id),
            "friend_request_accepted",
            "Friend request accepted",
            `${meUsername || "A player"} accepted your friend request.`,
            {
              reqId: requestFromTargetToMe.reqId,
              by: { id: meId, username: meUsername },
            }
          );
        }
      } catch (e) {}

      return res.json({ ok: true, acceptedMutual: true });
    }

    // otherwise create a new incomingFriendRequests entry on target
    const newReq = {
      reqId: new mongoose.Types.ObjectId().toString(),
      fromUserId: meId,
      fromUsername: meUsername,
      ts: Date.now(),
      status: "pending",
    };

    target.incomingFriendRequests = target.incomingFriendRequests || [];
    target.incomingFriendRequests.push(newReq);
    await target.save();

    // notify target if online (socket)
    notifyUser(target._id.toString(), "friend-request-received", {
      reqId: newReq.reqId,
      from: { id: meId, username: meUsername },
    });

    // Persist a Notification document so the notification list can be authoritative
    try {
      if (notificationService) {
        await notificationService.createNotification(
          String(target._id),
          "friend_request",
          "Friend request",
          `${meUsername || "A player"} sent you a friend request.`,
          { reqId: newReq.reqId, fromUserId: meId }
        );
      } else if (Notification) {
        const doc = new Notification({
          userId: String(target._id),
          type: "friend_request",
          title: "Friend request",
          body: `${meUsername || "A player"} sent you a friend request.`,
          data: { reqId: newReq.reqId, fromUserId: meId },
          fromUserId: String(meId),
          read: false,
          createdAt: Date.now(),
        });
        await doc.save().catch(() => {});
        // try to emit the persisted notification to recipient
        try {
          notifyUser(String(target._id), "notification", {
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
    } catch (e) {
      // non-fatal
      console.error("persist friend-request notification (non-fatal)", e);
    }

    res.json({ ok: true, reqId: newReq.reqId });
  } catch (err) {
    console.error("POST /api/friends/request error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/friends/respond
 * body: { reqId, accept: true|false }
 *
 * Responds to an incoming request addressed to current user.
 * Also updates/marks related Notifications (if any) so notification UI is consistent.
 */
router.post("/respond", restAuthMiddleware, async (req, res) => {
  try {
    const meId = req.user && req.user.id;
    const meUsername = req.user && req.user.username;
    if (!meId) return res.status(401).json({ error: "Missing auth" });

    const { reqId, accept } = req.body || {};
    if (!reqId) return res.status(400).json({ error: "Missing reqId" });

    const me = await User.findById(meId);
    if (!me) return res.status(404).json({ error: "User not found" });

    const idx = (me.incomingFriendRequests || []).findIndex(
      (r) => String(r.reqId) === String(reqId)
    );
    if (idx === -1) return res.status(404).json({ error: "Request not found" });

    const reqRec = me.incomingFriendRequests[idx];

    if (reqRec.status !== "pending") {
      return res.status(400).json({ error: "Request already responded" });
    }

    if (accept) {
      me.incomingFriendRequests[idx].status = "accepted";
      await me.save();

      await User.updateOne(
        { _id: meId },
        {
          $addToSet: {
            friends: { id: reqRec.fromUserId, username: reqRec.fromUsername },
          },
        }
      );

      await User.updateOne(
        { _id: reqRec.fromUserId },
        {
          $addToSet: {
            friends: { id: meId.toString(), username: meUsername },
          },
        }
      );

      // socket notifications
      notifyUser(reqRec.fromUserId, "friend-request-accepted", {
        by: { id: meId, username: meUsername },
      });
      notifyUser(meId, "friend-request-accepted", {
        by: { id: reqRec.fromUserId, username: reqRec.fromUsername },
      });

      // Persist a notification for the requester (so they see the persisted notification)
      try {
        if (notificationService) {
          await notificationService.createNotification(
            String(reqRec.fromUserId),
            "friend_request_accepted",
            "Friend request accepted",
            `${meUsername || "Player"} accepted your friend request.`,
            { reqId, by: { id: meId, username: meUsername } }
          );
        } else if (Notification) {
          const doc = new Notification({
            userId: String(reqRec.fromUserId),
            type: "friend_request_accepted",
            title: "Friend request accepted",
            body: `${meUsername || "Player"} accepted your friend request.`,
            data: { reqId, by: { id: meId, username: meUsername } },
            fromUserId: String(meId),
            read: false,
            createdAt: Date.now(),
          });
          await doc.save().catch(() => {});
          try {
            notifyUser(String(reqRec.fromUserId), "notification", {
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
      } catch (e) {
        // non-fatal
      }

      // Mark & emit any Notification docs referencing this reqId so UI updates consistently
      try {
        await _markAndEmitNotificationsByReqId(reqId, "accepted", { by: meId });
      } catch (e) {
        // non-fatal
      }

      return res.json({ ok: true, accepted: true });
    } else {
      me.incomingFriendRequests[idx].status = "declined";
      await me.save();

      notifyUser(reqRec.fromUserId, "friend-request-declined", {
        by: { id: meId, username: meUsername },
      });

      // Persist a notification for the requester (so they see the persisted notification)
      try {
        if (notificationService) {
          await notificationService.createNotification(
            String(reqRec.fromUserId),
            "friend_request_declined",
            "Friend request declined",
            `${meUsername || "Player"} declined your friend request.`,
            { reqId, by: { id: meId, username: meUsername } }
          );
        } else if (Notification) {
          const doc = new Notification({
            userId: String(reqRec.fromUserId),
            type: "friend_request_declined",
            title: "Friend request declined",
            body: `${meUsername || "Player"} declined your friend request.`,
            data: { reqId, by: { id: meId, username: meUsername } },
            fromUserId: String(meId),
            read: false,
            createdAt: Date.now(),
          });
          await doc.save().catch(() => {});
          try {
            notifyUser(String(reqRec.fromUserId), "notification", {
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
      } catch (e) {
        // non-fatal
      }

      // Mark & emit any Notification docs referencing this reqId so UI updates consistently
      try {
        await _markAndEmitNotificationsByReqId(reqId, "declined", { by: meId });
      } catch (e) {
        // non-fatal
      }

      return res.json({ ok: true, accepted: false });
    }
  } catch (err) {
    console.error("POST /api/friends/respond error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /api/friends/:id
 * Removes friend relationship (mutual) between current user and :id
 */
router.delete("/:id", restAuthMiddleware, async (req, res) => {
  try {
    const meId = req.user && req.user.id;
    if (!meId) return res.status(401).json({ error: "Missing auth" });

    const targetId = req.params.id;
    if (!targetId) return res.status(400).json({ error: "Missing target id" });
    if (String(targetId) === String(meId))
      return res.status(400).json({ error: "Cannot remove yourself" });

    await User.updateOne(
      { _id: meId },
      { $pull: { friends: { id: String(targetId) } } }
    );
    await User.updateOne(
      { _id: targetId },
      { $pull: { friends: { id: String(meId) } } }
    );

    // notify the other user (best-effort)
    notifyUser(targetId, "friend-removed", { by: { id: meId } });

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/friends/:id error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/friends/suggestions
 * Returns a short list of suggested players (not friends, not self), ordered by cups desc.
 * Query: ?limit=10
 */
router.get("/suggestions", restAuthMiddleware, async (req, res) => {
  try {
    const meId = req.user && req.user.id;
    if (!meId) return res.status(401).json({ error: "Missing auth" });

    const limit = Math.max(
      1,
      Math.min(50, parseInt(req.query.limit || "10", 10))
    );

    const me = await User.findById(meId).lean();
    if (!me) return res.status(404).json({ error: "User not found" });

    const friendIds = (me.friends || []).map((f) => String(f.id));
    // exclude friends and self
    const exclude = [String(meId), ...friendIds];

    const suggestions = await User.find({ _id: { $nin: exclude } })
      .sort({ cups: -1, createdAt: -1 })
      .limit(limit)
      .select("username displayName avatarUrl country cups")
      .lean();

    const out = suggestions.map((s) => ({
      id: s._id?.toString(),
      username: s.username,
      displayName: s.displayName || null,
      avatarUrl: s.avatarUrl || null,
      country: s.country || null,
      cups: s.cups || 0,
    }));

    res.json(out);
  } catch (err) {
    console.error("GET /api/friends/suggestions error", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
