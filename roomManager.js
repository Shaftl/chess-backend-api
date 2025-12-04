// roomManager.js (final, fixed - with finishRoom centralization)
// - robust activeRoom clearing
// - room expiration for abandoned rooms
// - createRematchFrom to create a new room for play-again/rematch (avoids reusing old id)
// - NEW: finishRoom(roomId, finishedObj) centralizes finalization and calls saveFinishedGame

const { Chess } = require("chess.js");
const Game = require("./models/Game");
const User = require("./models/User");
const RoomModel = require("./models/Room");
const {
  runStockfishAnalysis,
  computeDeltaForWinner,
} = require("./ratingUtils");

const DEFAULT_MS = 5 * 60 * 1000;
const DISCONNECT_GRACE_MS = 10 * 1000;
const FIRST_MOVE_TIMEOUT_MS = 30 * 1000;
const MAX_CHAT_MESSAGES = 500;

const rooms = {};
let io = null;

// expiration timers for rooms (cleanup when room doesn't start or is abandoned)
const roomExpirationTimers = {}; // roomId -> Timeout

function init(_io) {
  io = _io;
}

function generateRoomCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * assignColorsForRematch(room)
 * Keeps compatibility but doesn't change global behavior that depends on it.
 */
function assignColorsForRematch(room) {
  if (!room || !room.players) return;
  const hadW = room.players.find((p) => p.color === "w");
  const hadB = room.players.find((p) => p.color === "b");
  if (hadW && hadB) {
    room.players.forEach((p) => {
      if (p.color !== "w" && p.color !== "b") p.color = "spectator";
    });
    return;
  }
  for (const p of room.players) p.color = "spectator";
  if (room.players.length >= 1) room.players[0].color = "w";
  if (room.players.length >= 2) room.players[1].color = "b";
}

function clearDisconnectTimer(room, socketId) {
  if (!room || !room.disconnectTimers) return;
  const t = room.disconnectTimers[socketId];
  if (t) {
    clearTimeout(t);
    delete room.disconnectTimers[socketId];
  }
}

function clearFirstMoveTimer(room) {
  if (!room) return;
  if (room.firstMoveTimer) {
    clearTimeout(room.firstMoveTimer);
    room.firstMoveTimer = null;
  }
}

/**
 * _clearActiveRoomSafety(roomId, participantIds)
 * Best-effort clearing:
 * - clears the DB activeRoom/status for provided participants
 * - then clears any DB user whose activeRoom still equals this roomId
 */
async function _clearActiveRoomSafety(roomId, participantIds = []) {
  try {
    const ids = Array.isArray(participantIds)
      ? participantIds.filter(Boolean).map(String)
      : [];

    if (ids.length > 0) {
      await User.updateMany(
        { _id: { $in: ids } },
        { $set: { activeRoom: null, status: "idle" } }
      ).exec();
    }

    // safety net: clear any user still referencing this roomId
    await User.updateMany(
      { activeRoom: String(roomId) },
      { $set: { activeRoom: null, status: "idle" } }
    ).exec();
  } catch (e) {
    console.error("_clearActiveRoomSafety error:", e);
  }
}

/**
 * finishRoom(roomId, finishedObj)
 * Centralized end-of-game handler:
 * - idempotent (won't run twice)
 * - sets room.finished, emits game-over, persists snapshot via broadcastRoomState
 * - clears activeRoom on participants and calls saveFinishedGame to persist game + update cups
 */
async function finishRoom(roomId, finishedObj) {
  try {
    const room = rooms[roomId];
    if (!room) {
      // if no in-memory room exist, still attempt to persist finished to DB with RoomModel
      // but since saveFinishedGame relies on in-memory room shape, we bail here.
      return;
    }

    // Avoid double-finalization
    if (room.finished && room.finished._finalized) return;
    // stamp finished (keep given fields and add finishedAt)
    room.finished = {
      ...(finishedObj || {}),
      finishedAt:
        finishedObj && finishedObj.finishedAt
          ? finishedObj.finishedAt
          : Date.now(),
    };
    // mark finalized to prevent double-run
    room.finished._finalized = true;
    room.paused = true;

    // Emit game-over to clients
    try {
      io.to(roomId).emit("game-over", { ...room.finished });
    } catch (e) {}

    // Broadcast updated room state (room-update contains finished)
    broadcastRoomState(roomId);

    // Clear timers
    try {
      clearFirstMoveTimer(room);
      clearRoomExpiration(roomId);
    } catch (e) {}

    // Clear activeRoom entries for players (best-effort)
    try {
      const participantIds = (room.players || [])
        .map((p) => {
          if (!p) return null;
          const uid =
            (p.user && (p.user.id || p.user._id)) ||
            p.id ||
            (p.user && p.user._id) ||
            null;
          return uid ? String(uid) : null;
        })
        .filter(Boolean);

      if (participantIds.length > 0) {
        await User.updateMany(
          { _id: { $in: participantIds } },
          { $set: { activeRoom: null, status: "idle" } }
        ).exec();
      }

      // Safety: also clear any user still referencing this roomId as activeRoom
      await User.updateMany(
        { activeRoom: String(roomId) },
        { $set: { activeRoom: null, status: "idle" } }
      ).exec();
    } catch (e) {
      console.error("finishRoom: clearing activeRoom failed", e);
    }

    // Persist finished game and run cups/rating update
    try {
      await saveFinishedGame(roomId);
    } catch (e) {
      console.error("finishRoom: saveFinishedGame error", e);
    }
  } catch (err) {
    console.error("finishRoom error:", err);
  }
}

/**
 * saveFinishedGame(roomId)
 * Persist finished game and do rating updates, then clear DB activeRoom for participants.
 *
 * NOTE: This function has been hardened to correctly resolve winner/loser users
 * and to handle cups === 0 (nullish coalescing).
 */
async function saveFinishedGame(roomId) {
  try {
    const room = rooms[roomId];
    if (!room || !room.finished) return;
    const savedId = `${roomId}-${Date.now()}`;

    const doc = new Game({
      roomId: savedId,
      fen: room.fen || (room.chess ? room.chess.fen() : null),
      moves: room.moves || [],
      players: (room.players || []).map((p) => ({
        id: p.user?.id || p.id,
        user: p.user || { username: p.user?.username || "guest" },
        color: p.color,
        online: !!p.online,
      })),
      clocks: room.clocks
        ? { w: room.clocks.w, b: room.clocks.b, running: room.clocks.running }
        : null,
      messages: room.messages || [],
      createdAt: room.finished.finishedAt
        ? new Date(room.finished.finishedAt)
        : new Date(),
    });
    await doc.save();
    console.log("Saved finished game to Mongo:", savedId);
  } catch (err) {
    console.error("Error saving finished game:", err);
  }

  // Cups / rating update (best-effort)
  try {
    const room = rooms[roomId];
    if (!room || !room.finished) return;
    const finished = room.finished || {};

    // helper: detect objectid-like string
    const looksLikeObjectId = (v) =>
      !!(v && typeof v === "string" && /^[a-fA-F0-9]{24}$/.test(v));

    // More robust player -> user id resolution
    function playerUserId(p) {
      if (!p) return null;
      // prefer nested user id / _id
      if (p.user) {
        if (p.user.id) return String(p.user.id);
        if (p.user._id) return String(p.user._id);
      }
      // fallback to top-level id if it's an ObjectId-like string
      if (p.id && typeof p.id === "string" && looksLikeObjectId(p.id))
        return String(p.id);
      // otherwise no reliable DB id
      return null;
    }

    let winnerId = null;
    let loserId = null;

    if (finished.winnerId) winnerId = String(finished.winnerId);
    if (finished.loserId) loserId = String(finished.loserId);

    if (!winnerId && finished.winnerColor) {
      const p = (room.players || []).find(
        (x) => String(x.color) === String(finished.winnerColor)
      );
      winnerId = playerUserId(p);
    }
    if (!winnerId && finished.winner) {
      const w = String(finished.winner).toLowerCase();
      if (w === "w" || w === "b") {
        const p = (room.players || []).find((x) => x.color === w);
        winnerId = playerUserId(p);
      } else {
        // finished.winner may be a username; attempt to find player by username
        const p = (room.players || []).find((pp) => {
          const uname =
            (pp.user && (pp.user.username || pp.user.displayName)) ||
            pp.username;
          return (
            uname &&
            String(uname).toLowerCase() ===
              String(finished.winner).toLowerCase()
          );
        });
        if (p)
          winnerId =
            playerUserId(p) || (p.user && (p.user.id || p.user._id)) || null;
      }
    }

    if (!winnerId && finished.result) {
      const rs = String(finished.result).toLowerCase();
      if (
        rs === "draw" ||
        rs === "tie" ||
        rs === "stalemate" ||
        rs.includes("draw")
      ) {
        // draw, skip rating changes
      }
      if (finished.loserId || finished.loser) {
        const lid = finished.loserId || finished.loser;
        const loserCandidate = (room.players || []).find((p) => {
          const uid =
            (p.user && (p.user.id || p.user._id)) ||
            p.id ||
            (p.user && p.user._id) ||
            null;
          const uname =
            (p.user && (p.user.username || p.user.displayName)) || p.username;
          return uid === String(lid) || String(uname) === String(lid);
        });
        if (loserCandidate) {
          loserId =
            (loserCandidate.user &&
              (loserCandidate.user.id || loserCandidate.user._id)) ||
            loserCandidate.id ||
            null;
          const winnerCandidate = (room.players || []).find((p) => {
            const uid = (p.user && (p.user.id || p.user._id)) || p.id || null;
            return uid && String(uid) !== String(loserId);
          });
          winnerId =
            (winnerCandidate &&
              ((winnerCandidate.user &&
                (winnerCandidate.user.id || winnerCandidate.user._id)) ||
                winnerCandidate.id)) ||
            null;
        }
      }
    }

    // At this point winnerId/loserId may be a DB _id-string or may be null.
    // Try to load the users robustly: if we have an ObjectId-like string, use findById,
    // otherwise try a username lookup (in case id was passed as username).
    let winnerUser = null;
    let loserUser = null;

    if (winnerId) {
      if (looksLikeObjectId(winnerId)) {
        winnerUser = await User.findById(String(winnerId))
          .select("cups")
          .exec();
      } else {
        // try lookup by username/displayName
        winnerUser = await User.findOne({
          $or: [{ username: winnerId }, { displayName: winnerId }],
        })
          .select("cups")
          .exec();
      }
    }

    if (loserId) {
      if (looksLikeObjectId(loserId)) {
        loserUser = await User.findById(String(loserId)).select("cups").exec();
      } else {
        loserUser = await User.findOne({
          $or: [{ username: loserId }, { displayName: loserId }],
        })
          .select("cups")
          .exec();
      }
    }

    // As a last-ditch: if winnerUser/loserUser still null, try to derive them from room.players by matching username
    if (!winnerUser) {
      const p = (room.players || []).find((pp) => {
        const uname =
          (pp.user && (pp.user.username || pp.user.displayName)) || pp.username;
        return (
          uname &&
          String(uname).toLowerCase() ===
            String(finished.winner || "").toLowerCase()
        );
      });
      if (p && p.user && (p.user.id || p.user._id)) {
        try {
          winnerUser = await User.findById(String(p.user.id || p.user._id))
            .select("cups")
            .exec();
        } catch (e) {}
      }
    }

    if (!loserUser) {
      const p = (room.players || []).find((pp) => {
        const uname =
          (pp.user && (pp.user.username || pp.user.displayName)) || pp.username;
        return (
          uname &&
          String(uname).toLowerCase() ===
            String(finished.loser || "").toLowerCase()
        );
      });
      if (p && p.user && (p.user.id || p.user._id)) {
        try {
          loserUser = await User.findById(String(p.user.id || p.user._id))
            .select("cups")
            .exec();
        } catch (e) {}
      }
    }

    // Use nullish coalescing so that cups === 0 is treated as a valid rating (not replaced by 1200)
    const winnerRating = Number(winnerUser?.cups ?? 1200);
    const loserRating = Number(loserUser?.cups ?? 1200);

    const movesRaw = Array.isArray(room.moves) ? room.moves : [];
    const toUci = (m) => {
      if (!m) return null;
      if (typeof m === "string") return m;
      if (m.move && typeof m.move === "string") return m.move;
      if (m.move && m.move.from && m.move.to)
        return `${m.move.from}${m.move.to}${m.move.promotion || ""}`;
      if (m.from && m.to) return `${m.from}${m.to}${m.promotion || ""}`;
      return null;
    };
    const movesUci = movesRaw.map(toUci).filter(Boolean);

    let analysis = null;
    try {
      analysis = await runStockfishAnalysis(
        movesUci,
        parseInt(process.env.STOCKFISH_DEPTH || "12", 10),
        parseInt(process.env.STOCKFISH_TIMEOUT || "4000", 10)
      );
    } catch (e) {
      analysis = null;
    }

    let winnerColor = null;
    const pWinner = (room.players || []).find((p) => {
      const uid =
        (p.user && (p.user.id || p.user._id)) ||
        p.id ||
        (p.user && p.user._id) ||
        null;
      return uid && String(uid) === String(winnerId);
    });
    if (pWinner && pWinner.color) winnerColor = String(pWinner.color);

    let winnerACPL = 200,
      loserACPL = 200,
      maxSwingCp = 0;
    if (analysis) {
      if (winnerColor === "w") {
        winnerACPL = analysis.acplWhite || 200;
        loserACPL = analysis.acplBlack || 200;
      } else {
        winnerACPL = analysis.acplBlack || 200;
        loserACPL = analysis.acplWhite || 200;
      }
      maxSwingCp = analysis.maxSwingCp || 0;
    }

    let delta = 10;
    try {
      if (analysis && winnerUser && loserUser) {
        delta = computeDeltaForWinner(
          winnerRating,
          loserRating,
          winnerACPL,
          loserACPL,
          maxSwingCp,
          /*gamesplayed*/ 50
        );
      } else if (winnerUser && loserUser) {
        const expected =
          1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
        const K = 20;
        delta = Math.max(1, Math.round(K * (1 - expected)));
        if (delta < 10) delta = 10;
      } else {
        delta = 10;
      }
    } catch (e) {
      delta = 10;
    }

    async function adjustUserCupsAndNotify(uid, newValue, deltaValue) {
      try {
        const u = await User.findById(String(uid)).exec();
        if (!u) return;
        u.cups = Number(newValue);
        await u.save();
        try {
          notifyUser(String(uid), "cups-changed", {
            cups: u.cups,
            delta: Number(deltaValue),
          });
        } catch (e) {}
      } catch (err) {
        console.error("adjustUserCupsAndNotify error for", uid, err);
      }
    }

    if (winnerUser && loserUser) {
      const newWinner = Math.max(
        0,
        Number(winnerUser.cups ?? 0) + Number(delta)
      );
      await adjustUserCupsAndNotify(winnerUser._id, newWinner, delta);

      const newLoser = Math.max(0, Number(loserUser.cups ?? 0) - Number(delta));
      await adjustUserCupsAndNotify(loserUser._id, newLoser, -delta);
    }

    // no further active-room clearing here; finishRoom already attempted it
  } catch (err) {
    console.error("cups update error after saving game:", err);
  }
}

/**
 * scheduleFirstMoveTimer(roomId)
 * If first move not made, mark game drawn after FIRST_MOVE_TIMEOUT_MS.
 * Now uses finishRoom(...) instead of directly setting room.finished.
 */
function scheduleFirstMoveTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.lastIndex !== -1 || room.finished) return;
  clearFirstMoveTimer(room);
  const turn = room.chess ? room.chess.turn() : null;
  if (!turn) return;
  room.firstMoveTimer = setTimeout(async () => {
    try {
      if (room.lastIndex === -1 && !room.paused && !room.finished) {
        await finishRoom(roomId, {
          reason: "first-move-timeout",
          result: "draw",
          message: `No first move within ${
            FIRST_MOVE_TIMEOUT_MS / 1000
          }s — game drawn`,
        });
      }
    } catch (e) {
      console.error("first-move timer finish error", e);
    } finally {
      if (room) room.firstMoveTimer = null;
    }
  }, FIRST_MOVE_TIMEOUT_MS);
}

/* --------------------
    Room expiration (when a room never properly starts / lacks two active players)
    -------------------- */

function clearRoomExpiration(roomId) {
  try {
    const t = roomExpirationTimers[roomId];
    if (t) {
      clearTimeout(t);
      delete roomExpirationTimers[roomId];
    }
  } catch (e) {}
}

function scheduleRoomExpiration(roomId) {
  try {
    clearRoomExpiration(roomId);
    const room = rooms[roomId];
    if (!room) return;
    // expire after the room's configured minutes (or default)
    const ms = (room.settings && room.settings.minutesMs) || DEFAULT_MS;
    roomExpirationTimers[roomId] = setTimeout(async () => {
      try {
        const r = rooms[roomId];
        if (!r) return;
        // Only mark abandoned if game hasn't started (lastIndex === -1) or not enough active players
        const coloredPlayers = (r.players || []).filter(
          (p) => p.color === "w" || p.color === "b"
        );
        const activeCount = coloredPlayers.filter((p) => !!p.online).length;

        if (!r.finished && (r.lastIndex === -1 || activeCount < 2)) {
          await finishRoom(roomId, {
            reason: "abandoned",
            result: "abandoned",
            message: "Room expired (no opponent joined in time)",
          });
        }
      } catch (e) {
        console.error("scheduleRoomExpiration: handler error", e);
      } finally {
        clearRoomExpiration(roomId);
      }
    }, ms + 1000); // small safety slack
  } catch (e) {
    console.error("scheduleRoomExpiration error", e);
  }
}

/* --------------------
    ONLINE TRACKING & HELPERS
    -------------------- */

let onlineUsers = {}; // { [userIdString]: { sockets: Set, username } }
let pendingChallenges = {}; // exported placeholder

function _normId(v) {
  if (v === null || v === undefined) return null;
  try {
    return String(v);
  } catch (e) {
    return null;
  }
}

function addOnlineSocketForUser(userId, socketId, username) {
  const uid = _normId(userId);
  if (!uid || !socketId) return;

  const wasOnline = !!onlineUsers[uid] && onlineUsers[uid].sockets.size > 0;

  if (!onlineUsers[uid]) onlineUsers[uid] = { sockets: new Set(), username };
  onlineUsers[uid].sockets.add(socketId);
  if (username) onlineUsers[uid].username = username;

  const nowOnline = onlineUsers[uid].sockets.size > 0;
  if (!wasOnline && nowOnline && io) {
    try {
      io.emit("presence-changed", {
        userId: uid,
        online: true,
        sockets: onlineUsers[uid].sockets.size,
      });
    } catch (e) {}
  }
}

function removeOnlineSocketForUser(userId, socketId) {
  const uid = _normId(userId);
  if (!uid || !onlineUsers[uid]) return;

  const wasOnline = onlineUsers[uid].sockets.size > 0;

  onlineUsers[uid].sockets.delete(socketId);
  if (onlineUsers[uid].sockets.size === 0) {
    delete onlineUsers[uid];
    if (wasOnline && io) {
      try {
        io.emit("presence-changed", { userId: uid, online: false, sockets: 0 });
      } catch (e) {}
    }
  } else {
    if (io) {
      try {
        io.emit("presence-changed", {
          userId: uid,
          online: true,
          sockets: onlineUsers[uid].sockets.size,
        });
      } catch (e) {}
    }
  }
}

function getSocketsForUserId(userId) {
  const uid = _normId(userId);
  if (!uid || !onlineUsers[uid]) return [];
  return Array.from(onlineUsers[uid].sockets);
}

/**
 * notifyUser(userId, event, payload)
 * Emits `event` to every connected socket for userId. Best-effort.
 */
function notifyUser(userId, event, payload) {
  try {
    if (!io) return;
    const sids = getSocketsForUserId(userId);
    if (Array.isArray(sids) && sids.length > 0) {
      for (const sid of sids) {
        try {
          io.to(sid).emit(event, payload);
        } catch (e) {}
      }
      return;
    }
    try {
      io.to(`user:${userId}`).emit(event, payload);
    } catch (e) {}
  } catch (err) {
    console.error("notifyUser error (non-fatal):", err);
  }
}

/* --------------------
    broadcastRoomState (persist snapshot too)
    -------------------- */

/* --------------------
    broadcastRoomState (persist snapshot too)
    -------------------- */

function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room || !io) return;

  let pending = null;
  if (room.pendingDrawOffer) {
    let offerer = null;
    if (room.pendingDrawOffer.fromUserId) {
      offerer = room.players.find(
        (p) => p.user && p.user.id === room.pendingDrawOffer.fromUserId
      );
    }
    if (!offerer && room.pendingDrawOffer.fromSocketId) {
      offerer = room.players.find(
        (p) => p.id === room.pendingDrawOffer.fromSocketId
      );
    }
    if (offerer && offerer.user) {
      const u = offerer.user;
      pending = {
        from: {
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          avatarUrl: u.avatarUrl || u.avatarUrlAbsolute || u.avatar || null,
        },
      };
    }
  }

  let rematch = null;
  if (room.rematch) {
    rematch = {
      initiatorSocketId: room.rematch.initiatorSocketId || null,
      initiatorUserId: room.rematch.initiatorUserId || null,
      acceptedBy: room.rematch.acceptedBy
        ? Object.keys(room.rematch.acceptedBy)
        : [],
    };
  }

  // Normalize messages to an array so .length is safe to read
  const msgsArr = Array.isArray(room.messages) ? room.messages : [];
  const msgs = msgsArr.slice(-Math.min(MAX_CHAT_MESSAGES, msgsArr.length));

  io.to(roomId).emit("room-update", {
    players: room.players.map((p) => ({
      id: p.id,
      user: p.user,
      color: p.color,
      online: !!p.online,
      disconnectedAt: p.disconnectedAt || null,
    })),
    moves: room.moves,
    fen: room.chess ? (room.chess.fen ? room.chess.fen() : room.fen) : room.fen,
    lastIndex: room.lastIndex,
    clocks: room.clocks
      ? { w: room.clocks.w, b: room.clocks.b, running: room.clocks.running }
      : null,
    finished: room.finished || null,
    pendingDrawOffer: pending,
    settings: room.settings || null,
    messages: msgs,
    pendingRematch: rematch,
  });

  // If the room now has two active colored players and game started — cancel expiration
  try {
    const coloredPlayers = (room.players || []).filter(
      (p) => p.color === "w" || p.color === "b"
    );
    const activeCount = coloredPlayers.filter((p) => !!p.online).length;
    if (
      coloredPlayers.length === 2 &&
      activeCount === 2 &&
      room.clocks &&
      !room.finished
    ) {
      // game properly started -> cancel expiration
      clearRoomExpiration(roomId);
    }
  } catch (e) {}

  (async () => {
    try {
      const doc = {
        fen: room.chess
          ? room.chess.fen
            ? room.chess.fen()
            : room.fen
          : room.fen,
        moves: room.moves || [],
        lastIndex: typeof room.lastIndex !== "undefined" ? room.lastIndex : -1,
        players: (room.players || []).map((p) => ({
          id: p.user?.id || p.id,
          user: p.user || null,
          color: p.color,
          online: !!p.online,
          disconnectedAt: p.disconnectedAt || null,
        })),
        clocks: room.clocks || null,
        settings: room.settings || null,
        messages: msgs,
        finished: room.finished || null,
        rematch: room.rematch || null,
        pendingDrawOffer: pending || null,
        updatedAt: new Date(),
      };

      await RoomModel.updateOne(
        { roomId },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      ).exec();
    } catch (err) {
      console.error("broadcastRoomState: failed to persist room state:", err);
    }
  })();
}

/* --------------------
    createRoom(options)
    -------------------- */

/**
 * createRoom(options)
 * Creates a new in-memory room (and persists initial snapshot via broadcastRoomState).
 * Enforces single active room per user via conditional update only when called from
 * places that should reserve (matchmaking / challenge / accept flows).
 * - When a single user creates a room interactively (create-room socket event), avoid pre-reserving
 *   activeRoom; instead reservation happens when the user is assigned a playing seat.
 */
async function createRoom(options = {}) {
  try {
    const minutes = Math.max(1, Math.floor(Number(options.minutes) || 5));
    const minutesMs = minutes * 60 * 1000;
    let roomId =
      options.roomId && String(options.roomId).trim()
        ? String(options.roomId).trim()
        : generateRoomCode();

    let attempts = 0;
    while (rooms[roomId] && attempts < 12) {
      roomId = generateRoomCode();
      attempts++;
    }
    if (rooms[roomId]) {
      return null;
    }

    const userA = options.userA || null;
    const userB = options.userB || null;

    let initiatorUser = null;
    let acceptorUser = null;
    try {
      if (userA && userA.id)
        initiatorUser = await User.findById(userA.id).lean().exec();
    } catch (e) {}
    try {
      if (userB && userB.id)
        acceptorUser = await User.findById(userB.id).lean().exec();
    } catch (e) {}

    // ENFORCE single active room per user (server-side) using conditional update
    // This function will attempt to reserve activeRoom only if userA/userB provided (matchmaking/challenge flows).
    const setIfFree = async (userObj, rid) => {
      if (!userObj || !userObj.id) return { ok: true, set: false };
      const uid = String(userObj.id);
      try {
        // try to set activeRoom only if it's null or empty string
        const updated = await User.findOneAndUpdate(
          { _id: uid, $or: [{ activeRoom: null }, { activeRoom: "" }] },
          { $set: { activeRoom: rid, status: "playing" } },
          { new: true }
        ).exec();
        if (updated) return { ok: true, set: true };
        return { ok: true, set: false };
      } catch (e) {
        return { ok: false, error: e };
      }
    };

    const reserveId = roomId;
    let reservedA = { ok: true, set: false };
    let reservedB = { ok: true, set: false };

    if (initiatorUser && initiatorUser._id) {
      reservedA = await setIfFree(initiatorUser, reserveId);
      if (!reservedA.ok) {
        // DB error -> abort
        return null;
      }
      if (!reservedA.set) {
        // already has activeRoom -> abort
        try {
          if (io && userA && userA.id) {
            io.to(userA.id).emit("create-room-failed", {
              error: "already-in-active-room",
              activeRoom: initiatorUser.activeRoom,
            });
          }
        } catch (e) {}
        return null;
      }
    }

    if (acceptorUser && acceptorUser._id) {
      reservedB = await setIfFree(acceptorUser, reserveId);
      if (!reservedB.ok) {
        // DB error - rollback A if reserved
        if (reservedA.set && initiatorUser && initiatorUser._id) {
          try {
            await User.findByIdAndUpdate(initiatorUser._id, {
              activeRoom: null,
              status: "idle",
            }).exec();
          } catch (e) {}
        }
        return null;
      }
      if (!reservedB.set) {
        // acceptor already in active room - rollback A
        if (reservedA.set && initiatorUser && initiatorUser._id) {
          try {
            await User.findByIdAndUpdate(initiatorUser._id, {
              activeRoom: null,
              status: "idle",
            }).exec();
          } catch (e) {}
        }
        try {
          if (io && userB && userB.id) {
            io.to(userB.id).emit("create-room-failed", {
              error: "already-in-active-room",
              activeRoom: acceptorUser.activeRoom,
            });
          }
        } catch (e) {}
        return null;
      }
    }

    if (initiatorUser) initiatorUser = ensureAvatarAbs(initiatorUser);
    if (acceptorUser) acceptorUser = ensureAvatarAbs(acceptorUser);

    const pAUser =
      initiatorUser ||
      (userA
        ? { id: userA.id, username: userA.username }
        : { username: "guest" });
    const pBUser =
      acceptorUser ||
      (userB
        ? { id: userB.id, username: userB.username }
        : { username: "guest" });

    let colorPref = options.colorPreference || "random";
    let aColor = "w";
    let bColor = "b";
    if (colorPref === "white") {
      aColor = "w";
      bColor = "b";
    } else if (colorPref === "black") {
      aColor = "b";
      bColor = "w";
    } else if (colorPref === "random") {
      if (Math.random() < 0.5) {
        aColor = "w";
        bColor = "b";
      } else {
        aColor = "b";
        bColor = "w";
      }
    }

    const players = [];

    players.push({
      id: pAUser.id || pAUser._id || `user:${pAUser.username || "a"}`,
      user: pAUser,
      color: aColor,
      online: !!(
        pAUser &&
        pAUser.id &&
        onlineUsers[pAUser.id] &&
        onlineUsers[pAUser.id].sockets.size > 0
      ),
      disconnectedAt: null,
    });

    players.push({
      id: pBUser.id || pBUser._id || `user:${pBUser.username || "b"}`,
      user: pBUser,
      color: bColor,
      online: !!(
        pBUser &&
        pBUser.id &&
        onlineUsers[pBUser.id] &&
        onlineUsers[pBUser.id].sockets.size > 0
      ),
      disconnectedAt: null,
    });

    const room = {
      players,
      moves: [],
      chess: new Chess(),
      fen: null,
      lastIndex: -1,
      clocks: {
        w: minutesMs,
        b: minutesMs,
        running: "w",
        lastTick: Date.now(),
      },
      paused: false,
      disconnectTimers: {},
      firstMoveTimer: null,
      pendingDrawOffer: null,
      finished: null,
      settings: {
        minutes,
        minutesMs,
        creatorId: pAUser.id || pAUser._id || null,
        colorPreference: colorPref || "random",
        createdAt: Date.now(),
      },
      messages: [],
      rematch: null,
    };

    room.fen = room.chess ? room.chess.fen() : null;

    rooms[roomId] = room;

    // Join sockets for users if online
    try {
      const userAId = pAUser.id || pAUser._id || null;
      const userBId = pBUser.id || pBUser._id || null;

      const sidsA = userAId ? getSocketsForUserId(userAId) : [];
      const sidsB = userBId ? getSocketsForUserId(userBId) : [];

      const allSids = Array.from(new Set([...(sidsA || []), ...(sidsB || [])]));

      for (const sid of allSids) {
        try {
          const sock = io && io.sockets && io.sockets.sockets.get(sid);
          if (sock) sock.join(roomId);
        } catch (e) {}
      }
    } catch (e) {}

    // Broadcast initial state and schedule first-move timer & expiration
    broadcastRoomState(roomId);
    scheduleFirstMoveTimer(roomId);
    scheduleRoomExpiration(roomId);

    return { roomId };
  } catch (err) {
    console.error("createRoom error:", err);
    return null;
  }
}

/* --------------------
    Rematch helper: createRematchFrom(oldRoomId)
    - Creates a brand-new room id, moves players into it (keeps user objects),
    - joins available sockets and broadcasts the new room state.
    - returns { ok: true, roomId } or { ok: false, error }.
    -------------------- */

async function createRematchFrom(oldRoomId) {
  try {
    const old = rooms[oldRoomId];
    if (!old) return { ok: false, error: "No such room" };

    // build participants list only for colored players (w/b)
    const colored = (old.players || []).filter(
      (p) => p.color === "w" || p.color === "b"
    );
    if (colored.length === 0)
      return { ok: false, error: "No players to rematch" };

    // use the same minutes setting
    const minutes =
      (old.settings && old.settings.minutes) ||
      Math.max(1, Math.floor(DEFAULT_MS / 60000));
    const minutesMs =
      (old.settings && old.settings.minutesMs) || minutes * 60 * 1000;

    // generate new unique room id
    let newRoomId = generateRoomCode();
    let attempts = 0;
    while (rooms[newRoomId] && attempts < 16) {
      newRoomId = generateRoomCode();
      attempts++;
    }
    if (rooms[newRoomId])
      return { ok: false, error: "Unable to generate room id" };

    // create player entries for new room: pick best socket id (if user), otherwise keep existing id
    const newPlayers = [];
    for (const p of colored) {
      const uid = p.user && (p.user.id || p.user._id);
      let chosenSocket = null;
      if (uid) {
        const sids = getSocketsForUserId(String(uid));
        if (sids && sids.length > 0) chosenSocket = sids[0];
      }
      const newId = chosenSocket || p.id;
      const userObj = p.user ? p.user : null;
      newPlayers.push({
        id: newId,
        user: userObj,
        color: p.color,
        online: !!(chosenSocket || (p.online && p.id)),
        disconnectedAt: null,
      });
    }

    // ensure we have two entries; if only one player (rare), allow spectator slot for the other
    if (newPlayers.length === 1) {
      // add placeholder spectator
      newPlayers.push({
        id: `spectator-${Date.now()}`,
        user: { username: "guest" },
        color: "spectator",
        online: false,
        disconnectedAt: null,
      });
    }

    const newRoom = {
      players: newPlayers,
      moves: [],
      chess: new Chess(),
      fen: null,
      lastIndex: -1,
      clocks: {
        w: minutesMs,
        b: minutesMs,
        running: "w",
        lastTick: Date.now(),
      },
      paused: false,
      disconnectTimers: {},
      firstMoveTimer: null,
      pendingDrawOffer: null,
      finished: null,
      settings: {
        minutes,
        minutesMs,
        creatorId: old.settings && old.settings.creatorId,
        colorPreference: old.settings && old.settings.colorPreference,
        createdAt: Date.now(),
      },
      messages: [],
      rematch: null,
    };

    newRoom.fen = newRoom.chess ? newRoom.chess.fen() : null;

    rooms[newRoomId] = newRoom;

    // join sockets in new room
    try {
      for (const p of newPlayers) {
        const id = p.id;
        // if id matches a socket id, ensure that socket joins
        const sock = io && io.sockets && io.sockets.sockets.get(id);
        if (sock) sock.join(newRoomId);
        // if id looks like a user id, join all that user's sockets
        const sids = getSocketsForUserId(id);
        if (sids && sids.length > 0) {
          for (const sid of sids) {
            try {
              const sSock = io && io.sockets && io.sockets.sockets.get(sid);
              if (sSock) sSock.join(newRoomId);
            } catch (e) {}
          }
        }
      }
    } catch (e) {}

    // schedule timers and broadcast
    scheduleFirstMoveTimer(newRoomId);
    scheduleRoomExpiration(newRoomId);
    broadcastRoomState(newRoomId);

    return { ok: true, roomId: newRoomId };
  } catch (e) {
    console.error("createRematchFrom error:", e);
    return { ok: false, error: "Server error" };
  }
}

/* --------------------
    MATCHMAKING (simple / kept)
    (You already have fuller matchmaking in another file — kept reasonable support here)
    -------------------- */

const matchmaking = {
  queueByCups: new Map(), // cupsStr -> [{ socketId, userId, username, ts, minutes }]
  socketIndex: new Map(), // socketId -> { cupsStr }
  maxExpandDelta: 500,
};

async function enqueueMatch({
  socketId,
  userId,
  username,
  cups = 1200,
  minutes = 5,
}) {
  try {
    if (!socketId) return { ok: false, error: "Missing socketId" };
    const cupsNum = Number(cups) || 1200;
    const cupsStr = String(cupsNum);

    if (matchmaking.socketIndex.has(socketId)) {
      try {
        if (io)
          io.to(socketId).emit("match-queued", { ok: true, queued: true });
      } catch (e) {}
      return { ok: true, queued: true };
    }

    const opponentEntry = findAndRemoveOpponentFor({ socketId, cupsNum });
    if (opponentEntry) {
      const opp = opponentEntry;
      const roomRes = await createRoom({
        minutes,
        colorPreference: "random",
        userA: { id: userId, username: username || "Guest" },
        userB: { id: opp.userId, username: opp.username || "Guest" },
      });

      if (!roomRes || !roomRes.roomId) {
        try {
          if (io) {
            io.to(socketId).emit("match-found-failed", {
              ok: false,
              error: "create-room-failed",
            });
            io.to(opp.socketId).emit("match-found-failed", {
              ok: false,
              error: "create-room-failed",
            });
          }
        } catch (e) {}
        matchmaking.socketIndex.delete(socketId);
        return { ok: false, error: "create-room-failed" };
      }

      const roomId =
        (roomRes && (roomRes.roomId || roomRes.id)) || generateRoomCode();

      try {
        const sA = io && io.sockets && io.sockets.sockets.get(socketId);
        const sB = io && io.sockets && io.sockets.sockets.get(opp.socketId);
        if (sA) sA.join(roomId);
        if (sB) sB.join(roomId);
      } catch (e) {}

      try {
        broadcastRoomState(roomId);
      } catch (e) {}

      try {
        const payloadForA = {
          ok: true,
          matched: true,
          roomId,
          opponent: { id: opp.userId || null, username: opp.username || null },
          message: "Match found — joining room",
        };
        const payloadForB = {
          ok: true,
          matched: true,
          roomId,
          opponent: { id: userId || null, username: username || null },
          message: "Match found — joining room",
        };
        if (io) {
          io.to(socketId).emit("match-found", payloadForA);
          io.to(opp.socketId).emit("match-found", payloadForB);
        }
      } catch (e) {}

      matchmaking.socketIndex.delete(socketId);
      return { ok: true, matched: true, roomId };
    }

    const arr = matchmaking.queueByCups.get(cupsStr) || [];
    const entry = {
      socketId,
      userId: userId ? String(userId) : null,
      username: username || "Guest",
      ts: Date.now(),
      minutes: Number(minutes) || 5,
    };
    arr.push(entry);
    matchmaking.queueByCups.set(cupsStr, arr);
    matchmaking.socketIndex.set(socketId, { cupsStr });

    try {
      if (io) io.to(socketId).emit("match-queued", { ok: true, queued: true });
    } catch (e) {}

    return { ok: true, queued: true };
  } catch (err) {
    console.error("enqueueMatch error:", err);
    try {
      if (io) io.to(socketId).emit("match-queue-error", { ok: false });
    } catch (e) {}
    return { ok: false, error: "Server error" };
  }
}

function findAndRemoveOpponentFor({ socketId, cupsNum }) {
  try {
    const maxDelta = matchmaking.maxExpandDelta || 500;
    const start = Number(cupsNum) || 1200;

    for (let d = 0; d <= maxDelta; d++) {
      const candidates = [];
      const up = start + d;
      const down = start - d;
      if (matchmaking.queueByCups.has(String(up))) {
        candidates.push({
          cupsStr: String(up),
          list: matchmaking.queueByCups.get(String(up)),
        });
      }
      if (d > 0 && matchmaking.queueByCups.has(String(down))) {
        candidates.push({
          cupsStr: String(down),
          list: matchmaking.queueByCups.get(String(down)),
        });
      }
      for (const group of candidates) {
        for (let i = 0; i < group.list.length; i++) {
          const e = group.list[i];
          if (e.socketId === socketId) continue;
          group.list.splice(i, 1);
          if (group.list.length === 0)
            matchmaking.queueByCups.delete(group.cupsStr);
          else matchmaking.queueByCups.set(group.cupsStr, group.list);
          matchmaking.socketIndex.delete(e.socketId);
          return e;
        }
      }
    }
  } catch (err) {
    console.error("findAndRemoveOpponentFor error:", err);
  }
  return null;
}

function dequeueBySocketId(socketId) {
  try {
    if (!socketId || !matchmaking.socketIndex.has(socketId)) return false;
    const meta = matchmaking.socketIndex.get(socketId);
    const cupsStr = meta && meta.cupsStr;
    if (!cupsStr) {
      matchmaking.socketIndex.delete(socketId);
      return true;
    }
    const arr = matchmaking.queueByCups.get(cupsStr) || [];
    const idx = arr.findIndex((e) => e.socketId === socketId);
    if (idx !== -1) {
      arr.splice(idx, 1);
      if (arr.length === 0) matchmaking.queueByCups.delete(cupsStr);
      else matchmaking.queueByCups.set(cupsStr, arr);
    }
    matchmaking.socketIndex.delete(socketId);
    try {
      if (io) io.to(socketId).emit("match-dequeued", { ok: true });
    } catch (e) {}
    return true;
  } catch (err) {
    console.error("dequeueBySocketId error:", err);
    return false;
  }
}

function getQueueSizes() {
  const out = {};
  for (const [k, v] of matchmaking.queueByCups.entries()) {
    out[k] = v.length;
  }
  return out;
}

/* --------------------
    Utilities & exports
    -------------------- */

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

module.exports = {
  init,
  rooms,
  DEFAULT_MS,
  DISCONNECT_GRACE_MS,
  FIRST_MOVE_TIMEOUT_MS,
  MAX_CHAT_MESSAGES,
  generateRoomCode,
  assignColorsForRematch,
  broadcastRoomState,
  clearDisconnectTimer,
  clearFirstMoveTimer,
  saveFinishedGame,
  scheduleFirstMoveTimer,
  scheduleRoomExpiration,
  onlineUsers,
  pendingChallenges,
  addOnlineSocketForUser,
  removeOnlineSocketForUser,
  getSocketsForUserId,
  notifyUser,
  createRoom,
  createRematchFrom,
  // NEW export:
  finishRoom,
  // matchmaking:
  enqueueMatch,
  dequeueBySocketId,
  getQueueSizes,
};
