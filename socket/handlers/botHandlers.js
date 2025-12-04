// backend/socket/handlers/botHandlers.js
// Bot handlers (stockfish) for server-side computer opponents.
// Export: registerAll(socket, context)

const { Chess } = require("chess.js");

/**
 * small helper: create a wasm stockfish session using the npm 'stockfish' package.
 * Returns { send(cmd), readUntil(marker, timeout), quit() } or null on failure.
 */
async function createWasmEngine(timeout = 4000) {
  try {
    const pkg = require("stockfish");
    const engine = typeof pkg === "function" ? pkg() : pkg;

    let listeners = [];
    const onMessage = (ev) => {
      let data = ev;
      if (Array.isArray(ev) && ev.length) data = ev.join(" ");
      if (ev && typeof ev === "object" && typeof ev.data === "string")
        data = ev.data;
      try {
        listeners.forEach((fn) => {
          try {
            fn(String(data));
          } catch (e) {}
        });
      } catch (e) {}
    };

    try {
      engine.onmessage = onMessage;
    } catch (e) {}

    const send = (cmd) => {
      try {
        if (typeof engine.postMessage === "function") engine.postMessage(cmd);
        else if (typeof engine.send === "function") engine.send(cmd);
        else if (typeof engine === "function") engine(cmd);
      } catch (e) {}
    };

    const readUntil = (marker = "bestmove", t = timeout) =>
      new Promise((resolve) => {
        let out = "";
        const onData = (text) => {
          const s = String(text || "");
          out += s + "\n";
          if (out.includes(marker)) {
            cleanup();
            resolve(out);
          }
        };
        listeners.push(onData);
        const cleanup = () => {
          listeners = listeners.filter((l) => l !== onData);
        };
        setTimeout(() => {
          cleanup();
          resolve(out);
        }, t);
      });

    const quit = () => {
      try {
        if (typeof engine.postMessage === "function")
          engine.postMessage("quit");
        if (typeof engine.terminate === "function") engine.terminate();
      } catch (e) {}
    };

    return { send, readUntil, quit };
  } catch (e) {
    return null;
  }
}

/**
 * build a bot player object compatible with your rooms/player structure.
 */
function makeBotPlayer(level = 3, color = "b") {
  const id = `bot:stockfish:${level}:${Date.now()}`;
  return {
    id,
    color,
    user: {
      id: null,
      username: `Stockfish (lvl ${level})`,
      displayName: `Stockfish (lvl ${level})`,
      avatarUrl: null,
    },
    online: true,
    bot: true,
  };
}

function registerAll(socket, context) {
  if (!context) return;

  const io = context.io;
  const rooms = context.rooms;
  const genCode =
    context.generateRoomCode ||
    (() => `BOT-${Math.random().toString(36).slice(2, 8)}`);
  const broadcastRoomState = context.broadcastRoomState;
  const saveFinishedGame = context.saveFinishedGame;
  const scheduleFirstMoveTimer = context.scheduleFirstMoveTimer;
  const markUserActiveRoom = context.markUserActiveRoom;
  const tryReserveActiveRoom = context.tryReserveActiveRoom;
  const clearActiveRoomForRoom = context.clearActiveRoomForRoom;
  const applyCups = context.applyCupsForFinishedRoom || (async (rid) => {});
  const addOnlineSocketForUser = context.addOnlineSocketForUser || (() => {});
  const ChessLib = Chess || context.Chess || require("chess.js").Chess;

  const enginesByRoom = {};

  async function teardownEngineForRoom(roomId) {
    try {
      const s = enginesByRoom[roomId];
      if (s && typeof s.quit === "function") {
        try {
          s.quit();
        } catch (e) {}
      }
    } catch (e) {}
    delete enginesByRoom[roomId];
  }

  async function createBotRoomForSocket({
    socket,
    minutes = 5,
    level = 3,
    colorPreference = "random",
  }) {
    const user = socket.user || null;
    const userId =
      user && (user.id || user._id) ? String(user.id || user._id) : null;

    // generate id up front
    const roomId = genCode();
    const minutesNum = Math.max(1, Math.floor(Number(minutes) || 5));
    const msPerSide = minutesNum * 60 * 1000;

    // reserve DB activeRoom if helper exists (use generated roomId)
    if (userId && typeof tryReserveActiveRoom === "function") {
      try {
        await tryReserveActiveRoom(userId, roomId).catch(() => {});
      } catch (e) {}
    }

    // Determine colors
    let humanColor = "w";
    if (colorPreference === "black") humanColor = "b";
    else if (colorPreference === "white") humanColor = "w";
    else if (colorPreference === "random")
      humanColor = Math.random() < 0.5 ? "w" : "b";

    const botColor = humanColor === "w" ? "b" : "w";

    const now = Date.now();
    const chess = new ChessLib();
    const initialFen = chess.fen();

    const humanPlayer = {
      id: socket.id,
      color: humanColor,
      user: user
        ? {
            id: user.id || user._id,
            username: user.username || "guest",
            displayName: user.displayName || user.username || null,
            avatarUrl: user.avatarUrl || null,
          }
        : null,
      online: true,
    };

    const botPlayer = makeBotPlayer(level, botColor);

    const room = {
      roomId,
      players: [humanPlayer, botPlayer],
      fen: initialFen,
      moves: [],
      lastIndex: -1,
      clocks: { w: msPerSide, b: msPerSide, running: "w", lastTick: now },
      paused: false,
      finished: null,
      createdAt: now,
      disconnectTimers: {},
      firstMoveTimer: null,
      messages: [],
    };

    rooms[roomId] = room;

    try {
      socket.join(roomId);
    } catch (e) {}

    try {
      if (typeof broadcastRoomState === "function") broadcastRoomState(roomId);
      else io.to(socket.id).emit("room-update", room);
    } catch (e) {}

    // mark DB activeRoom if helper present
    try {
      if (userId && typeof markUserActiveRoom === "function") {
        markUserActiveRoom(userId, roomId).catch(() => {});
      }
    } catch (e) {}

    // schedule first move timer and expiration (use roomId)
    try {
      if (typeof scheduleFirstMoveTimer === "function")
        scheduleFirstMoveTimer(roomId);
    } catch (e) {}

    // create wasm engine for this room (if available)
    try {
      const engine = await createWasmEngine(8000);
      if (engine) enginesByRoom[roomId] = engine;
    } catch (e) {
      console.warn("[bot] engine creation failed:", e);
    }

    // If bot moves first, trigger an immediate check
    (async () => {
      try {
        await new Promise((r) => setTimeout(r, 100));
        const rObj = rooms[roomId];
        if (!rObj) return;
        if (
          rObj.clocks &&
          rObj.clocks.running &&
          rObj.clocks.running === botColor &&
          !rObj.finished
        ) {
          await runBotMakeMove(roomId, level);
        }
      } catch (e) {
        console.error("[bot] starter error:", e);
      }
    })();

    return roomId;
  }

  async function runBotMakeMove(roomId, level = 3) {
    try {
      const room = rooms[roomId];
      if (!room) return;
      if (room.finished) return;
      const engine = enginesByRoom[roomId];
      if (!engine) return;

      const bot = (room.players || []).find((p) => p.bot);
      const human = (room.players || []).find((p) => !p.bot);
      if (!bot || !human) return;

      const botColor = bot.color;
      const humanColor = human.color;

      if (!room.clocks || room.clocks.running !== botColor) return;

      // pause ticking while thinking
      const originalRunning = room.clocks.running;
      room.clocks.running = null;
      const thinkStart = Date.now();

      const uciList = [];
      try {
        for (const m of room.moves || []) {
          if (m && m.move) {
            if (typeof m.move === "string") {
              const s = m.move;
              if (/^[a-h][1-8][a-h][1-8]/.test(s)) {
                uciList.push(s.replace(/=/g, ""));
              }
            } else if (m.move.from && m.move.to) {
              let mm = `${m.move.from}${m.move.to}`;
              if (m.move.promotion) mm += m.move.promotion;
              uciList.push(mm);
            }
          }
        }
      } catch (e) {}

      let best = null;
      try {
        const depth = Math.max(
          2,
          Math.min(20, Math.floor(Number(level) * 2) + 4)
        );
        engine.send("uci");
        engine.send("isready");
        if (uciList.length)
          engine.send(`position startpos moves ${uciList.join(" ")}`);
        else engine.send("position startpos");
        engine.send(`go depth ${depth}`);
        const raw = await engine.readUntil("bestmove", 8000 + depth * 500);
        const m = raw.match(/bestmove\s+([a-h][1-8][a-h][1-8][qrbnQRBN]?)/);
        if (m) best = m[1].toLowerCase();
      } catch (e) {
        console.warn("[bot] engine bestmove failed:", e);
      }

      const thinkEnd = Date.now();
      const elapsed = Math.max(0, thinkEnd - thinkStart);

      try {
        room.clocks[botColor] = Math.max(
          0,
          (room.clocks[botColor] || 0) - elapsed
        );
      } catch (e) {}

      if (!best) {
        room.finished = {
          reason: "engine-failed",
          winner: humanColor,
          loser: botColor,
          message: "Computer failed to move — you win",
          finishedAt: Date.now(),
        };
        try {
          io.to(roomId).emit("game-over", { ...room.finished });
          broadcastRoomState && broadcastRoomState(roomId);
          await saveFinishedGame(roomId);
          await applyCups(roomId);
        } catch (e) {}
        await teardownEngineForRoom(roomId);
        return;
      }

      const moveObj = { from: best.slice(0, 2), to: best.slice(2, 4) };
      if (best.length === 5) moveObj.promotion = best[4];

      let chess = null;
      try {
        chess = new ChessLib(room.fen || undefined);
      } catch (e) {
        chess = new ChessLib();
      }
      try {
        const res = chess.move(moveObj);
        if (!res) {
          room.finished = {
            reason: "engine-illegal",
            winner: humanColor,
            loser: botColor,
            message: "Computer produced illegal move — you win",
            finishedAt: Date.now(),
          };
          io.to(roomId).emit("game-over", { ...room.finished });
          broadcastRoomState && broadcastRoomState(roomId);
          await saveFinishedGame(roomId);
          await applyCups(roomId);
          await teardownEngineForRoom(roomId);
          return;
        }
      } catch (e) {}

      try {
        room.lastIndex =
          (typeof room.lastIndex === "number" ? room.lastIndex : -1) + 1;
        const record = {
          index: room.lastIndex,
          move: moveObj,
          fen: chess.fen(),
          clocks: room.clocks,
        };
        room.moves = room.moves || [];
        room.moves.push(record);
        room.fen = chess.fen();

        try {
          io.to(roomId).emit("opponent-move", record);
          broadcastRoomState && broadcastRoomState(roomId);
        } catch (e) {}

        try {
          if (chess.isGameOver && chess.isGameOver()) {
            let finished = null;
            try {
              if (chess.in_checkmate && chess.in_checkmate()) {
                finished = {
                  reason: "checkmate",
                  winner: botColor,
                  loser: humanColor,
                  message: `${botColor.toUpperCase()} wins by checkmate`,
                  finishedAt: Date.now(),
                };
              } else if (
                (chess.in_draw && chess.in_draw()) ||
                (chess.in_stalemate && chess.in_stalemate())
              ) {
                finished = {
                  reason: "draw",
                  result: "draw",
                  message: "Draw",
                  finishedAt: Date.now(),
                };
              }
            } catch (e) {}

            if (finished) {
              room.finished = finished;
              io.to(roomId).emit("game-over", { ...finished });
              broadcastRoomState && broadcastRoomState(roomId);
              await saveFinishedGame(roomId);
              try {
                await applyCups(roomId);
              } catch (e) {}
              await teardownEngineForRoom(roomId);
              return;
            }
          }
        } catch (e) {}

        try {
          room.clocks.running = humanColor;
          room.clocks.lastTick = Date.now();
        } catch (e) {}

        try {
          if (
            typeof room.clocks[humanColor] === "number" &&
            room.clocks[humanColor] <= 0
          ) {
            room.paused = true;
            room.finished = {
              reason: "timeout",
              winner: botColor,
              loser: humanColor,
              message: `${botColor.toUpperCase()} wins by timeout`,
              finishedAt: Date.now(),
            };
            io.to(roomId).emit("game-over", { ...room.finished });
            broadcastRoomState && broadcastRoomState(roomId);
            await saveFinishedGame(roomId);
            await applyCups(roomId);
            await teardownEngineForRoom(roomId);
            return;
          }
        } catch (e) {}
      } catch (e) {
        console.error("[bot] failed append move:", e);
      }
    } catch (e) {
      console.error("[bot] runBotMakeMove caught:", e);
    }
  }

  socket.on("play-bot", async (payload = {}) => {
    try {
      const minutes = Math.max(
        1,
        Math.floor(Number(payload?.minutes || payload?.m || 5))
      );
      const level = Math.max(
        1,
        Math.min(8, Math.floor(Number(payload?.level || payload?.lvl || 3)))
      );
      const colorPreference =
        payload?.colorPreference || payload?.cp || "random";

      const roomId = await createBotRoomForSocket({
        socket,
        minutes,
        level,
        colorPreference,
      });

      socket.emit("room-created", { ok: true, roomId });
    } catch (err) {
      console.error("[bot] play-bot error:", err);
      try {
        socket.emit("room-created", {
          ok: false,
          error: "Failed to create bot game",
        });
      } catch (e) {}
    }
  });

  socket.on("cancel-bot", ({ roomId } = {}) => {
    try {
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room) return;
      teardownEngineForRoom(roomId).catch(() => {});
      try {
        if (typeof clearActiveRoomForRoom === "function")
          clearActiveRoomForRoom(room).catch(() => {});
      } catch (e) {}
      try {
        delete rooms[roomId];
      } catch (e) {}
      try {
        io.to(roomId).emit("no-such-room", { roomId });
      } catch (e) {}
    } catch (e) {}
  });

  socket.on("request-bot-check", async ({ roomId } = {}) => {
    try {
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room) return;
      const bot = (room.players || []).find((p) => p && p.bot);
      if (!bot) return;
      if (room.clocks && room.clocks.running === bot.color && !room.finished) {
        let level = 3;
        try {
          const m = (bot.id || "").match(/^bot:stockfish:(\d+)/);
          if (m) level = Number(m[1]) || level;
        } catch (e) {}
        await runBotMakeMove(roomId, level);
      }
    } catch (e) {}
  });

  socket.on("disconnect", () => {
    try {
      const ownedRooms = Object.keys(rooms).filter((rid) => {
        const r = rooms[rid];
        if (!r) return false;
        const human = (r.players || []).find((p) => p && !p.bot);
        if (!human) return false;
        return human.id === socket.id;
      });
      for (const rid of ownedRooms) {
        teardownEngineForRoom(rid).catch(() => {});
        try {
          delete rooms[rid];
        } catch (e) {}
      }
    } catch (e) {}
  });
}

module.exports = { registerAll };
