const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const { tryRequire } = (function () {
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
  return { tryRequire };
})();

const User = tryRequire([
  "../models/User",
  "../../models/User",
  "../src/models/User",
  "../../src/models/User",
]);

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

const Invite = tryRequire([
  "../models/Invite",
  "../../models/Invite",
  "../src/models/Invite",
  "../../src/models/Invite",
]);

// Notification model + service (best-effort)
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

/**
 * notifyUser(userId, event, payload)
 * Best-effort: try a few strategies to deliver a real-time socket notification
 */
function notifyUser(userId, event, payload) {
  try {
    if (!userId) return;

    // 1) If roomManager exposes a notifyUser helper, use it
    if (roomManager && typeof roomManager.notifyUser === "function") {
      try {
        roomManager.notifyUser(String(userId), event, payload);
        return;
      } catch (e) {
        // continue to other strategies
      }
    }

    // 2) If roomManager has io and onlineUsers, try to notify sockets directly
    if (
      roomManager &&
      roomManager.io &&
      typeof roomManager.io.to === "function"
    ) {
      try {
        const sockets = roomManager.getSocketsForUserId
          ? roomManager.getSocketsForUserId(String(userId))
          : null;

        if (sockets && Array.isArray(sockets) && sockets.length > 0) {
          for (const sid of sockets) {
            try {
              roomManager.io.to(sid).emit(event, payload);
            } catch (e) {}
          }
          return;
        }

        // Fallback: try to emit to a `user:<id>` room if your io uses that pattern
        try {
          roomManager.io.to(`user:${String(userId)}`).emit(event, payload);
          return;
        } catch (e) {}
      } catch (e) {
        // continue
      }
    }

    // 3) Try to require the roomManager fresh (in case earlier tryRequire failed)
    try {
      const rm = require("../roomManager");
      if (rm && typeof rm.notifyUser === "function") {
        try {
          rm.notifyUser(String(userId), event, payload);
          return;
        } catch (e) {}
      }
      if (rm && rm.io && typeof rm.io.to === "function") {
        const sockets = rm.getSocketsForUserId
          ? rm.getSocketsForUserId(String(userId))
          : null;
        if (sockets && Array.isArray(sockets) && sockets.length > 0) {
          for (const sid of sockets) {
            try {
              rm.io.to(sid).emit(event, payload);
            } catch (e) {}
          }
          return;
        }
      }
    } catch (e) {
      // nothing else to do
    }
  } catch (err) {
    console.error("notifyUser (invites) error (non-fatal)", err);
  }
}

/* --------------------------- auto-expiry (unchanged) --------------------------- */
const INVITE_EXPIRY_MS = 15_000; // 15 seconds server-side expiry
const expiryTimers = new Map(); // inviteId -> timeout

function clearScheduledExpiry(inviteId) {
  try {
    const t = expiryTimers.get(String(inviteId));
    if (t) {
      clearTimeout(t);
      expiryTimers.delete(String(inviteId));
    }
  } catch (e) {}
}

async function _markAndEmitNotificationsByInviteId(inviteId, status) {
  if (!inviteId) return;
  try {
    if (!Notification) return;
    const docs = await Notification.find({
      "data.inviteId": String(inviteId),
    }).exec();
    for (const d of docs) {
      try {
        d.read = true;
        d.status = status || "handled";
        d.updatedAt = Date.now();
        await d.save().catch(() => {});
        // emit to recipient
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
        notifyUser(String(d.userId), "notification", payload);
      } catch (e) {}
    }
  } catch (e) {
    console.error("_markAndEmitNotificationsByInviteId error (non-fatal)", e);
  }
}

async function expireInviteById(inviteId) {
  try {
    const inv = await Invite.findById(inviteId);
    if (!inv) return;
    if (inv.status !== "pending") return;
    inv.status = "declined";
    inv.declinedAt = Date.now();
    await inv.save();

    notifyUser(inv.fromUserId, "invite-updated", {
      inviteId: inv._id?.toString(),
      status: "declined",
      autoExpired: true,
    });

    notifyUser(inv.toUserId, "invite-updated", {
      inviteId: inv._id?.toString(),
      status: "declined",
      autoExpired: true,
    });

    // Mark related Notification docs as handled/declined
    try {
      await _markAndEmitNotificationsByInviteId(inv._id, "declined");
    } catch (e) {}

    clearScheduledExpiry(inviteId);
  } catch (err) {
    console.error("expireInviteById error", err);
  }
}

function scheduleExpiryForInvite(inv) {
  try {
    const id = String(
      inv._id?.toString ? inv._id.toString() : inv.id || inv.inviteId
    );
    if (!id) return;
    clearScheduledExpiry(id);

    const createdAt = Number(inv.createdAt) || Date.now();
    const expiryAt = createdAt + INVITE_EXPIRY_MS;
    const delay = Math.max(0, expiryAt - Date.now());
    const t = setTimeout(() => expireInviteById(id), delay);
    expiryTimers.set(id, t);
  } catch (e) {
    console.error("scheduleExpiryForInvite error", e);
  }
}

(async function initInviteExpiryScheduling() {
  try {
    if (mongoose && mongoose.connection && mongoose.connection.readyState) {
      const pending = await Invite.find({ status: "pending" }).lean();
      for (const inv of pending) {
        const createdAt = Number(inv.createdAt || Date.now());
        const age = Date.now() - createdAt;
        if (age >= INVITE_EXPIRY_MS) {
          try {
            await Invite.findByIdAndUpdate(inv._id, {
              status: "declined",
              declinedAt: Date.now(),
            });
            notifyUser(inv.fromUserId, "invite-updated", {
              inviteId: inv._id?.toString(),
              status: "declined",
              autoExpired: true,
            });
            notifyUser(inv.toUserId, "invite-updated", {
              inviteId: inv._id?.toString(),
              status: "declined",
              autoExpired: true,
            });
            // Mark related Notification docs as handled/declined
            try {
              await _markAndEmitNotificationsByInviteId(inv._id, "declined");
            } catch (e) {}
          } catch (e) {}
        } else {
          scheduleExpiryForInvite(inv);
        }
      }
    }
  } catch (e) {
    console.error("initInviteExpiryScheduling error (non-fatal)", e);
  }
})();
/* --------------------------- end auto-expiry --------------------------- */

/**
 * POST /api/invites
 * body: { toUserId, minutes, colorPreference }
 * Create/persist an invite and notify recipient.
 */
router.post("/", restAuthMiddleware, async (req, res) => {
  try {
    const meId = req.user && req.user.id;
    const meUsername = req.user && req.user.username;
    if (!meId) return res.status(401).json({ error: "Missing auth" });

    const toUserId = req.body && req.body.toUserId;
    const minutes = Number(req.body?.minutes || 5);
    const colorPreference = req.body?.colorPreference || "random";

    if (!toUserId) return res.status(400).json({ error: "Missing toUserId" });
    if (String(toUserId) === String(meId))
      return res.status(400).json({ error: "Cannot invite yourself" });

    const target = await User.findById(toUserId).lean();
    if (!target)
      return res.status(404).json({ error: "Target user not found" });

    const existing = await Invite.findOne({
      fromUserId: String(meId),
      toUserId: String(toUserId),
      status: "pending",
    }).lean();
    if (existing) {
      return res.status(400).json({ error: "Invite already pending" });
    }

    const newInv = new Invite({
      fromUserId: String(meId),
      fromUsername: meUsername,
      toUserId: String(toUserId),
      toUsername: target.username,
      minutes: Math.max(1, Math.floor(minutes)),
      colorPreference,
      status: "pending",
    });
    await newInv.save();

    // Schedule expiry server-side
    try {
      scheduleExpiryForInvite(newInv);
    } catch (e) {
      console.error("scheduleExpiryForInvite failed (non-fatal)", e);
    }

    // Notify recipient (socket)
    try {
      notifyUser(String(toUserId), "invite-received", {
        inviteId: newInv._id?.toString(),
        from: {
          id: meId,
          username: meUsername,
          displayName: req.user.displayName || null,
        },
        minutes: newInv.minutes,
        colorPreference: newInv.colorPreference,
        createdAt: newInv.createdAt,
      });
    } catch (e) {
      console.error("invite notify error (non-fatal)", e);
    }

    // Persist a Notification doc so notification UI has authoritative row (best-effort)
    try {
      if (notificationService) {
        await notificationService.createNotification(
          String(toUserId),
          "invite",
          "Game invite",
          `${meUsername || "A player"} invited you to a game.`,
          { inviteId: newInv._id?.toString(), minutes: newInv.minutes }
        );
      } else if (Notification) {
        const doc = new Notification({
          userId: String(toUserId),
          type: "invite",
          title: "Game invite",
          body: `${meUsername || "A player"} invited you to a game.`,
          data: { inviteId: newInv._id?.toString(), minutes: newInv.minutes },
          fromUserId: String(meId),
          read: false,
          createdAt: Date.now(),
        });
        await doc.save().catch(() => {});
        try {
          notifyUser(String(toUserId), "notification", {
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
      console.error("persist invite notification (non-fatal)", e);
    }

    res.json({ ok: true, inviteId: newInv._id?.toString() });
  } catch (err) {
    console.error("POST /api/invites error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/invites
 * Returns pending invites for current user (incoming).
 * Optionally ?direction=incoming|outgoing
 */
router.get("/", restAuthMiddleware, async (req, res) => {
  try {
    const meId = req.user && req.user.id;
    if (!meId) return res.status(401).json({ error: "Missing auth" });

    const direction = req.query.direction || "incoming";
    if (direction === "incoming") {
      const rows = await Invite.find({
        toUserId: String(meId),
        status: "pending",
      })
        .sort({ createdAt: -1 })
        .lean();

      const out = rows.map((r) => ({
        id: r._id?.toString(),
        fromUserId: r.fromUserId,
        fromUsername: r.fromUsername,
        minutes: r.minutes,
        colorPreference: r.colorPreference,
        createdAt: r.createdAt,
        status: r.status,
      }));
      return res.json(out);
    } else {
      // outgoing
      const rows = await Invite.find({ fromUserId: String(meId) })
        .sort({ createdAt: -1 })
        .lean();
      const out = rows.map((r) => ({
        id: r._id?.toString(),
        toUserId: r.toUserId,
        toUsername: r.toUsername,
        minutes: r.minutes,
        colorPreference: r.colorPreference,
        createdAt: r.createdAt,
        status: r.status,
      }));
      return res.json(out);
    }
  } catch (err) {
    console.error("GET /api/invites error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/invites/:id/accept
 * Accept an invite addressed to current user.
 */
router.post("/:id/accept", restAuthMiddleware, async (req, res) => {
  try {
    const meId = req.user && req.user.id;
    const meUsername = req.user && req.user.username;
    if (!meId) return res.status(401).json({ error: "Missing auth" });

    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Missing invite id" });

    const inv = await Invite.findById(id);
    if (!inv) return res.status(404).json({ error: "Invite not found" });
    if (String(inv.toUserId) !== String(meId))
      return res.status(403).json({ error: "Not authorized" });
    if (inv.status !== "pending")
      return res.status(400).json({ error: "Invite already responded" });

    // clear scheduled expiry
    try {
      clearScheduledExpiry(id);
    } catch (e) {}

    inv.status = "accepted";
    inv.acceptedAt = Date.now();

    let createdRoomId = null;

    // try to create a room using roomManager if available (best-effort)
    try {
      if (roomManager) {
        const createFn =
          roomManager.createRoom ||
          roomManager.createGameRoom ||
          roomManager.createChallengeRoom ||
          null;

        if (typeof createFn === "function") {
          try {
            const roomRes = await createFn({
              minutes: inv.minutes || 5,
              colorPreference: inv.colorPreference || "random",
              userA: { id: inv.fromUserId, username: inv.fromUsername },
              userB: { id: inv.toUserId, username: meUsername },
            });
            if (roomRes && (roomRes.roomId || roomRes.id)) {
              createdRoomId = roomRes.roomId || roomRes.id;
              inv.roomId = String(createdRoomId);
            }
          } catch (e) {
            console.error("roomManager.createRoom failed (non-fatal)", e);
          }
        }
      }
    } catch (e) {
      // ignore
    }

    await inv.save();

    // notify both parties
    notifyUser(inv.fromUserId, "invite-updated", {
      inviteId: inv._id?.toString(),
      status: "accepted",
      by: { id: meId, username: meUsername },
      roomId: createdRoomId || null,
    });

    notifyUser(inv.toUserId, "invite-updated", {
      inviteId: inv._id?.toString(),
      status: "accepted",
      roomId: createdRoomId || null,
    });

    // Persist notification for requester and mark any related Notification rows as handled
    try {
      if (notificationService) {
        await notificationService.createNotification(
          String(inv.fromUserId),
          "invite_accepted",
          "Invite accepted",
          `${meUsername || "A player"} accepted your invite.`,
          { inviteId: inv._id?.toString(), roomId: createdRoomId || null }
        );
      } else if (Notification) {
        const doc = new Notification({
          userId: String(inv.fromUserId),
          type: "invite_accepted",
          title: "Invite accepted",
          body: `${meUsername || "A player"} accepted your invite.`,
          data: {
            inviteId: inv._id?.toString(),
            roomId: createdRoomId || null,
          },
          fromUserId: String(meId),
          read: false,
          createdAt: Date.now(),
        });
        await doc.save().catch(() => {});
        try {
          notifyUser(String(inv.fromUserId), "notification", {
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
    } catch (e) {}

    // Mark & emit any Notification docs referencing this invite id
    try {
      await _markAndEmitNotificationsByInviteId(inv._id, "accepted");
    } catch (e) {}

    return res.json({
      ok: true,
      inviteId: inv._id?.toString(),
      roomId: createdRoomId || null,
    });
  } catch (err) {
    console.error("POST /api/invites/:id/accept error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/invites/:id/decline
 */
router.post("/:id/decline", restAuthMiddleware, async (req, res) => {
  try {
    const meId = req.user && req.user.id;
    const meUsername = req.user && req.user.username;
    if (!meId) return res.status(401).json({ error: "Missing auth" });

    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Missing invite id" });

    const inv = await Invite.findById(id);
    if (!inv) return res.status(404).json({ error: "Invite not found" });
    if (String(inv.toUserId) !== String(meId))
      return res.status(403).json({ error: "Not authorized" });
    if (inv.status !== "pending")
      return res.status(400).json({ error: "Invite already responded" });

    // clear scheduled expiry
    try {
      clearScheduledExpiry(id);
    } catch (e) {}

    inv.status = "declined";
    inv.declinedAt = Date.now();
    await inv.save();

    notifyUser(inv.fromUserId, "invite-updated", {
      inviteId: inv._id?.toString(),
      status: "declined",
      by: { id: meId, username: meUsername },
    });

    notifyUser(inv.toUserId, "invite-updated", {
      inviteId: inv._id?.toString(),
      status: "declined",
    });

    // Persist notification for requester (optional)
    try {
      if (notificationService) {
        await notificationService.createNotification(
          String(inv.fromUserId),
          "invite_declined",
          "Invite declined",
          `${meUsername || "A player"} declined your invite.`,
          { inviteId: inv._id?.toString() }
        );
      } else if (Notification) {
        const doc = new Notification({
          userId: String(inv.fromUserId),
          type: "invite_declined",
          title: "Invite declined",
          body: `${meUsername || "A player"} declined your invite.`,
          data: { inviteId: inv._id?.toString() },
          fromUserId: String(meId),
          read: false,
          createdAt: Date.now(),
        });
        await doc.save().catch(() => {});
        try {
          notifyUser(String(inv.fromUserId), "notification", {
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
    } catch (e) {}

    // Mark & emit any Notification docs referencing this invite id
    try {
      await _markAndEmitNotificationsByInviteId(inv._id, "declined");
    } catch (e) {}

    return res.json({ ok: true, inviteId: inv._id?.toString() });
  } catch (err) {
    console.error("POST /api/invites/:id/decline error", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
