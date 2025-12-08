// backend/socket/handlers/gameHandlers.js
// Complete socket handlers file with full bot support and all other handlers.
// Replace your existing file with this one.

const { Chess } = require("chess.js");

module.exports = {
  registerAll(socket, context) {
    // context expected keys (from your project):
    // io, rooms, Room, User, Game, Notification, notificationService,
    // broadcastRoomState, clearDisconnectTimer, scheduleFirstMoveTimer,
    // clearFirstMoveTimer, markUserActiveRoom, clearActiveRoomForRoom,
    // ensureAvatarAbs, mapPlayerForEmit, normalizeAndValidateRoomCode,
    // normalizePromotionChar, applyCupsForFinishedRoom, saveFinishedGame,
    // generateRoomCode, computeBaseUrl, DISCONNECT_GRACE_MS, MAX_CHAT_MESSAGES,
    // DEFAULT_MS, removeFromPlayQueueBySocket, removeFromPlayQueueByKey, etc.
    const {
      io,
      rooms,
      Room,
      User,
      Game,
      Notification,
      notificationService,
      broadcastRoomState,
      clearDisconnectTimer,
      scheduleFirstMoveTimer,
      clearFirstMoveTimer,
      markUserActiveRoom,
      clearActiveRoomForRoom,
      ensureAvatarAbs,
      mapPlayerForEmit,
      normalizeAndValidateRoomCode,
      normalizePromotionChar,
      applyCupsForFinishedRoom,
      saveFinishedGame,
      generateRoomCode,
      computeBaseUrl,
      DISCONNECT_GRACE_MS = 60_000,
      MAX_CHAT_MESSAGES = 200,
      DEFAULT_MS = 5 * 60 * 1000,
      removeFromPlayQueueBySocket,
    } = context || {};

    // === Bot adapter (optional) ===
    let jsChessEngineAdapter = null;
    try {
      jsChessEngineAdapter = require("../../lib/jsChessEngineAdapter");
      // expected exported method: aiMoveFromFen(fen, engineLevel) -> { from: 'e2', to: 'e4', promotion?: 'q' }
    } catch (e) {
      jsChessEngineAdapter = null;
    }

    // Helper: convert a provided level (rating number or 0-4) to engine level 0..4
    function mapRequestedBotLevelToEngine(level) {
      const n = Number(level);
      if (Number.isFinite(n)) {
        if (n >= 0 && n <= 4) return Math.max(0, Math.min(4, Math.floor(n)));
        if (n < 800) return 0;
        if (n < 1200) return 1;
        if (n < 1500) return 2;
        if (n < 1800) return 3;
        return 4;
      }
      return 2;
    }

    // Helper: clear any bot timer on room
    function clearBotTimeout(room) {
      try {
        if (!room) return;
        if (room._botTimeout) {
          clearTimeout(room._botTimeout);
          room._botTimeout = null;
        }
      } catch (e) {}
    }

    // Schedule a bot move after `delayMs` milliseconds
    function scheduleBotMove(roomId, delayMs = 500) {
      try {
        const room = rooms[roomId];
        if (!room) return;
        clearBotTimeout(room);
        room._botTimeout = setTimeout(() => {
          applyBotMove(roomId).catch((err) =>
            console.error("applyBotMove scheduled error:", err)
          );
        }, delayMs);
      } catch (e) {}
    }

    // Apply a bot move server-side
    async function applyBotMove(roomId) {
      try {
        const room = rooms[roomId];
        if (!room) return;
        clearBotTimeout(room);

        if (!room || room.finished) return;
        // bot settings must be present and enabled
        if (!(room.settings && room.settings.bot && room.settings.bot.enabled))
          return;

        if (!room.chess)
          room.chess = room.fen ? new Chess(room.fen) : new Chess();
        const chess = room.chess;

        const botPlayer = (room.players || []).find((p) =>
          String(p.id || "")
            .toLowerCase()
            .startsWith("bot:")
        );
        if (!botPlayer) return;

        const botColor = botPlayer.color;
        if (!botColor) return;

        // ensure it's the bot's turn
        const currentTurn = chess.turn();
        if (!currentTurn || currentTurn !== botColor) return;

        // engine level
        const engineLevel = mapRequestedBotLevelToEngine(
          room.settings.bot.level
        );

        // compute AI move via adapter, fallback to random
        let aiMove = null;
        try {
          if (
            jsChessEngineAdapter &&
            typeof jsChessEngineAdapter.aiMoveFromFen === "function"
          ) {
            aiMove = await jsChessEngineAdapter.aiMoveFromFen(
              room.fen || chess.fen(),
              engineLevel
            );
          }
        } catch (e) {
          aiMove = null;
        }

        // fallback: random legal verbose move (so we can know promotion)
        if (!aiMove || !aiMove.from || !aiMove.to) {
          let movesList = [];
          try {
            movesList = chess.moves({ verbose: true }) || [];
          } catch (e) {
            try {
              movesList = chess.moves() || [];
            } catch {
              movesList = [];
            }
          }
          if (!Array.isArray(movesList) || movesList.length === 0) return;
          const pick = movesList[Math.floor(Math.random() * movesList.length)];
          aiMove = {
            from: pick.from,
            to: pick.to,
            promotion: pick.promotion || undefined,
          };
        }

        if (!aiMove || !aiMove.from || !aiMove.to) return;

        // normalize promotion
        if (aiMove.promotion) {
          const p = normalizePromotionChar(aiMove.promotion);
          if (p) aiMove.promotion = p;
          else delete aiMove.promotion;
        }

        // attempt move
        const result = chess.move(aiMove);
        if (!result) {
          // illegal: request sync and abort
          try {
            io.to(roomId).emit("request-sync", { roomId });
          } catch (e) {}
          return;
        }

        room.lastIndex = (room.lastIndex ?? -1) + 1;
        const record = { index: room.lastIndex, move: aiMove };
        room.moves.push(record);
        room.fen = chess.fen();

        // clocks: update similar to human move handling
        try {
          if (!room.clocks) {
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
            room.clocks.running = chess.turn();
            room.clocks.lastTick = Date.now();
          }
        } catch (e) {}

        // clear first-move timer if any
        try {
          clearFirstMoveTimer && clearFirstMoveTimer(room);
        } catch (e) {}

        // detect finished states
        let finishedObj = null;

        let isCheckmate = false;
        let isStalemate = false;
        let isThreefold = false;
        let isInsufficient = false;
        let isDraw = false;
        try {
          if (typeof chess.in_checkmate === "function")
            isCheckmate = chess.in_checkmate();
          if (typeof chess.in_stalemate === "function")
            isStalemate = chess.in_stalemate();
          if (typeof chess.in_threefold_repetition === "function")
            isThreefold = chess.in_threefold_repetition();
          if (typeof chess.insufficient_material === "function")
            isInsufficient = chess.insufficient_material();
          if (typeof chess.in_draw === "function") isDraw = chess.in_draw();
        } catch (e) {}

        // fallback: if moves() returns 0, check in_check to decide mate vs stalemate
        try {
          const movesList =
            chess.moves && Array.isArray(chess.moves({ verbose: true }))
              ? chess.moves({ verbose: true })
              : [];
          if (
            (!movesList || movesList.length === 0) &&
            !(isCheckmate || isStalemate)
          ) {
            const inCheckNow =
              (typeof chess.in_check === "function" && chess.in_check()) ||
              false;
            if (inCheckNow) isCheckmate = true;
            else isStalemate = true;
          }
        } catch (e) {}

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
        } else if (isDraw) {
          finishedObj = {
            reason: "draw",
            result: "draw",
            message: "Draw",
            finishedAt: Date.now(),
          };
        }

        // clear pending draw offers from bot if needed
        if (room.pendingDrawOffer) {
          if (
            room.pendingDrawOffer.fromSocketId === botPlayer.id ||
            (botPlayer.user &&
              room.pendingDrawOffer.fromUserId === botPlayer.user.id)
          ) {
            room.pendingDrawOffer = null;
          }
        }

        // emit opponent-move to clients
        try {
          io.to(roomId).emit("opponent-move", {
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
        } catch (e) {}

        if (finishedObj) {
          room.finished = finishedObj;
          room.paused = true;
          if (room.clocks) {
            room.clocks.running = null;
            room.clocks.lastTick = null;
          }
          io.to(roomId).emit("game-over", { ...room.finished });
          clearFirstMoveTimer && clearFirstMoveTimer(room);
          Object.keys(room.disconnectTimers || {}).forEach((sid) => {
            try {
              clearDisconnectTimer(room, sid);
            } catch (e) {}
          });
          clearBotTimeout(room);
          broadcastRoomState && broadcastRoomState(roomId);

          // persist & apply cups: SKIP applyCups if room contains a bot (we don't want RATING changes for bot games)
          try {
            if (typeof saveFinishedGame === "function")
              await saveFinishedGame(roomId);
          } catch (e) {
            console.error("saveFinishedGame error (applyBotMove):", e);
          }

          try {
            const containsBot = (room.players || []).some((p) =>
              String(p.id || "")
                .toLowerCase()
                .startsWith("bot:")
            );
            if (!containsBot) {
              if (typeof applyCupsForFinishedRoom === "function")
                await applyCupsForFinishedRoom(roomId);
            } else {
              // if your applyCupsForFinishedRoom internally skips bots, the above check is redundant -- safe guard
            }
          } catch (e) {
            console.error("applyCupsForFinishedRoom error (applyBotMove):", e);
          }
        } else {
          broadcastRoomState && broadcastRoomState(roomId);

          // If the bot is still to move (bot vs bot or immediate reply) schedule next
          try {
            const nowTurn = chess.turn();
            const botIsNowToMove = (room.players || []).some(
              (p) =>
                String(p.id || "")
                  .toLowerCase()
                  .startsWith("bot:") && p.color === nowTurn
            );
            if (botIsNowToMove) {
              const nextEngine = mapRequestedBotLevelToEngine(
                room.settings.bot.level
              );
              const delay =
                300 +
                Math.max(0, 4 - nextEngine) * 300 +
                Math.floor(Math.random() * 300);
              scheduleBotMove(roomId, delay);
            }
          } catch (e) {}
        }
      } catch (err) {
        console.error("applyBotMove outer error:", err);
      }
    }

    // ---------- Event handlers below ----------

    socket.on("check-room", async ({ roomId }, cb) => {
      try {
        let exists = !!rooms[roomId];
        if (!exists && Room) {
          try {
            const doc = await Room.findOne({ roomId }).lean().exec();
            exists = !!doc;
          } catch (e) {
            exists = false;
          }
        }
        if (typeof cb === "function") cb({ exists });
      } catch (e) {
        if (typeof cb === "function") cb({ exists: false });
      }
    });

    socket.on("create-room", (params = {}) => {
      (async () => {
        try {
          const {
            roomId: requestedRoomId,
            minutes,
            colorPreference,
            user,
            bot,
            botLevel,
          } = params || {};

          let minutesNum =
            typeof minutes === "number"
              ? Math.max(1, Math.floor(minutes))
              : Math.floor(DEFAULT_MS / 60000);
          const minutesMs = minutesNum * 60 * 1000;

          // determine roomId
          let roomId = null;
          if (requestedRoomId && String(requestedRoomId).trim()) {
            const val = normalizeAndValidateRoomCode
              ? normalizeAndValidateRoomCode(requestedRoomId)
              : { ok: true, code: String(requestedRoomId).trim() };
            if (!val.ok) {
              socket.emit("room-created", { ok: false, error: val.error });
              return;
            }
            roomId = val.code;
            if (rooms[roomId]) {
              socket.emit("room-created", {
                ok: false,
                error: `Room code "${roomId}" is already in use.`,
              });
              return;
            }
          } else {
            // generate unique code
            roomId = generateRoomCode
              ? generateRoomCode()
              : Math.random().toString(36).slice(2, 8);
            let attempts = 0;
            while (rooms[roomId] && attempts < 8) {
              roomId = generateRoomCode
                ? generateRoomCode()
                : Math.random().toString(36).slice(2, 8);
              attempts++;
            }
            if (rooms[roomId]) {
              socket.emit("room-created", {
                ok: false,
                error: "Failed to generate unique room code",
              });
              return;
            }
          }

          // Create in-memory room
          rooms[roomId] = rooms[roomId] || {
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

          // Add creating socket as a player (if logged-in) or spectator
          let assignedColor = "spectator";
          if (socket.user) {
            // try to assign a color based on preference
            const wTaken = room.players.some((p) => p.color === "w");
            const bTaken = room.players.some((p) => p.color === "b");
            if (room.settings.colorPreference === "white" && !wTaken)
              assignedColor = "w";
            else if (room.settings.colorPreference === "black" && !bTaken)
              assignedColor = "b";
            else {
              if (!wTaken) assignedColor = "w";
              else if (!bTaken) assignedColor = "b";
              else assignedColor = "spectator";
            }

            const playerObj = {
              id: socket.id,
              user: ensureAvatarAbs(socket.user),
              color: assignedColor,
              online: true,
              disconnectedAt: null,
            };

            room.players.push(playerObj);
            socket.emit("player-assigned", { color: assignedColor });

            if (
              playerObj.user &&
              (playerObj.color === "w" || playerObj.color === "b")
            ) {
              (async () => {
                try {
                  if (typeof markUserActiveRoom === "function")
                    await markUserActiveRoom(
                      playerObj.user.id || playerObj.user._id,
                      roomId
                    );
                } catch (e) {}
              })();
            }
          } else {
            // guest spectator
            const playerObj = {
              id: socket.id,
              user: user || { username: "guest" },
              color: "spectator",
              online: true,
              disconnectedAt: null,
            };
            playerObj.user = ensureAvatarAbs(playerObj.user);
            room.players.push(playerObj);
            socket.emit("player-assigned", { color: "spectator" });
          }

          // Bot injection if requested
          try {
            const wantsBot = !!bot || typeof botLevel !== "undefined";
            if (wantsBot) {
              const lvl =
                Number(botLevel || (bot && bot.level) || 1200) || 1200;
              const botId = `bot:${lvl}-${Date.now()}`;
              const baseUrl = computeBaseUrl ? computeBaseUrl() : "";

              const botUser = {
                id: botId,
                username: `bot${lvl}`,
                displayName: `Bot (Lv ${lvl})`,
                avatarUrl: baseUrl
                  ? `${baseUrl}/api/uploads/bot-avatar.png`
                  : `/api/uploads/bot-avatar.png`,
              };

              // choose color for bot: opposite of human if human playing else follow preference
              let botColor = "b";
              const human = room.players.find((p) => p.id === socket.id);
              if (human && (human.color === "w" || human.color === "b")) {
                botColor = human.color === "w" ? "b" : "w";
              } else {
                const pref = room.settings.colorPreference;
                const wTaken = room.players.some((p) => p.color === "w");
                const bTaken = room.players.some((p) => p.color === "b");
                if (pref === "white" && !wTaken) botColor = "w";
                else if (pref === "black" && !bTaken) botColor = "b";
                else {
                  if (!wTaken) botColor = "w";
                  else if (!bTaken) botColor = "b";
                  else botColor = "spectator";
                }
              }

              const botPlayerObj = {
                id: botId,
                user: botUser,
                color: botColor,
                online: true,
                disconnectedAt: null,
              };

              room.players.push(botPlayerObj);

              room.settings.bot = { enabled: true, level: lvl };

              // ensure two colored players exist
              const coloredNow = room.players.filter(
                (p) => p.color === "w" || p.color === "b"
              );
              if (coloredNow.length === 2) {
                // init clocks
                room.clocks = {
                  w: room.settings.minutesMs || minutesMs,
                  b: room.settings.minutesMs || minutesMs,
                  running: room.chess.turn(),
                  lastTick: Date.now(),
                };
                scheduleFirstMoveTimer && scheduleFirstMoveTimer(roomId);
              } else {
                // if human was spectator, assign them the other color
                const humanEntry = room.players.find((p) => p.id === socket.id);
                if (
                  humanEntry &&
                  humanEntry.color === "spectator" &&
                  botPlayerObj.color !== "spectator"
                ) {
                  humanEntry.color = botPlayerObj.color === "w" ? "b" : "w";
                  socket.emit("player-assigned", { color: humanEntry.color });
                  (async () => {
                    try {
                      if (
                        humanEntry.user &&
                        typeof markUserActiveRoom === "function"
                      )
                        await markUserActiveRoom(
                          humanEntry.user.id || humanEntry.user._id,
                          roomId
                        );
                    } catch (e) {}
                  })();
                }
              }
            }
          } catch (err) {
            console.error("create-room: bot insertion error", err);
          }

          // initialize clocks if two colored
          try {
            const colored = room.players.filter(
              (p) => p.color === "w" || p.color === "b"
            );
            if (colored.length === 2 && !room.clocks && !room.finished) {
              room.clocks = {
                w: room.settings.minutesMs || minutesMs,
                b: room.settings.minutesMs || minutesMs,
                running: room.chess.turn(),
                lastTick: Date.now(),
              };
              scheduleFirstMoveTimer && scheduleFirstMoveTimer(roomId);
            }
          } catch (e) {}

          broadcastRoomState && broadcastRoomState(roomId);

          socket.join(roomId);
          socket.emit("room-created", {
            ok: true,
            roomId,
            settings: room.settings,
            assignedColor,
          });
          console.log(
            `Room ${roomId} created by ${socket.user?.username || socket.id}`
          );

          // If bot exists and it's bot's turn, schedule
          try {
            const botPl = (room.players || []).find((p) =>
              String(p.id || "")
                .toLowerCase()
                .startsWith("bot:")
            );
            if (
              botPl &&
              room.chess &&
              !room.finished &&
              room.chess.turn() === botPl.color
            ) {
              const engineLevel = mapRequestedBotLevelToEngine(
                room.settings.bot.level
              );
              const delay =
                300 +
                Math.max(0, 4 - engineLevel) * 300 +
                Math.floor(Math.random() * 500);
              scheduleBotMove(roomId, delay);
            }
          } catch (e) {}
        } catch (err) {
          console.error("create-room error:", err);
          socket.emit("room-created", {
            ok: false,
            error: "Server error creating room",
          });
        }
      })();
    });

    socket.on("join-room", async ({ roomId, user }) => {
      if (!roomId) return;
      try {
        // load persistent if not in-memory
        if (!rooms[roomId] && Room) {
          try {
            const doc = await Room.findOne({ roomId }).lean().exec();
            if (doc) {
              // send room snapshot to the new socket and return
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
                  message: doc.finished.message || "This room has finished.",
                });
              }
              return;
            } else {
              socket.emit("no-such-room", { roomId });
              return;
            }
          } catch (e) {
            socket.emit("no-such-room", { roomId });
            return;
          }
        }

        // in-memory join
        socket.join(roomId);
        const room = rooms[roomId];
        if (!room) {
          socket.emit("no-such-room", { roomId });
          return;
        }

        if (!room.chess)
          room.chess = room.fen ? new Chess(room.fen) : new Chess();
        const chess = room.chess;

        const candidateUserId =
          socket.user?.id ?? user?.id ?? user?._id
            ? String(socket.user?.id ?? user?.id ?? user?._id)
            : null;
        const candidateUsername =
          socket.user?.username ?? user?.username ?? null;

        // server-side guard: DB user activeRoom (deny join)
        if (candidateUserId && User) {
          try {
            const dbUser = await User.findById(candidateUserId).lean().exec();
            if (
              dbUser &&
              dbUser.activeRoom &&
              String(dbUser.activeRoom) !== String(roomId)
            ) {
              socket.emit("join-denied-active-room", {
                reason: "already_active",
                message: "You already have an active game.",
                activeRoom: dbUser.activeRoom,
              });
              socket.emit("notification", {
                type: "join_denied_active_room",
                activeRoom: dbUser.activeRoom,
                message: "You already have an active game.",
              });
              return;
            }
          } catch (e) {
            // ignore DB error and proceed
          }
        }

        // find existing player entry for this user
        let existing = null;
        if (candidateUserId) {
          existing = room.players.find(
            (p) => p.user && String(p.user.id || p.user._id) === candidateUserId
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
          // re-attach socket id
          clearDisconnectTimer && clearDisconnectTimer(room, existing.id);
          existing.id = socket.id;
          existing.user = ensureAvatarAbs(
            socket.user || existing.user || user || { username: "guest" }
          );
          existing.online = true;
          existing.disconnectedAt = null;
          socket.emit("player-assigned", {
            color: existing.color || "spectator",
          });

          if (
            existing.user &&
            (existing.color === "w" || existing.color === "b")
          ) {
            (async () => {
              try {
                if (typeof markUserActiveRoom === "function")
                  await markUserActiveRoom(
                    existing.user.id || existing.user._id,
                    roomId
                  );
              } catch (e) {}
            })();
          }
        } else {
          // new player: assign color if possible
          let assignedColor = "spectator";
          if (socket.user) {
            const wTaken = room.players.some((p) => p.color === "w");
            const bTaken = room.players.some((p) => p.color === "b");
            if (!wTaken) assignedColor = "w";
            else if (!bTaken) assignedColor = "b";
            else assignedColor = "spectator";
          }
          const playerObj = {
            id: socket.id,
            user: ensureAvatarAbs(socket.user || user || { username: "guest" }),
            color: assignedColor,
            online: true,
            disconnectedAt: null,
          };
          room.players.push(playerObj);
          socket.emit("player-assigned", { color: playerObj.color });
          if (
            playerObj.user &&
            (playerObj.color === "w" || playerObj.color === "b")
          ) {
            (async () => {
              try {
                if (typeof markUserActiveRoom === "function")
                  await markUserActiveRoom(
                    playerObj.user.id || playerObj.user._id,
                    roomId
                  );
              } catch (e) {}
            })();
          }
        }

        clearDisconnectTimer && clearDisconnectTimer(room, socket.id);

        // initialize clocks if now two colored players
        const coloredPlayers = room.players.filter(
          (p) => p.color === "w" || p.color === "b"
        );
        if (!room.clocks && coloredPlayers.length === 2 && !room.finished) {
          room.clocks = {
            w: room.settings?.minutesMs || room.settings.minutes * 60 * 1000,
            b: room.settings?.minutesMs || room.settings.minutes * 60 * 1000,
            running: room.chess.turn(),
            lastTick: Date.now(),
          };
          scheduleFirstMoveTimer && scheduleFirstMoveTimer(roomId);
        } else if (
          coloredPlayers.length === 2 &&
          !room.clocks?.running &&
          !room.finished
        ) {
          room.clocks.running = room.chess.turn();
          room.clocks.lastTick = Date.now();
          room.paused = false;
          scheduleFirstMoveTimer && scheduleFirstMoveTimer(roomId);
        }

        broadcastRoomState && broadcastRoomState(roomId);

        // emit readiness events
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

        // if bot exists and it's bot's turn, schedule move
        try {
          const botPl = (room.players || []).find((p) =>
            String(p.id || "")
              .toLowerCase()
              .startsWith("bot:")
          );
          if (
            botPl &&
            room.chess &&
            !room.finished &&
            room.chess.turn() === botPl.color
          ) {
            const engineLevel = mapRequestedBotLevelToEngine(
              room.settings?.bot?.level
            );
            const delay =
              300 +
              Math.max(0, 4 - engineLevel) * 300 +
              Math.floor(Math.random() * 500);
            scheduleBotMove(roomId, delay);
          }
        } catch (e) {}
      } catch (err) {
        console.error("join-room error:", err);
      }
    });

    socket.on("make-move", async ({ roomId, move }) => {
      if (!roomId || !move) return;
      try {
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

        if (!room.chess)
          room.chess = room.fen ? new Chess(room.fen) : new Chess();
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

        // normalize promotion if provided
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
            players: (room.players || []).map(mapPlayerForEmit),
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
              -Math.min(MAX_CHAT_MESSAGES, room.messages.length || 0)
            ),
          });
          return;
        }

        room.lastIndex = (room.lastIndex ?? -1) + 1;
        const record = { index: room.lastIndex, move };
        room.moves.push(record);
        room.fen = chess.fen();

        clearFirstMoveTimer && clearFirstMoveTimer(room);

        // detect finished
        let finishedObj = null;
        let isCheckmate = false;
        let isStalemate = false;
        let isThreefold = false;
        let isInsufficient = false;
        let isDraw = false;
        try {
          if (typeof chess.in_checkmate === "function")
            isCheckmate = chess.in_checkmate();
          if (typeof chess.in_stalemate === "function")
            isStalemate = chess.in_stalemate();
          if (typeof chess.in_threefold_repetition === "function")
            isThreefold = chess.in_threefold_repetition();
          if (typeof chess.insufficient_material === "function")
            isInsufficient = chess.insufficient_material();
          if (typeof chess.in_draw === "function") isDraw = chess.in_draw();
        } catch (e) {}

        // fallback moves() length check
        try {
          const movesList =
            chess.moves && Array.isArray(chess.moves({ verbose: true }))
              ? chess.moves({ verbose: true })
              : [];
          if (
            (!movesList || movesList.length === 0) &&
            !(isCheckmate || isStalemate)
          ) {
            const inCheckNow =
              (typeof chess.in_check === "function" && chess.in_check()) ||
              false;
            if (inCheckNow) isCheckmate = true;
            else isStalemate = true;
          }
        } catch (e) {}

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
        } else if (isDraw) {
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

        // clear pending draw if from this player
        if (room.pendingDrawOffer) {
          if (
            room.pendingDrawOffer.fromSocketId === player.id ||
            (player.user && room.pendingDrawOffer.fromUserId === player.user.id)
          ) {
            room.pendingDrawOffer = null;
          }
        }

        // emit to other players
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
          clearFirstMoveTimer && clearFirstMoveTimer(room);
          Object.keys(room.disconnectTimers || {}).forEach((sid) => {
            try {
              clearDisconnectTimer(room, sid);
            } catch (e) {}
          });
          clearBotTimeout(room);
          broadcastRoomState && broadcastRoomState(roomId);

          // persist and apply cups - skip for bot games
          try {
            if (typeof saveFinishedGame === "function")
              await saveFinishedGame(roomId);
          } catch (e) {
            console.error("saveFinishedGame error (make-move):", e);
          }
          try {
            const containsBot = (room.players || []).some((p) =>
              String(p.id || "")
                .toLowerCase()
                .startsWith("bot:")
            );
            if (!containsBot) {
              if (typeof applyCupsForFinishedRoom === "function")
                await applyCupsForFinishedRoom(roomId);
            }
          } catch (e) {
            console.error("applyCupsForFinishedRoom error (make-move):", e);
          }
        } else {
          broadcastRoomState && broadcastRoomState(roomId);

          // if bot present and it's now bot's turn, schedule
          try {
            const botPl = (room.players || []).find((p) =>
              String(p.id || "")
                .toLowerCase()
                .startsWith("bot:")
            );
            if (
              botPl &&
              room.chess &&
              !room.finished &&
              room.chess.turn() === botPl.color
            ) {
              const engineLevel = mapRequestedBotLevelToEngine(
                room.settings?.bot?.level
              );
              const delay =
                300 +
                Math.max(0, 4 - engineLevel) * 300 +
                Math.floor(Math.random() * 500);
              scheduleBotMove(roomId, delay);
            }
          } catch (e) {}
        }
      } catch (err) {
        console.error("make-move handler error:", err);
      }
    });

    socket.on("offer-draw", async ({ roomId }) => {
      if (!roomId) return;
      try {
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
          (p) =>
            p.color !== player.color && (p.color === "w" || p.color === "b")
        );
        if (opponent) {
          io.to(opponent.id).emit("draw-offered", { from: player.user });
          // persist a notification for opponent (best-effort)
          try {
            if (
              notificationService &&
              typeof notificationService.createNotification === "function"
            ) {
              const targetUserId = opponent.user?.id || null;
              if (targetUserId) {
                await notificationService.createNotification(
                  String(targetUserId),
                  "draw_offer",
                  "Draw offered",
                  `${player.user?.username || "Opponent"} offered a draw.`,
                  { fromUserId: player.user?.id || null, roomId }
                );
              }
            }
          } catch (e) {
            console.error("createNotification draw-offer error", e);
          }
        }
        broadcastRoomState && broadcastRoomState(roomId);
      } catch (e) {
        console.error("offer-draw error:", e);
      }
    });

    socket.on("accept-draw", ({ roomId }) => {
      try {
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room || room.finished) return;
        // mark finished as draw by agreement
        room.finished = {
          reason: "draw-agreed",
          result: "draw",
          message: "Draw agreed by both players",
          finishedAt: Date.now(),
        };
        room.paused = true;
        if (room.clocks) {
          room.clocks.running = null;
          room.clocks.lastTick = null;
        }
        room.pendingDrawOffer = null;
        clearBotTimeout(room);
        broadcastRoomState && broadcastRoomState(roomId);
        io.to(roomId).emit("game-over", { ...room.finished });
        (async () => {
          try {
            if (typeof saveFinishedGame === "function")
              await saveFinishedGame(roomId);
          } catch (e) {
            console.error("saveFinishedGame error (accept-draw)", e);
          }
          try {
            const containsBot = (room.players || []).some((p) =>
              String(p.id || "")
                .toLowerCase()
                .startsWith("bot:")
            );
            if (!containsBot) {
              if (typeof applyCupsForFinishedRoom === "function")
                await applyCupsForFinishedRoom(roomId);
            }
          } catch (e) {
            console.error("applyCupsForFinishedRoom error (accept-draw)", e);
          }
        })();
      } catch (e) {
        console.error("accept-draw error:", e);
      }
    });

    socket.on("decline-draw", ({ roomId }) => {
      try {
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;
        room.pendingDrawOffer = null;
        broadcastRoomState && broadcastRoomState(roomId);
      } catch (e) {
        console.error("decline-draw error:", e);
      }
    });

    socket.on("resign", async ({ roomId }) => {
      try {
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room || room.finished) return;
        const playerIdx = room.players.findIndex((p) => p.id === socket.id);
        if (playerIdx === -1) return;
        const player = room.players[playerIdx];
        if (player.color === "w" || player.color === "b") {
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
          clearFirstMoveTimer && clearFirstMoveTimer(room);
          Object.keys(room.disconnectTimers || {}).forEach((sid) => {
            try {
              clearDisconnectTimer(room, sid);
            } catch (e) {}
          });
          clearBotTimeout(room);
          broadcastRoomState && broadcastRoomState(roomId);
          try {
            if (typeof saveFinishedGame === "function")
              await saveFinishedGame(roomId);
          } catch (e) {
            console.error("saveFinishedGame error (resign)", e);
          }
          try {
            const containsBot = (room.players || []).some((p) =>
              String(p.id || "")
                .toLowerCase()
                .startsWith("bot:")
            );
            if (!containsBot) {
              if (typeof applyCupsForFinishedRoom === "function")
                await applyCupsForFinishedRoom(roomId);
            }
          } catch (e) {
            console.error("applyCupsForFinishedRoom error (resign)", e);
          }
        }
        // remove player from players array (they left)
        room.players = (room.players || []).filter((p) => p.id !== socket.id);
        broadcastRoomState && broadcastRoomState(roomId);
      } catch (e) {
        console.error("resign error:", e);
      }
    });

    socket.on("send-chat", ({ roomId, text }) => {
      try {
        if (!roomId || typeof text !== "string") return;
        const room = rooms[roomId];
        if (!room) return;
        const trimmed = String(text).trim().slice(0, 2000);
        if (!trimmed) return;
        const msg = {
          id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          text: trimmed,
          ts: Date.now(),
          user: socket.user || { username: "guest" },
        };
        room.messages = room.messages || [];
        room.messages.push(msg);
        if (room.messages.length > MAX_CHAT_MESSAGES)
          room.messages = room.messages.slice(-MAX_CHAT_MESSAGES);
        io.to(roomId).emit("chat-message", msg);
        broadcastRoomState && broadcastRoomState(roomId);
      } catch (e) {
        console.error("send-chat error:", e);
      }
    });

    socket.on("request-sync", ({ roomId }) => {
      try {
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) {
          socket.emit("no-such-room", { roomId });
          return;
        }
        socket.emit("room-update", {
          players: (room.players || []).map(mapPlayerForEmit),
          moves: room.moves || [],
          fen: room.fen || (room.chess ? room.chess.fen() : null),
          lastIndex:
            typeof room.lastIndex !== "undefined" ? room.lastIndex : -1,
          clocks: room.clocks || null,
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
      } catch (e) {
        console.error("request-sync error:", e);
      }
    });

    socket.on("leave-room", ({ roomId }) => {
      try {
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;
        // if player was a colored seat, and leaves while game in progress, we may want to resign/finish
        const idx = room.players.findIndex((p) => p.id === socket.id);
        if (idx !== -1) {
          const player = room.players[idx];
          // if colored and game in progress -> mark as left and possibly finish if opponent present
          if (
            (player.color === "w" || player.color === "b") &&
            !room.finished
          ) {
            // attempt to gracefully give win to opponent
            const opponent = room.players.find(
              (p) =>
                (p.color === "w" || p.color === "b") &&
                p.color !== player.color &&
                p.online
            );
            if (opponent) {
              room.finished = {
                reason: "resign",
                winner: opponent.color,
                loser: player.color,
                message: `Player ${player.user?.username || player.id} left — ${
                  opponent.user?.username || opponent.id
                } wins`,
                finishedAt: Date.now(),
              };
              io.to(roomId).emit("game-over", { ...room.finished });
              clearFirstMoveTimer && clearFirstMoveTimer(room);
              clearBotTimeout(room);
              broadcastRoomState && broadcastRoomState(roomId);
              (async () => {
                try {
                  if (typeof saveFinishedGame === "function")
                    await saveFinishedGame(roomId);
                } catch (e) {}
                try {
                  const containsBot = (room.players || []).some((p) =>
                    String(p.id || "")
                      .toLowerCase()
                      .startsWith("bot:")
                  );
                  if (!containsBot) {
                    if (typeof applyCupsForFinishedRoom === "function")
                      await applyCupsForFinishedRoom(roomId);
                  }
                } catch (e) {}
              })();
            }
          }
          // remove the player entry
          room.players = room.players.filter((p) => p.id !== socket.id);
          broadcastRoomState && broadcastRoomState(roomId);
        }
        try {
          socket.leave(roomId);
        } catch (e) {}
      } catch (e) {
        console.error("leave-room error:", e);
      }
    });

    socket.on("save-game", async ({ roomId }) => {
      try {
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;
        if (typeof saveFinishedGame === "function") {
          await saveFinishedGame(roomId);
        }
      } catch (e) {
        console.error("save-game error:", e);
      }
    });

    socket.on("play-again", ({ roomId }) => {
      try {
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;
        // set pending rematch structure
        room.rematch = room.rematch || {
          initiatorSocketId: socket.id,
          initiatorUserId: socket.user?.id || null,
          acceptedBy: {},
        };
        if (!room.rematch.initiatorSocketId)
          room.rematch.initiatorSocketId = socket.id;
        if (!room.rematch.initiatorUserId)
          room.rematch.initiatorUserId = socket.user?.id || null;
        room.rematch.acceptedBy = room.rematch.acceptedBy || {};
        // if there are two colored players, notify the opponent
        const opponent = room.players.find(
          (p) => (p.color === "w" || p.color === "b") && p.id !== socket.id
        );
        if (opponent) {
          io.to(roomId).emit("rematch-offered", {
            from: socket.user || {
              username: socket.user?.username || "Opponent",
              id: socket.user?.id || null,
            },
          });
        } else {
          // spectator or no opponent: still set my pending state
        }
        broadcastRoomState && broadcastRoomState(roomId);
      } catch (e) {
        console.error("play-again error:", e);
      }
    });

    socket.on("accept-play-again", async ({ roomId }) => {
      try {
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room || !room.rematch) return;
        // mark accepted and when both accepted start new game
        room.rematch.acceptedBy = room.rematch.acceptedBy || {};
        room.rematch.acceptedBy[socket.id] = true;
        const coloredPlayers = (room.players || []).filter(
          (p) => p.color === "w" || p.color === "b"
        );
        const allAccepted = coloredPlayers.every(
          (p) => room.rematch.acceptedBy[p.id]
        );
        if (allAccepted) {
          // start rematch: create new room state or reuse room by resetting fen and moves
          try {
            // simple rematch: reset chess, moves, clocks, finished, pendingDrawOffer, rematch structure
            room.chess = new Chess();
            room.fen = room.chess.fen();
            room.moves = [];
            room.lastIndex = -1;
            room.finished = null;
            room.pendingDrawOffer = null;
            room.paused = false;
            room.rematch = null;
            // reset clocks to settings
            room.clocks = {
              w: room.settings?.minutesMs || room.settings.minutes * 60 * 1000,
              b: room.settings?.minutesMs || room.settings.minutes * 60 * 1000,
              running: room.chess.turn(),
              lastTick: Date.now(),
            };
            // broadcast and notify clients
            io.to(roomId).emit("play-again", { started: true, roomId });
            broadcastRoomState && broadcastRoomState(roomId);

            // if bot present and bot is to move, schedule bot
            const botPl = (room.players || []).find((p) =>
              String(p.id || "")
                .toLowerCase()
                .startsWith("bot:")
            );
            if (botPl) {
              const engineLevel = mapRequestedBotLevelToEngine(
                room.settings?.bot?.level
              );
              const delay =
                300 +
                Math.max(0, 4 - engineLevel) * 300 +
                Math.floor(Math.random() * 500);
              scheduleBotMove(roomId, delay);
            }
          } catch (e) {
            console.error("start rematch error:", e);
          }
        } else {
          // notify other players someone accepted
          io.to(roomId).emit("play-again", {
            started: false,
            message: "Opponent accepted rematch",
            from: socket.user || {
              username: socket.user?.username || "Opponent",
              id: socket.user?.id || null,
            },
          });
        }
        broadcastRoomState && broadcastRoomState(roomId);
      } catch (e) {
        console.error("accept-play-again error:", e);
      }
    });

    socket.on("decline-play-again", ({ roomId }) => {
      try {
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;
        room.rematch = null;
        io.to(roomId).emit("rematch-declined", { message: "Rematch declined" });
        broadcastRoomState && broadcastRoomState(roomId);
      } catch (e) {
        console.error("decline-play-again error:", e);
      }
    });

    socket.on("player-timeout", async ({ roomId, loser }) => {
      try {
        if (!roomId || !loser) return;
        const room = rooms[roomId];
        if (!room || room.finished) return;
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
          clearFirstMoveTimer && clearFirstMoveTimer(room);
          Object.keys(room.disconnectTimers || {}).forEach((sid) => {
            try {
              clearDisconnectTimer(room, sid);
            } catch (e) {}
          });
          clearBotTimeout(room);
          broadcastRoomState && broadcastRoomState(roomId);
          try {
            if (typeof saveFinishedGame === "function")
              await saveFinishedGame(roomId);
          } catch (e) {
            console.error("saveFinishedGame error (player-timeout)", e);
          }
          try {
            const containsBot = (room.players || []).some((p) =>
              String(p.id || "")
                .toLowerCase()
                .startsWith("bot:")
            );
            if (!containsBot) {
              if (typeof applyCupsForFinishedRoom === "function")
                await applyCupsForFinishedRoom(roomId);
            }
          } catch (e) {
            console.error("applyCupsForFinishedRoom error (player-timeout)", e);
          }
        }
      } catch (e) {
        console.error("player-timeout error:", e);
      }
    });

    socket.on("dequeue-match", () => {
      try {
        if (
          removeFromPlayQueueBySocket &&
          typeof removeFromPlayQueueBySocket === "function"
        ) {
          try {
            removeFromPlayQueueBySocket(socket.id);
          } catch (e) {}
        }
      } catch (e) {}
    });

    socket.on("enqueue-match", ({ cups, minutes }) => {
      try {
        if (context && typeof context.addToPlayQueue === "function") {
          context.addToPlayQueue({
            socketId: socket.id,
            cups: Number(cups || 1200),
            minutes: Number(minutes || 5),
            socket,
          });
        }
      } catch (e) {}
    });

    // Disconnect: mark offline and schedule finish if needed
    socket.on("disconnect", () => {
      try {
        try {
          if (removeFromPlayQueueBySocket)
            removeFromPlayQueueBySocket(socket.id);
        } catch (e) {}
      } catch (e) {}

      if (socket.user && socket.user.id) {
        try {
          // if you have add/remove online socket tracking
          if (typeof context.removeOnlineSocketForUser === "function") {
            try {
              context.removeOnlineSocketForUser(socket.user.id, socket.id);
            } catch (e) {}
          }
        } catch (e) {}
      }

      try {
        Object.keys(rooms).forEach((rId) => {
          const room = rooms[rId];
          const idx = room.players.findIndex((p) => p.id === socket.id);
          if (idx !== -1) {
            room.players[idx].online = false;
            room.players[idx].disconnectedAt = Date.now();
            room.disconnectTimers = room.disconnectTimers || {};
            clearDisconnectTimer && clearDisconnectTimer(room, socket.id);
            room.disconnectTimers[socket.id] = setTimeout(async () => {
              try {
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
                      message: `Player ${
                        p.user?.username || p.id
                      } disconnected — ${
                        opponent.user?.username || opponent.id
                      } wins`,
                      finishedAt: Date.now(),
                    };
                    io.to(rId).emit("game-over", { ...room.finished });
                    clearFirstMoveTimer && clearFirstMoveTimer(room);
                    clearBotTimeout(room);
                    broadcastRoomState && broadcastRoomState(rId);
                    try {
                      if (typeof saveFinishedGame === "function")
                        await saveFinishedGame(rId);
                    } catch (e) {
                      console.error(
                        "saveFinishedGame error (disconnect timer)",
                        e
                      );
                    }
                    try {
                      const containsBot = (room.players || []).some((pp) =>
                        String(pp.id || "")
                          .toLowerCase()
                          .startsWith("bot:")
                      );
                      if (!containsBot) {
                        if (typeof applyCupsForFinishedRoom === "function")
                          await applyCupsForFinishedRoom(rId);
                      }
                    } catch (e) {
                      console.error(
                        "applyCupsForFinishedRoom error (disconnect timer)",
                        e
                      );
                    }
                  } else {
                    // no online opponent — keep room open
                  }
                }
              } catch (e) {
                console.error("disconnect timer handler error", e);
              }
              try {
                clearDisconnectTimer(room, socket.id);
              } catch (e) {}
            }, DISCONNECT_GRACE_MS || 60000);
            broadcastRoomState && broadcastRoomState(rId);
          }
        });
      } catch (e) {
        console.error("disconnect outer error", e);
      }
      console.log("socket disconnected:", socket.id);
    });

    // end registerAll
  },
};
