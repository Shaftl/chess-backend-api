// backend/socket.js
// Complete fixed version — copy & paste to replace your current socket.js

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
  createRematchRoom, // new helper added in roomManager
} = roomManager;

const User = require("./models/User");
const Game = require("./models/Game");
const Room = require("./models/Room");

// NEW: notification service + Notification model
const notificationService = require("./services/notificationService");
const Notification = require("./models/Notification");

const mongoose = require("mongoose");

/* ----------------- Helper functions ----------------- */

/**
 * markUserActiveRoom(userId, roomId)
 * Marks the given user document with activeRoom and status 'playing'.
 * Best-effort, logs errors but does not throw.
 */
async function markUserActiveRoom(userId, roomId) {
  try {
    if (!userId) return;
    await User.findByIdAndUpdate(
      String(userId),
      { $set: { activeRoom: roomId, status: "playing" } },
      { new: true, upsert: false }
    ).exec();
  } catch (err) {
    console.error("markUserActiveRoom error", err);
  }
}

/**
 * clearActiveRoomForUsers([userIds])
 * Clears activeRoom and sets status to 'idle' for provided user ids.
 */
async function clearActiveRoomForUsers(userIds = []) {
  try {
    const ids = (userIds || []).filter(Boolean).map(String);
    if (!ids.length) return;
    // ensure we construct ObjectId instances correctly (use new)
    const objectIds = ids
      .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
      .map((id) => new mongoose.Types.ObjectId(String(id)));
    if (objectIds.length === 0) return;
    await User.updateMany(
      { _id: { $in: objectIds } },
      { $set: { activeRoom: null, status: "idle" } }
    ).exec();
  } catch (err) {
    console.error("clearActiveRoomForUsers error", err);
  }
}

/**
 * clearActiveRoomForRoom(room)
 * Convenience to clear activeRoom for both colored players inside a room.
 */
async function clearActiveRoomForRoom(room) {
  try {
    if (!room || !Array.isArray(room.players)) return;
    const ids = room.players
      .filter((p) => p.color === "w" || p.color === "b")
      .map((p) => p?.user?.id || p?.user?._id)
      .filter(Boolean);
    if (ids.length) await clearActiveRoomForUsers(ids);
  } catch (err) {
    console.error("clearActiveRoomForRoom error", err);
  }
}

/** Helper: verifyToken */
function verifyToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded;
  } catch (e) {
    return null;
  }
}

function normId(v) {
  if (!v && v !== 0) return null;
  try {
    return String(v);
  } catch {
    return null;
  }
}

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

function mapPlayerForEmit(p) {
  const base = computeBaseUrl();
  const u = p.user || {};
  const rel = u.avatarUrl || u.avatar || null;
  const avatarUrlAbsolute =
    u.avatarUrlAbsolute ||
    (rel && String(rel).startsWith("http")
      ? rel
      : rel
      ? `${base}${rel}`
      : null);

  return {
    id: p.id,
    color: p.color,
    online: !!p.online,
    disconnectedAt: p.disconnectedAt || null,
    user: {
      id: u.id || u._id || null,
      username: u.username || null,
      displayName: u.displayName || null,
      avatarUrl: rel,
      avatarUrlAbsolute,
      country: u.country || null,
    },
  };
}

function normalizeAndValidateRoomCode(raw) {
  if (!raw || typeof raw !== "string")
    return { ok: false, error: "Missing code" };
  const t = String(raw).trim();
  if (!t) return { ok: false, error: "Missing code" };
  const code = t.toUpperCase();
  const re = /^[A-Z0-9]{4,12}$/;
  if (!re.test(code)) {
    return {
      ok: false,
      error:
        "Invalid code. Use 4–12 characters: letters and numbers only (A-Z, 0-9).",
    };
  }
  return { ok: true, code };
}

function normalizePromotionChar(p) {
  if (!p) return null;
  try {
    const s = String(p).trim().toLowerCase();
    if (!s) return null;
    if (s === "q" || s.includes("queen")) return "q";
    if (s === "r" || s.includes("rook")) return "r";
    if (s === "n" || s.includes("knight") || s === "k") return "n";
    if (
      s === "b" ||
      s.includes("bishop") ||
      s.includes("eleph") ||
      s.includes("elephant")
    )
      return "b";
    const first = s[0];
    if (["q", "r", "n", "b"].includes(first)) return first;
    return null;
  } catch (e) {
    return null;
  }
}

/* ---------------------------------------------------------------------
   Reservation helpers (enforce single active room per user)
   - tryReserveActiveRoom(userId, roomId) -> { ok, set, error }
   - releaseActiveRoom(userId, roomId) -> { ok, released, error }
   These use conditional updates so two concurrent requests won't both succeed.
   --------------------------------------------------------------------- */

async function tryReserveActiveRoom(userId, roomId) {
  try {
    if (!userId) return { ok: true, set: false };
    const uid = String(userId);
    // Attempt to set activeRoom only if currently null or empty string
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
    // Only clear if activeRoom matches roomId (best-effort to avoid clobbering)
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
    // If no doc matched (maybe already cleared or different room), still ok
    return { ok: true, released: false };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/* -------------------------------
   Matchmaking / Play Queue helpers
   (kept from your code)
   ------------------------------- */

const playQueue = new Map(); // key => entry { id, socketId, cups, ts, minutes, colorPreference }
const playQueueByCups = new Map(); // cups -> Set of keys

function queueKeyFor(entry) {
  return entry.id ? `u:${entry.id}` : `s:${entry.socketId}`;
}

async function addToPlayQueue({
  socketId,
  userId,
  cups = null,
  minutes = 5,
  colorPreference = "random",
}) {
  const key = queueKeyFor({ id: userId, socketId });
  if (playQueue.has(key)) return false;
  const ts = Date.now();
  const entry = {
    id: userId || null,
    socketId,
    cups: Number.isFinite(Number(cups)) ? Number(cups) : null,
    ts,
    minutes: Number(minutes) || 5,
    colorPreference: colorPreference || "random",
  };
  playQueue.set(key, entry);
  const cupKey = entry.cups !== null ? String(entry.cups) : "__unknown__";
  if (!playQueueByCups.has(cupKey)) playQueueByCups.set(cupKey, new Set());
  playQueueByCups.get(cupKey).add(key);
  return true;
}

function removeFromPlayQueueByKey(key) {
  const ent = playQueue.get(key);
  if (!ent) return false;
  const cupKey = ent.cups !== null ? String(ent.cups) : "__unknown__";
  if (playQueueByCups.has(cupKey)) {
    playQueueByCups.get(cupKey).delete(key);
    if (playQueueByCups.get(cupKey).size === 0) playQueueByCups.delete(cupKey);
  }
  playQueue.delete(key);
  return true;
}

function removeFromPlayQueueBySocket(socketId) {
  let removed = false;
  for (const [k, v] of playQueue) {
    if (v.socketId === socketId) {
      removeFromPlayQueueByKey(k);
      removed = true;
    }
  }
  return removed;
}

function findSocketsForKeys(keys) {
  const out = [];
  try {
    for (const k of keys) {
      const ent = playQueue.get(k);
      if (!ent) continue;
      const sock =
        ioServer &&
        ioServer.sockets &&
        ioServer.sockets.sockets.get(ent.socketId);
      if (sock) out.push({ key: k, socket: sock, entry: ent });
    }
  } catch (e) {}
  return out;
}

/* -----------------------
   Matchmaking algorithm
   (adapted from your code; includes reservation attempt on fallback creation)
   ----------------------- */

async function attemptMatchmaking() {
  if (!playQueue.size) return;
  const now = Date.now();
  const entries = Array.from(playQueue.entries())
    .map(([k, v]) => ({ key: k, entry: v }))
    .sort((a, b) => a.entry.ts - b.entry.ts);
  const used = new Set();

  for (const { key: k1, entry: e1 } of entries) {
    if (used.has(k1)) continue;
    const cups = e1.cups;
    let candidateKeys = [];
    if (cups !== null) {
      const exact = playQueueByCups.get(String(cups))
        ? Array.from(playQueueByCups.get(String(cups)))
        : [];
      candidateKeys = exact.filter((k) => k !== k1);
    } else {
      const unk = playQueueByCups.get("__unknown__")
        ? Array.from(playQueueByCups.get("__unknown__"))
        : [];
      candidateKeys = unk.filter((k) => k !== k1);
    }

    let foundKey = null;
    for (const k2 of candidateKeys) {
      if (used.has(k2)) continue;
      const e2 = playQueue.get(k2);
      if (!e2) continue;
      if (e1.id && e2.id && String(e1.id) === String(e2.id)) continue;
      const s1 = ioServer.sockets.sockets.get(e1.socketId);
      const s2 = ioServer.sockets.sockets.get(e2.socketId);
      if (!s1 || !s2) continue;
      foundKey = k2;
      break;
    }

    if (!foundKey && cups !== null) {
      const deltas = [25, 50, 100, 200, 400, 800, 1600];
      for (const delta of deltas) {
        if (foundKey) break;
        const low = cups - delta;
        const high = cups + delta;
        for (const [cupKey, setKeys] of playQueueByCups) {
          if (cupKey === "__unknown__") continue;
          const cupNum = Number(cupKey);
          if (isNaN(cupNum)) continue;
          if (cupNum >= low && cupNum <= high && cupNum !== cups) {
            for (const k2 of setKeys) {
              if (k2 === k1) continue;
              if (used.has(k2)) continue;
              const e2 = playQueue.get(k2);
              if (!e2) continue;
              if (e1.id && e2.id && String(e1.id) === String(e2.id)) continue;
              const s1 = ioServer.sockets.sockets.get(e1.socketId);
              const s2 = ioServer.sockets.sockets.get(e2.socketId);
              if (!s1 || !s2) continue;
              foundKey = k2;
              break;
            }
            if (foundKey) break;
          }
        }
      }
    }

    if (!foundKey) {
      const unkSet = playQueueByCups.get("__unknown__");
      if (unkSet) {
        for (const k2 of Array.from(unkSet)) {
          if (k2 === k1) continue;
          if (used.has(k2)) continue;
          const e2 = playQueue.get(k2);
          if (!e2) continue;
          if (e1.id && e2.id && String(e1.id) === String(e2.id)) continue;
          const s1 = ioServer.sockets.sockets.get(e1.socketId);
          const s2 = ioServer.sockets.sockets.get(e2.socketId);
          if (!s1 || !s2) continue;
          foundKey = k2;
          break;
        }
      }
    }

    if (foundKey) {
      const e2 = playQueue.get(foundKey);
      if (!e2) {
        removeFromPlayQueueByKey(foundKey);
        continue;
      }

      used.add(k1);
      used.add(foundKey);

      removeFromPlayQueueByKey(k1);
      removeFromPlayQueueByKey(foundKey);

      let createdRoomId = null;
      try {
        if (typeof roomManager.createRoom === "function") {
          const userA = e1.id ? { id: String(e1.id) } : null;
          const userB = e2.id ? { id: String(e2.id) } : null;

          const res = await roomManager.createRoom({
            minutes: Math.max(
              1,
              Math.floor(Number(e1.minutes || e2.minutes || 5))
            ),
            colorPreference:
              e1.colorPreference || e2.colorPreference || "random",
            userA,
            userB,
          });

          if (res && (res.roomId || res.id)) {
            createdRoomId = res.roomId || res.id;
          }
        }
      } catch (err) {
        console.error("play-online: roomManager.createRoom failed", err);
        createdRoomId = null;
      }

      // If createRoom failed (likely because one user busy), fallback to creating room here,
      // but attempt to reserve both DB users first to avoid races.
      if (!createdRoomId) {
        try {
          let fallbackRoomId = generateRoomCode(8);
          while (rooms[fallbackRoomId]) fallbackRoomId = generateRoomCode(8);

          // Attempt to reserve both users before building room
          let reservedA = { ok: true, set: false };
          let reservedB = { ok: true, set: false };
          const userAId = e1.id ? String(e1.id) : null;
          const userBId = e2.id ? String(e2.id) : null;

          if (userAId) {
            reservedA = await tryReserveActiveRoom(userAId, fallbackRoomId);
            if (!reservedA.ok)
              throw reservedA.error || new Error("reserve-A failed");
            if (!reservedA.set) {
              // cannot reserve A, abort fallback
              if (ioServer && ioServer.sockets.sockets.get(e1.socketId)) {
                ioServer.to(e1.socketId).emit("match-found-failed", {
                  ok: false,
                  error: "player-busy",
                });
              }
              if (userBId && reservedB.set)
                await releaseActiveRoom(userBId, fallbackRoomId);
              continue;
            }
          }

          if (userBId) {
            reservedB = await tryReserveActiveRoom(userBId, fallbackRoomId);
            if (!reservedB.ok) {
              // rollback A
              if (reservedA.set && userAId) {
                await releaseActiveRoom(userAId, fallbackRoomId);
              }
              throw reservedB.error || new Error("reserve-B failed");
            }
            if (!reservedB.set) {
              // rollback A
              if (reservedA.set && userAId) {
                await releaseActiveRoom(userAId, fallbackRoomId);
              }
              if (ioServer && ioServer.sockets.sockets.get(e2.socketId)) {
                ioServer.to(e2.socketId).emit("match-found-failed", {
                  ok: false,
                  error: "player-busy",
                });
              }
              continue;
            }
          }

          // Build fallback room (safe now)
          const room = {
            players: [],
            moves: [],
            chess: new Chess(),
            fen: null,
            lastIndex: -1,
            clocks: null,
            paused: false,
            disconnectTimers: {},
            firstMoveTimer: null,
            pendingDrawOffer: null,
            finished: null,
            settings: {
              minutes: Math.max(
                1,
                Math.floor(Number(e1.minutes || e2.minutes || 5))
              ),
              minutesMs:
                Math.max(1, Math.floor(Number(e1.minutes || e2.minutes || 5))) *
                60 *
                1000,
              creatorId: e1.id || e2.id || null,
              colorPreference:
                e1.colorPreference || e2.colorPreference || "random",
            },
            messages: [],
            rematch: null,
          };

          let userDocA = null;
          let userDocB = null;
          try {
            if (e1.id) userDocA = await User.findById(e1.id).lean().exec();
          } catch (e) {}
          try {
            if (e2.id) userDocB = await User.findById(e2.id).lean().exec();
          } catch (e) {}
          if (userDocA) userDocA = ensureAvatarAbs(userDocA);
          if (userDocB) userDocB = ensureAvatarAbs(userDocB);

          const pA = {
            id: e1.socketId,
            user: userDocA || {
              id: e1.id,
              username: userDocA?.username || "guest",
            },
            color: "w",
            online: true,
            disconnectedAt: null,
          };
          const pB = {
            id: e2.socketId,
            user: userDocB || {
              id: e2.id,
              username: userDocB?.username || "guest",
            },
            color: "b",
            online: true,
            disconnectedAt: null,
          };

          if (room.settings.colorPreference === "random") {
            if (Math.random() < 0.5) {
              pA.color = "w";
              pB.color = "b";
            } else {
              pA.color = "b";
              pB.color = "w";
            }
          } else if (room.settings.colorPreference === "white") {
            pA.color = "w";
            pB.color = "b";
          } else if (room.settings.colorPreference === "black") {
            pA.color = "b";
            pB.color = "w";
          }

          room.players.push(pA);
          room.players.push(pB);

          room.clocks = {
            w: room.settings.minutesMs,
            b: room.settings.minutesMs,
            running: room.chess.turn(),
            lastTick: Date.now(),
          };

          rooms[fallbackRoomId] = room;
          broadcastRoomState(fallbackRoomId);
          scheduleFirstMoveTimer(fallbackRoomId);
          createdRoomId = fallbackRoomId;
        } catch (err) {
          console.error("play-online: fallback room creation failed", err);
          // try to rollback any reservations if present
          try {
            // best-effort: release any reserved DB activeRoom set to that fallback id
            if (e1.id)
              await releaseActiveRoom(String(e1.id), createdRoomId || null);
            if (e2.id)
              await releaseActiveRoom(String(e2.id), createdRoomId || null);
          } catch (e) {}
          createdRoomId = null;
        }
      }

      if (createdRoomId) {
        try {
          const s1 = ioServer.sockets.sockets.get(e1.socketId);
          const s2 = ioServer.sockets.sockets.get(e2.socketId);
          if (s1) s1.join(createdRoomId);
          if (s2) s2.join(createdRoomId);

          const payload = {
            ok: true,
            roomId: createdRoomId,
            message: "Match found — joining room",
            assignedColors: {},
          };

          try {
            const r = rooms[createdRoomId];
            if (r && Array.isArray(r.players)) {
              for (const p of r.players) {
                payload.assignedColors[p.user?.id || p.id || p.id] = p.color;
              }
            }
          } catch (e) {}

          if (s1) s1.emit("match-found", payload);
          if (s2) s2.emit("match-found", payload);

          try {
            const room = rooms[createdRoomId];
            if (room) {
              if (s1) {
                const p =
                  room.players.find((pp) => pp.id === e1.socketId) ||
                  room.players[0];
                if (p) s1.emit("player-assigned", { color: p.color });
              }
              if (s2) {
                const p =
                  room.players.find((pp) => pp.id === e2.socketId) ||
                  room.players[1];
                if (p) s2.emit("player-assigned", { color: p.color });
              }
              ioServer.to(createdRoomId).emit("room-update", {
                players: room.players.map(mapPlayerForEmit),
                moves: room.moves,
                fen: room.chess ? room.chess.fen() : room.fen,
                lastIndex: room.lastIndex,
                clocks: room.clocks
                  ? {
                      w: room.clocks.w,
                      b: room.clocks.b,
                      running: room.clocks.running,
                    }
                  : null,
                finished: room.finished || null,
                pendingDrawOffer: room.pendingDrawOffer || null,
                settings: room.settings || null,
                messages: (room.messages || []).slice(
                  -Math.min(MAX_CHAT_MESSAGES, room.messages.length || 0)
                ),
                pendingRematch: room.rematch
                  ? {
                      initiatorSocketId: room.rematch.initiatorSocketId || null,
                      initiatorUserId: room.rematch.initiatorUserId || null,
                      acceptedBy: room.rematch.acceptedBy
                        ? Object.keys(room.rematch.acceptedBy)
                        : [],
                    }
                  : null,
              });
            }
          } catch (e) {}
        } catch (err) {
          console.error("play-online: final join emit failed", err);
        }
      } else {
        try {
          const s1 = ioServer.sockets.sockets.get(e1.socketId);
          const s2 = ioServer.sockets.sockets.get(e2.socketId);
          if (s1)
            s1.emit("match-queue-error", {
              ok: false,
              error: "Match created but room creation failed",
            });
          if (s2)
            s2.emit("match-queue-error", {
              ok: false,
              error: "Match created but room creation failed",
            });
        } catch (e) {}
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Init sockets and wire up your existing listeners (kept intact)      */
/* ------------------------------------------------------------------ */

let ioServer = null;

function initSockets(server, CLIENT_ORIGIN = "https://chess-alyas.vercel.app") {
  const io = new Server(server, {
    cors: { origin: CLIENT_ORIGIN, credentials: true },
  });
  ioServer = io;
  roomManager.init(io);

  const MATCHMAKING_INTERVAL_MS = 1000;
  const matchmakingTimer = setInterval(() => {
    try {
      attemptMatchmaking().catch((e) => {
        console.error("matchmaking error:", e);
      });
    } catch (e) {}
  }, MATCHMAKING_INTERVAL_MS);

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
        saveFinishedGame(roomId).catch(() => {});
      }
    });
  }, 500);

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

    /* -------------------------
       Event handlers (full; kept your logic intact)
       ------------------------- */

    socket.on("check-room", async ({ roomId }, cb) => {
      try {
        let exists = !!rooms[roomId];
        if (!exists) {
          try {
            const doc = await Room.findOne({ roomId }).lean().exec();
            exists = !!doc;
          } catch (e) {}
        }
        if (typeof cb === "function") {
          cb({ exists });
        }
      } catch (e) {
        if (typeof cb === "function") cb({ exists: false });
      }
    });

    socket.on(
      "create-room",
      async ({ roomId: requestedRoomId, minutes, colorPreference, user }) => {
        try {
          let minutesNum =
            typeof minutes === "number"
              ? Math.max(1, Math.floor(minutes))
              : Math.floor(DEFAULT_MS / 60000);
          const minutesMs = minutesNum * 60 * 1000;

          let roomId = null;

          if (requestedRoomId && String(requestedRoomId).trim()) {
            const val = normalizeAndValidateRoomCode(requestedRoomId);
            if (!val.ok) {
              socket.emit("room-created", { ok: false, error: val.error });
              return;
            }
            roomId = val.code;
            if (rooms[roomId]) {
              socket.emit("room-created", {
                ok: false,
                error: `Room code "${roomId}" is already in use. Choose a different code.`,
              });
              return;
            }
          } else {
            roomId = generateRoomCode();
            let attempts = 0;
            while (rooms[roomId] && attempts < 8) {
              roomId = generateRoomCode();
              attempts++;
            }
            if (rooms[roomId]) {
              socket.emit("room-created", {
                ok: false,
                error: "Unable to generate unique room code, please try again.",
              });
              return;
            }
          }

          // create in-memory room (no pre-reservation for single-player create)
          rooms[roomId] = {
            players: [],
            moves: [],
            chess: new Chess(),
            fen: null,
            lastIndex: -1,
            clocks: null,
            paused: false,
            disconnectTimers: {},
            firstMoveTimer: null,
            pendingDrawOffer: null,
            finished: null,
            settings: {
              minutes: minutesNum,
              minutesMs,
              creatorId: socket.user?.id || socket.id,
              colorPreference: colorPreference || "random",
            },
            messages: [],
            rematch: null,
          };

          const room = rooms[roomId];

          let assignedColor = "spectator";
          if (socket.user) {
            const playerObj = {
              id: socket.id,
              user: socket.user || user || { username: "guest" },
              color: "spectator",
              online: true,
              disconnectedAt: null,
            };

            playerObj.user = ensureAvatarAbs(playerObj.user);

            const pref = room.settings.colorPreference;
            const wTaken = room.players.some((p) => p.color === "w");
            const bTaken = room.players.some((p) => p.color === "b");

            if (pref === "white" && !wTaken) assignedColor = "w";
            else if (pref === "black" && !bTaken) assignedColor = "b";
            else {
              if (!wTaken) assignedColor = "w";
              else if (!bTaken) assignedColor = "b";
              else assignedColor = "spectator";
            }

            playerObj.color = assignedColor;
            room.players.push(playerObj);
            socket.emit("player-assigned", { color: playerObj.color });

            // IMPORTANT: do NOT mark DB activeRoom here for single-player creation.
            // We only mark activeRoom for a DB user when they actually become
            // part of an active two-player match (handled on join / on second player).
          } else {
            const playerObj = {
              id: socket.id,
              user: user || { username: "guest" },
              color: "spectator",
              online: true,
              disconnectedAt: null,
            };
            playerObj.user = ensureAvatarAbs(playerObj.user);

            room.players.push(playerObj);
            assignedColor = "spectator";
            socket.emit("player-assigned", { color: "spectator" });
          }

          // broadcast and schedule expiry (roomManager.broadcastRoomState
          // will automatically cancel expiry when second player joins)
          broadcastRoomState(roomId);

          // If there's only <2 colored players, schedule an expiry timer for this room
          // (clears/finishes room after settings.minutesMs). This is done in roomManager.js
          // via scheduleRoomExpiry called inside broadcastRoomState (if needed).

          socket.join(roomId);
          socket.emit("room-created", {
            ok: true,
            roomId,
            settings: room.settings,
            assignedColor,
          });
          console.log(
            "Room created:",
            roomId,
            "by",
            socket.user?.username || socket.id
          );
        } catch (err) {
          console.error("create-room outer error", err);
          socket.emit("room-created", { ok: false, error: "Server error" });
        }
      }
    );

    socket.on("join-room", async ({ roomId, user }) => {
      if (!roomId) return;

      // If room not present in memory, attempt to load persisted snapshot (existing logic kept)
      if (!rooms[roomId]) {
        try {
          const doc = await Room.findOne({ roomId }).lean().exec();
          if (doc) {
            socket.join(roomId);
            socket.emit("room-update", {
              players: (doc.players || []).map((p) => ({
                id: p.id,
                user: p.user,
                color: p.color,
                online: !!p.online,
                disconnectedAt: p.disconnectedAt || null,
              })),
              moves: doc.moves || [],
              fen: doc.fen || null,
              lastIndex:
                typeof doc.lastIndex !== "undefined" ? doc.lastIndex : -1,
              clocks: doc.clocks || null,
              finished: doc.finished || null,
              pendingDrawOffer: doc.pendingDrawOffer || null,
              settings: doc.settings || null,
              messages: (doc.messages || []).slice(
                -Math.min(MAX_CHAT_MESSAGES, doc.messages.length || 0)
              ),
              pendingRematch: doc.rematch
                ? {
                    initiatorSocketId: doc.rematch.initiatorSocketId || null,
                    initiatorUserId: doc.rematch.initiatorUserId || null,
                    acceptedBy: doc.rematch.acceptedBy
                      ? Object.keys(doc.rematch.acceptedBy)
                      : [],
                  }
                : null,
            });

            if (doc.finished) {
              socket.emit("room-finished", {
                roomId,
                finished: true,
                message:
                  doc.finished.message ||
                  "This room has finished and is view-only.",
              });
            }

            return;
          } else {
            try {
              socket.emit("no-such-room", { roomId });
            } catch (e) {}
            return;
          }
        } catch (err) {
          console.error("join-room: error loading persisted room", err);
          try {
            socket.emit("no-such-room", { roomId });
          } catch (e) {}
          return;
        }
      }

      // join in-memory flow (original)
      socket.join(roomId);
      const room = rooms[roomId];

      if (!room.chess) {
        room.chess = room.fen ? new Chess(room.fen) : new Chess();
        room.fen = room.chess.fen();
        room.lastIndex = room.moves.length
          ? room.moves[room.moves.length - 1].index
          : -1;
      }

      const candidateUserId = normId(socket.user?.id ?? user?.id ?? user?._id);
      const candidateUsername =
        socket.user?.username ??
        user?.username ??
        (user && user.fromUsername) ??
        null;

      // --- NEW: server-side guard: if DB user already has activeRoom (different), deny join ---
      if (candidateUserId) {
        try {
          const dbUser = await User.findById(candidateUserId).lean().exec();
          if (
            dbUser &&
            dbUser.activeRoom &&
            String(dbUser.activeRoom) !== String(roomId)
          ) {
            try {
              socket.emit("join-denied-active-room", {
                reason: "already_active",
                message: "You already have an active game.",
                activeRoom: dbUser.activeRoom,
              });
              // also emit a notification fallback for clients that rely on 'notification' relay
              socket.emit("notification", {
                type: "join_denied_active_room",
                activeRoom: dbUser.activeRoom,
                message: "You already have an active game.",
              });
            } catch (e) {}
            return;
          }
        } catch (err) {
          console.error("join-room: error checking user activeRoom", err);
        }
      }

      // --- locate existing player entry (original logic) ---
      let existing = null;
      if (candidateUserId) {
        existing = room.players.find(
          (p) => p.user && normId(p.user.id) === candidateUserId
        );
      }
      if (!existing && candidateUsername) {
        existing = room.players.find(
          (p) => p.user && p.user.username === candidateUsername
        );
      }
      if (!existing) {
        existing = room.players.find((p) => p.id === socket.id);
      }

      if (existing) {
        clearDisconnectTimer(room, existing.id);
        existing.id = socket.id;
        existing.user = socket.user ||
          existing.user ||
          user || { username: "guest" };
        existing.user = ensureAvatarAbs(existing.user);
        existing.online = true;
        existing.disconnectedAt = null;

        socket.emit("player-assigned", {
          color: existing.color || "spectator",
        });

        // mark DB user activeRoom if they are a colored (playing) seat
        if (
          existing.user &&
          (existing.color === "w" || existing.color === "b")
        ) {
          try {
            const uid = existing.user.id || existing.user._id;
            await markUserActiveRoom(uid, roomId);
          } catch (e) {
            console.error(
              "markUserActiveRoom after existing player assignment failed",
              e
            );
          }
        }
      } else {
        // create new player object (original)
        let assignedColor = "spectator";
        if (socket.user) {
          const wTaken = room.players.some((p) => p.color === "w");
          const bTaken = room.players.some((p) => p.color === "b");
          if (!wTaken) assignedColor = "w";
          else if (!bTaken) assignedColor = "b";
          else assignedColor = "spectator";
        } else {
          assignedColor = "spectator";
        }

        const playerObj = {
          id: socket.id,
          user: socket.user || user || { username: "guest" },
          color: assignedColor,
          online: true,
          disconnectedAt: null,
        };
        playerObj.user = ensureAvatarAbs(playerObj.user);

        room.players.push(playerObj);
        socket.emit("player-assigned", { color: playerObj.color });

        // mark DB user activeRoom if assigned color w/b and user exists
        try {
          const uid =
            playerObj.user && (playerObj.user.id || playerObj.user._id);
          if (uid && (playerObj.color === "w" || playerObj.color === "b")) {
            await markUserActiveRoom(uid, roomId);
          }
        } catch (e) {
          console.error("markUserActiveRoom error after new player push", e);
        }
      }

      clearDisconnectTimer(room, socket.id);

      // clocks / ready notifications (original logic)
      const coloredPlayers = room.players.filter(
        (p) => p.color === "w" || p.color === "b"
      );

      if (!room.clocks && !room.finished) {
        if (coloredPlayers.length === 2) {
          const minutes =
            room.settings?.minutes || Math.floor(DEFAULT_MS / 60000);
          const ms = room.settings?.minutesMs || minutes * 60 * 1000;
          room.clocks = {
            w: ms,
            b: ms,
            running: room.chess.turn(),
            lastTick: Date.now(),
          };
          scheduleFirstMoveTimer(roomId);
        }
      } else {
        if (
          coloredPlayers.length === 2 &&
          !room.clocks?.running &&
          !room.finished
        ) {
          room.clocks.running = room.chess.turn();
          room.clocks.lastTick = Date.now();
          room.paused = false;
          scheduleFirstMoveTimer(roomId);
        }
      }

      broadcastRoomState(roomId);

      if (coloredPlayers.length === 2 && !room.finished) {
        io.to(roomId).emit("room-ready", {
          ok: true,
          message: "Two players connected — game ready",
        });
      } else if (!room.finished) {
        io.to(roomId).emit("room-waiting", {
          ok: false,
          message: "Waiting for second player...",
        });
      } else {
        io.to(roomId).emit("game-over", { ...room.finished });
      }
    });

    socket.on("make-move", async ({ roomId, move }) => {
      try {
        if (!roomId || !move) return;
        const room = rooms[roomId];
        if (!room) {
          socket.emit("error", { error: "Room not found" });
          return;
        }

        if (room.finished) {
          socket.emit("game-over", { ...room.finished });
          return;
        }

        const player = room.players.find((p) => p.id === socket.id) || null;
        if (!player) {
          socket.emit("not-your-room", { error: "You are not in this room" });
          return;
        }
        if (player.color === "spectator") {
          socket.emit("not-your-turn", { error: "Spectators cannot move" });
          return;
        }

        const colored = room.players.filter(
          (p) => p.color === "w" || p.color === "b"
        );
        if (colored.length < 2) {
          socket.emit("not-enough-players", {
            error: "Game requires two players to start",
          });
          io.to(roomId).emit("room-waiting", {
            ok: false,
            message: "Waiting for second player...",
          });
          return;
        }

        if (!room.chess) {
          room.chess = room.fen ? new Chess(room.fen) : new Chess();
        }
        const chess = room.chess;

        const currentTurn = chess.turn();
        if (!currentTurn) {
          socket.emit("error", { error: "Unable to determine turn" });
          return;
        }
        if (player.color !== currentTurn) {
          socket.emit("not-your-turn", {
            error: "It is not your turn",
            currentTurn,
          });
          return;
        }

        try {
          if (move && move.promotion) {
            const p = normalizePromotionChar(move.promotion);
            if (p) move.promotion = p;
            else delete move.promotion;
          }
        } catch (e) {}

        const result = chess.move(move);
        if (!result) {
          socket.emit("invalid-move", {
            reason: "illegal move on server",
            move,
          });
          socket.emit("room-update", {
            players: room.players.map(mapPlayerForEmit),
            moves: room.moves,
            fen: chess.fen(),
            lastIndex: room.lastIndex,
            clocks: room.clocks
              ? {
                  w: room.clocks.w,
                  b: room.clocks.b,
                  running: room.clocks.running,
                }
              : null,
            finished: room.finished || null,
            messages: (room.messages || []).slice(
              -Math.min(MAX_CHAT_MESSAGES, room.messages.length)
            ),
          });
          return;
        }

        room.lastIndex = (room.lastIndex ?? -1) + 1;
        const record = { index: room.lastIndex, move };
        room.moves.push(record);
        room.fen = chess.fen();

        clearFirstMoveTimer(room);

        let finishedObj = null;

        const gameOver =
          (typeof chess.game_over === "function" && chess.game_over()) || false;

        let isCheckmate =
          (typeof chess.in_checkmate === "function" && chess.in_checkmate()) ||
          false;
        let isStalemate =
          (typeof chess.in_stalemate === "function" && chess.in_stalemate()) ||
          false;
        const isThreefold =
          (typeof chess.in_threefold_repetition === "function" &&
            chess.in_threefold_repetition()) ||
          false;
        const isInsufficient =
          (typeof chess.insufficient_material === "function" &&
            chess.insufficient_material()) ||
          false;
        const isDraw =
          (typeof chess.in_draw === "function" && chess.in_draw()) || false;

        try {
          if (!isCheckmate && !isStalemate) {
            let movesList = [];
            try {
              movesList =
                typeof chess.moves === "function"
                  ? chess.moves({ verbose: true })
                  : [];
            } catch (e) {
              try {
                movesList =
                  typeof chess.moves === "function" ? chess.moves() : [];
              } catch (e2) {
                movesList = [];
              }
            }

            if (!Array.isArray(movesList)) movesList = [];

            if (movesList.length === 0) {
              const inCheckNow =
                (typeof chess.in_check === "function" && chess.in_check()) ||
                (typeof chess.inCheck === "function" && chess.inCheck()) ||
                (typeof chess.isInCheck === "function" && chess.isInCheck()) ||
                (typeof chess.isCheck === "function" && chess.isCheck()) ||
                false;

              if (inCheckNow) {
                isCheckmate = true;
              } else {
                isStalemate = true;
              }

              console.warn(
                "[GAME DETECTION FALLBACK] no legal moves ->",
                `inCheckNow=${inCheckNow}, isCheckmate=${isCheckmate}, isStalemate=${isStalemate}`,
                "move:",
                JSON.stringify(move),
                "fen:",
                (() => {
                  try {
                    return chess.fen();
                  } catch {
                    return "<fen-error>";
                  }
                })()
              );
            }
          }
        } catch (e) {
          console.error("Fallback detection error:", e);
        }

        if (isCheckmate) {
          const winner = result.color;
          const loser = winner === "w" ? "b" : "w";
          finishedObj = {
            reason: "checkmate",
            winner,
            loser,
            message: `${winner.toUpperCase()} wins by checkmate`,
            finishedAt: Date.now(),
          };
        } else if (isStalemate) {
          finishedObj = {
            reason: "stalemate",
            result: "draw",
            message: "Draw by stalemate",
            finishedAt: Date.now(),
          };
        } else if (isThreefold) {
          finishedObj = {
            reason: "threefold-repetition",
            result: "draw",
            message: "Draw by threefold repetition",
            finishedAt: Date.now(),
          };
        } else if (isInsufficient) {
          finishedObj = {
            reason: "insufficient-material",
            result: "draw",
            message: "Draw by insufficient material",
            finishedAt: Date.now(),
          };
        } else if (isDraw || gameOver) {
          finishedObj = {
            reason: "draw",
            result: "draw",
            message: "Draw",
            finishedAt: Date.now(),
          };
        }

        if (!room.clocks) {
          if (!finishedObj) {
            const minutes =
              room.settings?.minutes || Math.floor(DEFAULT_MS / 60000);
            const ms = room.settings?.minutesMs || minutes * 60 * 1000;
            room.clocks = {
              w: ms,
              b: ms,
              running: chess.turn(),
              lastTick: Date.now(),
            };
          } else {
            room.clocks = {
              w: room.clocks?.w ?? DEFAULT_MS,
              b: room.clocks?.b ?? DEFAULT_MS,
              running: null,
              lastTick: null,
            };
          }
        } else {
          if (finishedObj) {
            room.paused = true;
            room.clocks.running = null;
            room.clocks.lastTick = null;
          } else {
            room.clocks.running = chess.turn();
            room.clocks.lastTick = Date.now();
          }
        }

        if (room.pendingDrawOffer) {
          if (
            room.pendingDrawOffer.fromSocketId === player.id ||
            (player.user && room.pendingDrawOffer.fromUserId === player.user.id)
          ) {
            room.pendingDrawOffer = null;
          }
        }

        socket.to(roomId).emit("opponent-move", {
          ...record,
          fen: room.fen,
          clocks: room.clocks
            ? {
                w: room.clocks.w,
                b: room.clocks.b,
                running: room.clocks.running,
              }
            : null,
        });

        if (finishedObj) {
          room.finished = finishedObj;
          room.paused = true;
          if (room.clocks) {
            room.clocks.running = null;
            room.clocks.lastTick = null;
          }

          io.to(roomId).emit("game-over", { ...room.finished });
          clearFirstMoveTimer(room);
          Object.keys(room.disconnectTimers || {}).forEach((sid) =>
            clearDisconnectTimer(room, sid)
          );
          broadcastRoomState(roomId);
          try {
            await saveFinishedGame(roomId);
          } catch (err) {
            console.error("saveFinishedGame error:", err);
          }
        } else {
          broadcastRoomState(roomId);
        }
      } catch (err) {
        console.error("make-move error", err);
      }
    });

    // ---------- SECOND HALF: resign, draw, chat, timeouts, sync, leave, save, rematch, challenge, friends, matchmaking, webrtc, disconnect ----------

    socket.on("resign", async ({ roomId }) => {
      if (!roomId) return;
      try {
        const room = rooms[roomId];
        if (!room) return;
        const playerIdx = room.players.findIndex((p) => p.id === socket.id);
        if (playerIdx === -1) return;
        const player = room.players[playerIdx];

        if ((player.color === "w" || player.color === "b") && !room.finished) {
          const winnerColor = player.color === "w" ? "b" : "w";
          room.paused = true;
          if (room.clocks) {
            room.clocks.running = null;
            room.clocks.lastTick = null;
          }
          room.finished = {
            reason: "resign",
            winner: winnerColor,
            loser: player.color,
            message: `Player ${player.user?.username || player.id} resigned`,
            finishedAt: Date.now(),
          };
          io.to(roomId).emit("game-over", { ...room.finished });
          clearFirstMoveTimer(room);
          Object.keys(room.disconnectTimers || {}).forEach((sid) =>
            clearDisconnectTimer(room, sid)
          );
          broadcastRoomState(roomId);

          // --- NEW: clear DB activeRoom for both players in this room ---
          try {
            await clearActiveRoomForRoom(room);
          } catch (e) {
            console.error("clearActiveRoomForRoom after resign failed", e);
          }

          await saveFinishedGame(roomId);
        }

        room.players = room.players.filter((p) => p.id !== socket.id);
        broadcastRoomState(roomId);
      } catch (err) {
        console.error("resign handler error", err);
      }
    });

    socket.on("offer-draw", async ({ roomId }) => {
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room || room.finished) return;
      const player = room.players.find((p) => p.id === socket.id);
      if (!player) return;
      if (!(player.color === "w" || player.color === "b")) return;

      room.pendingDrawOffer = {
        fromSocketId: socket.id,
        fromUserId: player.user?.id || null,
      };

      const opponent = room.players.find(
        (p) => p.color !== player.color && (p.color === "w" || p.color === "b")
      );
      if (opponent) {
        io.to(opponent.id).emit("draw-offered", { from: player.user });
        // Persist notification for opponent
        try {
          const targetUserId = opponent.user?.id || opponent.id;
          await notificationService.createNotification(
            String(targetUserId),
            "draw_offer",
            "Draw offered",
            `${player.user?.username || "Opponent"} offered a draw.`,
            { fromUserId: player.user?.id || null, roomId }
          );
        } catch (e) {
          console.error("createNotification (draw_offer) failed", e);
        }
      }
      broadcastRoomState(roomId);
    });

    socket.on("accept-draw", async ({ roomId }) => {
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room) return;
      if (room.finished) {
        socket.emit("game-over", { ...room.finished });
        return;
      }
      const offer = room.pendingDrawOffer;
      if (!offer) return;

      let offerer = null;
      if (offer.fromUserId) {
        offerer = room.players.find(
          (p) => p.user && p.user.id === offer.fromUserId
        );
      }
      if (!offerer && offer.fromSocketId) {
        offerer = room.players.find((p) => p.id === offer.fromSocketId);
      }

      const acceptor = room.players.find((p) => p.id === socket.id);
      if (!offerer || !acceptor) return;
      if (offerer.color === acceptor.color) return;

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
      io.to(roomId).emit("game-over", { ...room.finished });
      clearFirstMoveTimer(room);
      Object.keys(room.disconnectTimers || {}).forEach((sid) =>
        clearDisconnectTimer(room, sid)
      );
      broadcastRoomState(roomId);
      await saveFinishedGame(roomId);

      // Notify both parties that draw was accepted (persisted notifications)
      try {
        const offererId = offerer.user?.id || offerer.id;
        const acceptorId = acceptor.user?.id || acceptor.id;
        await notificationService.createNotification(
          String(offererId),
          "draw_accepted",
          "Draw accepted",
          `${acceptor.user?.username || "Opponent"} accepted your draw.`,
          { roomId }
        );
        await notificationService.createNotification(
          String(acceptorId),
          "draw_confirmed",
          "Draw confirmed",
          `You accepted a draw.`,
          { roomId }
        );
      } catch (e) {
        console.error("createNotification (draw accepted) failed", e);
      }

      // --- FINAL FIX: mark original draw_offer notification for the acceptor as read + emit update ---
      try {
        const orig = await Notification.findOneAndUpdate(
          { "data.roomId": roomId, userId: String(socket.user?.id) },
          {
            $set: {
              read: true,
              updatedAt: Date.now(),
              "data.status": "accepted",
            },
          },
          { new: true }
        )
          .lean()
          .exec();
        if (orig) {
          try {
            const payload = {
              id: orig._id?.toString(),
              _id: orig._1d?.toString
                ? orig._id?.toString()
                : orig._id?.toString(),
              userId: orig.userId,
              type: orig.type,
              title: orig.title,
              body: orig.body,
              data: orig.data,
              read: orig.read,
              createdAt: orig.createdAt,
              updatedAt: orig.updatedAt,
            };
            io.to(`user:${String(socket.user?.id)}`).emit(
              "notification",
              payload
            );
          } catch (e) {}
        }
      } catch (e) {
        console.error(
          "accept-draw: mark original draw_offer notification failed",
          e
        );
      }
    });

    socket.on("decline-draw", ({ roomId }) => {
      try {
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;
        room.pendingDrawOffer = null;
        broadcastRoomState(roomId);

        // mark original draw_offer as declined for this user
        (async () => {
          try {
            const orig = await Notification.findOneAndUpdate(
              { "data.roomId": roomId, userId: String(socket.user?.id) },
              {
                $set: {
                  read: true,
                  updatedAt: Date.now(),
                  "data.status": "declined",
                },
              },
              { new: true }
            )
              .lean()
              .exec();
            if (orig) {
              try {
                io.to(`user:${String(socket.user?.id)}`).emit("notification", {
                  id: orig._id?.toString(),
                  _id: orig._id?.toString(),
                  ...orig,
                });
              } catch (e) {}
            }
          } catch (e) {
            console.error(
              "decline-draw: mark original draw_offer notification failed",
              e
            );
          }
        })();
      } catch (err) {
        console.error("decline-draw error", err);
      }
    });

    socket.on("send-chat", ({ roomId, text }) => {
      try {
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;
        if (!text || typeof text !== "string") return;
        const trimmed = text.trim().slice(0, 2000);
        if (!trimmed) return;

        const msg = {
          id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
          text: trimmed,
          ts: Date.now(),
          user: socket.user || { username: socket.user?.username || "guest" },
        };

        room.messages = room.messages || [];
        room.messages.push(msg);
        if (room.messages.length > MAX_CHAT_MESSAGES) {
          room.messages = room.messages.slice(-MAX_CHAT_MESSAGES);
        }

        io.to(roomId).emit("chat-message", msg);
        broadcastRoomState(roomId);
      } catch (err) {
        console.error("send-chat error", err);
      }
    });

    socket.on("player-timeout", async ({ roomId, loser }) => {
      if (!roomId || !loser) return;
      const room = rooms[roomId];
      if (!room) return;
      if (room.finished) {
        socket.emit("game-over", { ...room.finished });
        return;
      }
      if (
        room.clocks &&
        typeof room.clocks[loser] === "number" &&
        room.clocks[loser] <= 0
      ) {
        room.paused = true;
        if (room.clocks) {
          room.clocks.running = null;
          room.clocks.lastTick = null;
        }
        const winner = loser === "w" ? "b" : "w";
        room.finished = {
          reason: "timeout",
          winner,
          loser,
          message: `${winner.toUpperCase()} wins by timeout`,
          finishedAt: Date.now(),
        };
        io.to(roomId).emit("game-over", { ...room.finished });
        clearFirstMoveTimer(room);
        Object.keys(room.disconnectTimers || {}).forEach((sid) =>
          clearDisconnectTimer(room, sid)
        );
        broadcastRoomState(roomId);
        await saveFinishedGame(roomId);
      }
    });

    socket.on("request-sync", async ({ roomId }) => {
      if (!roomId || !rooms[roomId]) {
        try {
          const doc = await Room.findOne({ roomId }).lean().exec();
          if (!doc) {
            socket.emit("room-update", {
              players: [],
              moves: [],
              fen: null,
              lastIndex: -1,
              clocks: null,
              finished: null,
              messages: [],
            });
            return;
          }

          socket.emit("room-update", {
            players: (doc.players || []).map((p) => ({
              id: p.id,
              user: p.user,
              color: p.color,
              online: !!p.online,
              disconnectedAt: p.disconnectedAt || null,
            })),
            moves: doc.moves || [],
            fen: doc.fen || null,
            lastIndex:
              typeof doc.lastIndex !== "undefined" ? doc.lastIndex : -1,
            clocks: doc.clocks || null,
            finished: doc.finished || null,
            pendingDrawOffer: doc.pendingDrawOffer || null,
            settings: doc.settings || null,
            messages: (doc.messages || []).slice(
              -Math.min(MAX_CHAT_MESSAGES, doc.messages.length || 0)
            ),
            pendingRematch: doc.rematch
              ? {
                  initiatorSocketId: doc.rematch.initiatorSocketId || null,
                  initiatorUserId: doc.rematch.initiatorUserId || null,
                  acceptedBy: doc.rematch.acceptedBy
                    ? Object.keys(doc.rematch.acceptedBy)
                    : [],
                }
              : null,
          });
          return;
        } catch (err) {
          socket.emit("room-update", {
            players: [],
            moves: [],
            fen: null,
            lastIndex: -1,
            clocks: null,
            finished: null,
            messages: [],
          });
          return;
        }
      }

      const r = rooms[roomId];

      socket.emit("room-update", {
        players: r.players.map(mapPlayerForEmit),
        moves: r.moves,
        fen: r.chess ? r.chess.fen() : r.fen,
        lastIndex: r.lastIndex,
        clocks: r.clocks
          ? { w: r.clocks.w, b: r.clocks.b, running: r.clocks.running }
          : null,
        finished: r.finished || null,
        pendingDrawOffer: (() => {
          if (!r.pendingDrawOffer) return null;
          let offerer = null;
          if (r.pendingDrawOffer.fromUserId) {
            offerer = r.players.find(
              (p) => p.user && p.user.id === r.pendingDrawOffer.fromUserId
            );
          }
          if (!offerer && r.pendingDrawOffer.fromSocketId) {
            offerer = r.players.find(
              (p) => p.id === r.pendingDrawOffer.fromSocketId
            );
          }
          if (offerer && offerer.user) {
            const u = offerer.user;
            return {
              from: {
                id: u.id,
                username: u.username,
                displayName: u.displayName,
                avatarUrl:
                  u.avatarUrl || u.avatarUrlAbsolute || u.avatar || null,
                avatarUrlAbsolute:
                  u.avatarUrlAbsolute ||
                  (u.avatarUrl && String(u.avatarUrl).startsWith("http")
                    ? u.avatarUrl
                    : u.avatarUrl
                    ? `${computeBaseUrl()}${u.avatarUrl}`
                    : null),
              },
            };
          }
          return null;
        })(),
        settings: r.settings || null,
        messages: (r.messages || []).slice(
          -Math.min(MAX_CHAT_MESSAGES, r.messages || 0)
        ),
        pendingRematch: r.rematch
          ? {
              initiatorSocketId: r.rematch.initiatorSocketId || null,
              initiatorUserId: r.rematch.initiatorUserId || null,
              acceptedBy: r.rematch.acceptedBy
                ? Object.keys(r.rematch.acceptedBy)
                : [],
            }
          : null,
      });
    });

    // leave-room handler with DB clear (kept your logic and improved clearing)
    socket.on("leave-room", async ({ roomId }) => {
      if (!roomId || !rooms[roomId]) return;
      const room = rooms[roomId];
      socket.leave(roomId);
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx === -1) return;
      const player = room.players[idx];

      if ((player.color === "w" || player.color === "b") && !room.finished) {
        const winnerColor = player.color === "w" ? "b" : "w";
        room.paused = true;
        if (room.clocks) {
          room.clocks.running = null;
          room.clocks.lastTick = null;
        }
        room.finished = {
          reason: "leave-resign",
          winner: winnerColor,
          loser: player.color,
          message: `Player ${player.user?.username || player.id} left (resign)`,
          finishedAt: Date.now(),
        };
        io.to(roomId).emit("game-over", { ...room.finished });
        clearFirstMoveTimer(room);
        Object.keys(room.disconnectTimers || {}).forEach((sid) =>
          clearDisconnectTimer(room, sid)
        );
        broadcastRoomState(roomId);
        await saveFinishedGame(roomId);
      }

      // remove the player socket entry
      room.players = room.players.filter((p) => p.id !== socket.id);
      broadcastRoomState(roomId);

      // Best-effort: clear activeRoom for this user in DB (if authenticated)
      try {
        const uid = normId(player?.user?.id || player?.user?._id || null);
        if (uid) {
          await User.updateOne(
            { _id: uid },
            { $set: { activeRoom: null } }
          ).exec();
        }
      } catch (e) {
        console.warn("leave-room: failed to clear activeRoom (non-fatal):", e);
      }
    });

    socket.on("save-game", ({ roomId, fen, moves, players }) => {
      io.to(roomId).emit("game-saved", { ok: true });
    });

    // play-again / rematch (modified here to use createRematchRoom)
    socket.on("play-again", async ({ roomId }) => {
      try {
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;

        if (!room.finished && (!room.moves || room.moves.length === 0)) {
          socket.emit("play-again", {
            ok: false,
            started: false,
            error: "No finished game to rematch",
          });
          return;
        }

        const player = room.players.find((p) => p.id === socket.id);
        if (!player) {
          socket.emit("play-again", {
            ok: false,
            started: false,
            error: "Not in room",
          });
          return;
        }

        room.rematch = room.rematch || {
          initiatorSocketId: socket.id,
          initiatorUserId: player.user?.id || null,
          acceptedBy: {},
        };
        room.rematch.initiatorSocketId = socket.id;
        room.rematch.initiatorUserId = player.user?.id || null;

        room.rematch.acceptedBy = room.rematch.acceptedBy || {};
        room.rematch.acceptedBy[socket.id] = true;

        const opponent = room.players.find(
          (p) =>
            p.color !== player.color && (p.color === "w" || p.color === "b")
        );
        if (opponent) {
          io.to(opponent.id).emit("rematch-offered", {
            from: player.user || { username: "Guest" },
          });

          // Persist rematch notification
          try {
            const targetUserId = opponent.user?.id || opponent.id;
            await notificationService.createNotification(
              String(targetUserId),
              "rematch",
              "Rematch offered",
              `${player.user?.username || "Opponent"} offered a rematch.`,
              { fromUserId: player.user?.id || null, roomId }
            );
          } catch (e) {
            console.error("createNotification (rematch) failed", e);
          }
        }

        socket.emit("play-again", {
          ok: true,
          started: false,
          message: "Rematch requested",
        });
        broadcastRoomState(roomId);
      } catch (err) {
        console.error("play-again error", err);
        socket.emit("play-again", {
          ok: false,
          started: false,
          error: "Server error",
        });
      }
    });

    socket.on("accept-play-again", async ({ roomId }) => {
      try {
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room || !room.rematch) {
          socket.emit("play-again", {
            ok: false,
            started: false,
            error: "No rematch pending",
          });
          return;
        }
        const player = room.players.find((p) => p.id === socket.id);
        if (!player) {
          socket.emit("play-again", {
            ok: false,
            started: false,
            error: "Not in room",
          });
          return;
        }

        room.rematch.acceptedBy = room.rematch.acceptedBy || {};
        room.rematch.acceptedBy[socket.id] = true;

        const coloredPlayers = room.players.filter(
          (p) => p.color === "w" || p.color === "b"
        );
        const coloredIds = coloredPlayers.map((p) => p.id).filter(Boolean);

        const acceptedKeys = Object.keys(room.rematch.acceptedBy || {});

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

        const allAccepted =
          required.length > 0 &&
          required.every((id) => acceptedKeys.includes(id));

        if (allAccepted) {
          // Attempt to create a brand-new room for the rematch (prevents re-using the old roomId)
          try {
            const res = await createRematchRoom(roomId);
            if (res && res.ok && res.roomId) {
              const newRoomId = res.roomId;
              const newRoom = rooms[newRoomId];

              // join players' sockets to new room and emit player-assigned for each
              for (const p of newRoom.players) {
                try {
                  const sock = io && io.sockets && io.sockets.sockets.get(p.id);
                  if (sock) {
                    // leave old room (best-effort)
                    try {
                      sock.leave(roomId);
                    } catch (e) {}
                    sock.join(newRoomId);
                    io.to(p.id).emit("player-assigned", { color: p.color });
                    // If p has an associated user id (DB user), mark their activeRoom
                    try {
                      const uid = p.user?.id || p.user?._id || null;
                      if (uid && (p.color === "w" || p.color === "b")) {
                        await markUserActiveRoom(uid, newRoomId);
                      }
                    } catch (e) {
                      console.error(
                        "markUserActiveRoom during rematch failed",
                        e
                      );
                    }
                  }
                } catch (e) {}
              }

              broadcastRoomState(newRoomId);

              io.to(newRoomId).emit("play-again", {
                ok: true,
                started: true,
                message: "Rematch started",
                roomId: newRoomId,
              });

              // Persist rematch-started notifications to participants
              try {
                for (const p of newRoom.players) {
                  const uid = p.user?.id || p.id;
                  if (!uid) continue;
                  await notificationService.createNotification(
                    String(uid),
                    "rematch_started",
                    "Rematch started",
                    `Rematch started in room ${newRoomId}`,
                    { roomId: newRoomId }
                  );
                }
              } catch (e) {
                console.error("createNotification (rematch_started) failed", e);
              }

              scheduleFirstMoveTimer(newRoomId);

              // Mark original rematch notification as read for the acceptor
              try {
                const orig = await Notification.findOneAndUpdate(
                  { "data.roomId": roomId, userId: String(socket.user?.id) },
                  {
                    $set: {
                      read: true,
                      updatedAt: Date.now(),
                      "data.status": "accepted",
                    },
                  },
                  { new: true }
                )
                  .lean()
                  .exec();
                if (orig) {
                  try {
                    const payload = {
                      id: orig._id?.toString(),
                      _id: orig._id?.toString(),
                      userId: orig.userId,
                      type: orig.type,
                      title: orig.title,
                      body: orig.body,
                      data: orig.data,
                      read: orig.read,
                      createdAt: orig.createdAt,
                      updatedAt: orig.updatedAt,
                    };
                    io.to(`user:${String(socket.user?.id)}`).emit(
                      "notification",
                      payload
                    );
                  } catch (e) {}
                }
              } catch (e) {
                console.error(
                  "accept-play-again: mark original rematch notification failed",
                  e
                );
              }

              return;
            }
          } catch (e) {
            console.error("createRematchRoom failed or errored", e);
            // fallback to original in-place rematch below
          }

          // fallback — original behavior (reset same room) if new-room creation failed
          try {
            assignColorsForRematch(room);

            room.chess = new Chess();
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
                    w: DEFAULT_MS,
                    b: DEFAULT_MS,
                    running: room.chess.turn(),
                    lastTick: Date.now(),
                  }
                : null;
            }

            room.rematch = null;

            broadcastRoomState(roomId);

            io.to(roomId).emit("play-again", {
              ok: true,
              started: true,
              message: "Rematch started",
            });

            for (const p of room.players) {
              io.to(p.id).emit("player-assigned", { color: p.color });
            }

            // Persist rematch-started notifications to participants
            try {
              for (const p of room.players) {
                const uid = p.user?.id || p.id;
                if (!uid) continue;
                await notificationService.createNotification(
                  String(uid),
                  "rematch_started",
                  "Rematch started",
                  `Rematch started in room ${roomId}`,
                  { roomId }
                );
              }
            } catch (e) {
              console.error("createNotification (rematch_started) failed", e);
            }

            scheduleFirstMoveTimer(roomId);
          } catch (err) {
            console.error("fallback rematch reset failed", err);
            socket.emit("play-again", {
              ok: false,
              started: false,
              error: "Server error",
            });
            return;
          }
        } else {
          broadcastRoomState(roomId);
        }

        // --- FINAL FIX: mark original rematch notification for this acceptor as read and emit update ---
        try {
          const orig = await Notification.findOneAndUpdate(
            { "data.roomId": roomId, userId: String(socket.user?.id) },
            {
              $set: {
                read: true,
                updatedAt: Date.now(),
                "data.status": "accepted",
              },
            },
            { new: true }
          )
            .lean()
            .exec();
          if (orig) {
            try {
              const payload = {
                id: orig._id?.toString(),
                _id: orig._id?.toString(),
                userId: orig.userId,
                type: orig.type,
                title: orig.title,
                body: orig.body,
                data: orig.data,
                read: orig.read,
                createdAt: orig.createdAt,
                updatedAt: orig.updatedAt,
              };
              io.to(`user:${String(socket.user?.id)}`).emit(
                "notification",
                payload
              );
            } catch (e) {}
          }
        } catch (e) {
          console.error(
            "accept-play-again: mark original rematch notification failed",
            e
          );
        }
      } catch (err) {
        console.error("accept-play-again error", err);
        socket.emit("play-again", {
          ok: false,
          started: false,
          error: "Server error",
        });
      }
    });

    socket.on("decline-play-again", ({ roomId }) => {
      try {
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room || !room.rematch) return;

        const initiatorId = room.rematch.initiatorSocketId;
        if (initiatorId) {
          io.to(initiatorId).emit("rematch-declined", {
            message: "Opponent declined rematch",
          });
        }
        room.rematch = null;
        broadcastRoomState(roomId);

        // mark original rematch notification for this user as read/declined
        (async () => {
          try {
            const orig = await Notification.findOneAndUpdate(
              { "data.roomId": roomId, userId: String(socket.user?.id) },
              {
                $set: {
                  read: true,
                  updatedAt: Date.now(),
                  "data.status": "declined",
                },
              },
              { new: true }
            )
              .lean()
              .exec();
            if (orig) {
              try {
                io.to(`user:${String(socket.user?.id)}`).emit("notification", {
                  id: orig._id?.toString(),
                  _id: orig._id?.toString(),
                  ...orig,
                });
              } catch (e) {}
            }
          } catch (e) {
            console.error(
              "decline-play-again: mark original rematch notification failed",
              e
            );
          }
        })();
      } catch (err) {
        console.error("decline-play-again error", err);
      }
    });

    // challenge / accept-challenge (critical section — fixed)
    socket.on(
      "challenge",
      async ({ toUserId, minutes = 5, colorPreference = "random" }) => {
        try {
          if (!toUserId) {
            socket.emit("challenge-response", {
              ok: false,
              error: "Missing target",
            });
            return;
          }
          if (!socket.user || !socket.user.id) {
            socket.emit("challenge-response", {
              ok: false,
              error: "Auth required",
            });
            return;
          }
          const targetSockets = getSocketsForUserId(toUserId);
          const challengeId = `${Date.now()}-${Math.floor(
            Math.random() * 1000000
          )}`;
          pendingChallenges[challengeId] = {
            fromSocketId: socket.id,
            fromUserId: socket.user.id,
            toUserId,
            minutes: Math.max(1, Math.floor(Number(minutes) || 5)),
            colorPreference: colorPreference || "random",
            createdAt: Date.now(),
          };

          if (!targetSockets || targetSockets.length === 0) {
            socket.emit("challenge-declined", {
              challengeId,
              reason: "offline",
            });
            delete pendingChallenges[challengeId];
            return;
          }

          const challengePayload = {
            challengeId,
            from: { id: socket.user.id, username: socket.user.username },
            minutes: pendingChallenges[challengeId].minutes,
            colorPreference: pendingChallenges[challengeId].colorPreference,
          };
          targetSockets.forEach((sid) => {
            io.to(sid).emit("challenge-received", challengePayload);
          });

          // Persist notification for recipient
          try {
            await notificationService.createNotification(
              String(toUserId),
              "challenge",
              "New challenge",
              `${socket.user?.username || "A player"} challenged you (${
                pendingChallenges[challengeId].minutes
              }m).`,
              {
                challengeId,
                minutes: pendingChallenges[challengeId].minutes,
                fromUserId: socket.user?.id || null,
              }
            );
          } catch (e) {
            console.error("createNotification (challenge) failed", e);
          }

          socket.emit("challenge-sent", { ok: true, challengeId });
        } catch (err) {
          console.error("challenge error", err);
          socket.emit("challenge-response", {
            ok: false,
            error: "Server error",
          });
        }
      }
    );

    socket.on("accept-challenge", async ({ challengeId }) => {
      try {
        const pending = pendingChallenges[challengeId];
        if (!pending) {
          socket.emit("challenge-accept-response", {
            ok: false,
            error: "No such challenge",
          });
          return;
        }

        const acceptorSocket = socket;
        const acceptorUserId = socket.user?.id;
        if (!acceptorUserId || acceptorUserId !== pending.toUserId) {
          socket.emit("challenge-accept-response", {
            ok: false,
            error: "Not authorized",
          });
          return;
        }

        const initiatorSocket = io.sockets.sockets.get(pending.fromSocketId);
        if (!initiatorSocket) {
          socket.emit("challenge-declined", {
            challengeId,
            reason: "initiator-offline",
          });
          delete pendingChallenges[challengeId];
          return;
        }

        // ---------- NEW: attempt to reserve both users BEFORE creating the room ----------
        let roomId = generateRoomCode(8);
        while (rooms[roomId]) roomId = generateRoomCode(8);

        let reservedInitiator = { ok: true, set: false };
        let reservedAcceptor = { ok: true, set: false };
        const initiatorUserId = pending.fromUserId;
        const acceptorUserId_local = pending.toUserId; // avoid duplicate var name

        try {
          if (initiatorUserId) {
            reservedInitiator = await tryReserveActiveRoom(
              initiatorUserId,
              roomId
            );
            if (!reservedInitiator.ok) {
              throw reservedInitiator.error || new Error("reserve-init failed");
            }
            if (!reservedInitiator.set) {
              // initiator already busy
              if (initiatorSocket) {
                initiatorSocket.emit("challenge-declined", {
                  challengeId,
                  reason: "already-in-active-room",
                });
              }
              if (acceptorSocket) {
                acceptorSocket.emit("challenge-accept-response", {
                  ok: false,
                  error: "opponent-busy",
                });
              }
              delete pendingChallenges[challengeId];
              return;
            }
          }

          if (acceptorUserId_local) {
            reservedAcceptor = await tryReserveActiveRoom(
              acceptorUserId_local,
              roomId
            );
            if (!reservedAcceptor.ok) {
              // rollback initiator if set
              if (reservedInitiator.set && initiatorUserId) {
                await releaseActiveRoom(initiatorUserId, roomId);
              }
              throw (
                reservedAcceptor.error || new Error("reserve-accept failed")
              );
            }
            if (!reservedAcceptor.set) {
              // acceptor already busy (rare)
              if (reservedInitiator.set && initiatorUserId) {
                await releaseActiveRoom(initiatorUserId, roomId);
              }
              acceptorSocket.emit("challenge-accept-response", {
                ok: false,
                error: "already-in-active-room",
              });
              delete pendingChallenges[challengeId];
              return;
            }
          }

          // create room object (same as original) - now safe because reservations present
          const room = {
            players: [],
            moves: [],
            chess: new Chess(),
            fen: null,
            lastIndex: -1,
            clocks: null,
            paused: false,
            disconnectTimers: {},
            firstMoveTimer: null,
            pendingDrawOffer: null,
            finished: null,
            settings: {
              minutes: pending.minutes,
              minutesMs: pending.minutes * 60 * 1000,
              creatorId: pending.fromUserId,
              colorPreference: pending.colorPreference || "random",
            },
            messages: [],
            rematch: null,
          };

          let initiatorUser = null;
          let acceptorUser = null;
          try {
            initiatorUser = await User.findById(pending.fromUserId)
              .select("-passwordHash")
              .lean();
          } catch (e) {}
          try {
            acceptorUser = await User.findById(pending.toUserId)
              .select("-passwordHash")
              .lean();
          } catch (e) {}

          if (initiatorUser) initiatorUser = ensureAvatarAbs(initiatorUser);
          if (acceptorUser) acceptorUser = ensureAvatarAbs(acceptorUser);

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
            id: acceptorSocket.id,
            user: acceptorUser || {
              id: pending.toUserId,
              username: acceptorUser?.username || "guest",
            },
            color: "b",
            online: true,
            disconnectedAt: null,
          };

          initiatorPlayer.user = ensureAvatarAbs(initiatorPlayer.user);
          acceptorPlayer.user = ensureAvatarAbs(acceptorPlayer.user);

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

          rooms[roomId] = room;

          const initiatorSockObj = io.sockets.sockets.get(pending.fromSocketId);
          const acceptorSockObj = acceptorSocket;
          if (initiatorSockObj) initiatorSockObj.join(roomId);
          if (acceptorSockObj) acceptorSockObj.join(roomId);

          broadcastRoomState(roomId);

          const payload = {
            ok: true,
            challengeId,
            roomId,
            message: "Challenge accepted — room created",
            assignedColors: {
              [pending.fromUserId]: initiatorPlayer.color,
              [pending.toUserId]: acceptorPlayer.color,
            },
            redirectPath: "/play",
          };
          initiatorSockObj &&
            initiatorSockObj.emit("challenge-accepted", payload);
          acceptorSockObj &&
            acceptorSockObj.emit("challenge-accepted", payload);

          // Persist notifications to both parties
          try {
            await notificationService.createNotification(
              String(pending.fromUserId),
              "challenge_accepted",
              "Challenge accepted",
              `${acceptorUser?.username || "Player"} accepted your challenge.`,
              { challengeId, roomId }
            );
          } catch (e) {
            console.error("createNotification (challenge_accepted) failed", e);
          }

          try {
            await notificationService.createNotification(
              String(pending.toUserId),
              "challenge_joined",
              "Challenge joined",
              `You accepted a challenge — room ${roomId} created.`,
              { challengeId, roomId }
            );
          } catch (e) {
            console.error("createNotification (challenge_joined) failed", e);
          }

          // --- FINAL FIX: mark original challenge notification for the acceptor as read + emit update ---
          try {
            const orig = await Notification.findOneAndUpdate(
              {
                "data.challengeId": challengeId,
                userId: String(pending.toUserId),
              },
              {
                $set: {
                  read: true,
                  updatedAt: Date.now(),
                  "data.status": "accepted",
                },
              },
              { new: true }
            )
              .lean()
              .exec();
            if (orig) {
              try {
                const payload = {
                  id: orig._id?.toString(),
                  _id: orig._id?.toString(),
                  userId: orig.userId,
                  type: orig.type,
                  title: orig.title,
                  body: orig.body,
                  data: orig.data,
                  read: orig.read,
                  createdAt: orig.createdAt,
                  updatedAt: orig.updatedAt,
                };
                io.to(`user:${String(pending.toUserId)}`).emit(
                  "notification",
                  payload
                );
              } catch (e) {}
            }
          } catch (e) {
            console.error(
              "accept-challenge: mark original notification handled failed",
              e
            );
          }

          delete pendingChallenges[challengeId];
        } catch (err) {
          console.error("accept-challenge error", err);
          // rollback reservations if necessary
          try {
            if (
              reservedInitiator &&
              reservedInitiator.set &&
              pending.fromUserId
            ) {
              await releaseActiveRoom(pending.fromUserId, roomId);
            }
            if (reservedAcceptor && reservedAcceptor.set && pending.toUserId) {
              await releaseActiveRoom(pending.toUserId, roomId);
            }
          } catch (e) {}
          socket.emit("challenge-accept-response", {
            ok: false,
            error: "Server error",
          });
        }
      } catch (err) {
        console.error("accept-challenge error", err);
        socket.emit("challenge-accept-response", {
          ok: false,
          error: "Server error",
        });
      }
    });

    socket.on("decline-challenge", async ({ challengeId }) => {
      try {
        const pending = pendingChallenges[challengeId];
        if (!pending) {
          socket.emit("challenge-decline-response", {
            ok: false,
            error: "No such challenge",
          });
          return;
        }
        const initiatorSocket = io.sockets.sockets.get(pending.fromSocketId);
        if (initiatorSocket) {
          initiatorSocket.emit("challenge-declined", {
            challengeId,
            reason: "opponent-declined",
          });
        }

        // Persist decline notification to initiator
        try {
          await notificationService.createNotification(
            String(pending.fromUserId),
            "challenge_declined",
            "Challenge declined",
            `${
              pending.toUserId ? "Opponent" : "Player"
            } declined your challenge.`,
            { challengeId }
          );
        } catch (e) {
          console.error("createNotification (challenge_declined) failed", e);
        }

        // --- FINAL FIX: mark original challenge notification for the decliner as read/declined + emit update ---
        try {
          const orig = await Notification.findOneAndUpdate(
            {
              "data.challengeId": challengeId,
              userId: String(pending.toUserId),
            },
            {
              $set: {
                read: true,
                updatedAt: Date.now(),
                "data.status": "declined",
              },
            },
            { new: true }
          )
            .lean()
            .exec();
          if (orig) {
            try {
              io.to(`user:${String(pending.toUserId)}`).emit("notification", {
                id: orig._id?.toString(),
                _id: orig._id?.toString(),
                ...orig,
              });
            } catch (e) {}
          }
        } catch (e) {
          console.error(
            "decline-challenge: mark original notification handled failed",
            e
          );
        }

        delete pendingChallenges[challengeId];
        socket.emit("challenge-decline-response", { ok: true });
      } catch (err) {
        console.error("decline-challenge error", err);
        socket.emit("challenge-decline-response", {
          ok: false,
          error: "Server error",
        });
      }
    });

    // friend request handlers (kept intact)
    socket.on("send-friend-request", async ({ toUserId }, callback) => {
      try {
        if (!socket.user || !socket.user.id) {
          if (callback) callback({ ok: false, error: "Not authenticated" });
          return;
        }
        if (!toUserId) {
          if (callback) callback({ ok: false, error: "Missing target" });
          return;
        }
        if (toUserId === socket.user.id) {
          if (callback)
            callback({ ok: false, error: "Cannot friend yourself" });
          return;
        }

        const reqId = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
        const fromUserId = socket.user.id;
        const fromUsername = socket.user.username || "unknown";

        const target = await User.findById(toUserId);
        if (!target) {
          if (callback) callback({ ok: false, error: "User not found" });
          return;
        }

        const alreadyFriend = (target.friends || []).some(
          (f) => f.id === fromUserId
        );
        const alreadyPending = (target.incomingFriendRequests || []).some(
          (r) => r.fromUserId === fromUserId && r.status === "pending"
        );
        if (alreadyFriend) {
          if (callback) callback({ ok: false, error: "Already friends" });
          return;
        }
        if (alreadyPending) {
          if (callback)
            callback({ ok: false, error: "Request already pending" });
          return;
        }

        target.incomingFriendRequests = target.incomingFriendRequests || [];
        target.incomingFriendRequests.push({
          reqId,
          fromUserId,
          fromUsername,
          ts: Date.now(),
          status: "pending",
        });
        await target
          .save()
          .catch((e) => console.error("save incoming req error", e));

        const targetSockets = getSocketsForUserId(toUserId);
        const payload = { reqId, fromUserId, fromUsername };
        targetSockets.forEach((sid) =>
          io.to(sid).emit("friend-request-received", payload)
        );

        // Persist notification for recipient
        try {
          await notificationService.createNotification(
            String(toUserId),
            "friend_request",
            "New friend request",
            `${fromUsername} sent you a friend request.`,
            { reqId, fromUserId }
          );
        } catch (e) {
          console.error("createNotification (friend_request) failed", e);
        }

        if (callback) callback({ ok: true, reqId });
      } catch (err) {
        console.error("send-friend-request error", err);
        if (callback) callback({ ok: false, error: "Server error" });
      }
    });

    socket.on("respond-friend-request", async ({ reqId, accept }, callback) => {
      try {
        if (!socket.user || !socket.user.id) {
          if (callback) callback({ ok: false, error: "Not authenticated" });
          return;
        }
        const toUserId = socket.user.id;

        const targetUser = await User.findOne({
          "incomingFriendRequests.reqId": reqId,
        }).exec();
        if (!targetUser) {
          if (callback) callback({ ok: false, error: "Request not found" });
          return;
        }
        const reqEntry = (targetUser.incomingFriendRequests || []).find(
          (r) => r.reqId === reqId
        );
        if (!reqEntry) {
          if (callback) callback({ ok: false, error: "Request not found" });
          return;
        }
        if (reqEntry.status !== "pending") {
          if (callback)
            callback({ ok: false, error: "Request already handled" });
          return;
        }

        const fromUserId = reqEntry.fromUserId;

        if (accept) {
          const fromUserDoc = await User.findById(fromUserId)
            .select("username friends")
            .exec();
          if (!fromUserDoc) {
            targetUser.incomingFriendRequests = (
              targetUser.incomingFriendRequests || []
            ).filter((r) => r.reqId !== reqId);
            await targetUser.save().catch(() => {});
            if (callback)
              callback({ ok: false, error: "Request sender not found" });
            return;
          }
          const fromUsername = fromUserDoc.username || "unknown";
          const toUserDoc = await User.findById(toUserId)
            .select("username friends")
            .exec();
          const toUsername = toUserDoc.username || "unknown";

          await User.updateOne(
            { _id: fromUserId },
            { $addToSet: { friends: { id: toUserId, username: toUsername } } }
          )
            .exec()
            .catch(() => {});
          await User.updateOne(
            { _id: toUserId },
            {
              $addToSet: {
                friends: { id: fromUserId, username: fromUsername },
              },
            }
          )
            .exec()
            .catch(() => {});

          targetUser.incomingFriendRequests = (
            targetUser.incomingFriendRequests || []
          ).filter((r) => r.reqId !== reqId);
          await targetUser.save().catch(() => {});

          const senderSockets = getSocketsForUserId(fromUserId);
          senderSockets.forEach((sid) =>
            io.to(sid).emit("friend-request-accepted", {
              reqId,
              by: { id: toUserId, username: toUsername },
            })
          );

          // Persist notification to request sender
          try {
            await notificationService.createNotification(
              String(fromUserId),
              "friend_request_accepted",
              "Friend request accepted",
              `${
                socket.user?.username || "User"
              } accepted your friend request.`,
              { reqId, by: { id: toUserId, username: socket.user?.username } }
            );
          } catch (e) {
            console.error(
              "createNotification (friend_request_accepted) failed",
              e
            );
          }

          // --- FINAL FIX: mark original friend_request notification for the accepter (toUserId) as read + emit update ---
          try {
            const orig = await Notification.findOneAndUpdate(
              { "data.reqId": reqId, userId: String(toUserId) },
              {
                $set: {
                  read: true,
                  updatedAt: Date.now(),
                  "data.status": "accepted",
                },
              },
              { new: true }
            )
              .lean()
              .exec();

            if (orig) {
              try {
                const payload = {
                  id: orig._id?.toString(),
                  _id: orig._id?.toString(),
                  userId: orig.userId,
                  type: orig.type,
                  title: orig.title,
                  body: orig.body,
                  data: orig.data,
                  read: orig.read,
                  createdAt: orig.createdAt,
                  updatedAt: orig.updatedAt,
                };
                io.to(`user:${String(toUserId)}`).emit("notification", payload);
              } catch (e) {}
            }
          } catch (e) {
            console.error(
              "respond-friend-request: mark original notification handled failed",
              e
            );
          }

          if (callback) callback({ ok: true, accepted: true });
        } else {
          targetUser.incomingFriendRequests = (
            targetUser.incomingFriendRequests || []
          ).filter((r) => r.reqId !== reqId);
          await targetUser.save().catch(() => {});

          const senderSockets = getSocketsForUserId(fromUserId);
          senderSockets.forEach((sid) =>
            io.to(sid).emit("friend-request-declined", {
              reqId,
              by: { id: toUserId, username: socket.user.username },
            })
          );

          // Persist notification to request sender about decline
          try {
            await notificationService.createNotification(
              String(fromUserId),
              "friend_request_declined",
              "Friend request declined",
              `${
                socket.user?.username || "User"
              } declined your friend request.`,
              { reqId, by: { id: toUserId, username: socket.user?.username } }
            );
          } catch (e) {
            console.error(
              "createNotification (friend_request_declined) failed",
              e
            );
          }

          // --- FINAL FIX: mark original friend_request notification for the decliner (toUserId) as read + emit update ---
          try {
            const orig = await Notification.findOneAndUpdate(
              { "data.reqId": reqId, userId: String(toUserId) },
              {
                $set: {
                  read: true,
                  updatedAt: Date.now(),
                  "data.status": "declined",
                },
              },
              { new: true }
            )
              .lean()
              .exec();

            if (orig) {
              try {
                const payload = {
                  id: orig._id?.toString(),
                  _id: orig._id?.toString(),
                  userId: orig.userId,
                  type: orig.type,
                  title: orig.title,
                  body: orig.body,
                  data: orig.data,
                  read: orig.read,
                  createdAt: orig.createdAt,
                  updatedAt: orig.updatedAt,
                };
                io.to(`user:${String(toUserId)}`).emit("notification", payload);
              } catch (e) {}
            }
          } catch (e) {
            console.error(
              "respond-friend-request: mark original notification handled failed",
              e
            );
          }

          if (callback) callback({ ok: true, accepted: false });
        }
      } catch (err) {
        console.error("respond-friend-request error", err);
        if (callback) callback({ ok: false, error: "Server error" });
      }
    });

    socket.on("remove-friend", ({ targetId }, callback) => {
      try {
        if (!socket.user || !socket.user.id) {
          if (callback) callback({ ok: false, error: "Not authenticated" });
          return;
        }
        if (!targetId) {
          if (callback) callback({ ok: false, error: "Missing targetId" });
          return;
        }
        const byPayload = {
          id: socket.user.id,
          username: socket.user.username,
        };
        const targetSockets = getSocketsForUserId(targetId);
        targetSockets.forEach((sid) =>
          io.to(sid).emit("friend-removed", { by: byPayload, targetId })
        );
        if (callback) callback({ ok: true });

        // Persist notification to the removed friend
        try {
          notificationService.createNotification(
            String(targetId),
            "friend_removed",
            "Friend removed",
            `${socket.user?.username || "User"} removed you from friends.`,
            { by: byPayload }
          );
        } catch (e) {
          console.error("createNotification (friend_removed) failed", e);
        }
      } catch (err) {
        console.error("remove-friend error", err);
        if (callback) callback({ ok: false, error: "Server error" });
      }
    });

    /* ------------------------
       Matchmaking events (support both name styles)
       ------------------------ */

    // enqueue-match
    socket.on("enqueue-match", async (payload = {}) => {
      try {
        const userId = socket.user?.id || null;
        const cups =
          socket.user?.cups ??
          (Number.isFinite(Number(payload?.cups))
            ? Number(payload.cups)
            : null);
        const minutes = Math.max(
          1,
          Math.floor(Number(payload?.minutes || payload?.m || 5))
        );
        const colorPreference =
          payload?.colorPreference || payload?.cp || "random";

        const added = await addToPlayQueue({
          socketId: socket.id,
          userId,
          cups,
          minutes,
          colorPreference,
        });
        if (added) {
          socket.emit("match-queued", {
            ok: true,
            message: "Queued for matchmaking",
          });
        } else {
          socket.emit("match-queued", { ok: false, error: "Already in queue" });
        }
      } catch (err) {
        console.error("enqueue-match error", err);
        socket.emit("match-queue-error", { ok: false, error: "Server error" });
      }
    });

    // dequeue-match
    socket.on("dequeue-match", () => {
      try {
        const removed = removeFromPlayQueueBySocket(socket.id);
        socket.emit("match-dequeued", { ok: true, removed });
      } catch (e) {
        console.error("dequeue-match error", e);
        socket.emit("match-queue-error", { ok: false, error: "Server error" });
      }
    });

    // WebRTC signalling helpers (kept)
    function relayToSocketOrUser(targetId, eventName, payload) {
      try {
        const sock = io && io.sockets && io.sockets.sockets.get(targetId);
        if (sock) {
          io.to(targetId).emit(eventName, payload);
          return true;
        }

        const sids = getSocketsForUserId(targetId);
        if (Array.isArray(sids) && sids.length > 0) {
          for (const sid of sids) {
            try {
              io.to(sid).emit(eventName, payload);
            } catch (e) {}
          }
          return true;
        }

        return false;
      } catch (e) {
        console.error("relayToSocketOrUser error:", e);
        return false;
      }
    }

    socket.on("webrtc-answer", ({ roomId, toSocketId, answer }) => {
      try {
        const payload = { fromSocketId: socket.id, answer };

        if (toSocketId) {
          relayToSocketOrUser(toSocketId, "webrtc-answer", payload);
          return;
        }

        if (roomId && rooms[roomId]) {
          const opponent = (rooms[roomId].players || []).find(
            (p) => p.id !== socket.id && (p.color === "w" || p.color === "b")
          );
          if (opponent && opponent.id) {
            relayToSocketOrUser(opponent.id, "webrtc-answer", payload);
          }
        }
      } catch (e) {
        console.error("webrtc-answer relay error:", e);
      }
    });

    socket.on("webrtc-ice", ({ roomId, toSocketId, candidate }) => {
      try {
        const payload = { fromSocketId: socket.id, candidate };

        if (toSocketId) {
          relayToSocketOrUser(toSocketId, "webrtc-ice", payload);
          return;
        }

        if (roomId && rooms[roomId]) {
          const opponent = (rooms[roomId].players || []).find(
            (p) => p.id !== socket.id && (p.color === "w" || p.color === "b")
          );
          if (opponent && opponent.id) {
            relayToSocketOrUser(opponent.id, "webrtc-ice", payload);
          }
        }
      } catch (e) {
        console.error("webrtc-ice relay error:", e);
      }
    });

    socket.on("webrtc-hangup", ({ roomId, toSocketId }) => {
      try {
        const payload = { fromSocketId: socket.id };

        if (toSocketId) {
          relayToSocketOrUser(toSocketId, "webrtc-hangup", payload);
          return;
        }

        if (roomId && rooms[roomId]) {
          const opponent = (rooms[roomId].players || []).find(
            (p) => p.id !== socket.id && (p.color === "w" || p.color === "b")
          );
          if (opponent && opponent.id) {
            relayToSocketOrUser(opponent.id, "webrtc-hangup", payload);
          }
        }
      } catch (e) {
        console.error("webrtc-hangup relay error:", e);
      }
    });

    // Legacy play-online API
    socket.on("play-online", async (payload = {}) => {
      try {
        const userId = socket.user?.id || null;
        const cups =
          socket.user?.cups ??
          (Number.isFinite(Number(payload?.cups))
            ? Number(payload.cups)
            : null);
        const minutes = Math.max(
          1,
          Math.floor(Number(payload?.minutes || payload?.m || 5))
        );
        const colorPreference =
          payload?.colorPreference || payload?.cp || "random";

        const added = await addToPlayQueue({
          socketId: socket.id,
          userId,
          cups,
          minutes,
          colorPreference,
        });
        if (added) {
          socket.emit("match-queued", {
            ok: true,
            message: "Queued for matchmaking",
          });
        } else {
          socket.emit("match-queued", { ok: false, error: "Already in queue" });
        }
      } catch (err) {
        console.error("play-online error", err);
        socket.emit("match-queue-error", { ok: false, error: "Server error" });
      }
    });

    socket.on("cancel-play-online", () => {
      try {
        const removed = removeFromPlayQueueBySocket(socket.id);
        socket.emit("match-dequeued", { ok: true, removed });
      } catch (e) {
        console.error("cancel-play-online error", e);
        socket.emit("match-queue-error", { ok: false, error: "Server error" });
      }
    });

    /* ------------------------
       Disconnect handling
       ------------------------ */
    socket.on("disconnect", () => {
      try {
        removeFromPlayQueueBySocket(socket.id);
      } catch (e) {}

      if (socket.user && socket.user.id) {
        removeOnlineSocketForUser(socket.user.id, socket.id);
      }

      Object.keys(rooms).forEach((rId) => {
        const room = rooms[rId];
        const idx = room.players.findIndex((p) => p.id === socket.id);
        if (idx !== -1) {
          room.players[idx].online = false;
          room.players[idx].disconnectedAt = Date.now();

          room.disconnectTimers = room.disconnectTimers || {};
          clearDisconnectTimer(room, socket.id);
          room.disconnectTimers[socket.id] = setTimeout(async () => {
            const p = room.players.find((pp) => pp.id === socket.id);
            if (p && !p.online && !room.finished) {
              const opponent = room.players.find(
                (pp) =>
                  (pp.color === "w" || pp.color === "b") &&
                  pp.color !== p.color &&
                  pp.online
              );
              if (opponent) {
                room.paused = true;
                if (room.clocks) {
                  room.clocks.running = null;
                  room.clocks.lastTick = null;
                }
                room.finished = {
                  reason: "opponent-disconnected",
                  winner: opponent.color,
                  loser: p.color,
                  message: `Player ${p.user?.username || p.id} disconnected — ${
                    opponent.user?.username || opponent.id
                  } wins`,
                  finishedAt: Date.now(),
                };
                io.to(rId).emit("game-over", { ...room.finished });
                clearFirstMoveTimer(room);
                broadcastRoomState(rId);

                // --- NEW: clear DB activeRoom for both players ---
                try {
                  await clearActiveRoomForRoom(room);
                } catch (e) {
                  console.error(
                    "clearActiveRoomForRoom failed in disconnect timer",
                    e
                  );
                }

                await saveFinishedGame(rId);
              } else {
                // no online opponent — leave offline (no immediate finish)
              }
            }
            clearDisconnectTimer(room, socket.id);
          }, DISCONNECT_GRACE_MS);

          broadcastRoomState(rId);
        }
      });
      console.log("socket disconnected", socket.id);
    });
  });

  return io;
}

module.exports = { initSockets };
