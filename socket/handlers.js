// // backend/socket/handlers.js
// // Full handlers file (verbatim from your socket.js halves), adapted to use `context`
// // Usage: const handlers = require("./socket/handlers"); handlers.registerAll(socket, context);

// module.exports = {
//   registerAll(socket, context) {
//     const io = context.io;
//     const rooms = context.rooms;
//     const User = context.User;
//     const Room = context.Room;
//     const Game = context.Game;
//     const Notification = context.Notification;
//     const notificationService = context.notificationService;
//     const broadcastRoomState = context.broadcastRoomState;
//     const clearDisconnectTimer = context.clearDisconnectTimer;
//     const clearFirstMoveTimer = context.clearFirstMoveTimer;
//     const scheduleFirstMoveTimer = context.scheduleFirstMoveTimer;
//     const getSocketsForUserId = context.getSocketsForUserId;
//     const generateRoomCode = context.generateRoomCode;
//     const addOnlineSocketForUser = context.addOnlineSocketForUser;
//     const removeOnlineSocketForUser = context.removeOnlineSocketForUser;
//     const pendingChallenges = context.pendingChallenges;
//     const MAX_CHAT_MESSAGES = context.MAX_CHAT_MESSAGES;
//     const helpers = context.helpers;
//     const reservations = context.reservations;
//     const applyCupsModule = context.applyCupsModule;
//     const Chess = context.Chess;

//     /* -------------------------
//        Handlers (complete)
//        ------------------------- */

//     socket.on("check-room", async ({ roomId }, cb) => {
//       try {
//         let exists = !!rooms[roomId];
//         if (!exists) {
//           try {
//             const doc = await Room.findOne({ roomId }).lean().exec();
//             exists = !!doc;
//           } catch (e) {}
//         }
//         if (typeof cb === "function") {
//           cb({ exists });
//         }
//       } catch (e) {
//         if (typeof cb === "function") cb({ exists: false });
//       }
//     });

//     socket.on(
//       "create-room",
//       ({ roomId: requestedRoomId, minutes, colorPreference, user }) => {
//         try {
//           let minutesNum =
//             typeof minutes === "number"
//               ? Math.max(1, Math.floor(minutes))
//               : Math.floor(context.DEFAULT_MS / 60000);
//           const minutesMs = minutesNum * 60 * 1000;

//           let roomId = null;

//           if (requestedRoomId && String(requestedRoomId).trim()) {
//             const val = helpers.normalizeAndValidateRoomCode(requestedRoomId);
//             if (!val.ok) {
//               socket.emit("room-created", { ok: false, error: val.error });
//               return;
//             }
//             roomId = val.code;
//             if (rooms[roomId]) {
//               socket.emit("room-created", {
//                 ok: false,
//                 error: `Room code "${roomId}" is already in use. Choose a different code.`,
//               });
//               return;
//             }
//           } else {
//             roomId = generateRoomCode();
//             let attempts = 0;
//             while (rooms[roomId] && attempts < 8) {
//               roomId = generateRoomCode();
//               attempts++;
//             }
//             if (rooms[roomId]) {
//               socket.emit("room-created", {
//                 ok: false,
//                 error: "Unable to generate unique room code, please try again.",
//               });
//               return;
//             }
//           }

//           // Do not pre-reserve activeRoom here — reservation happens when user is assigned colored seat.

//           rooms[roomId] = {
//             players: [],
//             moves: [],
//             chess: new Chess(),
//             fen: null,
//             lastIndex: -1,
//             clocks: null,
//             paused: false,
//             disconnectTimers: {},
//             firstMoveTimer: null,
//             pendingDrawOffer: null,
//             finished: null,
//             settings: {
//               minutes: minutesNum,
//               minutesMs,
//               creatorId: socket.user?.id || socket.id,
//               colorPreference: colorPreference || "random",
//             },
//             messages: [],
//             rematch: null,
//           };

//           const room = rooms[roomId];

//           let assignedColor = "spectator";
//           if (socket.user) {
//             const playerObj = {
//               id: socket.id,
//               user: socket.user || user || { username: "guest" },
//               color: "spectator",
//               online: true,
//               disconnectedAt: null,
//             };

//             playerObj.user = helpers.ensureAvatarAbs(playerObj.user);

//             const pref = room.settings.colorPreference;
//             const wTaken = room.players.some((p) => p.color === "w");
//             const bTaken = room.players.some((p) => p.color === "b");

//             if (pref === "white" && !wTaken) assignedColor = "w";
//             else if (pref === "black" && !bTaken) assignedColor = "b";
//             else {
//               if (!wTaken) assignedColor = "w";
//               else if (!bTaken) assignedColor = "b";
//               else assignedColor = "spectator";
//             }

//             playerObj.color = assignedColor;
//             room.players.push(playerObj);
//             socket.emit("player-assigned", { color: playerObj.color });

//             // mark DB user activeRoom if they are a colored (playing) seat
//             if (
//               playerObj.user &&
//               (playerObj.color === "w" || playerObj.color === "b")
//             ) {
//               (async () => {
//                 try {
//                   await helpers.markUserActiveRoom(
//                     playerObj.user.id || playerObj.user._id,
//                     roomId
//                   );
//                 } catch (e) {
//                   console.error(
//                     "markUserActiveRoom after create-room failed",
//                     e
//                   );
//                 }
//               })();
//             }
//           } else {
//             const playerObj = {
//               id: socket.id,
//               user: user || { username: "guest" },
//               color: "spectator",
//               online: true,
//               disconnectedAt: null,
//             };
//             playerObj.user = helpers.ensureAvatarAbs(playerObj.user);

//             room.players.push(playerObj);
//             assignedColor = "spectator";
//             socket.emit("player-assigned", { color: "spectator" });
//           }

//           broadcastRoomState(roomId);

//           socket.join(roomId);
//           socket.emit("room-created", {
//             ok: true,
//             roomId,
//             settings: room.settings,
//             assignedColor,
//           });
//           console.log(
//             "Room created:",
//             roomId,
//             "by",
//             socket.user?.username || socket.id
//           );
//         } catch (err) {
//           console.error("create-room outer error", err);
//           socket.emit("room-created", { ok: false, error: "Server error" });
//         }
//       }
//     );

//     socket.on("join-room", async ({ roomId, user }) => {
//       if (!roomId) return;

//       // If room not present in memory, attempt to load persisted snapshot
//       if (!rooms[roomId]) {
//         try {
//           const doc = await Room.findOne({ roomId }).lean().exec();
//           if (doc) {
//             socket.join(roomId);
//             socket.emit("room-update", {
//               players: (doc.players || []).map((p) => ({
//                 id: p.id,
//                 user: p.user,
//                 color: p.color,
//                 online: !!p.online,
//                 disconnectedAt: p.disconnectedAt || null,
//               })),
//               moves: doc.moves || [],
//               fen: doc.fen || null,
//               lastIndex:
//                 typeof doc.lastIndex !== "undefined" ? doc.lastIndex : -1,
//               clocks: doc.clocks || null,
//               finished: doc.finished || null,
//               pendingDrawOffer: doc.pendingDrawOffer || null,
//               settings: doc.settings || null,
//               messages: (doc.messages || []).slice(
//                 -Math.min(MAX_CHAT_MESSAGES, doc.messages.length || 0)
//               ),
//               pendingRematch: doc.rematch
//                 ? {
//                     initiatorSocketId: doc.rematch.initiatorSocketId || null,
//                     initiatorUserId: doc.rematch.initiatorUserId || null,
//                     acceptedBy: doc.rematch.acceptedBy
//                       ? Object.keys(doc.rematch.acceptedBy)
//                       : [],
//                   }
//                 : null,
//             });

//             if (doc.finished) {
//               socket.emit("room-finished", {
//                 roomId,
//                 finished: true,
//                 message:
//                   doc.finished.message ||
//                   "This room has finished and is view-only.",
//               });
//             }

//             return;
//           } else {
//             try {
//               socket.emit("no-such-room", { roomId });
//             } catch (e) {}
//             return;
//           }
//         } catch (err) {
//           console.error("join-room: error loading persisted room", err);
//           try {
//             socket.emit("no-such-room", { roomId });
//           } catch (e) {}
//           return;
//         }
//       }

//       // join in-memory flow
//       socket.join(roomId);
//       const room = rooms[roomId];

//       if (!room.chess) {
//         room.chess = room.fen ? new Chess(room.fen) : new Chess();
//         room.fen = room.chess.fen();
//         room.lastIndex = room.moves.length
//           ? room.moves[room.moves.length - 1].index
//           : -1;
//       }

//       const candidateUserId = helpers.normId(
//         socket.user?.id ?? user?.id ?? user?._id
//       );
//       const candidateUsername =
//         socket.user?.username ??
//         user?.username ??
//         (user && user.fromUsername) ??
//         null;

//       // server-side guard: if DB user already has activeRoom (different), deny join
//       if (candidateUserId) {
//         try {
//           const dbUser = await User.findById(candidateUserId).lean().exec();
//           if (
//             dbUser &&
//             dbUser.activeRoom &&
//             String(dbUser.activeRoom) !== String(roomId)
//           ) {
//             try {
//               socket.emit("join-denied-active-room", {
//                 reason: "already_active",
//                 message: "You already have an active game.",
//                 activeRoom: dbUser.activeRoom,
//               });
//               socket.emit("notification", {
//                 type: "join_denied_active_room",
//                 activeRoom: dbUser.activeRoom,
//                 message: "You already have an active game.",
//               });
//             } catch (e) {}
//             return;
//           }
//         } catch (err) {
//           console.error("join-room: error checking user activeRoom", err);
//         }
//       }

//       // locate existing player entry
//       let existing = null;
//       if (candidateUserId) {
//         existing = room.players.find(
//           (p) => p.user && helpers.normId(p.user.id) === candidateUserId
//         );
//       }
//       if (!existing && candidateUsername) {
//         existing = room.players.find(
//           (p) => p.user && p.user.username === candidateUsername
//         );
//       }
//       if (!existing) {
//         existing = room.players.find((p) => p.id === socket.id);
//       }

//       if (existing) {
//         clearDisconnectTimer(room, existing.id);
//         existing.id = socket.id;
//         existing.user = socket.user ||
//           existing.user ||
//           user || { username: "guest" };
//         existing.user = helpers.ensureAvatarAbs(existing.user);
//         existing.online = true;
//         existing.disconnectedAt = null;

//         socket.emit("player-assigned", {
//           color: existing.color || "spectator",
//         });

//         // mark DB user activeRoom if colored playing seat
//         if (
//           existing.user &&
//           (existing.color === "w" || existing.color === "b")
//         ) {
//           (async () => {
//             try {
//               const uid = existing.user.id || existing.user._id;
//               await helpers.markUserActiveRoom(uid, roomId);
//             } catch (e) {
//               console.error(
//                 "markUserActiveRoom after existing player assignment failed",
//                 e
//               );
//             }
//           })();
//         }
//       } else {
//         // create new player object
//         let assignedColor = "spectator";
//         if (socket.user) {
//           const wTaken = room.players.some((p) => p.color === "w");
//           const bTaken = room.players.some((p) => p.color === "b");
//           if (!wTaken) assignedColor = "w";
//           else if (!bTaken) assignedColor = "b";
//           else assignedColor = "spectator";
//         } else {
//           assignedColor = "spectator";
//         }

//         const playerObj = {
//           id: socket.id,
//           user: socket.user || user || { username: "guest" },
//           color: assignedColor,
//           online: true,
//           disconnectedAt: null,
//         };
//         playerObj.user = helpers.ensureAvatarAbs(playerObj.user);

//         room.players.push(playerObj);
//         socket.emit("player-assigned", { color: playerObj.color });

//         // mark DB user activeRoom if assigned a playing seat
//         (async () => {
//           try {
//             const uid =
//               playerObj.user && (playerObj.user.id || playerObj.user._id);
//             if (uid && (playerObj.color === "w" || playerObj.color === "b")) {
//               await helpers.markUserActiveRoom(uid, roomId);
//             }
//           } catch (e) {
//             console.error("markUserActiveRoom error after new player push", e);
//           }
//         })();
//       }

//       clearDisconnectTimer(room, socket.id);

//       // clocks / ready notifications
//       const coloredPlayers = room.players.filter(
//         (p) => p.color === "w" || p.color === "b"
//       );

//       if (!room.clocks && !room.finished) {
//         if (coloredPlayers.length === 2) {
//           const minutes =
//             room.settings?.minutes || Math.floor(context.DEFAULT_MS / 60000);
//           const ms = room.settings?.minutesMs || minutes * 60 * 1000;
//           room.clocks = {
//             w: ms,
//             b: ms,
//             running: room.chess.turn(),
//             lastTick: Date.now(),
//           };
//           scheduleFirstMoveTimer(roomId);
//         }
//       } else {
//         if (
//           coloredPlayers.length === 2 &&
//           !room.clocks?.running &&
//           !room.finished
//         ) {
//           room.clocks.running = room.chess.turn();
//           room.clocks.lastTick = Date.now();
//           room.paused = false;
//           scheduleFirstMoveTimer(roomId);
//         }
//       }

//       broadcastRoomState(roomId);

//       if (coloredPlayers.length === 2 && !room.finished) {
//         io.to(roomId).emit("room-ready", {
//           ok: true,
//           message: "Two players connected — game ready",
//         });
//       } else if (!room.finished) {
//         io.to(roomId).emit("room-waiting", {
//           ok: false,
//           message: "Waiting for second player...",
//         });
//       } else {
//         io.to(roomId).emit("game-over", { ...room.finished });
//       }
//     });

//     socket.on("make-move", async ({ roomId, move }) => {
//       try {
//         if (!roomId || !move) return;
//         const room = rooms[roomId];
//         if (!room) {
//           socket.emit("error", { error: "Room not found" });
//           return;
//         }

//         if (room.finished) {
//           socket.emit("game-over", { ...room.finished });
//           return;
//         }

//         const player = room.players.find((p) => p.id === socket.id) || null;
//         if (!player) {
//           socket.emit("not-your-room", { error: "You are not in this room" });
//           return;
//         }
//         if (player.color === "spectator") {
//           socket.emit("not-your-turn", { error: "Spectators cannot move" });
//           return;
//         }

//         const colored = room.players.filter(
//           (p) => p.color === "w" || p.color === "b"
//         );
//         if (colored.length < 2) {
//           socket.emit("not-enough-players", {
//             error: "Game requires two players to start",
//           });
//           io.to(roomId).emit("room-waiting", {
//             ok: false,
//             message: "Waiting for second player...",
//           });
//           return;
//         }

//         if (!room.chess) {
//           room.chess = room.fen ? new Chess(room.fen) : new Chess();
//         }
//         const chess = room.chess;

//         const currentTurn = chess.turn();
//         if (!currentTurn) {
//           socket.emit("error", { error: "Unable to determine turn" });
//           return;
//         }
//         if (player.color !== currentTurn) {
//           socket.emit("not-your-turn", {
//             error: "It is not your turn",
//             currentTurn,
//           });
//           return;
//         }

//         try {
//           if (move && move.promotion) {
//             const p = helpers.normalizePromotionChar(move.promotion);
//             if (p) move.promotion = p;
//             else delete move.promotion;
//           }
//         } catch (e) {}

//         const result = chess.move(move);
//         if (!result) {
//           socket.emit("invalid-move", {
//             reason: "illegal move on server",
//             move,
//           });
//           socket.emit("room-update", {
//             players: room.players.map(helpers.mapPlayerForEmit),
//             moves: room.moves,
//             fen: chess.fen(),
//             lastIndex: room.lastIndex,
//             clocks: room.clocks
//               ? {
//                   w: room.clocks.w,
//                   b: room.clocks.b,
//                   running: room.clocks.running,
//                 }
//               : null,
//             finished: room.finished || null,
//             messages: (room.messages || []).slice(
//               -Math.min(MAX_CHAT_MESSAGES, room.messages.length)
//             ),
//           });
//           return;
//         }

//         room.lastIndex = (room.lastIndex ?? -1) + 1;
//         const record = { index: room.lastIndex, move };
//         room.moves.push(record);
//         room.fen = chess.fen();

//         clearFirstMoveTimer(room);

//         let finishedObj = null;

//         const gameOver =
//           (typeof chess.game_over === "function" && chess.game_over()) || false;

//         let isCheckmate =
//           (typeof chess.in_checkmate === "function" && chess.in_checkmate()) ||
//           false;
//         let isStalemate =
//           (typeof chess.in_stalemate === "function" && chess.in_stalemate()) ||
//           false;
//         const isThreefold =
//           (typeof chess.in_threefold_repetition === "function" &&
//             chess.in_threefold_repetition()) ||
//           false;
//         const isInsufficient =
//           (typeof chess.insufficient_material === "function" &&
//             chess.insufficient_material()) ||
//           false;
//         const isDraw =
//           (typeof chess.in_draw === "function" && chess.in_draw()) || false;

//         try {
//           if (!isCheckmate && !isStalemate) {
//             let movesList = [];
//             try {
//               movesList =
//                 typeof chess.moves === "function"
//                   ? chess.moves({ verbose: true })
//                   : [];
//             } catch (e) {
//               try {
//                 movesList =
//                   typeof chess.moves === "function" ? chess.moves() : [];
//               } catch (e2) {
//                 movesList = [];
//               }
//             }

//             if (!Array.isArray(movesList)) movesList = [];

//             if (movesList.length === 0) {
//               const inCheckNow =
//                 (typeof chess.in_check === "function" && chess.in_check()) ||
//                 (typeof chess.inCheck === "function" && chess.inCheck()) ||
//                 (typeof chess.isInCheck === "function" && chess.isInCheck()) ||
//                 (typeof chess.isCheck === "function" && chess.isCheck()) ||
//                 false;

//               if (inCheckNow) {
//                 isCheckmate = true;
//               } else {
//                 isStalemate = true;
//               }

//               console.warn(
//                 "[GAME DETECTION FALLBACK] no legal moves ->",
//                 `inCheckNow=${inCheckNow}, isCheckmate=${isCheckmate}, isStalemate=${isStalemate}`,
//                 "move:",
//                 JSON.stringify(move),
//                 "fen:",
//                 (() => {
//                   try {
//                     return chess.fen();
//                   } catch {
//                     return "<fen-error>";
//                   }
//                 })()
//               );
//             }
//           }
//         } catch (e) {
//           console.error("Fallback detection error:", e);
//         }

//         if (isCheckmate) {
//           const winner = result.color;
//           const loser = winner === "w" ? "b" : "w";
//           finishedObj = {
//             reason: "checkmate",
//             winner,
//             loser,
//             message: `${winner.toUpperCase()} wins by checkmate`,
//             finishedAt: Date.now(),
//           };
//         } else if (isStalemate) {
//           finishedObj = {
//             reason: "stalemate",
//             result: "draw",
//             message: "Draw by stalemate",
//             finishedAt: Date.now(),
//           };
//         } else if (isThreefold) {
//           finishedObj = {
//             reason: "threefold-repetition",
//             result: "draw",
//             message: "Draw by threefold repetition",
//             finishedAt: Date.now(),
//           };
//         } else if (isInsufficient) {
//           finishedObj = {
//             reason: "insufficient-material",
//             result: "draw",
//             message: "Draw by insufficient material",
//             finishedAt: Date.now(),
//           };
//         } else if (isDraw || gameOver) {
//           finishedObj = {
//             reason: "draw",
//             result: "draw",
//             message: "Draw",
//             finishedAt: Date.now(),
//           };
//         }

//         if (!room.clocks) {
//           if (!finishedObj) {
//             const minutes =
//               room.settings?.minutes || Math.floor(context.DEFAULT_MS / 60000);
//             const ms = room.settings?.minutesMs || minutes * 60 * 1000;
//             room.clocks = {
//               w: ms,
//               b: ms,
//               running: chess.turn(),
//               lastTick: Date.now(),
//             };
//           } else {
//             room.clocks = {
//               w: room.clocks?.w ?? context.DEFAULT_MS,
//               b: room.clocks?.b ?? context.DEFAULT_MS,
//               running: null,
//               lastTick: null,
//             };
//           }
//         } else {
//           if (finishedObj) {
//             room.paused = true;
//             room.clocks.running = null;
//             room.clocks.lastTick = null;
//           } else {
//             room.clocks.running = chess.turn();
//             room.clocks.lastTick = Date.now();
//           }
//         }

//         if (room.pendingDrawOffer) {
//           if (
//             room.pendingDrawOffer.fromSocketId === player.id ||
//             (player.user && room.pendingDrawOffer.fromUserId === player.user.id)
//           ) {
//             room.pendingDrawOffer = null;
//           }
//         }

//         socket.to(roomId).emit("opponent-move", {
//           ...record,
//           fen: room.fen,
//           clocks: room.clocks
//             ? {
//                 w: room.clocks.w,
//                 b: room.clocks.b,
//                 running: room.clocks.running,
//               }
//             : null,
//         });

//         if (finishedObj) {
//           room.finished = finishedObj;
//           room.paused = true;
//           if (room.clocks) {
//             room.clocks.running = null;
//             room.clocks.lastTick = null;
//           }

//           io.to(roomId).emit("game-over", { ...room.finished });
//           clearFirstMoveTimer(room);
//           Object.keys(room.disconnectTimers || {}).forEach((sid) =>
//             clearDisconnectTimer(room, sid)
//           );
//           broadcastRoomState(roomId);
//           try {
//             await context.saveFinishedGame(roomId);
//           } catch (err) {
//             console.error("saveFinishedGame error (make-move):", err);
//           }
//           try {
//             await applyCupsModule.applyCupsForFinishedRoom(context, roomId);
//           } catch (e) {
//             console.error("applyCupsForFinishedRoom error (make-move):", e);
//           }
//         } else {
//           broadcastRoomState(roomId);
//         }
//       } catch (err) {
//         console.error("make-move error", err);
//       }
//     });

//     // resign
//     socket.on("resign", async ({ roomId }) => {
//       if (!roomId) return;
//       try {
//         const room = rooms[roomId];
//         if (!room) return;
//         const playerIdx = room.players.findIndex((p) => p.id === socket.id);
//         if (playerIdx === -1) return;
//         const player = room.players[playerIdx];

//         if ((player.color === "w" || player.color === "b") && !room.finished) {
//           const winnerColor = player.color === "w" ? "b" : "w";
//           room.paused = true;
//           if (room.clocks) {
//             room.clocks.running = null;
//             room.clocks.lastTick = null;
//           }
//           room.finished = {
//             reason: "resign",
//             winner: winnerColor,
//             loser: player.color,
//             message: `Player ${player.user?.username || player.id} resigned`,
//             finishedAt: Date.now(),
//           };
//           io.to(roomId).emit("game-over", { ...room.finished });
//           clearFirstMoveTimer(room);
//           Object.keys(room.disconnectTimers || {}).forEach((sid) =>
//             clearDisconnectTimer(room, sid)
//           );
//           broadcastRoomState(roomId);

//           // clear DB activeRoom for both players in this room
//           try {
//             await helpers.clearActiveRoomForRoom(room);
//           } catch (e) {
//             console.error("clearActiveRoomForRoom after resign failed", e);
//           }

//           try {
//             await context.saveFinishedGame(roomId);
//           } catch (err) {
//             console.error("saveFinishedGame error (resign):", err);
//           }
//           try {
//             await applyCupsModule.applyCupsForFinishedRoom(context, roomId);
//           } catch (e) {
//             console.error("applyCupsForFinishedRoom error (resign):", e);
//           }
//         }

//         room.players = room.players.filter((p) => p.id !== socket.id);
//         broadcastRoomState(roomId);
//       } catch (err) {
//         console.error("resign handler error", err);
//       }
//     });

//     // offer-draw
//     socket.on("offer-draw", async ({ roomId }) => {
//       if (!roomId) return;
//       const room = rooms[roomId];
//       if (!room || room.finished) return;
//       const player = room.players.find((p) => p.id === socket.id);
//       if (!player) return;
//       if (!(player.color === "w" || player.color === "b")) return;

//       room.pendingDrawOffer = {
//         fromSocketId: socket.id,
//         fromUserId: player.user?.id || null,
//       };

//       const opponent = room.players.find(
//         (p) => p.color !== player.color && (p.color === "w" || p.color === "b")
//       );
//       if (opponent) {
//         io.to(opponent.id).emit("draw-offered", { from: player.user });
//         // Persist notification for opponent
//         try {
//           const targetUserId = opponent.user?.id || opponent.id;
//           await notificationService.createNotification(
//             String(targetUserId),
//             "draw_offer",
//             "Draw offered",
//             `${player.user?.username || "Opponent"} offered a draw.`,
//             { fromUserId: player.user?.id || null, roomId }
//           );
//         } catch (e) {
//           console.error("createNotification (draw_offer) failed", e);
//         }
//       }
//       broadcastRoomState(roomId);
//     });

//     // accept-draw
//     socket.on("accept-draw", async ({ roomId }) => {
//       if (!roomId) return;
//       const room = rooms[roomId];
//       if (!room) return;
//       if (room.finished) {
//         socket.emit("game-over", { ...room.finished });
//         return;
//       }
//       const offer = room.pendingDrawOffer;
//       if (!offer) return;

//       let offerer = null;
//       if (offer.fromUserId) {
//         offerer = room.players.find(
//           (p) => p.user && p.user.id === offer.fromUserId
//         );
//       }
//       if (!offerer && offer.fromSocketId) {
//         offerer = room.players.find((p) => p.id === offer.fromSocketId);
//       }

//       const acceptor = room.players.find((p) => p.id === socket.id);
//       if (!offerer || !acceptor) return;
//       if (offerer.color === acceptor.color) return;

//       room.paused = true;
//       if (room.clocks) {
//         room.clocks.running = null;
//         room.clocks.lastTick = null;
//       }
//       room.pendingDrawOffer = null;
//       room.finished = {
//         reason: "draw-agreed",
//         result: "draw",
//         message: "Game drawn by agreement",
//         finishedAt: Date.now(),
//       };
//       io.to(roomId).emit("game-over", { ...room.finished });
//       clearFirstMoveTimer(room);
//       Object.keys(room.disconnectTimers || {}).forEach((sid) =>
//         clearDisconnectTimer(room, sid)
//       );
//       broadcastRoomState(roomId);
//       try {
//         await context.saveFinishedGame(roomId);
//       } catch (err) {
//         console.error("saveFinishedGame error (accept-draw):", err);
//       }
//       try {
//         await applyCupsModule.applyCupsForFinishedRoom(context, roomId);
//       } catch (e) {
//         console.error("applyCupsForFinishedRoom error (accept-draw):", e);
//       }

//       // Persist notifications for both parties
//       try {
//         const offererId = offerer.user?.id || offerer.id;
//         const acceptorId = acceptor.user?.id || acceptor.id;
//         await notificationService.createNotification(
//           String(offererId),
//           "draw_accepted",
//           "Draw accepted",
//           `${acceptor.user?.username || "Opponent"} accepted your draw.`,
//           { roomId }
//         );
//         await notificationService.createNotification(
//           String(acceptorId),
//           "draw_confirmed",
//           "Draw confirmed",
//           `You accepted a draw.`,
//           { roomId }
//         );
//       } catch (e) {
//         console.error("createNotification (draw accepted) failed", e);
//       }

//       // mark original draw_offer notification for the acceptor as read + emit update
//       try {
//         const orig = await Notification.findOneAndUpdate(
//           { "data.roomId": roomId, userId: String(socket.user?.id) },
//           {
//             $set: {
//               read: true,
//               updatedAt: Date.now(),
//               "data.status": "accepted",
//             },
//           },
//           { new: true }
//         )
//           .lean()
//           .exec();
//         if (orig) {
//           try {
//             const payload = {
//               id: orig._id?.toString(),
//               _id: orig._1d?.toString
//                 ? orig._id?.toString()
//                 : orig._id?.toString(),
//               userId: orig.userId,
//               type: orig.type,
//               title: orig.title,
//               body: orig.body,
//               data: orig.data,
//               read: orig.read,
//               createdAt: orig.createdAt,
//               updatedAt: orig.updatedAt,
//             };
//             io.to(`user:${String(socket.user?.id)}`).emit(
//               "notification",
//               payload
//             );
//           } catch (e) {}
//         }
//       } catch (e) {
//         console.error(
//           "accept-draw: mark original draw_offer notification failed",
//           e
//         );
//       }
//     });

//     // decline-draw
//     socket.on("decline-draw", ({ roomId }) => {
//       try {
//         if (!roomId) return;
//         const room = rooms[roomId];
//         if (!room) return;
//         room.pendingDrawOffer = null;
//         broadcastRoomState(roomId);

//         // mark original draw_offer as declined for this user
//         (async () => {
//           try {
//             const orig = await Notification.findOneAndUpdate(
//               { "data.roomId": roomId, userId: String(socket.user?.id) },
//               {
//                 $set: {
//                   read: true,
//                   updatedAt: Date.now(),
//                   "data.status": "declined",
//                 },
//               },
//               { new: true }
//             )
//               .lean()
//               .exec();
//             if (orig) {
//               try {
//                 io.to(`user:${String(socket.user?.id)}`).emit("notification", {
//                   id: orig._id?.toString(),
//                   _id: orig._id?.toString(),
//                   ...orig,
//                 });
//               } catch (e) {}
//             }
//           } catch (e) {
//             console.error(
//               "decline-draw: mark original draw_offer notification failed",
//               e
//             );
//           }
//         })();
//       } catch (err) {
//         console.error("decline-draw error", err);
//       }
//     });

//     // send-chat
//     socket.on("send-chat", ({ roomId, text }) => {
//       try {
//         if (!roomId) return;
//         const room = rooms[roomId];
//         if (!room) return;
//         if (!text || typeof text !== "string") return;
//         const trimmed = text.trim().slice(0, 2000);
//         if (!trimmed) return;

//         const msg = {
//           id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
//           text: trimmed,
//           ts: Date.now(),
//           user: socket.user || { username: socket.user?.username || "guest" },
//         };

//         room.messages = room.messages || [];
//         room.messages.push(msg);
//         if (room.messages.length > MAX_CHAT_MESSAGES) {
//           room.messages = room.messages.slice(-MAX_CHAT_MESSAGES);
//         }

//         io.to(roomId).emit("chat-message", msg);
//         broadcastRoomState(roomId);
//       } catch (err) {
//         console.error("send-chat error", err);
//       }
//     });

//     // player-timeout
//     socket.on("player-timeout", async ({ roomId, loser }) => {
//       if (!roomId || !loser) return;
//       const room = rooms[roomId];
//       if (!room) return;
//       if (room.finished) {
//         socket.emit("game-over", { ...room.finished });
//         return;
//       }
//       if (
//         room.clocks &&
//         typeof room.clocks[loser] === "number" &&
//         room.clocks[loser] <= 0
//       ) {
//         room.paused = true;
//         if (room.clocks) {
//           room.clocks.running = null;
//           room.clocks.lastTick = null;
//         }
//         const winner = loser === "w" ? "b" : "w";
//         room.finished = {
//           reason: "timeout",
//           winner,
//           loser,
//           message: `${winner.toUpperCase()} wins by timeout`,
//           finishedAt: Date.now(),
//         };
//         io.to(roomId).emit("game-over", { ...room.finished });
//         clearFirstMoveTimer(room);
//         Object.keys(room.disconnectTimers || {}).forEach((sid) =>
//           clearDisconnectTimer(room, sid)
//         );
//         broadcastRoomState(roomId);
//         try {
//           await context.saveFinishedGame(roomId);
//         } catch (err) {
//           console.error("saveFinishedGame error (player-timeout):", err);
//         }
//         try {
//           await applyCupsModule.applyCupsForFinishedRoom(context, roomId);
//         } catch (e) {
//           console.error("applyCupsForFinishedRoom error (player-timeout):", e);
//         }
//       }
//     });

//     // request-sync
//     socket.on("request-sync", async ({ roomId }) => {
//       if (!roomId || !rooms[roomId]) {
//         try {
//           const doc = await Room.findOne({ roomId }).lean().exec();
//           if (!doc) {
//             socket.emit("room-update", {
//               players: [],
//               moves: [],
//               fen: null,
//               lastIndex: -1,
//               clocks: null,
//               finished: null,
//               messages: [],
//             });
//             return;
//           }

//           socket.emit("room-update", {
//             players: (doc.players || []).map((p) => ({
//               id: p.id,
//               user: p.user,
//               color: p.color,
//               online: !!p.online,
//               disconnectedAt: p.disconnectedAt || null,
//             })),
//             moves: doc.moves || [],
//             fen: doc.fen || null,
//             lastIndex:
//               typeof doc.lastIndex !== "undefined" ? doc.lastIndex : -1,
//             clocks: doc.clocks || null,
//             finished: doc.finished || null,
//             pendingDrawOffer: doc.pendingDrawOffer || null,
//             settings: doc.settings || null,
//             messages: (doc.messages || []).slice(
//               -Math.min(MAX_CHAT_MESSAGES, doc.messages.length || 0)
//             ),
//             pendingRematch: doc.rematch
//               ? {
//                   initiatorSocketId: doc.rematch.initiatorSocketId || null,
//                   initiatorUserId: doc.rematch.initiatorUserId || null,
//                   acceptedBy: doc.rematch.acceptedBy
//                     ? Object.keys(doc.rematch.acceptedBy)
//                     : [],
//                 }
//               : null,
//           });
//           return;
//         } catch (err) {
//           socket.emit("room-update", {
//             players: [],
//             moves: [],
//             fen: null,
//             lastIndex: -1,
//             clocks: null,
//             finished: null,
//             messages: [],
//           });
//           return;
//         }
//       }

//       const r = rooms[roomId];

//       socket.emit("room-update", {
//         players: r.players.map(helpers.mapPlayerForEmit),
//         moves: r.moves,
//         fen: r.chess ? r.chess.fen() : r.fen,
//         lastIndex: r.lastIndex,
//         clocks: r.clocks
//           ? { w: r.clocks.w, b: r.clocks.b, running: r.clocks.running }
//           : null,
//         finished: r.finished || null,
//         pendingDrawOffer: (() => {
//           if (!r.pendingDrawOffer) return null;
//           let offerer = null;
//           if (r.pendingDrawOffer.fromUserId) {
//             offerer = r.players.find(
//               (p) => p.user && p.user.id === r.pendingDrawOffer.fromUserId
//             );
//           }
//           if (!offerer && r.pendingDrawOffer.fromSocketId) {
//             offerer = r.players.find(
//               (p) => p.id === r.pendingDrawOffer.fromSocketId
//             );
//           }
//           if (offerer && offerer.user) {
//             const u = offerer.user;
//             return {
//               from: {
//                 id: u.id,
//                 username: u.username,
//                 displayName: u.displayName,
//                 avatarUrl:
//                   u.avatarUrl || u.avatarUrlAbsolute || u.avatar || null,
//                 avatarUrlAbsolute:
//                   u.avatarUrlAbsolute ||
//                   (u.avatarUrl && String(u.avatarUrl).startsWith("http")
//                     ? u.avatarUrl
//                     : u.avatarUrl
//                     ? `${helpers.computeBaseUrl()}${u.avatarUrl}`
//                     : null),
//               },
//             };
//           }
//           return null;
//         })(),
//         settings: r.settings || null,
//         messages: (r.messages || []).slice(
//           -Math.min(MAX_CHAT_MESSAGES, r.messages || 0)
//         ),
//         pendingRematch: r.rematch
//           ? {
//               initiatorSocketId: r.rematch.initiatorSocketId || null,
//               initiatorUserId: r.rematch.initiatorUserId || null,
//               acceptedBy: r.rematch.acceptedBy
//                 ? Object.keys(r.rematch.acceptedBy)
//                 : [],
//             }
//           : null,
//       });
//     });

//     // leave-room
//     socket.on("leave-room", async ({ roomId }) => {
//       if (!roomId || !rooms[roomId]) return;
//       const room = rooms[roomId];
//       socket.leave(roomId);
//       const idx = room.players.findIndex((p) => p.id === socket.id);
//       if (idx === -1) return;
//       const player = room.players[idx];

//       if ((player.color === "w" || player.color === "b") && !room.finished) {
//         const winnerColor = player.color === "w" ? "b" : "w";
//         room.paused = true;
//         if (room.clocks) {
//           room.clocks.running = null;
//           room.clocks.lastTick = null;
//         }
//         room.finished = {
//           reason: "leave-resign",
//           winner: winnerColor,
//           loser: player.color,
//           message: `Player ${player.user?.username || player.id} left (resign)`,
//           finishedAt: Date.now(),
//         };
//         io.to(roomId).emit("game-over", { ...room.finished });
//         clearFirstMoveTimer(room);
//         Object.keys(room.disconnectTimers || {}).forEach((sid) =>
//           clearDisconnectTimer(room, sid)
//         );
//         broadcastRoomState(roomId);
//         try {
//           await context.saveFinishedGame(roomId);
//         } catch (err) {
//           console.error("saveFinishedGame error (leave-room):", err);
//         }
//         try {
//           await applyCupsModule.applyCupsForFinishedRoom(context, roomId);
//         } catch (e) {
//           console.error("applyCupsForFinishedRoom error (leave-room):", e);
//         }
//       }

//       // remove the player socket entry
//       room.players = room.players.filter((p) => p.id !== socket.id);
//       broadcastRoomState(roomId);

//       // Best-effort: clear activeRoom for this user in DB (if authenticated)
//       try {
//         const uid = helpers.normId(
//           player?.user?.id || player?.user?._id || null
//         );
//         if (uid) {
//           await User.updateOne(
//             { _id: uid },
//             { $set: { activeRoom: null } }
//           ).exec();
//         }
//       } catch (e) {
//         console.warn("leave-room: failed to clear activeRoom (non-fatal):", e);
//       }
//     });

//     // save-game
//     socket.on("save-game", ({ roomId, fen, moves, players }) => {
//       io.to(roomId).emit("game-saved", { ok: true });
//     });

//     // play-again / rematch
//     socket.on("play-again", async ({ roomId }) => {
//       try {
//         if (!roomId) return;
//         const room = rooms[roomId];
//         if (!room) return;

//         if (!room.finished && (!room.moves || room.moves.length === 0)) {
//           socket.emit("play-again", {
//             ok: false,
//             started: false,
//             error: "No finished game to rematch",
//           });
//           return;
//         }

//         const player = room.players.find((p) => p.id === socket.id);
//         if (!player) {
//           socket.emit("play-again", {
//             ok: false,
//             started: false,
//             error: "Not in room",
//           });
//           return;
//         }

//         room.rematch = room.rematch || {
//           initiatorSocketId: socket.id,
//           initiatorUserId: player.user?.id || null,
//           acceptedBy: {},
//         };
//         room.rematch.initiatorSocketId = socket.id;
//         room.rematch.initiatorUserId = player.user?.id || null;

//         room.rematch.acceptedBy = room.rematch.acceptedBy || {};
//         room.rematch.acceptedBy[socket.id] = true;

//         const opponent = room.players.find(
//           (p) =>
//             p.color !== player.color && (p.color === "w" || p.color === "b")
//         );
//         if (opponent) {
//           io.to(opponent.id).emit("rematch-offered", {
//             from: player.user || { username: "Guest" },
//           });

//           // Persist rematch notification
//           try {
//             const targetUserId = opponent.user?.id || opponent.id;
//             await notificationService.createNotification(
//               String(targetUserId),
//               "rematch",
//               "Rematch offered",
//               `${player.user?.username || "Opponent"} offered a rematch.`,
//               { fromUserId: player.user?.id || null, roomId }
//             );
//           } catch (e) {
//             console.error("createNotification (rematch) failed", e);
//           }
//         }

//         socket.emit("play-again", {
//           ok: true,
//           started: false,
//           message: "Rematch requested",
//         });
//         broadcastRoomState(roomId);
//       } catch (err) {
//         console.error("play-again error", err);
//         socket.emit("play-again", {
//           ok: false,
//           started: false,
//           error: "Server error",
//         });
//       }
//     });

//     // accept-play-again
//     socket.on("accept-play-again", async ({ roomId }) => {
//       try {
//         if (!roomId) return;
//         const room = rooms[roomId];
//         if (!room || !room.rematch) {
//           socket.emit("play-again", {
//             ok: false,
//             started: false,
//             error: "No rematch pending",
//           });
//           return;
//         }
//         const player = room.players.find((p) => p.id === socket.id);
//         if (!player) {
//           socket.emit("play-again", {
//             ok: false,
//             started: false,
//             error: "Not in room",
//           });
//           return;
//         }

//         room.rematch.acceptedBy = room.rematch.acceptedBy || {};
//         room.rematch.acceptedBy[socket.id] = true;

//         const coloredPlayers = room.players.filter(
//           (p) => p.color === "w" || p.color === "b"
//         );
//         const coloredIds = coloredPlayers.map((p) => p.id).filter(Boolean);

//         const acceptedKeys = Object.keys(room.rematch.acceptedBy || {});

//         let required = [];
//         if (coloredIds.length === 2) {
//           required = coloredIds;
//         } else if (coloredIds.length === 1) {
//           required = Array.from(
//             new Set([room.rematch.initiatorSocketId, coloredIds[0]])
//           ).filter(Boolean);
//         } else {
//           required = [room.rematch.initiatorSocketId].filter(Boolean);
//         }

//         const allAccepted =
//           required.length > 0 &&
//           required.every((id) => acceptedKeys.includes(id));

//         if (allAccepted) {
//           // create a NEW room for the rematch (do not reuse old roomId)
//           try {
//             const res = await context.roomManager.createRematchFrom(roomId);
//             if (res && res.ok && res.roomId) {
//               const newRoomId = res.roomId;

//               // clear rematch on old room
//               try {
//                 if (rooms[roomId]) {
//                   rooms[roomId].rematch = null;
//                   broadcastRoomState(roomId);
//                 }
//               } catch (e) {}

//               // notify new room: play-again started
//               io.to(newRoomId).emit("play-again", {
//                 ok: true,
//                 started: true,
//                 message: "Rematch started",
//                 roomId: newRoomId,
//               });

//               // emit player-assigned for clients in new room
//               try {
//                 const newRoom = rooms[newRoomId];
//                 if (newRoom && Array.isArray(newRoom.players)) {
//                   for (const p of newRoom.players) {
//                     try {
//                       io.to(p.id).emit("player-assigned", { color: p.color });
//                     } catch (e) {}
//                   }
//                 }
//               } catch (e) {}

//               // Persist rematch-started notifications to participants (new room id)
//               try {
//                 const newRoom = rooms[newRoomId];
//                 if (newRoom && Array.isArray(newRoom.players)) {
//                   for (const p of newRoom.players) {
//                     const uid = p.user?.id || p.id;
//                     if (!uid) continue;
//                     await notificationService.createNotification(
//                       String(uid),
//                       "rematch_started",
//                       "Rematch started",
//                       `Rematch started in room ${newRoomId}`,
//                       { roomId: newRoomId }
//                     );
//                   }
//                 }
//               } catch (e) {
//                 console.error("createNotification (rematch_started) failed", e);
//               }
//             } else {
//               // fallback
//               broadcastRoomState(roomId);
//               socket.emit("play-again", {
//                 ok: false,
//                 started: false,
//                 error: "rematch-create-failed",
//               });
//             }
//           } catch (err) {
//             console.error("createRematchFrom error", err);
//             socket.emit("play-again", {
//               ok: false,
//               started: false,
//               error: "Server error",
//             });
//           }
//         } else {
//           broadcastRoomState(roomId);
//         }

//         // mark original rematch notification for this acceptor as read and emit update
//         try {
//           const orig = await Notification.findOneAndUpdate(
//             { "data.roomId": roomId, userId: String(socket.user?.id) },
//             {
//               $set: {
//                 read: true,
//                 updatedAt: Date.now(),
//                 "data.status": "accepted",
//               },
//             },
//             { new: true }
//           )
//             .lean()
//             .exec();
//           if (orig) {
//             try {
//               const payload = {
//                 id: orig._id?.toString(),
//                 _id: orig._id?.toString(),
//                 userId: orig.userId,
//                 type: orig.type,
//                 title: orig.title,
//                 body: orig.body,
//                 data: orig.data,
//                 read: orig.read,
//                 createdAt: orig.createdAt,
//                 updatedAt: orig.updatedAt,
//               };
//               io.to(`user:${String(socket.user?.id)}`).emit(
//                 "notification",
//                 payload
//               );
//             } catch (e) {}
//           }
//         } catch (e) {
//           console.error(
//             "accept-play-again: mark original rematch notification failed",
//             e
//           );
//         }
//       } catch (err) {
//         console.error("accept-play-again error", err);
//         socket.emit("play-again", {
//           ok: false,
//           started: false,
//           error: "Server error",
//         });
//       }
//     });

//     // decline-play-again
//     socket.on("decline-play-again", ({ roomId }) => {
//       try {
//         if (!roomId) return;
//         const room = rooms[roomId];
//         if (!room || !room.rematch) return;

//         const initiatorId = room.rematch.initiatorSocketId;
//         if (initiatorId) {
//           io.to(initiatorId).emit("rematch-declined", {
//             message: "Opponent declined rematch",
//           });
//         }
//         room.rematch = null;
//         broadcastRoomState(roomId);

//         // mark original rematch notification for this user as read/declined
//         (async () => {
//           try {
//             const orig = await Notification.findOneAndUpdate(
//               { "data.roomId": roomId, userId: String(socket.user?.id) },
//               {
//                 $set: {
//                   read: true,
//                   updatedAt: Date.now(),
//                   "data.status": "declined",
//                 },
//               },
//               { new: true }
//             )
//               .lean()
//               .exec();
//             if (orig) {
//               try {
//                 io.to(`user:${String(socket.user?.id)}`).emit("notification", {
//                   id: orig._id?.toString(),
//                   _id: orig._id?.toString(),
//                   ...orig,
//                 });
//               } catch (e) {}
//             }
//           } catch (e) {
//             console.error(
//               "decline-play-again: mark original rematch notification failed",
//               e
//             );
//           }
//         })();
//       } catch (err) {
//         console.error("decline-play-again error", err);
//       }
//     });

//     // challenge
//     socket.on(
//       "challenge",
//       async ({ toUserId, minutes = 5, colorPreference = "random" }) => {
//         try {
//           if (!toUserId) {
//             socket.emit("challenge-response", {
//               ok: false,
//               error: "Missing target",
//             });
//             return;
//           }
//           if (!socket.user || !socket.user.id) {
//             socket.emit("challenge-response", {
//               ok: false,
//               error: "Auth required",
//             });
//             return;
//           }
//           const targetSockets = getSocketsForUserId(toUserId);
//           const challengeId = `${Date.now()}-${Math.floor(
//             Math.random() * 1000000
//           )}`;
//           pendingChallenges[challengeId] = {
//             fromSocketId: socket.id,
//             fromUserId: socket.user.id,
//             toUserId,
//             minutes: Math.max(1, Math.floor(Number(minutes) || 5)),
//             colorPreference: colorPreference || "random",
//             createdAt: Date.now(),
//           };

//           if (!targetSockets || targetSockets.length === 0) {
//             socket.emit("challenge-declined", {
//               challengeId,
//               reason: "offline",
//             });
//             delete pendingChallenges[challengeId];
//             return;
//           }

//           const challengePayload = {
//             challengeId,
//             from: { id: socket.user.id, username: socket.user.username },
//             minutes: pendingChallenges[challengeId].minutes,
//             colorPreference: pendingChallenges[challengeId].colorPreference,
//           };
//           targetSockets.forEach((sid) => {
//             io.to(sid).emit("challenge-received", challengePayload);
//           });

//           // Persist notification for recipient
//           try {
//             await notificationService.createNotification(
//               String(toUserId),
//               "challenge",
//               "New challenge",
//               `${socket.user?.username || "A player"} challenged you (${
//                 pendingChallenges[challengeId].minutes
//               }m).`,
//               {
//                 challengeId,
//                 minutes: pendingChallenges[challengeId].minutes,
//                 fromUserId: socket.user?.id || null,
//               }
//             );
//           } catch (e) {
//             console.error("createNotification (challenge) failed", e);
//           }

//           socket.emit("challenge-sent", { ok: true, challengeId });
//         } catch (err) {
//           console.error("challenge error", err);
//           socket.emit("challenge-response", {
//             ok: false,
//             error: "Server error",
//           });
//         }
//       }
//     );

//     // accept-challenge
//     socket.on("accept-challenge", async ({ challengeId }) => {
//       try {
//         const pending = pendingChallenges[challengeId];
//         if (!pending) {
//           socket.emit("challenge-accept-response", {
//             ok: false,
//             error: "No such challenge",
//           });
//           return;
//         }

//         const acceptorSocket = socket;
//         const acceptorUserId = socket.user?.id;
//         if (!acceptorUserId || acceptorUserId !== pending.toUserId) {
//           socket.emit("challenge-accept-response", {
//             ok: false,
//             error: "Not authorized",
//           });
//           return;
//         }

//         const initiatorSocket = io.sockets.sockets.get(pending.fromSocketId);
//         if (!initiatorSocket) {
//           socket.emit("challenge-declined", {
//             challengeId,
//             reason: "initiator-offline",
//           });
//           delete pendingChallenges[challengeId];
//           return;
//         }

//         // attempt to reserve both users BEFORE creating the room
//         let roomId = generateRoomCode(8);
//         while (rooms[roomId]) roomId = generateRoomCode(8);

//         let reservedInitiator = { ok: true, set: false };
//         let reservedAcceptor = { ok: true, set: false };
//         const initiatorUserId = pending.fromUserId;
//         const acceptorUserId_local = pending.toUserId; // avoid duplicate var name

//         try {
//           if (initiatorUserId) {
//             reservedInitiator = await reservations.tryReserveActiveRoom(
//               initiatorUserId,
//               roomId
//             );
//             if (!reservedInitiator.ok) {
//               throw reservedInitiator.error || new Error("reserve-init failed");
//             }
//             if (!reservedInitiator.set) {
//               // initiator already busy
//               if (initiatorSocket) {
//                 initiatorSocket.emit("challenge-declined", {
//                   challengeId,
//                   reason: "already-in-active-room",
//                 });
//               }
//               if (acceptorSocket) {
//                 acceptorSocket.emit("challenge-accept-response", {
//                   ok: false,
//                   error: "opponent-busy",
//                 });
//               }
//               delete pendingChallenges[challengeId];
//               return;
//             }
//           }

//           if (acceptorUserId_local) {
//             reservedAcceptor = await reservations.tryReserveActiveRoom(
//               acceptorUserId_local,
//               roomId
//             );
//             if (!reservedAcceptor.ok) {
//               // rollback initiator if set
//               if (reservedInitiator.set && initiatorUserId) {
//                 await reservations.releaseActiveRoom(initiatorUserId, roomId);
//               }
//               throw (
//                 reservedAcceptor.error || new Error("reserve-accept failed")
//               );
//             }
//             if (!reservedAcceptor.set) {
//               // acceptor already busy (rare)
//               if (reservedInitiator.set && initiatorUserId) {
//                 await reservations.releaseActiveRoom(initiatorUserId, roomId);
//               }
//               acceptorSocket.emit("challenge-accept-response", {
//                 ok: false,
//                 error: "already-in-active-room",
//               });
//               delete pendingChallenges[challengeId];
//               return;
//             }
//           }

//           // create room object - safe because reservations present
//           const room = {
//             players: [],
//             moves: [],
//             chess: new Chess(),
//             fen: null,
//             lastIndex: -1,
//             clocks: null,
//             paused: false,
//             disconnectTimers: {},
//             firstMoveTimer: null,
//             pendingDrawOffer: null,
//             finished: null,
//             settings: {
//               minutes: pending.minutes,
//               minutesMs: pending.minutes * 60 * 1000,
//               creatorId: pending.fromUserId,
//               colorPreference: pending.colorPreference || "random",
//             },
//             messages: [],
//             rematch: null,
//           };

//           let initiatorUser = null;
//           let acceptorUser = null;
//           try {
//             initiatorUser = await User.findById(pending.fromUserId)
//               .select("-passwordHash")
//               .lean();
//           } catch (e) {}
//           try {
//             acceptorUser = await User.findById(pending.toUserId)
//               .select("-passwordHash")
//               .lean();
//           } catch (e) {}

//           if (initiatorUser)
//             initiatorUser = helpers.ensureAvatarAbs(initiatorUser);
//           if (acceptorUser)
//             acceptorUser = helpers.ensureAvatarAbs(acceptorUser);

//           const initiatorPlayer = {
//             id: pending.fromSocketId,
//             user: initiatorUser || {
//               id: pending.fromUserId,
//               username: initiatorUser?.username || "guest",
//             },
//             color: "w",
//             online: true,
//             disconnectedAt: null,
//           };
//           const acceptorPlayer = {
//             id: acceptorSocket.id,
//             user: acceptorUser || {
//               id: pending.toUserId,
//               username: acceptorUser?.username || "guest",
//             },
//             color: "b",
//             online: true,
//             disconnectedAt: null,
//           };

//           initiatorPlayer.user = helpers.ensureAvatarAbs(initiatorPlayer.user);
//           acceptorPlayer.user = helpers.ensureAvatarAbs(acceptorPlayer.user);

//           if (pending.colorPreference === "white") {
//             initiatorPlayer.color = "w";
//             acceptorPlayer.color = "b";
//           } else if (pending.colorPreference === "black") {
//             initiatorPlayer.color = "b";
//             acceptorPlayer.color = "w";
//           } else {
//             if (Math.random() < 0.5) {
//               initiatorPlayer.color = "w";
//               acceptorPlayer.color = "b";
//             } else {
//               initiatorPlayer.color = "b";
//               acceptorPlayer.color = "w";
//             }
//           }

//           room.players.push(initiatorPlayer);
//           room.players.push(acceptorPlayer);

//           room.clocks = {
//             w: room.settings.minutesMs,
//             b: room.settings.minutesMs,
//             running: room.chess.turn(),
//             lastTick: Date.now(),
//           };

//           rooms[roomId] = room;

//           const initiatorSockObj = io.sockets.sockets.get(pending.fromSocketId);
//           const acceptorSockObj = acceptorSocket;
//           if (initiatorSockObj) initiatorSockObj.join(roomId);
//           if (acceptorSockObj) acceptorSockObj.join(roomId);

//           broadcastRoomState(roomId);

//           const payload = {
//             ok: true,
//             challengeId,
//             roomId,
//             message: "Challenge accepted — room created",
//             assignedColors: {
//               [pending.fromUserId]: initiatorPlayer.color,
//               [pending.toUserId]: acceptorPlayer.color,
//             },
//             redirectPath: "/play",
//           };
//           initiatorSockObj &&
//             initiatorSockObj.emit("challenge-accepted", payload);
//           acceptorSockObj &&
//             acceptorSockObj.emit("challenge-accepted", payload);

//           // Persist notifications to both parties
//           try {
//             await notificationService.createNotification(
//               String(pending.fromUserId),
//               "challenge_accepted",
//               "Challenge accepted",
//               `${acceptorUser?.username || "Player"} accepted your challenge.`,
//               { challengeId, roomId }
//             );
//           } catch (e) {
//             console.error("createNotification (challenge_accepted) failed", e);
//           }

//           try {
//             await notificationService.createNotification(
//               String(pending.toUserId),
//               "challenge_joined",
//               "Challenge joined",
//               `You accepted a challenge — room ${roomId} created.`,
//               { challengeId, roomId }
//             );
//           } catch (e) {
//             console.error("createNotification (challenge_joined) failed", e);
//           }

//           // mark original challenge notification for the acceptor as read + emit update
//           try {
//             const orig = await Notification.findOneAndUpdate(
//               {
//                 "data.challengeId": challengeId,
//                 userId: String(pending.toUserId),
//               },
//               {
//                 $set: {
//                   read: true,
//                   updatedAt: Date.now(),
//                   "data.status": "accepted",
//                 },
//               },
//               { new: true }
//             )
//               .lean()
//               .exec();
//             if (orig) {
//               try {
//                 const payload = {
//                   id: orig._id?.toString(),
//                   _id: orig._id?.toString(),
//                   userId: orig.userId,
//                   type: orig.type,
//                   title: orig.title,
//                   body: orig.body,
//                   data: orig.data,
//                   read: orig.read,
//                   createdAt: orig.createdAt,
//                   updatedAt: orig.updatedAt,
//                 };
//                 io.to(`user:${String(pending.toUserId)}`).emit(
//                   "notification",
//                   payload
//                 );
//               } catch (e) {}
//             }
//           } catch (e) {
//             console.error(
//               "accept-challenge: mark original notification handled failed",
//               e
//             );
//           }

//           delete pendingChallenges[challengeId];
//         } catch (err) {
//           console.error("accept-challenge error", err);
//           // rollback reservations if necessary
//           try {
//             if (
//               reservedInitiator &&
//               reservedInitiator.set &&
//               pending.fromUserId
//             ) {
//               await reservations.releaseActiveRoom(pending.fromUserId, roomId);
//             }
//             if (reservedAcceptor && reservedAcceptor.set && pending.toUserId) {
//               await reservations.releaseActiveRoom(pending.toUserId, roomId);
//             }
//           } catch (e) {}
//           socket.emit("challenge-accept-response", {
//             ok: false,
//             error: "Server error",
//           });
//         }
//       } catch (err) {
//         console.error("accept-challenge error", err);
//         socket.emit("challenge-accept-response", {
//           ok: false,
//           error: "Server error",
//         });
//       }
//     });

//     // decline-challenge
//     socket.on("decline-challenge", async ({ challengeId }) => {
//       try {
//         const pending = pendingChallenges[challengeId];
//         if (!pending) {
//           socket.emit("challenge-decline-response", {
//             ok: false,
//             error: "No such challenge",
//           });
//           return;
//         }
//         const initiatorSocket = io.sockets.sockets.get(pending.fromSocketId);
//         if (initiatorSocket) {
//           initiatorSocket.emit("challenge-declined", {
//             challengeId,
//             reason: "opponent-declined",
//           });
//         }

//         // Persist decline notification to initiator
//         try {
//           await notificationService.createNotification(
//             String(pending.fromUserId),
//             "challenge_declined",
//             "Challenge declined",
//             `${
//               pending.toUserId ? "Opponent" : "Player"
//             } declined your challenge.`,
//             { challengeId }
//           );
//         } catch (e) {
//           console.error("createNotification (challenge_declined) failed", e);
//         }

//         // mark original challenge notification for the decliner as read/declined + emit update
//         try {
//           const orig = await Notification.findOneAndUpdate(
//             {
//               "data.challengeId": challengeId,
//               userId: String(pending.toUserId),
//             },
//             {
//               $set: {
//                 read: true,
//                 updatedAt: Date.now(),
//                 "data.status": "declined",
//               },
//             },
//             { new: true }
//           )
//             .lean()
//             .exec();
//           if (orig) {
//             try {
//               io.to(`user:${String(pending.toUserId)}`).emit("notification", {
//                 id: orig._id?.toString(),
//                 _id: orig._id?.toString(),
//                 ...orig,
//               });
//             } catch (e) {}
//           }
//         } catch (e) {
//           console.error(
//             "decline-challenge: mark original notification handled failed",
//             e
//           );
//         }

//         delete pendingChallenges[challengeId];
//         socket.emit("challenge-decline-response", { ok: true });
//       } catch (err) {
//         console.error("decline-challenge error", err);
//         socket.emit("challenge-decline-response", {
//           ok: false,
//           error: "Server error",
//         });
//       }
//     });

//     // friend request handlers
//     socket.on("send-friend-request", async ({ toUserId }, callback) => {
//       try {
//         if (!socket.user || !socket.user.id) {
//           if (callback) callback({ ok: false, error: "Not authenticated" });
//           return;
//         }
//         if (!toUserId) {
//           if (callback) callback({ ok: false, error: "Missing target" });
//           return;
//         }
//         if (toUserId === socket.user.id) {
//           if (callback)
//             callback({ ok: false, error: "Cannot friend yourself" });
//           return;
//         }

//         const reqId = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
//         const fromUserId = socket.user.id;
//         const fromUsername = socket.user.username || "unknown";

//         const target = await User.findById(toUserId);
//         if (!target) {
//           if (callback) callback({ ok: false, error: "User not found" });
//           return;
//         }

//         const alreadyFriend = (target.friends || []).some(
//           (f) => f.id === fromUserId
//         );
//         const alreadyPending = (target.incomingFriendRequests || []).some(
//           (r) => r.fromUserId === fromUserId && r.status === "pending"
//         );
//         if (alreadyFriend) {
//           if (callback) callback({ ok: false, error: "Already friends" });
//           return;
//         }
//         if (alreadyPending) {
//           if (callback)
//             callback({ ok: false, error: "Request already pending" });
//           return;
//         }

//         target.incomingFriendRequests = target.incomingFriendRequests || [];
//         target.incomingFriendRequests.push({
//           reqId,
//           fromUserId,
//           fromUsername,
//           ts: Date.now(),
//           status: "pending",
//         });
//         await target
//           .save()
//           .catch((e) => console.error("save incoming req error", e));

//         const targetSockets = getSocketsForUserId(toUserId);
//         const payload = { reqId, fromUserId, fromUsername };
//         targetSockets.forEach((sid) =>
//           io.to(sid).emit("friend-request-received", payload)
//         );

//         // Persist notification for recipient
//         try {
//           await notificationService.createNotification(
//             String(toUserId),
//             "friend_request",
//             "New friend request",
//             `${fromUsername} sent you a friend request.`,
//             { reqId, fromUserId }
//           );
//         } catch (e) {
//           console.error("createNotification (friend_request) failed", e);
//         }

//         if (callback) callback({ ok: true, reqId });
//       } catch (err) {
//         console.error("send-friend-request error", err);
//         if (callback) callback({ ok: false, error: "Server error" });
//       }
//     });

//     socket.on("respond-friend-request", async ({ reqId, accept }, callback) => {
//       try {
//         if (!socket.user || !socket.user.id) {
//           if (callback) callback({ ok: false, error: "Not authenticated" });
//           return;
//         }
//         const toUserId = socket.user.id;

//         const targetUser = await User.findOne({
//           "incomingFriendRequests.reqId": reqId,
//         }).exec();
//         if (!targetUser) {
//           if (callback) callback({ ok: false, error: "Request not found" });
//           return;
//         }
//         const reqEntry = (targetUser.incomingFriendRequests || []).find(
//           (r) => r.reqId === reqId
//         );
//         if (!reqEntry) {
//           if (callback) callback({ ok: false, error: "Request not found" });
//           return;
//         }
//         if (reqEntry.status !== "pending") {
//           if (callback)
//             callback({ ok: false, error: "Request already handled" });
//           return;
//         }

//         const fromUserId = reqEntry.fromUserId;

//         if (accept) {
//           const fromUserDoc = await User.findById(fromUserId)
//             .select("username friends")
//             .exec();
//           if (!fromUserDoc) {
//             targetUser.incomingFriendRequests = (
//               targetUser.incomingFriendRequests || []
//             ).filter((r) => r.reqId !== reqId);
//             await targetUser.save().catch(() => {});
//             if (callback)
//               callback({ ok: false, error: "Request sender not found" });
//             return;
//           }
//           const fromUsername = fromUserDoc.username || "unknown";
//           const toUserDoc = await User.findById(toUserId)
//             .select("username friends")
//             .exec();
//           const toUsername = toUserDoc.username || "unknown";

//           await User.updateOne(
//             { _id: fromUserId },
//             { $addToSet: { friends: { id: toUserId, username: toUsername } } }
//           )
//             .exec()
//             .catch(() => {});
//           await User.updateOne(
//             { _id: toUserId },
//             {
//               $addToSet: {
//                 friends: { id: fromUserId, username: fromUsername },
//               },
//             }
//           )
//             .exec()
//             .catch(() => {});

//           targetUser.incomingFriendRequests = (
//             targetUser.incomingFriendRequests || []
//           ).filter((r) => r.reqId !== reqId);
//           await targetUser.save().catch(() => {});

//           const senderSockets = getSocketsForUserId(fromUserId);
//           senderSockets.forEach((sid) =>
//             io.to(sid).emit("friend-request-accepted", {
//               reqId,
//               by: { id: toUserId, username: toUsername },
//             })
//           );

//           // Persist notification to request sender
//           try {
//             await notificationService.createNotification(
//               String(fromUserId),
//               "friend_request_accepted",
//               "Friend request accepted",
//               `${
//                 socket.user?.username || "User"
//               } accepted your friend request.`,
//               { reqId, by: { id: toUserId, username: socket.user?.username } }
//             );
//           } catch (e) {
//             console.error(
//               "createNotification (friend_request_accepted) failed",
//               e
//             );
//           }

//           // mark original friend_request notification for the accepter as read + emit update
//           try {
//             const orig = await Notification.findOneAndUpdate(
//               { "data.reqId": reqId, userId: String(toUserId) },
//               {
//                 $set: {
//                   read: true,
//                   updatedAt: Date.now(),
//                   "data.status": "accepted",
//                 },
//               },
//               { new: true }
//             )
//               .lean()
//               .exec();

//             if (orig) {
//               try {
//                 const payload = {
//                   id: orig._id?.toString(),
//                   _id: orig._id?.toString(),
//                   userId: orig.userId,
//                   type: orig.type,
//                   title: orig.title,
//                   body: orig.body,
//                   data: orig.data,
//                   read: orig.read,
//                   createdAt: orig.createdAt,
//                   updatedAt: orig.updatedAt,
//                 };
//                 io.to(`user:${String(toUserId)}`).emit("notification", payload);
//               } catch (e) {}
//             }
//           } catch (e) {
//             console.error(
//               "respond-friend-request: mark original notification handled failed",
//               e
//             );
//           }

//           if (callback) callback({ ok: true, accepted: true });
//         } else {
//           targetUser.incomingFriendRequests = (
//             targetUser.incomingFriendRequests || []
//           ).filter((r) => r.reqId !== reqId);
//           await targetUser.save().catch(() => {});

//           const senderSockets = getSocketsForUserId(fromUserId);
//           senderSockets.forEach((sid) =>
//             io.to(sid).emit("friend-request-declined", {
//               reqId,
//               by: { id: toUserId, username: socket.user.username },
//             })
//           );

//           // Persist notification to request sender about decline
//           try {
//             await notificationService.createNotification(
//               String(fromUserId),
//               "friend_request_declined",
//               "Friend request declined",
//               `${
//                 socket.user?.username || "User"
//               } declined your friend request.`,
//               { reqId, by: { id: toUserId, username: socket.user?.username } }
//             );
//           } catch (e) {
//             console.error(
//               "createNotification (friend_request_declined) failed",
//               e
//             );
//           }

//           // mark original friend_request notification for the decliner as read + emit update
//           try {
//             const orig = await Notification.findOneAndUpdate(
//               { "data.reqId": reqId, userId: String(toUserId) },
//               {
//                 $set: {
//                   read: true,
//                   updatedAt: Date.now(),
//                   "data.status": "declined",
//                 },
//               },
//               { new: true }
//             )
//               .lean()
//               .exec();

//             if (orig) {
//               try {
//                 const payload = {
//                   id: orig._id?.toString(),
//                   _id: orig._id?.toString(),
//                   userId: orig.userId,
//                   type: orig.type,
//                   title: orig.title,
//                   body: orig.body,
//                   data: orig.data,
//                   read: orig.read,
//                   createdAt: orig.createdAt,
//                   updatedAt: orig.updatedAt,
//                 };
//                 io.to(`user:${String(toUserId)}`).emit("notification", payload);
//               } catch (e) {}
//             }
//           } catch (e) {
//             console.error(
//               "respond-friend-request: mark original notification handled failed",
//               e
//             );
//           }

//           if (callback) callback({ ok: true, accepted: false });
//         }
//       } catch (err) {
//         console.error("respond-friend-request error", err);
//         if (callback) callback({ ok: false, error: "Server error" });
//       }
//     });

//     // remove-friend
//     socket.on("remove-friend", ({ targetId }, callback) => {
//       try {
//         if (!socket.user || !socket.user.id) {
//           if (callback) callback({ ok: false, error: "Not authenticated" });
//           return;
//         }
//         if (!targetId) {
//           if (callback) callback({ ok: false, error: "Missing targetId" });
//           return;
//         }
//         const byPayload = {
//           id: socket.user.id,
//           username: socket.user.username,
//         };
//         const targetSockets = getSocketsForUserId(targetId);
//         targetSockets.forEach((sid) =>
//           io.to(sid).emit("friend-removed", { by: byPayload, targetId })
//         );
//         if (callback) callback({ ok: true });

//         // Persist notification to the removed friend
//         try {
//           notificationService.createNotification(
//             String(targetId),
//             "friend_removed",
//             "Friend removed",
//             `${socket.user?.username || "User"} removed you from friends.`,
//             { by: byPayload }
//           );
//         } catch (e) {
//           console.error("createNotification (friend_removed) failed", e);
//         }
//       } catch (err) {
//         console.error("remove-friend error", err);
//         if (callback) callback({ ok: false, error: "Server error" });
//       }
//     });

//     /* ------------------------
//        Matchmaking events
//        ------------------------ */

//     // enqueue-match
//     socket.on("enqueue-match", async (payload = {}) => {
//       try {
//         const userId = socket.user?.id || null;
//         const cups =
//           socket.user?.cups ??
//           (Number.isFinite(Number(payload?.cups))
//             ? Number(payload.cups)
//             : null);
//         const minutes = Math.max(
//           1,
//           Math.floor(Number(payload?.minutes || payload?.m || 5))
//         );
//         const colorPreference =
//           payload?.colorPreference || payload?.cp || "random";

//         const added = await context.matchmaking.addToPlayQueue({
//           socketId: socket.id,
//           userId,
//           cups,
//           minutes,
//           colorPreference,
//         });
//         if (added) {
//           socket.emit("match-queued", {
//             ok: true,
//             message: "Queued for matchmaking",
//           });
//         } else {
//           socket.emit("match-queued", { ok: false, error: "Already in queue" });
//         }
//       } catch (err) {
//         console.error("enqueue-match error", err);
//         socket.emit("match-queue-error", { ok: false, error: "Server error" });
//       }
//     });

//     // dequeue-match
//     socket.on("dequeue-match", () => {
//       try {
//         const removed = context.matchmaking.removeFromPlayQueueBySocket(
//           socket.id
//         );
//         socket.emit("match-dequeued", { ok: true, removed });
//       } catch (e) {
//         console.error("dequeue-match error", e);
//         socket.emit("match-queue-error", { ok: false, error: "Server error" });
//       }
//     });

//     // WebRTC signalling helpers
//     function relayToSocketOrUser(targetId, eventName, payload) {
//       try {
//         const sock = io && io.sockets && io.sockets.sockets.get(targetId);
//         if (sock) {
//           io.to(targetId).emit(eventName, payload);
//           return true;
//         }

//         const sids = getSocketsForUserId(targetId);
//         if (Array.isArray(sids) && sids.length > 0) {
//           for (const sid of sids) {
//             try {
//               io.to(sid).emit(eventName, payload);
//             } catch (e) {}
//           }
//           return true;
//         }

//         return false;
//       } catch (e) {
//         console.error("relayToSocketOrUser error:", e);
//         return false;
//       }
//     }

//     // webrtc-offer
//     socket.on("webrtc-offer", ({ roomId, toSocketId, offer }) => {
//       try {
//         const payload = { fromSocketId: socket.id, offer };

//         if (toSocketId) {
//           relayToSocketOrUser(toSocketId, "webrtc-offer", payload);
//           return;
//         }

//         if (roomId && rooms[roomId]) {
//           const opponent = (rooms[roomId].players || []).find(
//             (p) => p.id !== socket.id && (p.color === "w" || p.color === "b")
//           );
//           if (opponent && opponent.id) {
//             relayToSocketOrUser(opponent.id, "webrtc-offer", payload);
//           }
//         }
//       } catch (e) {
//         console.error("webrtc-offer relay error:", e);
//       }
//     });

//     // webrtc-answer
//     socket.on("webrtc-answer", ({ roomId, toSocketId, answer }) => {
//       try {
//         const payload = { fromSocketId: socket.id, answer };

//         if (toSocketId) {
//           relayToSocketOrUser(toSocketId, "webrtc-answer", payload);
//           return;
//         }

//         if (roomId && rooms[roomId]) {
//           const opponent = (rooms[roomId].players || []).find(
//             (p) => p.id !== socket.id && (p.color === "w" || p.color === "b")
//           );
//           if (opponent && opponent.id) {
//             relayToSocketOrUser(opponent.id, "webrtc-answer", payload);
//           }
//         }
//       } catch (e) {
//         console.error("webrtc-answer relay error:", e);
//       }
//     });

//     // webrtc-ice
//     socket.on("webrtc-ice", ({ roomId, toSocketId, candidate }) => {
//       try {
//         const payload = { fromSocketId: socket.id, candidate };

//         if (toSocketId) {
//           relayToSocketOrUser(toSocketId, "webrtc-ice", payload);
//           return;
//         }

//         if (roomId && rooms[roomId]) {
//           const opponent = (rooms[roomId].players || []).find(
//             (p) => p.id !== socket.id && (p.color === "w" || p.color === "b")
//           );
//           if (opponent && opponent.id) {
//             relayToSocketOrUser(opponent.id, "webrtc-ice", payload);
//           }
//         }
//       } catch (e) {
//         console.error("webrtc-ice relay error:", e);
//       }
//     });

//     // webrtc-hangup
//     socket.on("webrtc-hangup", ({ roomId, toSocketId }) => {
//       try {
//         const payload = { fromSocketId: socket.id };

//         if (toSocketId) {
//           relayToSocketOrUser(toSocketId, "webrtc-hangup", payload);
//           return;
//         }

//         if (roomId && rooms[roomId]) {
//           const opponent = (rooms[roomId].players || []).find(
//             (p) => p.id !== socket.id && (p.color === "w" || p.color === "b")
//           );
//           if (opponent && opponent.id) {
//             relayToSocketOrUser(opponent.id, "webrtc-hangup", payload);
//           }
//         }
//       } catch (e) {
//         console.error("webrtc-hangup relay error:", e);
//       }
//     });

//     // Legacy play-online API (same as enqueue-match)
//     socket.on("play-online", async (payload = {}) => {
//       try {
//         const userId = socket.user?.id || null;
//         const cups =
//           socket.user?.cups ??
//           (Number.isFinite(Number(payload?.cups))
//             ? Number(payload.cups)
//             : null);
//         const minutes = Math.max(
//           1,
//           Math.floor(Number(payload?.minutes || payload?.m || 5))
//         );
//         const colorPreference =
//           payload?.colorPreference || payload?.cp || "random";

//         const added = await context.matchmaking.addToPlayQueue({
//           socketId: socket.id,
//           userId,
//           cups,
//           minutes,
//           colorPreference,
//         });
//         if (added) {
//           socket.emit("match-queued", {
//             ok: true,
//             message: "Queued for matchmaking",
//           });
//         } else {
//           socket.emit("match-queued", { ok: false, error: "Already in queue" });
//         }
//       } catch (err) {
//         console.error("play-online error", err);
//         socket.emit("match-queue-error", { ok: false, error: "Server error" });
//       }
//     });

//     // cancel-play-online
//     socket.on("cancel-play-online", () => {
//       try {
//         const removed = context.matchmaking.removeFromPlayQueueBySocket(
//           socket.id
//         );
//         socket.emit("match-dequeued", { ok: true, removed });
//       } catch (e) {
//         console.error("cancel-play-online error", e);
//         socket.emit("match-queue-error", { ok: false, error: "Server error" });
//       }
//     });

//     /* ------------------------
//        Disconnect handling
//        ------------------------ */
//     socket.on("disconnect", () => {
//       try {
//         context.matchmaking.removeFromPlayQueueBySocket(socket.id);
//       } catch (e) {}

//       if (socket.user && socket.user.id) {
//         removeOnlineSocketForUser(socket.user.id, socket.id);
//       }

//       Object.keys(rooms).forEach((rId) => {
//         const room = rooms[rId];
//         const idx = room.players.findIndex((p) => p.id === socket.id);
//         if (idx !== -1) {
//           room.players[idx].online = false;
//           room.players[idx].disconnectedAt = Date.now();

//           room.disconnectTimers = room.disconnectTimers || {};
//           clearDisconnectTimer(room, socket.id);
//           room.disconnectTimers[socket.id] = setTimeout(async () => {
//             const p = room.players.find((pp) => pp.id === socket.id);
//             if (p && !p.online && !room.finished) {
//               const opponent = room.players.find(
//                 (pp) =>
//                   (pp.color === "w" || pp.color === "b") &&
//                   pp.color !== p.color &&
//                   pp.online
//               );
//               if (opponent) {
//                 room.paused = true;
//                 if (room.clocks) {
//                   room.clocks.running = null;
//                   room.clocks.lastTick = null;
//                 }
//                 room.finished = {
//                   reason: "opponent-disconnected",
//                   winner: opponent.color,
//                   loser: p.color,
//                   message: `Player ${p.user?.username || p.id} disconnected — ${
//                     opponent.user?.username || opponent.id
//                   } wins`,
//                   finishedAt: Date.now(),
//                 };
//                 io.to(rId).emit("game-over", { ...room.finished });
//                 clearFirstMoveTimer(room);
//                 broadcastRoomState(rId);

//                 // clear DB activeRoom for both players
//                 try {
//                   await helpers.clearActiveRoomForRoom(room);
//                 } catch (e) {
//                   console.error(
//                     "clearActiveRoomForRoom failed in disconnect timer",
//                     e
//                   );
//                 }

//                 try {
//                   await context.saveFinishedGame(rId);
//                 } catch (err) {
//                   console.error(
//                     "saveFinishedGame error (disconnect timer):",
//                     err
//                   );
//                 }
//                 try {
//                   await applyCupsModule.applyCupsForFinishedRoom(context, rId);
//                 } catch (e) {
//                   console.error(
//                     "applyCupsForFinishedRoom error (disconnect timer):",
//                     e
//                   );
//                 }
//               } else {
//                 // no online opponent — leave offline (no immediate finish)
//               }
//             }
//             clearDisconnectTimer(room, socket.id);
//           }, context.DISCONNECT_GRACE_MS);

//           broadcastRoomState(rId);
//         }
//       });
//       console.log("socket disconnected", socket.id);
//     });
//   },
// };
