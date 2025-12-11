// backend/socket.js
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { Chess } = require("chess.js");

const roomManager = require("./roomManager");

const {
  rooms,
  DEFAULT_MS,
  DISCONNECT_GRACE_MS,
  FIRST_MOVE_TIMEOUT_MS,
  MAX_CHAT_MESSAGES,
  broadcastRoomState,
  clearDisconnectTimer,
  clearFirstMoveTimer,
  saveFinishedGame,
  scheduleFirstMoveTimer,
  addOnlineSocketForUser,
  removeOnlineSocketForUser,
  getSocketsForUserId,
  pendingChallenges,
  onlineUsers,
  generateRoomCode,
  assignColorsForRematch,
} = roomManager;

const User = require("./models/User");
const Game = require("./models/Game");
const Room = require("./models/Room");

const notificationService = require("./services/notificationService");
const Notification = require("./models/Notification");

const mongoose = require("mongoose");

// optional rating utils
let ratingUtils = null;
try {
  ratingUtils = require("./ratingUtils");
} catch (e) {
  ratingUtils = null;
}

/* Modules (split files) */
const helpers = require("./socket/helpers"); // helper functions (markUserActiveRoom, ensureAvatarAbs, etc)
const reservations = require("./socket/reservations"); // tryReserveActiveRoom, releaseActiveRoom
const matchmaking = require("./socket/matchmaking"); // playQueue & attemptMatchmaking, addToPlayQueue, removeFromPlayQueue...
const applyCupsModule = require("./socket/applyCups"); // applyCupsForFinishedRoom

// your handler files (must export registerAll(socket, context))
const gameHandlers = require("./socket/handlers/gameHandlers");
const matchHandlers = require("./socket/handlers/matchHandlers");
const friendHandlers = require("./socket/handlers/friendHandlers");
const webrtcHandlers = require("./socket/handlers/webrtcHandlers");
// NEW: invite handler
const inviteHandlers = require("./socket/handlers/inviteHandlers");

/* === Extract helpers / functions so they're available by name in context === */
const {
  markUserActiveRoom,
  clearActiveRoomForUsers,
  clearActiveRoomForRoom,
  computeBaseUrl,
  normId,
  verifyToken,
  ensureAvatarAbs,
  mapPlayerForEmit,
  normalizeAndValidateRoomCode,
  normalizePromotionChar,
} = helpers || {};

const { tryReserveActiveRoom, releaseActiveRoom } = reservations || {};

const {
  addToPlayQueue,
  removeFromPlayQueueBySocket,
  attemptMatchmaking: matchmakingAttemptFromModule,
} = matchmaking || {};

// fallback if module exported function under different name
const attemptMatchmaking =
  matchmakingAttemptFromModule || matchmaking.attemptMatchmaking;

const { applyCupsForFinishedRoom } = applyCupsModule || {};

/* ------------------------------------------------------------------ */
/* Exported initSockets                                                */
/* ------------------------------------------------------------------ */
function initSockets(server, CLIENT_ORIGIN = "https://chess-alyas.vercel.app") {
  // allow either a string or an array of origins
  const corsOrigin = CLIENT_ORIGIN;

  const io = new Server(server, {
    cors: { origin: corsOrigin, credentials: true },
  });

  // log for visibility
  try {
    if (Array.isArray(corsOrigin)) {
      console.log("Socket.IO allowed origins:", corsOrigin.join(", "));
    } else {
      console.log("Socket.IO allowed origin:", corsOrigin);
    }
  } catch (e) {}

  // initialize roomManager with io
  roomManager.init(io);

  // context object passed to modules/handlers so they have access to constants and DB models
  const context = {
    io,
    rooms,
    DEFAULT_MS,
    DISCONNECT_GRACE_MS,
    FIRST_MOVE_TIMEOUT_MS,
    MAX_CHAT_MESSAGES,
    broadcastRoomState,
    clearDisconnectTimer,
    clearFirstMoveTimer,
    saveFinishedGame,
    scheduleFirstMoveTimer,
    addOnlineSocketForUser,
    removeOnlineSocketForUser,
    getSocketsForUserId,
    pendingChallenges,
    onlineUsers,
    generateRoomCode,
    assignColorsForRematch,
    roomManager,
    User,
    Game,
    Room,
    notificationService,
    Notification,
    mongoose,
    jwt,
    Chess,
    ratingUtils,
    helpers,
    reservations,
    matchmaking,
    applyCupsModule,
    // Explicit functions exported into context so handlers don't hit ReferenceError:
    markUserActiveRoom,
    clearActiveRoomForUsers,
    clearActiveRoomForRoom,
    computeBaseUrl,
    normId,
    verifyToken,
    ensureAvatarAbs,
    mapPlayerForEmit,
    normalizeAndValidateRoomCode,
    normalizePromotionChar,
    tryReserveActiveRoom,
    releaseActiveRoom,
    addToPlayQueue,
    removeFromPlayQueueBySocket,
    attemptMatchmaking,
    applyCupsForFinishedRoom,
  };

  // --- reliable wrapper so handlers can call a single consistent API ----
  // Use context.applyCupsForFinishedRoom(roomId)
  context.applyCupsForFinishedRoom = async (roomId) => {
    if (!roomId) {
      // If caller failed to provide roomId, still call module which will attempt fallback.
      // Log a warning for visibility.
      console.warn(
        "[applyCups] wrapper called without roomId — attempting fallback"
      );
    }
    try {
      // Prefer module export that accepts (context, roomId)
      if (
        applyCupsModule &&
        typeof applyCupsModule.applyCupsForFinishedRoom === "function"
      ) {
        try {
          return await applyCupsModule.applyCupsForFinishedRoom(
            context,
            roomId
          );
        } catch (err) {
          // fallback to single-arg pattern
          try {
            return await applyCupsModule.applyCupsForFinishedRoom(roomId);
          } catch (err2) {
            console.error(
              "[applyCups] module.applyCupsForFinishedRoom failed (both):",
              err2
            );
          }
        }
      }

      // If module exported directly as function
      if (typeof applyCupsForFinishedRoom === "function") {
        try {
          return await applyCupsForFinishedRoom(context, roomId);
        } catch (err) {
          try {
            return await applyCupsForFinishedRoom(roomId);
          } catch (err2) {
            console.error(
              "[applyCups] applyCupsForFinishedRoom failed (both):",
              err2
            );
          }
        }
      }

      console.warn("[applyCups] no apply function available to call");
    } catch (err) {
      console.error("[applyCups] wrapper error:", err);
    }
  };
  // ---------------------------------------------------------------------

  // start matchmaking interval (robust to different export names)
  const MATCHMAKING_INTERVAL_MS = 1000;
  const matchmakingTimer = setInterval(() => {
    try {
      if (typeof attemptMatchmaking === "function") {
        // try calling with context first (some implementations expect context)
        try {
          attemptMatchmaking(context);
        } catch (err) {
          // fallback to no-arg
          try {
            attemptMatchmaking();
          } catch (err2) {
            console.error(
              "matchmaking attempt failed (both signatures):",
              err2
            );
          }
        }
      } else if (
        matchmaking &&
        typeof matchmaking.attemptMatchmaking === "function"
      ) {
        try {
          matchmaking.attemptMatchmaking(context);
        } catch (err) {
          try {
            matchmaking.attemptMatchmaking();
          } catch (err2) {
            console.error(
              "matchmaking.attemptMatchmaking failed (both):",
              err2
            );
          }
        }
      }
    } catch (e) {}
  }, MATCHMAKING_INTERVAL_MS);

  // global tick for clocks (kept same logic)
  let lastGlobalTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const delta = now - lastGlobalTick;
    lastGlobalTick = now;

    Object.keys(rooms).forEach((roomId) => {
      const room = rooms[roomId];
      if (!room) return;

      if (room.finished) {
        if (room.clocks) {
          room.clocks.running = null;
          room.clocks.lastTick = null;
        }
        return;
      }

      if (!room.clocks || !room.clocks.running || room.paused) return;

      const running = room.clocks.running;
      room.clocks[running] = Math.max(0, room.clocks[running] - delta);
      room.clocks.lastTick = now;

      io.to(roomId).emit("clock-update", {
        w: room.clocks.w,
        b: room.clocks.b,
        running: room.clocks.running,
      });

      if (room.clocks[running] <= 0 && !room.finished) {
        const winner = running === "w" ? "b" : "w";
        room.paused = true;
        room.clocks.running = null;
        room.clocks.lastTick = null;
        room.finished = {
          reason: "timeout",
          winner,
          loser: running,
          message: `${winner.toUpperCase()} wins by timeout`,
          finishedAt: Date.now(),
        };
        io.to(roomId).emit("game-over", { ...room.finished });
        clearFirstMoveTimer(room);
        Object.keys(room.disconnectTimers || {}).forEach((sid) =>
          clearDisconnectTimer(room, sid)
        );
        broadcastRoomState(roomId);

        // save finished game and then apply cups
        (async () => {
          try {
            await saveFinishedGame(roomId);
          } catch (err) {
            console.error("saveFinishedGame error (timeout):", err);
          }
          try {
            // Use the consistent wrapper that will handle either signature and fallbacks.
            await context.applyCupsForFinishedRoom(roomId);
          } catch (e) {
            console.error("applyCupsForFinishedRoom error (timeout):", e);
          }
        })();
      }
    });
  }, 500);

  // helper: emit presence-changed to all clients (safe, client expects this)
  function emitPresenceChanged(userId) {
    try {
      if (!userId) return;
      const sockets = getSocketsForUserId ? getSocketsForUserId(userId) : null;
      const online = sockets && Array.isArray(sockets) && sockets.length > 0;
      io.emit("presence-changed", { userId, online, sockets });
    } catch (e) {
      console.warn("emitPresenceChanged error:", e);
    }
  }

  // auth middleware (kept original logic) — uses helpers.verifyToken & addOnlineSocketForUser
  io.use(async (socket, next) => {
    let token = socket.handshake?.auth?.token || null;

    if (!token) {
      const cookieHeader = socket.handshake?.headers?.cookie || null;
      if (cookieHeader) {
        const parts = cookieHeader.split(";");
        for (const p of parts) {
          const kv = p.split("=").map((s) => s.trim());
          if (kv[0] === "token") {
            token = decodeURIComponent(kv[1] || "");
            break;
          }
        }
      }
    }

    if (!token) {
      return next();
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const userDoc = await User.findById(decoded.id)
        .select("_id username displayName avatarUrl country cups")
        .lean();

      if (userDoc) {
        const base = computeBaseUrl();
        const avatarRel = userDoc.avatarUrl || null;
        const avatarAbs =
          avatarRel && String(avatarRel).startsWith("http")
            ? avatarRel
            : avatarRel
            ? `${base}${avatarRel}`
            : null;

        socket.user = {
          id: normId(userDoc._id),
          username: userDoc.username,
          displayName: userDoc.displayName || null,
          avatarUrl: userDoc.avatarUrl || null,
          avatarUrlAbsolute: avatarAbs,
          country: userDoc.country || null,
          cups:
            typeof userDoc.cups !== "undefined" ? Number(userDoc.cups) : null,
        };

        // track online socket for this user
        try {
          addOnlineSocketForUser(
            socket.user.id,
            socket.id,
            socket.user.username
          );
          // immediately let everyone know this user is online
          emitPresenceChanged(socket.user.id);
        } catch (e) {
          console.warn("addOnlineSocketForUser (middleware) failed:", e);
        }
      } else {
        socket.user = {
          id: normId(decoded.id),
          username: decoded.username || "unknown",
        };
        try {
          addOnlineSocketForUser(
            socket.user.id,
            socket.id,
            socket.user.username
          );
          emitPresenceChanged(socket.user.id);
        } catch (e) {
          console.warn(
            "addOnlineSocketForUser (middleware anonymous) failed:",
            e
          );
        }
      }
    } catch (err) {
      console.warn("Socket auth parse failed:", err?.message || err);
    }

    next();
  });

  io.on("connection", (socket) => {
    console.log("socket connected", socket.id);

    // attach token-decoded user if present (keeps original behavior)
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const decodedUser = verifyToken(token);
    if (decodedUser) {
      socket.user = socket.user || {
        id: normId(decodedUser.id),
        username: decodedUser.username,
      };
      try {
        addOnlineSocketForUser(socket.user.id, socket.id, socket.user.username);
        emitPresenceChanged(socket.user.id);
      } catch (e) {
        console.warn("addOnlineSocketForUser (connection) failed:", e);
      }
    } else {
      socket.user = socket.user || null;
    }

    try {
      if (socket.user && socket.user.id) {
        socket.join(`user:${socket.user.id}`);
      }
    } catch (e) {}

    // Register all handlers (each handler file must export registerAll)
    try {
      if (gameHandlers && typeof gameHandlers.registerAll === "function")
        gameHandlers.registerAll(socket, context);
      if (matchHandlers && typeof matchHandlers.registerAll === "function")
        matchHandlers.registerAll(socket, context);
      if (friendHandlers && typeof friendHandlers.registerAll === "function")
        friendHandlers.registerAll(socket, context);
      if (webrtcHandlers && typeof webrtcHandlers.registerAll === "function")
        webrtcHandlers.registerAll(socket, context);
      if (inviteHandlers && typeof inviteHandlers.registerAll === "function")
        inviteHandlers.registerAll(socket, context);
    } catch (e) {
      console.error("Error registering socket handlers:", e);
    }

    // --- Presence & disconnect helpers for this socket ---
    // client fires this when page is unloading; best-effort to remove socket immediately
    socket.on("client-unload", (payload) => {
      try {
        if (socket.user && socket.user.id) {
          removeOnlineSocketForUser(socket.user.id, socket.id);
          emitPresenceChanged(socket.user.id);
        }
      } catch (e) {
        console.warn("client-unload handler failed:", e);
      }
    });

    // explicit logout from client (e.g. logout button)
    socket.on("client-logout", (payload) => {
      try {
        if (socket.user && socket.user.id) {
          removeOnlineSocketForUser(socket.user.id, socket.id);
          emitPresenceChanged(socket.user.id);
        }
        // optionally leave rooms, etc.
        try {
          socket.leaveAll && socket.leaveAll();
        } catch (e) {}
      } catch (e) {
        console.warn("client-logout handler failed:", e);
      }
    });

    // lightweight heartbeat: server may update last-seen or consider socket healthy
    socket.on("presence-heartbeat", (payload) => {
      try {
        // payload may be used to update lastSeen somewhere in roomManager if implemented
        if (
          socket.user &&
          socket.user.id &&
          typeof roomManager.markSocketHeartbeat === "function"
        ) {
          try {
            roomManager.markSocketHeartbeat(
              socket.user.id,
              socket.id,
              Date.now()
            );
          } catch (e) {}
        }
        // for visibility, emit presence-changed for this user (sender)
        if (socket.user && socket.user.id) {
          emitPresenceChanged(socket.user.id);
        }
      } catch (e) {}
    });

    // when socket is in the process of disconnecting
    socket.on("disconnecting", (reason) => {
      try {
        if (socket.user && socket.user.id) {
          // remove this socket from online tracking immediately
          removeOnlineSocketForUser(socket.user.id, socket.id);
          // broadcast so clients update quickly
          emitPresenceChanged(socket.user.id);
        }
      } catch (e) {
        console.warn("disconnecting handler failed:", e);
      }
    });

    // final disconnect event
    socket.on("disconnect", (reason) => {
      console.log(`socket ${socket.id} disconnected:`, reason);
      try {
        if (socket.user && socket.user.id) {
          // ensure removal (idempotent)
          try {
            removeOnlineSocketForUser(socket.user.id, socket.id);
          } catch (e) {}
          emitPresenceChanged(socket.user.id);
        }
      } catch (e) {
        console.warn("disconnect handler failed:", e);
      }
      // leave everything to other handlers to tidy up room state if needed
    });

    // (other logic, webrtc, etc. should live inside the registered handlers)
  });

  return io;
}

module.exports = { initSockets };
