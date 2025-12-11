// roomManager.js
const { Chess } = require("chess.js");
const Game = require("./models/Game");
const User = require("./models/User");
const RoomModel = require("./models/Room");
const jsChessAdapter = require("./lib/jsChessEngineAdapter");

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
// bot timers map: roomId -> Timeout (schedules next bot move)
const botMoveTimers = {};

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
 * Helper: detect objectid-like string (24 hex chars)
 * Use this to avoid passing non-ObjectId values (bot ids, socket ids) into queries
 * that target the `_id` field.
 */
function isObjectIdLike(v) {
  return !!(v && typeof v === "string" && /^[a-fA-F0-9]{24}$/.test(v));
}

/**
 * Helper: escape regex for username lookup
 */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Try to find a DB userId from a socketId by scanning onlineUsers map.
 * Returns userId string or null.
 */
function findUserIdBySocketId(socketId) {
  try {
    if (!socketId) return null;
    for (const [uid, meta] of Object.entries(onlineUsers || {})) {
      try {
        if (
          meta &&
          meta.sockets &&
          meta.sockets.has &&
          meta.sockets.has(socketId)
        ) {
          return uid;
        }
        // some older shapes store sockets as arrays
        if (
          meta &&
          Array.isArray(meta.sockets) &&
          meta.sockets.includes(socketId)
        ) {
          return uid;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return null;
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
 *
 * NOTE: we filter participantIds to ObjectId-like strings only to avoid casting errors
 * when bot IDs or socket IDs are present.
 */
async function _clearActiveRoomSafety(roomId, participantIds = []) {
  try {
    const ids = Array.isArray(participantIds)
      ? participantIds.filter(Boolean).map(String)
      : [];

    // filter only those that look like ObjectId strings
    const dbIds = ids.filter((x) => isObjectIdLike(x));

    if (dbIds.length > 0) {
      await User.updateMany(
        { _id: { $in: dbIds } },
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
      clearBotTimer(roomId);
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

      // Filter to ObjectId-like IDs before calling DB updates to avoid CastError when bot ids are present
      const dbParticipantIds = participantIds.filter((x) => isObjectIdLike(x));

      if (dbParticipantIds.length > 0) {
        await User.updateMany(
          { _id: { $in: dbParticipantIds } },
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

// fallback apply: atomic increment/decrement if applyCups is not available
async function applyFallbackDelta(winnerId, loserId, delta = 12) {
  try {
    if (!winnerId || !loserId) {
      console.warn("applyFallbackDelta: missing ids", winnerId, loserId);
      return { ok: false, reason: "missing-ids" };
    }
    // ensure numeric delta and integer
    const d = Number(delta) || 12;
    // use findByIdAndUpdate with $inc to avoid race conditions
    const beforeWinner = await User.findById(winnerId)
      .select("cups username")
      .lean()
      .exec();
    const beforeLoser = await User.findById(loserId)
      .select("cups username")
      .lean()
      .exec();

    const winnerUpdate = await User.findByIdAndUpdate(
      winnerId,
      { $inc: { cups: Math.abs(d) } },
      { new: true, lean: true }
    )
      .select("cups username")
      .exec();

    const loserUpdate = await User.findByIdAndUpdate(
      loserId,
      { $inc: { cups: -Math.abs(d) } },
      { new: true, lean: true }
    )
      .select("cups username")
      .exec();

    console.log("[applyFallbackDelta] applied fallback cups delta:", {
      delta: d,
      winner: {
        id: winnerId,
        username: winnerUpdate?.username,
        before: beforeWinner?.cups,
        after: winnerUpdate?.cups,
      },
      loser: {
        id: loserId,
        username: loserUpdate?.username,
        before: beforeLoser?.cups,
        after: loserUpdate?.cups,
      },
    });
    return { ok: true, delta: d, winner: winnerUpdate, loser: loserUpdate };
  } catch (e) {
    console.error("[applyFallbackDelta] error:", e);
    return { ok: false, error: e.message || String(e) };
  }
}

async function saveFinishedGame(roomId) {
  try {
    const room = rooms[roomId];
    if (!room || !room.finished) return;
    const savedId = `${roomId}-${Date.now()}`;

    // build players payload (store whatever client sent so we can debug)
    const playersPayload = (room.players || []).map((p) => {
      const userObj = p.user || {};
      return {
        id: p.id || null,
        user: {
          id: userObj.id || userObj._id || null,
          _id: userObj._id || null,
          username: userObj.username || null,
          displayName: userObj.displayName || null,
          avatarUrl: userObj.avatarUrl || userObj.avatar || null,
          email: userObj.email || null,
        },
        color: p.color,
        online: !!p.online,
        disconnectedAt: p.disconnectedAt || null,
      };
    });

    // small helper: test for 24-hex ObjectId string
    const looksLikeObjectId = (v) =>
      !!(v && typeof v === "string" && /^[a-fA-F0-9]{24}$/.test(v));

    // helper: try to map a socket id to a user id using onlineUsers map (best-effort)
    function findUserIdBySocketId_local(socketId) {
      try {
        if (!socketId) return null;
        // onlineUsers shape: { userId: { sockets: Set, username } }
        for (const [uid, meta] of Object.entries(onlineUsers || {})) {
          try {
            if (meta && meta.sockets) {
              if (meta.sockets instanceof Set) {
                if (meta.sockets.has(socketId)) return uid;
              } else if (Array.isArray(meta.sockets)) {
                if (meta.sockets.includes(socketId)) return uid;
              }
            }
          } catch (e) {}
        }
      } catch (e) {}
      return null;
    }

    // robust resolver that tries many strategies to return DB _id string or null
    async function resolveUserIdFromPlayer(p) {
      if (!p) return null;
      try {
        // 1) nested user.id/_id
        if (p.user) {
          if (p.user.id && looksLikeObjectId(String(p.user.id)))
            return String(p.user.id);
          if (p.user._id && looksLikeObjectId(String(p.user._id)))
            return String(p.user._id);
        }
        // 2) top-level p.id if ObjectId-like
        if (p.id && looksLikeObjectId(String(p.id))) return String(p.id);

        // 3) map p.id as socketId -> userId via onlineUsers
        if (p.id && typeof p.id === "string") {
          const maybe = findUserIdBySocketId_local(p.id);
          if (maybe && looksLikeObjectId(String(maybe))) return String(maybe);
        }

        // 4) try username/displayName DB lookup (case-insensitive)
        const uname =
          (p.user && (p.user.username || p.user.displayName)) || null;
        if (uname && typeof uname === "string") {
          const esc = String(uname).trim();
          if (esc.length > 0) {
            try {
              const cand = await User.findOne({
                $or: [
                  { username: new RegExp(`^${esc}$`, "i") },
                  { displayName: new RegExp(`^${esc}$`, "i") },
                  { email: new RegExp(`^${esc}$`, "i") },
                ],
              })
                .select("_id username")
                .lean()
                .exec();
              if (cand && cand._id) return String(cand._id);
            } catch (e) {}
          }
        }

        // 5) p.user.id present but not objectid-like -> still return (maybe external id)
        if (p.user && p.user.id) return String(p.user.id);
      } catch (e) {}
      return null;
    }

    // --------------- Determine winner/loser color if missing ---------------
    let winnerId = null;
    let loserId = null;
    let winnerColor = null;
    try {
      const finished = room.finished || {};

      // prefer explicit winnerId/loserId already present
      if (finished.winnerId && String(finished.winnerId).trim())
        winnerId = String(finished.winnerId).trim();
      if (finished.loserId && String(finished.loserId).trim())
        loserId = String(finished.loserId).trim();

      // prefer winnerColor if set
      if (finished.winnerColor) winnerColor = finished.winnerColor;

      // If neither color nor ids present, attempt to detect from chess state
      if (!winnerColor) {
        try {
          // if room.chess present, run robust detection
          let detectRes = null;
          if (room.chess) {
            detectRes = detectGameFinishedForRoom(room.chess);
            if (detectRes && detectRes.winner) winnerColor = detectRes.winner;
          } else {
            // rebuild chess from moves
            const tmpChess = rebuildChessFromMoves(room);
            detectRes = detectGameFinishedForRoom(tmpChess);
            if (detectRes && detectRes.winner) winnerColor = detectRes.winner;
          }
        } catch (e) {}
      }

      // Now try to resolve winner/loser ids from players using winnerColor mapping
      if ((!winnerId || !loserId) && winnerColor) {
        const pW = (room.players || []).find((pp) => pp.color === winnerColor);
        const pL = (room.players || []).find(
          (pp) => pp.color && pp.color !== winnerColor
        );
        if (pW && !winnerId) winnerId = await resolveUserIdFromPlayer(pW);
        if (pL && !loserId) loserId = await resolveUserIdFromPlayer(pL);
      }

      // If still missing, attempt to resolve each player one by one
      if (!winnerId || !loserId) {
        for (const p of room.players || []) {
          const resolved = await resolveUserIdFromPlayer(p);
          if (resolved) {
            // if winnerId not set, set it first; otherwise set loser
            if (!winnerId) winnerId = resolved;
            else if (!loserId && winnerId !== resolved) loserId = resolved;
          }
        }
      }

      // as last resort, if exactly two players, try mapping order: first -> white, second -> black
      if (
        (!winnerId || !loserId) &&
        Array.isArray(room.players) &&
        room.players.length === 2
      ) {
        try {
          const p0 = room.players[0];
          const p1 = room.players[1];
          if (!winnerId) winnerId = await resolveUserIdFromPlayer(p0);
          if (!loserId) loserId = await resolveUserIdFromPlayer(p1);
          // if we accidentally assigned same id to both, clear loser to let fallback handle it
          if (winnerId && loserId && winnerId === loserId) loserId = null;
        } catch (e) {}
      }
    } catch (e) {
      console.error("saveFinishedGame winner/loser resolution error:", e);
    }

    // Compose finishedToSave (embed any resolved ids/colors)
    const finishedToSave = {
      ...(room.finished || {}),
      winnerId: winnerId || null,
      loserId: loserId || null,
      winnerColor:
        winnerColor || (room.finished && room.finished.winnerColor) || null,
    };

    // Persist Game doc
    const doc = new Game({
      roomId: savedId,
      fen:
        room.fen ||
        (room.chess ? (room.chess.fen ? room.chess.fen() : null) : null),
      moves: room.moves || [],
      players: playersPayload,
      clocks: room.clocks
        ? { w: room.clocks.w, b: room.clocks.b, running: room.clocks.running }
        : null,
      messages: room.messages || [],
      finished: finishedToSave || null,
      createdAt:
        room.finished && room.finished.finishedAt
          ? new Date(room.finished.finishedAt)
          : new Date(),
    });
    await doc.save();
    console.log("Saved finished game to Mongo:", savedId);

    // If we still don't have winner/loser ids, log full debug payload and leave for retry
    if (!doc.finished || (!doc.finished.winnerId && !doc.finished.loserId)) {
      console.warn(
        "[saveFinishedGame] winner/loser NOT resolved when saving. Saved players payload:",
        {
          gameId: String(doc._id),
          players: playersPayload,
          finished: doc.finished,
        }
      );
    } else {
      console.log("[saveFinishedGame] resolved winner/loser saved on Game:", {
        gameId: String(doc._id),
        winnerId: doc.finished.winnerId,
        loserId: doc.finished.loserId,
      });
    }

    // Attempt to call existing applyCups module first (many projects expose this)
    try {
      // try a few common paths
      const tryPaths = [
        path.join(__dirname, "socket", "applyCups"),
        path.join(__dirname, "applyCups"),
        path.join(__dirname, "..", "socket", "applyCups"),
        path.join(__dirname, "..", "src", "socket", "applyCups"),
        path.join(process.cwd(), "backend", "socket", "applyCups"),
        path.join(process.cwd(), "socket", "applyCups"),
        "./socket/applyCups",
        "./applyCups",
      ];
      let applyCupsModule = null;
      for (const p of tryPaths) {
        try {
          applyCupsModule = require(p);
          if (applyCupsModule) break;
        } catch (e) {
          // ignore
        }
      }

      if (applyCupsModule) {
        // find a callable function
        let applyCupsFunc = null;
        if (typeof applyCupsModule === "function")
          applyCupsFunc = applyCupsModule;
        else if (typeof applyCupsModule.applyCupsForFinishedRoom === "function")
          applyCupsFunc = applyCupsModule.applyCupsForFinishedRoom;
        else if (typeof applyCupsModule.default === "function")
          applyCupsFunc = applyCupsModule.default;

        if (!applyCupsFunc) {
          console.warn(
            "[saveFinishedGame] applyCups module found but no callable exported function"
          );
        } else {
          // try calling it with common signatures: (ctx, gameId) or (gameId)
          let calledRes = null;
          try {
            const ctx = {
              Game,
              User,
              ratingUtils:
                typeof ratingUtils !== "undefined" ? ratingUtils : null,
              io,
              notifyUser:
                typeof notifyUser === "function" ? notifyUser : () => {},
            };
            calledRes = await applyCupsFunc(ctx, doc._id);
          } catch (e) {
            try {
              calledRes = await applyCupsFunc(doc._id);
            } catch (err) {
              console.error("[saveFinishedGame] applyCups call error:", err);
              calledRes = null;
            }
          }
          if (calledRes && calledRes.ok) {
            console.log("[saveFinishedGame] applyCups reported ok:", calledRes);
          } else if (calledRes) {
            console.warn(
              "[saveFinishedGame] applyCups reported non-ok:",
              calledRes
            );
          } else {
            console.warn("[saveFinishedGame] applyCups returned falsy result");
          }
          return;
        }
      } else {
        console.warn("[saveFinishedGame] could not locate applyCups module");
      }
    } catch (e) {
      console.error(
        "[saveFinishedGame] error attempting to call applyCups (ignored):",
        e
      );
    }

    // FINAL fallback: if we have resolved winnerId & loserId, apply a deterministic delta (ensures winner ++, loser --)
    if (finishedToSave.winnerId && finishedToSave.loserId) {
      try {
        // You wanted Stockfish rating alternative earlier — if you have ratingUtils ready you can compute delta:
        // const delta = typeof computeDeltaForWinner === "function" ? computeDeltaForWinner(...) : 12;
        // For now, use fixed 12 to guarantee deterministic behavior (always increase winner, decrease loser)
        const fallbackDelta = 12;
        const res = await applyFallbackDelta(
          finishedToSave.winnerId,
          finishedToSave.loserId,
          fallbackDelta
        );
        if (res && res.ok) {
          console.log("[saveFinishedGame] applied fallback cups update:", res);
        } else {
          console.warn(
            "[saveFinishedGame] fallback cups update reported non-ok:",
            res
          );
        }
      } catch (e) {
        console.error(
          "[saveFinishedGame] fallback delta application failed:",
          e
        );
      }
      return;
    }

    // if we reach here, we could not resolve both users — leave the saved game for async/cron retry/inspection
    console.warn(
      "[saveFinishedGame] could not resolve both users — leaving unprocessed for retry",
      {
        gameId: String(doc._id),
        winnerEntry: finishedToSave.winnerId || null,
        loserEntry: finishedToSave.loserId || null,
      }
    );
  } catch (err) {
    console.error("Error saving finished game:", err);
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
    console.error("scheduleRoomExpiration error:", e);
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
    Bot helpers (server-side AI using chess.js and negamax)
    - schedules bot moves when room contains a bot player (id starting with 'bot:' or username 'Bot')
    - supports simple levels (1..4) mapped to search depth
    -------------------- */

function clearBotTimer(roomId) {
  try {
    const t = botMoveTimers[roomId];
    if (t) {
      clearTimeout(t);
      delete botMoveTimers[roomId];
    }
  } catch (e) {}
}

function isBotPlayerEntry(p) {
  if (!p) return false;
  if (typeof p.id === "string" && p.id.startsWith("bot:")) return true;
  if (p.user && typeof p.user.username === "string") {
    const uname = String(p.user.username).toLowerCase();
    if (uname === "bot" || uname.startsWith("bot:")) return true;
  }
  return false;
}

function findBotInRoom(room) {
  if (!room || !Array.isArray(room.players)) return null;
  for (const p of room.players) {
    if (isBotPlayerEntry(p)) return p;
  }
  return null;
}

function isBotRoom(roomOrId) {
  try {
    let room = null;
    if (typeof roomOrId === "string") room = rooms[roomOrId];
    else room = roomOrId;
    if (!room) return false;
    if (room.settings && room.settings.bot && room.settings.bot.enabled)
      return true;
    const botP = findBotInRoom(room);
    return !!botP;
  } catch (e) {
    return false;
  }
}

function mapLevelToDepth(level) {
  // safe mapping; allow surprisingly shallow depths to keep CPU usage reasonable
  const lvl = Number(level) || 2;
  if (lvl <= 1) return 1;
  if (lvl === 2) return 2;
  if (lvl === 3) return 3;
  return 4;
}

function evaluateChessMaterialAndMobility(chessInstance) {
  // returns score from White's perspective (higher => better for white)
  const MAT = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 200 };
  let s = 0;
  try {
    const board = chessInstance.board(); // 8x8 array
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const cell = board[r][c];
        if (!cell) continue;
        const v = MAT[cell.type] || 0;
        s += cell.color === "w" ? v : -v;
      }
    }
    // mobility: small bonus
    const wMoves = chessInstance.moves({
      verbose: false,
      legal: true,
      color: "w",
    }).length;
    const bMoves = chessInstance.moves({
      verbose: false,
      legal: true,
      color: "b",
    }).length;
    s += 0.08 * (wMoves - bMoves);
  } catch (e) {}
  return s;
}

// negamax with alpha-beta using chess.js instance
function negamaxSearch(chessInstance, depth, alpha, beta, colorSign) {
  // colorSign = 1 if evaluating from White perspective for current side; easier to treat like
  // We'll evaluate position at leaf by using evaluateChessMaterialAndMobility and flipping sign as needed.
  const moves = chessInstance.moves({ verbose: true });
  if (depth === 0 || moves.length === 0) {
    const evalv = evaluateChessMaterialAndMobility(chessInstance);
    // return value from side-to-move perspective
    return (chessInstance.turn() === "w" ? 1 : -1) * evalv;
  }

  // move ordering: captures first
  moves.sort((a, b) => {
    const va = a.captured
      ? a.captured in { p: 1, n: 3, b: 3, r: 5, q: 9 }
        ? { p: 1, n: 3, b: 3, r: 5, q: 9 }[a.captured]
        : 0
      : 0;
    const vb = b.captured
      ? b.captured in { p: 1, n: 3, b: 3, r: 5, q: 9 }
        ? { p: 1, n: 3, b: 3, r: 5, q: 9 }[b.captured]
        : 0
      : 0;
    return vb - va;
  });

  let best = -Infinity;
  for (let i = 0; i < moves.length; i++) {
    const mv = moves[i];
    try {
      chessInstance.move({
        from: mv.from,
        to: mv.to,
        promotion: mv.promotion || "q",
      });
    } catch (e) {
      continue;
    }
    const score = -negamaxSearch(
      chessInstance,
      depth - 1,
      -beta,
      -alpha,
      -colorSign
    );
    chessInstance.undo();
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

// ---------- paste/replace into roomManager.js ----------
// Requires at top of file: const jsChessAdapter = require("../lib/jsChessEngineAdapter");

// Robust detectGameFinished helper for roomManager (same logic as gameHandlers)
function _safeCallRM(chess, ...names) {
  for (const n of names) {
    if (!chess) break;
    if (typeof chess[n] === "function") {
      try {
        return chess[n]();
      } catch (e) {}
    }
  }
  return null;
}

function detectGameFinishedForRoom(chess, lastMoveResult = null) {
  try {
    if (!chess) return null;
    const now = Date.now();

    if (_safeCallRM(chess, "in_checkmate", "inCheckmate", "isCheckmate")) {
      const moverColor = lastMoveResult?.color || null;
      const winner =
        moverColor ||
        (typeof chess.turn === "function"
          ? chess.turn() === "w"
            ? "b"
            : "w"
          : "w");
      const loser = winner === "w" ? "b" : "w";
      return {
        reason: "checkmate",
        winner,
        loser,
        message: `${winner.toUpperCase()} wins by checkmate`,
        finishedAt: now,
      };
    }

    if (_safeCallRM(chess, "in_stalemate", "inStalemate", "isStalemate")) {
      return {
        reason: "stalemate",
        result: "draw",
        message: "Draw by stalemate",
        finishedAt: now,
      };
    }

    if (
      _safeCallRM(
        chess,
        "in_threefold_repetition",
        "inThreefoldRepetition",
        "isThreefold"
      )
    ) {
      return {
        reason: "threefold-repetition",
        result: "draw",
        message: "Draw by threefold repetition",
        finishedAt: now,
      };
    }

    if (
      _safeCallRM(
        chess,
        "insufficient_material",
        "insufficientMaterial",
        "isInsufficientMaterial"
      )
    ) {
      return {
        reason: "insufficient-material",
        result: "draw",
        message: "Draw by insufficient material",
        finishedAt: now,
      };
    }

    if (_safeCallRM(chess, "in_draw", "inDraw", "isDraw")) {
      return {
        reason: "draw",
        result: "draw",
        message: "Draw",
        finishedAt: now,
      };
    }

    // fallback canonical rule
    let moves = [];
    try {
      moves =
        typeof chess.moves === "function" ? chess.moves({ verbose: true }) : [];
    } catch (e) {
      try {
        moves = chess.moves ? chess.moves() : [];
      } catch {
        moves = [];
      }
    }

    if (!Array.isArray(moves) || moves.length === 0) {
      const inCheck = _safeCallRM(chess, "in_check", "inCheck") || false;
      if (inCheck) {
        const moverColor = lastMoveResult?.color || null;
        const winner =
          moverColor ||
          (typeof chess.turn === "function"
            ? chess.turn() === "w"
              ? "b"
              : "w"
            : "w");
        const loser = winner === "w" ? "b" : "w";
        return {
          reason: "checkmate",
          winner,
          loser,
          message: `${winner.toUpperCase()} wins by checkmate`,
          finishedAt: now,
        };
      } else {
        return {
          reason: "stalemate",
          result: "draw",
          message: "Draw by stalemate",
          finishedAt: now,
        };
      }
    }

    return null;
  } catch (e) {
    console.error("detectGameFinishedForRoom error:", e);
    return null;
  }
}

// chooseBotMoveForRoom(roomId, botLevel)
// returns normalized { from, to } or null
async function chooseBotMoveForRoom(roomId) {
  try {
    const room = rooms[roomId];
    if (!room) return null;
    // ensure room.chess exists and we have FEN
    try {
      if (!room.chess)
        room.chess = room.fen ? new Chess(room.fen) : new Chess();
    } catch (e) {
      room.chess = new Chess(room.fen || undefined);
    }
    const fen = room.chess ? room.chess.fen() : room.fen || null;
    if (!fen) return null;

    // map your bot level (if stored) to js-chess-engine level range (0..4)
    // if you stored bot levels 1..4 map to 0..4: level-1 but clamp
    let configuredLevel = 2;
    try {
      configuredLevel = Number.isFinite(+room.settings?.botLevel)
        ? Math.max(0, Math.min(4, +room.settings.botLevel))
        : 2;
    } catch (e) {
      configuredLevel = 2;
    }

    // use adapter
    const move = await jsChessAdapter.aiMoveFromFen(fen, configuredLevel);
    // move is { from, to } lower-case squares (e2, e4)
    if (!move || !move.from || !move.to) return null;
    return move;
  } catch (err) {
    console.error("chooseBotMoveForRoom error:", err);
    return null;
  }
}

// performBotMove(roomId, opts = {})
// opts: { thinkMs } - used for optional delayed scheduling by caller
async function performBotMove(roomId, opts = {}) {
  try {
    const room = rooms[roomId];
    if (!room) return false;

    // recompute chess object
    if (!room.chess) room.chess = room.fen ? new Chess(room.fen) : new Chess();

    // find bot player entry in room.players (your code used isBotPlayerEntry earlier)
    const botPlayer = (room.players || []).find((p) => {
      // bot players often have user id starting with 'bot:' or user object missing real id
      const uid = p.user?.id || p.user?._id || p.id || "";
      return (
        String(uid).toLowerCase().startsWith("bot:") ||
        (p.user && p.user.isBot) ||
        (p.id && String(p.id).startsWith("bot:"))
      );
    });
    if (!botPlayer) {
      // no bot found
      return false;
    }

    // ensure it's bot's turn
    const currentTurn = room.chess.turn(); // 'w' or 'b'
    if (!currentTurn) return false;

    // If bot's color does not match turn -> nothing to do.
    if (botPlayer.color !== currentTurn) return false;

    // choose move via adapter
    const chosen = await chooseBotMoveForRoom(roomId);
    if (!chosen) {
      // no move found — possibly game over
      return false;
    }

    // Convert chosen move to the format used in make-move handler: { from: 'e2', to: 'e4' }
    const move = { from: chosen.from, to: chosen.to };
    // apply move to server chess (this mirrors make-move flow)
    const result = room.chess.move(move);
    if (!result) {
      // Something illegal or mismatch, abort
      console.warn(
        "performBotMove: engine returned illegal move",
        move,
        "fen:",
        room.chess.fen()
      );
      return false;
    }

    // record move
    room.lastIndex = (room.lastIndex ?? -1) + 1;
    const record = {
      index: room.lastIndex,
      move: {
        from: move.from,
        to: move.to,
        promotion: result.promotion || undefined,
      },
    };
    room.moves = room.moves || [];
    room.moves.push(record);
    room.fen = room.chess.fen();

    // stop first-move timer (if any)
    try {
      if (typeof clearFirstMoveTimer === "function") clearFirstMoveTimer(room);
    } catch (e) {}

    // unified finished detection using the robust helper
    const finishedObj = detectGameFinishedForRoom(room.chess, result);

    // update clocks
    if (!room.clocks) {
      const minutes = room.settings?.minutes || Math.floor(DEFAULT_MS / 60000);
      const ms = room.settings?.minutesMs || minutes * 60 * 1000;
      room.clocks = {
        w: ms,
        b: ms,
        running: room.chess.turn(),
        lastTick: Date.now(),
      };
    } else {
      if (finishedObj) {
        room.paused = true;
        room.clocks.running = null;
        room.clocks.lastTick = null;
      } else {
        room.clocks.running = room.chess.turn();
        room.clocks.lastTick = Date.now();
      }
    }

    // clear draw offer if originating from bot
    if (room.pendingDrawOffer) {
      if (
        room.pendingDrawOffer.fromSocketId === botPlayer.id ||
        (botPlayer.user &&
          room.pendingDrawOffer.fromUserId === botPlayer.user.id)
      ) {
        room.pendingDrawOffer = null;
      }
    }

    // notify opponent via socket emit (match existing behavior)
    try {
      // roomId is string key
      io.to(roomId).emit("opponent-move", {
        ...record,
        fen: room.fen,
        clocks: room.clocks
          ? { w: room.clocks.w, b: room.clocks.b, running: room.clocks.running }
          : null,
      });
    } catch (e) {}

    if (finishedObj) {
      room.finished = finishedObj;
      room.paused = true;
      if (room.clocks) {
        room.clocks.running = null;
        room.clocks.lastTick = null;
      }
      io.to(roomId).emit("game-over", { ...room.finished });
      try {
        clearFirstMoveTimer(room);
      } catch (e) {}
      Object.keys(room.disconnectTimers || {}).forEach((sid) => {
        try {
          clearDisconnectTimer(room, sid);
        } catch (e) {}
      });
      broadcastRoomState(roomId);

      // persist finished game & apply cups (like make-move does)
      try {
        await saveFinishedGame(roomId);
      } catch (e) {
        console.error("performBotMove: saveFinishedGame failed", e);
      }
      try {
        await applyCupsForFinishedRoom(roomId);
      } catch (e) {
        console.error("performBotMove: applyCupsForFinishedRoom failed", e);
      }
    } else {
      broadcastRoomState(roomId);
    }

    return true;
  } catch (err) {
    console.error("performBotMove error:", err);
    return false;
  }
}
// ---------- end paste ----------

function scheduleBotIfNeeded(roomId) {
  try {
    clearBotTimer(roomId);
    const room = rooms[roomId];
    if (!room || !room.players || !room.chess) return;
    if (room.finished || room.paused) return;

    const botP = findBotInRoom(room);
    if (!botP) return;

    // only schedule if it's bot's turn
    const turn = room.chess.turn();
    if (!turn) return;

    if (botP.color !== turn) return;

    // if schedule due to first-move timer & room.lastIndex === -1 we still schedule
    // else schedule as normal
    performBotMove(roomId);
  } catch (e) {
    console.error("scheduleBotIfNeeded error:", e);
  }
}

/* --------------------
    broadcastRoomState (persist snapshot too)
    -------------------- */

function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room || !io) return;

  const isBot = isBotRoom(room);

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

  // For bot rooms enforce no chat and no clocks in the emitted state
  const emitClocks =
    isBot || !room.clocks
      ? null
      : { w: room.clocks.w, b: room.clocks.b, running: room.clocks.running };

  const emitMessages = isBot ? [] : msgs;

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
    clocks: emitClocks,
    finished: room.finished || null,
    pendingDrawOffer: pending,
    settings: room.settings || null,
    messages: emitMessages,
    pendingRematch: rematch,
    // replay support: include replay index and fen if present
    replayIndex:
      typeof room.replayIndex !== "undefined" ? room.replayIndex : null,
    replayFen: typeof room.replayFen !== "undefined" ? room.replayFen : null,
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
        messages: isBot ? [] : msgs,
        finished: room.finished || null,
        rematch: room.rematch || null,
        pendingDrawOffer: pending || null,
        updatedAt: new Date(),
        // persist replay metadata too (non-destructive)
        replayIndex:
          typeof room.replayIndex !== "undefined" ? room.replayIndex : null,
        replayFen:
          typeof room.replayFen !== "undefined" ? room.replayFen : null,
      };

      await RoomModel.updateOne(
        { roomId },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      ).exec();
    } catch (err) {
      console.error("broadcastRoomState: failed to persist room state:", err);
    } finally {
      // After persisting state, if the room contains a bot and it's the bot's turn, schedule a bot move
      try {
        scheduleBotIfNeeded(roomId);
      } catch (e) {}
    }
  })();
}

/* --------------------
    createRoom(options)
    Creates a new in-memory room (and persists initial snapshot via broadcastRoomState).
    Enforces single active room per user via conditional update only when called from
    places that should reserve (matchmaking/challenge flows).
    - When a single user creates a room interactively (create-room socket event), avoid pre-reserving
      activeRoom; instead reservation happens when the user is assigned a playing seat.
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
    let pBUser =
      acceptorUser ||
      (userB
        ? { id: userB.id, username: userB.username }
        : { username: "guest" });

    // ----- NEW: If options.bot or options.botLevel provided, create a bot player -----
    // If bot requested, replace pBUser with a bot user entry (unless userB explicitly provided and you want both)
    if (options && (options.bot || options.botLevel)) {
      const botLevel =
        Number(options.botLevel || (options.bot && options.bot.level) || 2) ||
        2;
      const botId = `bot:${botLevel}-${Date.now()}`;
      const botUser = {
        id: botId,
        username: `Bot`,
        displayName: `Bot (Lv ${botLevel})`,
        // no avatar by default; UI can show a Bot placeholder
        avatarUrl: null,
      };
      pBUser = botUser;
      // reflect bot settings into room.settings.bot
      if (!options.bot) options.bot = {};
      options.bot.level = botLevel;
    }
    // ------------------------------------------------------------------------------

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
      // if this is a bot (id starts with bot:) mark online true so UI counts it as present
      online:
        (typeof pBUser.id === "string" &&
          String(pBUser.id).startsWith("bot:")) ||
        !!(
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
      // replay / undo stacks:
      undoneMoves: [],
      replayIndex: null,
      replayFen: null,
    };

    // Respect bot options if provided (botLevel or options.bot)
    if (options && (options.botLevel || options.bot)) {
      room.settings.bot = {
        enabled: true,
        level: Number(
          options.botLevel || (options.bot && options.bot.level) || 2
        ),
      };
    }

    // If this is a bot room: disable clocks (no time) and disable chat persistence
    if (isBotRoom(room)) {
      room.clocks = null; // no clock for bot games
      // keep room.messages empty and mark in settings to signal UI (no chat)
      room.messages = [];
      if (!room.settings) room.settings = {};
      room.settings.noChat = true;
      // Do NOT set first-move timer for bot rooms (no forced first-move timeout)
      // scheduleFirstMoveTimer will be skipped below for bot rooms
    }

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

    // Only schedule first-move timer for non-bot rooms
    try {
      if (!isBotRoom(room)) scheduleFirstMoveTimer(roomId);
    } catch (e) {}

    // expiration still scheduled to allow cleanup if desired
    scheduleRoomExpiration(roomId);

    // If the room contains a bot and it's the bot's turn, ensure move scheduled
    try {
      scheduleBotIfNeeded(roomId);
    } catch (e) {}

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
      undoneMoves: [],
      replayIndex: null,
      replayFen: null,
    };

    // preserve bot settings if old had them for rematch
    if (old.settings && old.settings.bot) {
      newRoom.settings.bot = { ...old.settings.bot };
      // if bot rematch -> disable clocks and chat on new room
      newRoom.clocks = null;
      newRoom.messages = [];
      newRoom.settings.noChat = true;
    }

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
    // do not schedule first-move timer for bot rooms
    try {
      if (!isBotRoom(newRoom)) scheduleFirstMoveTimer(newRoomId);
    } catch (e) {}
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
    Undo / Redo / Replay helpers for Bot Rooms
    - undoLastMoveForBot(roomId, count = 1)
    - redoLastMoveForBot(roomId, count = 1)
    - setReplayIndex(roomId, idx)  (non-destructive navigation)
    These are intentionally only enabled for bot rooms.
    -------------------- */

function rebuildChessFromMoves(room) {
  const c = new Chess();
  const moves = Array.isArray(room.moves) ? room.moves : [];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    try {
      if (m && m.move) {
        const mv = m.move;
        c.move({
          from: mv.from,
          to: mv.to,
          promotion: mv.promotion || undefined,
        });
      } else if (typeof m === "string") {
        c.move(m);
      } else if (m && m.from && m.to) {
        c.move({
          from: m.from,
          to: m.to,
          promotion: m.promotion || undefined,
        });
      }
    } catch (e) {
      // ignore illegal moves during replay reconstruction
    }
  }
  return c;
}

/**
 * undoLastMoveForBot(roomId, count = 1)
 * - Pops up to `count` moves from room.moves (LIFO).
 * - Stores popped moves into room.undoneMoves stack so redo is possible.
 * - Rebuilds server chess from remaining moves and updates fen/lastIndex.
 * - Broadcasts room state and schedules bot move if appropriate.
 *
 * Only allowed in bot rooms.
 */
function undoLastMoveForBot(roomId, count = 1) {
  try {
    const room = rooms[roomId];
    if (!room) return { ok: false, error: "No such room" };
    if (!isBotRoom(room)) return { ok: false, error: "Not a bot room" };
    if (!Array.isArray(room.moves) || room.moves.length === 0)
      return { ok: false, error: "No moves to undo" };

    room.undoneMoves = room.undoneMoves || [];

    let removed = 0;
    for (let i = 0; i < count; i++) {
      if (!room.moves || room.moves.length === 0) break;
      const m = room.moves.pop();
      room.undoneMoves.push(m);
      removed++;
    }
    room.lastIndex =
      room.moves.length > 0 ? room.moves[room.moves.length - 1].index : -1;

    // rebuild chess and fen from remaining moves
    try {
      room.chess = rebuildChessFromMoves(room);
      room.fen = room.chess ? room.chess.fen() : null;
    } catch (e) {
      room.chess = new Chess(room.fen || undefined);
    }

    // after undo, make sure room is not considered finished if it was
    if (room.finished) {
      room.finished = null;
      room.paused = false;
    }

    broadcastRoomState(roomId);

    // if bot is now to move, schedule a choice
    try {
      scheduleBotIfNeeded(roomId);
    } catch (e) {}

    return { ok: true, removed };
  } catch (err) {
    console.error("undoLastMoveForBot error:", err);
    return { ok: false, error: "Server error" };
  }
}

/**
 * redoLastMoveForBot(roomId, count = 1)
 * - Pops up to `count` moves from room.undoneMoves (LIFO) and appends them back to room.moves preserving original order.
 * - Rebuilds room.chess and room.fen.
 *
 * Only allowed in bot rooms.
 */
function redoLastMoveForBot(roomId, count = 1) {
  try {
    const room = rooms[roomId];
    if (!room) return { ok: false, error: "No such room" };
    if (!isBotRoom(room)) return { ok: false, error: "Not a bot room" };
    room.undoneMoves = room.undoneMoves || [];
    if (!Array.isArray(room.undoneMoves) || room.undoneMoves.length === 0)
      return { ok: false, error: "No moves to redo" };

    let restored = 0;
    for (let i = 0; i < count; i++) {
      if (!room.undoneMoves || room.undoneMoves.length === 0) break;
      // we popped moves from moves into undoneMoves in LIFO order.
      // To redo the last undone, pop from undoneMoves and push onto moves.
      const m = room.undoneMoves.pop();
      room.moves.push(m);
      restored++;
    }

    room.lastIndex =
      room.moves.length > 0 ? room.moves[room.moves.length - 1].index : -1;

    // rebuild chess and fen from moves
    try {
      room.chess = rebuildChessFromMoves(room);
      room.fen = room.chess ? room.chess.fen() : null;
    } catch (e) {
      room.chess = new Chess(room.fen || undefined);
    }

    broadcastRoomState(roomId);

    // if bot to move, schedule
    try {
      scheduleBotIfNeeded(roomId);
    } catch (e) {}

    return { ok: true, restored };
  } catch (err) {
    console.error("redoLastMoveForBot error:", err);
    return { ok: false, error: "Server error" };
  }
}

/**
 * setReplayIndex(roomId, idx)
 * - Non-destructive navigation through move history.
 * - Sets room.replayIndex and room.replayFen; does NOT alter room.moves.
 * - idx can be -1 for starting position, or 0..(moves.length-1)
 */
function setReplayIndex(roomId, idx) {
  try {
    const room = rooms[roomId];
    if (!room) return { ok: false, error: "No such room" };
    const moves = Array.isArray(room.moves) ? room.moves : [];
    if (idx === null || typeof idx === "undefined") {
      room.replayIndex = null;
      room.replayFen = null;
      broadcastRoomState(roomId);
      return { ok: true, replayIndex: null, replayFen: null };
    }
    const target = Number(idx);
    if (isNaN(target) || target < -1)
      return { ok: false, error: "Invalid index" };
    const last = moves.length - 1;
    if (target > last) return { ok: false, error: "Index out of range" };

    // build a temp chess and apply moves up to target
    const c = new Chess();
    if (target >= 0) {
      for (let i = 0; i <= target; i++) {
        const m = moves[i];
        try {
          if (m && m.move) {
            c.move({
              from: m.move.from,
              to: m.move.to,
              promotion: m.move.promotion || undefined,
            });
          } else if (typeof m === "string") {
            c.move(m);
          } else if (m && m.from && m.to) {
            c.move({
              from: m.from,
              to: m.to,
              promotion: m.promotion || undefined,
            });
          }
        } catch (e) {
          // ignore
        }
      }
    }
    room.replayIndex = target;
    room.replayFen = c.fen();
    broadcastRoomState(roomId);
    return { ok: true, replayIndex: target, replayFen: room.replayFen };
  } catch (err) {
    console.error("setReplayIndex error:", err);
    return { ok: false, error: "Server error" };
  }
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
  // Bot / replay helpers
  isBotRoom,
  undoLastMoveForBot,
  redoLastMoveForBot,
  setReplayIndex,
};
