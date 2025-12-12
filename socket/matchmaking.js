// backend/socket/matchmaking.js
// playQueue maps and attemptMatchmaking - moved from your original file
// This module expects a context object { io, rooms, generateRoomCode, User, tryReserveActiveRoom, releaseActiveRoom, ... }
// and provides addToPlayQueue/removeFromPlayQueue/attemptMatchmaking functions.

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

function findSocketsForKeys(keys, context) {
  const out = [];
  try {
    for (const k of keys) {
      const ent = playQueue.get(k);
      if (!ent) continue;
      const sock =
        context.io &&
        context.io.sockets &&
        context.io.sockets.sockets.get(ent.socketId);
      if (sock) out.push({ key: k, socket: sock, entry: ent });
    }
  } catch (e) {}
  return out;
}

/* Helper: robust bot detection for a room object or player entries.
   Returns boolean.
*/
function detectIsBotRoomFromPlayers(players = [], settings = {}) {
  try {
    if (settings && settings.bot) return true;
    if (!Array.isArray(players)) return false;
    for (const p of players) {
      if (!p) continue;
      // check p.user.id, p.user.username, p.id, p.username, or explicit flags
      const candidateId =
        (p.user && (p.user.id || p.user._id)) ||
        p.user?.id ||
        p.id ||
        p.user?.userId ||
        null;
      const candidateName =
        (p.user && (p.user.username || p.user.displayName)) ||
        p.username ||
        p.user?.username ||
        "";
      if (
        typeof candidateId === "string" &&
        candidateId.toLowerCase().startsWith("bot:")
      )
        return true;
      if (
        typeof candidateName === "string" &&
        candidateName.toLowerCase().includes("bot")
      )
        return true;
      if (p.isBot || (p.user && p.user.isBot)) return true;
    }
  } catch (e) {}
  return false;
}

async function attemptMatchmaking(context) {
  // context must provide: io, rooms, generateRoomCode, User, tryReserveActiveRoom, releaseActiveRoom
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
      const s1 = context.io.sockets.sockets.get(e1.socketId);
      const s2 = context.io.sockets.sockets.get(e2.socketId);
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
              const s1 = context.io.sockets.sockets.get(e1.socketId);
              const s2 = context.io.sockets.sockets.get(e2.socketId);
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
          const s1 = context.io.sockets.sockets.get(e1.socketId);
          const s2 = context.io.sockets.sockets.get(e2.socketId);
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
        if (typeof context.roomManager.createRoom === "function") {
          const userA = e1.id ? { id: String(e1.id) } : null;
          const userB = e2.id ? { id: String(e2.id) } : null;

          const res = await context.roomManager.createRoom({
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

      // fallback creation with reservations (kept same logic)
      if (!createdRoomId) {
        try {
          let fallbackRoomId = context.generateRoomCode(8);
          while (context.rooms[fallbackRoomId])
            fallbackRoomId = context.generateRoomCode(8);

          let reservedA = { ok: true, set: false };
          let reservedB = { ok: true, set: false };
          const userAId = e1.id ? String(e1.id) : null;
          const userBId = e2.id ? String(e2.id) : null;

          if (userAId) {
            reservedA = await context.reservations.tryReserveActiveRoom(
              userAId,
              fallbackRoomId
            );
            if (!reservedA.ok)
              throw reservedA.error || new Error("reserve-A failed");
            if (!reservedA.set) {
              if (context.io && context.io.sockets.sockets.get(e1.socketId)) {
                context.io.to(e1.socketId).emit("match-found-failed", {
                  ok: false,
                  error: "player-busy",
                });
              }
              if (userBId && reservedB.set)
                await context.reservations.releaseActiveRoom(
                  userBId,
                  fallbackRoomId
                );
              continue;
            }
          }

          if (userBId) {
            reservedB = await context.reservations.tryReserveActiveRoom(
              userBId,
              fallbackRoomId
            );
            if (!reservedB.ok) {
              if (reservedA.set && userAId)
                await context.reservations.releaseActiveRoom(
                  userAId,
                  fallbackRoomId
                );
              throw reservedB.error || new Error("reserve-B failed");
            }
            if (!reservedB.set) {
              if (reservedA.set && userAId)
                await context.reservations.releaseActiveRoom(
                  userAId,
                  fallbackRoomId
                );
              if (context.io && context.io.sockets.sockets.get(e2.socketId)) {
                context.io.to(e2.socketId).emit("match-found-failed", {
                  ok: false,
                  error: "player-busy",
                });
              }
              continue;
            }
          }

          // Build fallback room object (kept original)
          const room = {
            players: [],
            moves: [],
            chess: new context.Chess(),
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
            if (e1.id)
              userDocA = await context.User.findById(e1.id).lean().exec();
          } catch (e) {}
          try {
            if (e2.id)
              userDocB = await context.User.findById(e2.id).lean().exec();
          } catch (e) {}
          if (userDocA) userDocA = context.helpers.ensureAvatarAbs(userDocA);
          if (userDocB) userDocB = context.helpers.ensureAvatarAbs(userDocB);

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

          // initialize clocks only when two colored players are present and both online AND not a bot room
          try {
            const colored = room.players.filter(
              (p) => p.color === "w" || p.color === "b"
            );
            const activeCount = colored.filter((p) => !!p.online).length;

            // detect bot presence robustly via players' user fields or explicit settings.bot
            const isBot = detectIsBotRoomFromPlayers(
              room.players,
              room.settings
            );

            if (!isBot && colored.length === 2 && activeCount === 2) {
              room.clocks = {
                w: room.settings.minutesMs,
                b: room.settings.minutesMs,
                running: room.chess.turn(),
                lastTick: Date.now(),
              };
              try {
                context.scheduleFirstMoveTimer &&
                  context.scheduleFirstMoveTimer(fallbackRoomId);
              } catch (e) {}
            } else {
              // mark setting so other parts of code can easily detect this
              if (isBot)
                room.settings = { ...(room.settings || {}), bot: true };
              room.clocks = room.clocks || null;
            }
          } catch (e) {}

          context.rooms[fallbackRoomId] = room;
          context.broadcastRoomState(fallbackRoomId);
          // scheduleFirstMoveTimer was attempted above only if clocks were created
          createdRoomId = fallbackRoomId;
        } catch (err) {
          console.error("play-online: fallback room creation failed", err);
          try {
            if (e1.id)
              await context.reservations.releaseActiveRoom(
                String(e1.id),
                createdRoomId || null
              );
            if (e2.id)
              await context.reservations.releaseActiveRoom(
                String(e2.id),
                createdRoomId || null
              );
          } catch (e) {}
          createdRoomId = null;
        }
      }

      if (createdRoomId) {
        try {
          // Ensure that if the created room contains a bot we remove clocks/clear any timers
          try {
            // attempt to find the room object either in in-memory map or via roomManager
            let roomObj =
              context.rooms && context.rooms[createdRoomId]
                ? context.rooms[createdRoomId]
                : null;

            // If roomManager can provide a room getter, try that (non-breaking)
            if (
              !roomObj &&
              context.roomManager &&
              typeof context.roomManager.getRoom === "function"
            ) {
              try {
                roomObj = await context.roomManager.getRoom(createdRoomId);
              } catch (e) {
                // ignore
              }
            }

            if (roomObj) {
              const isBotRoom = detectIsBotRoomFromPlayers(
                roomObj.players,
                roomObj.settings
              );
              if (isBotRoom) {
                roomObj.settings = { ...(roomObj.settings || {}), bot: true };
                // ensure clocks cleared
                roomObj.clocks = null;
                // if context provides a way to clear scheduled timers for a room, call it
                try {
                  if (typeof context.cancelRoomTimers === "function") {
                    context.cancelRoomTimers(createdRoomId);
                  } else if (typeof context.clearRoomTimersFor === "function") {
                    context.clearRoomTimersFor(createdRoomId);
                  } else if (
                    context.scheduleClear &&
                    typeof context.scheduleClear === "function"
                  ) {
                    // don't rely on this; just attempt if exist
                    try {
                      context.scheduleClear(createdRoomId);
                    } catch (e) {}
                  }
                } catch (e) {}
                // broadcast updated room state so frontends receive clocks=null
                try {
                  context.broadcastRoomState(createdRoomId);
                } catch (e) {}
              }
            }
          } catch (e) {
            // don't fail matchmaking if post-creation cleanup failed
            console.error("post-create bot-room cleanup error", e);
          }

          const s1 = context.io.sockets.sockets.get(e1.socketId);
          const s2 = context.io.sockets.sockets.get(e2.socketId);
          if (s1) s1.join(createdRoomId);
          if (s2) s2.join(createdRoomId);

          const payload = {
            ok: true,
            roomId: createdRoomId,
            message: "Match found — joining room",
            assignedColors: {},
          };

          try {
            const r = context.rooms[createdRoomId];
            if (r && Array.isArray(r.players)) {
              for (const p of r.players) {
                payload.assignedColors[p.user?.id || p.id || p.id] = p.color;
              }
            }
          } catch (e) {}

          if (s1) s1.emit("match-found", payload);
          if (s2) s2.emit("match-found", payload);

          try {
            const room = context.rooms[createdRoomId];
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
              context.io.to(createdRoomId).emit("room-update", {
                players: room.players.map(context.helpers.mapPlayerForEmit),
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
                  -Math.min(
                    context.MAX_CHAT_MESSAGES,
                    room.messages.length || 0
                  )
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
          const s1 = context.io.sockets.sockets.get(e1.socketId);
          const s2 = context.io.sockets.sockets.get(e2.socketId);
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

module.exports = {
  addToPlayQueue,
  removeFromPlayQueueByKey,
  removeFromPlayQueueBySocket,
  findSocketsForKeys,
  attemptMatchmaking,
  // expose playQueue structures for debugging if needed
  _playQueue: playQueue,
  _playQueueByCups: playQueueByCups,
};
