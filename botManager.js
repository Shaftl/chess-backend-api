// backend/botManager.js
// Bot driver using the safe computeBestMove from services. No external engine usage.

const roomManager = require("./roomManager");
const { computeBestMove } = require("./services/stockfishEngine");

const rooms = roomManager.rooms || {};
const botRecords = {}; // roomId -> { thinking, stopFlag, level, failures }

/* small helper */
function uciToMoveObj(uci) {
  if (!uci || typeof uci !== "string") return null;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci.slice(4) : undefined;
  const obj = { from, to };
  if (promotion) obj.promotion = promotion;
  return obj;
}

async function applyUciMoveToRoom(roomId, uci) {
  const room = rooms[roomId];
  if (!room) return false;
  try {
    const Chess = require("chess.js").Chess;
    if (!room.chess) room.chess = new Chess();

    // load authoritative FEN if present
    if (room.fen) {
      try {
        if (typeof room.chess.load === "function") room.chess.load(room.fen);
        else room.chess = new Chess(room.fen);
      } catch (e) {
        // ignore and continue
      }
    }

    const mo = uciToMoveObj(uci);
    if (!mo) return false;

    // validate vs legal moves list
    const legal = (room.chess.moves({ verbose: true }) || []).map(
      (m) => `${m.from}${m.to}${m.promotion || ""}`
    );
    const candidate = `${mo.from}${mo.to}${mo.promotion || ""}`;
    if (!legal.includes(candidate)) {
      return false;
    }

    const res = room.chess.move(mo);
    if (!res) return false;

    room.moves = room.moves || [];
    room.lastIndex =
      typeof room.lastIndex === "number"
        ? room.lastIndex + 1
        : room.moves.length;
    room.moves.push({ index: room.lastIndex, move: uci });
    room.fen = room.chess.fen();

    if (room.clocks && room.clocks.running) {
      room.clocks.running = room.clocks.running === "w" ? "b" : "w";
      room.clocks.lastTick = Date.now();
    }

    // broadcast
    try {
      if (typeof roomManager.broadcastRoomState === "function")
        roomManager.broadcastRoomState(roomId);
    } catch (e) {}

    return true;
  } catch (err) {
    console.error(
      "applyUciMoveToRoom error",
      err && err.stack ? err.stack : err
    );
    return false;
  }
}

async function _botLoop(roomId) {
  const record = botRecords[roomId];
  if (!record) return;
  if (record.stopFlag) {
    delete botRecords[roomId];
    return;
  }
  const room = rooms[roomId];
  if (!room) {
    delete botRecords[roomId];
    return;
  }
  if (room.finished) {
    delete botRecords[roomId];
    return;
  }

  try {
    const bot = room.bot;
    if (!bot) {
      delete botRecords[roomId];
      return;
    }
    const botColor = bot.color;
    const turn = room.chess ? room.chess.turn() : null;
    if (!turn) {
      setTimeout(() => _botLoop(roomId), 400);
      return;
    }
    if (turn !== botColor) {
      setTimeout(() => _botLoop(roomId), 300);
      return;
    }
    if (record.thinking) {
      setTimeout(() => _botLoop(roomId), 300);
      return;
    }

    record.thinking = true;

    const moves = (room.moves || [])
      .map((m) => {
        if (!m) return null;
        if (typeof m === "string") return m;
        if (m.move && typeof m.move === "string") return m.move;
        if (m.move && m.move.from && m.move.to)
          return `${m.move.from}${m.move.to}${m.move.promotion || ""}`;
        if (m.from && m.to) return `${m.from}${m.to}${m.promotion || ""}`;
        return null;
      })
      .filter(Boolean);

    const fen = room.fen || (room.chess ? room.chess.fen() : null);
    const opts = Object.assign({}, record.level || { movetimeMs: 800 });
    if (fen) opts.fen = fen;

    let best = null;
    try {
      // computeBestMove is memory-safe and fast (pure JS)
      best = await computeBestMove(moves, opts);
    } catch (e) {
      console.error("bot computeBestMove error", e && e.stack ? e.stack : e);
      record.failures = (record.failures || 0) + 1;
    }

    let applied = false;
    if (best) {
      applied = await applyUciMoveToRoom(roomId, best);
      if (!applied) {
        record.failures = (record.failures || 0) + 1;
      } else {
        record.failures = 0;
      }
    } else {
      record.failures = (record.failures || 0) + 1;
    }

    // If repeated failures -> stop bot to avoid busy loops
    if ((record.failures || 0) >= 6) {
      console.warn(`[bot] too many failures for ${roomId}, stopping bot`);
      record.stopFlag = true;
      try {
        if (room && room.bot) delete room.bot;
      } catch (e) {}
    }
  } catch (e) {
    console.error("_botLoop top-level error", e && e.stack ? e.stack : e);
    if (botRecords[roomId])
      botRecords[roomId].failures = (botRecords[roomId].failures || 0) + 1;
    if ((botRecords[roomId] && botRecords[roomId].failures) >= 8)
      botRecords[roomId].stopFlag = true;
  } finally {
    const r = botRecords[roomId];
    if (r) {
      r.thinking = false;
      if (!r.stopFlag) setTimeout(() => _botLoop(roomId), 300);
      else delete botRecords[roomId];
    }
  }
}

/**
 * createBotRoomForUser(userObj, opts)
 * - opts: { minutes, playAs, level:{movetimeMs,depth}, botName }
 * This function tries to use the roomManager.createRoom path first, falling back to an in-memory
 * room if that fails. It starts the bot loop which uses the memory-safe computeBestMove.
 */
async function createBotRoomForUser(userObj, opts = {}) {
  try {
    const minutes = Math.max(1, Math.floor(Number(opts.minutes || 5)));
    const level = opts.level || { movetimeMs: Number(opts.movetimeMs || 800) };
    const playAs = opts.playAs || "random";
    const botName = opts.botName || "JS-Engine";

    // Try to create a normal room (so DB activeRoom handling is used)
    let res = null;
    try {
      if (roomManager && typeof roomManager.createRoom === "function") {
        res = await roomManager.createRoom({
          minutes,
          colorPreference: opts.colorPreference || "random",
          userA: { id: userObj.id, username: userObj.username },
          userB: null,
        });
      }
    } catch (e) {
      res = null;
    }

    let roomId = null;
    if (res && typeof res === "object") {
      if (res.roomId) roomId = String(res.roomId);
      else if (res.id) roomId = String(res.id);
      else if (res.room && (res.room.roomId || res.room.id || res.room._id))
        roomId =
          String(res.room.roomId || res.room.id || res.room._id || "").trim() ||
          null;
    }

    if (!roomId) {
      // fallback minimal in-memory room (keeps earlier behavior)
      let generated =
        typeof roomManager.generateRoomCode === "function"
          ? roomManager.generateRoomCode()
          : null;
      if (!generated)
        generated = `bot-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      roomId = String(generated);
      if (!roomManager.rooms) roomManager.rooms = {};
      if (roomManager.rooms[roomId])
        roomId = `${roomId}-${Math.floor(Math.random() * 1000)}`;
      // prepare players and colors
      let humanIndex = 0;
      if (playAs === "white") humanIndex = 0;
      else if (playAs === "black") humanIndex = 1;
      else humanIndex = Math.random() < 0.5 ? 0 : 1;
      const botIdx = humanIndex === 0 ? 1 : 0;
      const botColor = botIdx === 0 ? "w" : "b";
      const players = [
        { id: `p:${roomId}:0`, user: null, color: "w", online: false },
        { id: `p:${roomId}:1`, user: null, color: "b", online: false },
      ];
      players[humanIndex] = {
        id: `user:${userObj.id || "guest"}`,
        user: { id: userObj.id || null, username: userObj.username || "user" },
        color: humanIndex === 0 ? "w" : "b",
        online: true,
        disconnectedAt: null,
      };
      players[botIdx] = {
        id: `bot:jsengine:${roomId}`,
        user: { id: null, username: botName },
        color: botColor,
        online: true,
        disconnectedAt: null,
      };
      const Chess = require("chess.js").Chess;
      const chess = new Chess();
      const newRoom = {
        roomId,
        createdAt: Date.now(),
        minutes,
        colorPreference: opts.colorPreference || "random",
        players,
        bot: { engine: "simple", color: botColor, level },
        chess,
        fen: chess.fen(),
        moves: [],
        lastIndex: -1,
        clocks: {
          w: minutes * 60 * 1000,
          b: minutes * 60 * 1000,
          running: null,
          lastTick: null,
        },
        paused: false,
        finished: false,
        messages: [],
        rematch: null,
      };
      roomManager.rooms[roomId] = newRoom;
      try {
        if (typeof roomManager.broadcastRoomState === "function")
          roomManager.broadcastRoomState(roomId);
      } catch (e) {}
      botRecords[roomId] = { thinking: false, stopFlag: false, level };
      setTimeout(() => _botLoop(roomId), 300);
      return { ok: true, roomId };
    }

    const room = rooms[roomId];
    if (!room) return { ok: true, roomId };

    // decide bot color relative to user
    let botColor = "b";
    const userIndex = room.players.findIndex((p) => {
      const uid = (p.user && (p.user.id || p.user._id)) || p.id;
      return uid && String(uid) === String(userObj.id);
    });
    if (userIndex !== -1) {
      const p = room.players[userIndex];
      if (p && p.color === "w") botColor = "b";
      else if (p && p.color === "b") botColor = "w";
    } else {
      botColor =
        room.players[1] && room.players[1].color ? room.players[1].color : "b";
    }

    let botPlayerIdx = room.players.findIndex((p) => {
      const uid = (p.user && (p.user.id || p.user._id)) || p.id;
      return !uid || String(uid) !== String(userObj.id);
    });
    if (botPlayerIdx === -1) botPlayerIdx = 1;

    room.players[botPlayerIdx] = {
      id: `bot:jsengine:${roomId}`,
      user: { id: null, username: botName },
      color: botColor,
      online: true,
      disconnectedAt: null,
    };

    room.bot = { engine: "simple", color: botColor, level };

    if (!room.chess) room.chess = new (require("chess.js").Chess)();
    room.fen = room.chess.fen();

    try {
      if (typeof roomManager.broadcastRoomState === "function")
        roomManager.broadcastRoomState(roomId);
    } catch (e) {}

    botRecords[roomId] = { thinking: false, stopFlag: false, level };
    setTimeout(() => _botLoop(roomId), 300);

    return { ok: true, roomId };
  } catch (err) {
    console.error(
      "createBotRoomForUser error",
      err && err.stack ? err.stack : err
    );
    return {
      ok: false,
      error: err && err.message ? err.message : "server-error",
    };
  }
}

async function stopBotForRoom(roomId) {
  if (botRecords[roomId]) {
    botRecords[roomId].stopFlag = true;
    delete botRecords[roomId];
  }
}

module.exports = {
  createBotRoomForUser,
  stopBotForRoom,
};
