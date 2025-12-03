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

// your four new handler files (must export registerAll(socket, context))
const gameHandlers = require("./socket/handlers/gameHandlers");
const matchHandlers = require("./socket/handlers/matchHandlers");
const friendHandlers = require("./socket/handlers/friendHandlers");
const webrtcHandlers = require("./socket/handlers/webrtcHandlers");

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
  const io = new Server(server, {
    cors: { origin: CLIENT_ORIGIN, credentials: true },
  });

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
            if (typeof applyCupsForFinishedRoom === "function") {
              // prefer applyCupsForFinishedRoom(context, roomId) if it expects context
              try {
                await applyCupsForFinishedRoom(context, roomId);
              } catch (e) {
                try {
                  await applyCupsForFinishedRoom(roomId);
                } catch (e2) {
                  console.error("applyCupsForFinishedRoom failed (both):", e2);
                }
              }
            } else if (
              applyCupsModule &&
              typeof applyCupsModule.applyCupsForFinishedRoom === "function"
            ) {
              try {
                await applyCupsModule.applyCupsForFinishedRoom(context, roomId);
              } catch (e) {
                try {
                  await applyCupsModule.applyCupsForFinishedRoom(roomId);
                } catch (e2) {
                  console.error(
                    "applyCupsModule.applyCupsForFinishedRoom failed (both):",
                    e2
                  );
                }
              }
            }
          } catch (e) {
            console.error("applyCupsForFinishedRoom error (timeout):", e);
          }
        })();
      }
    });
  }, 500);

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
        addOnlineSocketForUser(socket.user.id, socket.id, socket.user.username);
      } else {
        socket.user = {
          id: normId(decoded.id),
          username: decoded.username || "unknown",
        };
        addOnlineSocketForUser(socket.user.id, socket.id, socket.user.username);
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
      addOnlineSocketForUser(socket.user.id, socket.id, socket.user.username);
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
    } catch (e) {
      console.error("Error registering socket handlers:", e);
    }

    // (disconnect logic, webrtc, etc. should live inside the registered handlers)
  });

  return io;
}

module.exports = { initSockets };
