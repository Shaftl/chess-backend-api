// // backend/socket/handlers/matchHandlers.js
// // Matchmaking, play-queue and challenge handlers

// module.exports = {
//   registerAll(socket, context) {
//     const {
//       io,
//       rooms,
//       User,
//       Room,
//       Game,
//       notificationService,
//       pendingChallenges,
//       addToPlayQueue,
//       removeFromPlayQueueBySocket,
//       getSocketsForUserId,
//       generateRoomCode,
//       tryReserveActiveRoom,
//       releaseActiveRoom,
//       ensureAvatarAbs,
//       Chess,
//       broadcastRoomState,
//       mapPlayerForEmit,
//       scheduleFirstMoveTimer,
//       applyCupsForFinishedRoom,
//     } = context;

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

//         const added = await addToPlayQueue({
//           socketId: socket.id,
//           userId,
//           cups,
//           minutes,
//           colorPreference,
//         });
//         if (added)
//           socket.emit("match-queued", {
//             ok: true,
//             message: "Queued for matchmaking",
//           });
//         else
//           socket.emit("match-queued", { ok: false, error: "Already in queue" });
//       } catch (err) {
//         console.error("enqueue-match error", err);
//         socket.emit("match-queue-error", { ok: false, error: "Server error" });
//       }
//     });

//     socket.on("dequeue-match", () => {
//       try {
//         const removed = removeFromPlayQueueBySocket(socket.id);
//         socket.emit("match-dequeued", { ok: true, removed });
//       } catch (e) {
//         console.error("dequeue-match error", e);
//         socket.emit("match-queue-error", { ok: false, error: "Server error" });
//       }
//     });

//     // Legacy play-online (kept identical)
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

//         const added = await addToPlayQueue({
//           socketId: socket.id,
//           userId,
//           cups,
//           minutes,
//           colorPreference,
//         });
//         if (added)
//           socket.emit("match-queued", {
//             ok: true,
//             message: "Queued for matchmaking",
//           });
//         else
//           socket.emit("match-queued", { ok: false, error: "Already in queue" });
//       } catch (err) {
//         console.error("play-online error", err);
//         socket.emit("match-queue-error", { ok: false, error: "Server error" });
//       }
//     });

//     socket.on("cancel-play-online", () => {
//       try {
//         const removed = removeFromPlayQueueBySocket(socket.id);
//         socket.emit("match-dequeued", { ok: true, removed });
//       } catch (e) {
//         console.error("cancel-play-online error", e);
//         socket.emit("match-queue-error", { ok: false, error: "Server error" });
//       }
//     });

//     // challenge / accept / decline
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
//           targetSockets.forEach((sid) =>
//             io.to(sid).emit("challenge-received", challengePayload)
//           );

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
//         const acceptorUserId_local = pending.toUserId;

//         try {
//           if (initiatorUserId) {
//             reservedInitiator = await tryReserveActiveRoom(
//               initiatorUserId,
//               roomId
//             );
//             if (!reservedInitiator.ok)
//               throw reservedInitiator.error || new Error("reserve-init failed");
//             if (!reservedInitiator.set) {
//               if (initiatorSocket)
//                 initiatorSocket.emit("challenge-declined", {
//                   challengeId,
//                   reason: "already-in-active-room",
//                 });
//               if (acceptorSocket)
//                 acceptorSocket.emit("challenge-accept-response", {
//                   ok: false,
//                   error: "opponent-busy",
//                 });
//               delete pendingChallenges[challengeId];
//               return;
//             }
//           }

//           if (acceptorUserId_local) {
//             reservedAcceptor = await tryReserveActiveRoom(
//               acceptorUserId_local,
//               roomId
//             );
//             if (!reservedAcceptor.ok) {
//               if (reservedInitiator.set && initiatorUserId)
//                 await releaseActiveRoom(initiatorUserId, roomId);
//               throw (
//                 reservedAcceptor.error || new Error("reserve-accept failed")
//               );
//             }
//             if (!reservedAcceptor.set) {
//               if (reservedInitiator.set && initiatorUserId)
//                 await releaseActiveRoom(initiatorUserId, roomId);
//               acceptorSocket.emit("challenge-accept-response", {
//                 ok: false,
//                 error: "already-in-active-room",
//               });
//               delete pendingChallenges[challengeId];
//               return;
//             }
//           }

//           // create room object now that reservations are present
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

//           if (initiatorUser) initiatorUser = ensureAvatarAbs(initiatorUser);
//           if (acceptorUser) acceptorUser = ensureAvatarAbs(acceptorUser);

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

//           initiatorPlayer.user = ensureAvatarAbs(initiatorPlayer.user);
//           acceptorPlayer.user = ensureAvatarAbs(acceptorPlayer.user);

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

//           // mark original challenge notification for acceptor as read + emit update
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
//             )
//               await releaseActiveRoom(pending.fromUserId, roomId);
//             if (reservedAcceptor && reservedAcceptor.set && pending.toUserId)
//               await releaseActiveRoom(pending.toUserId, roomId);
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
//         if (initiatorSocket)
//           initiatorSocket.emit("challenge-declined", {
//             challengeId,
//             reason: "opponent-declined",
//           });

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

//         // mark original challenge notification for decliner as read/declined + emit update
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
//   }, // end registerAll
// };

// Matchmaking, play-queue and challenge handlers
// Full file: includes enqueue-match, dequeue-match, play-online, cancel-play-online,
// create-room (with bot support), challenge/accept/decline handlers.

module.exports = {
  registerAll(socket, context) {
    const {
      io,
      rooms,
      User,
      Room,
      Game,
      Notification,
      notificationService,
      pendingChallenges,
      addToPlayQueue,
      removeFromPlayQueueBySocket,
      getSocketsForUserId,
      generateRoomCode,
      tryReserveActiveRoom,
      releaseActiveRoom,
      ensureAvatarAbs,
      Chess,
      broadcastRoomState,
      mapPlayerForEmit,
      scheduleFirstMoveTimer,
      applyCupsForFinishedRoom,
    } = context;

    // === enqueue / dequeue handlers ===
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
        if (added)
          socket.emit("match-queued", {
            ok: true,
            message: "Queued for matchmaking",
          });
        else
          socket.emit("match-queued", { ok: false, error: "Already in queue" });
      } catch (err) {
        console.error("enqueue-match error", err);
        socket.emit("match-queue-error", { ok: false, error: "Server error" });
      }
    });

    socket.on("dequeue-match", () => {
      try {
        const removed = removeFromPlayQueueBySocket(socket.id);
        socket.emit("match-dequeued", { ok: true, removed });
      } catch (e) {
        console.error("dequeue-match error", e);
        socket.emit("match-queue-error", { ok: false, error: "Server error" });
      }
    });

    // Legacy play-online (kept identical)
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
        if (added)
          socket.emit("match-queued", {
            ok: true,
            message: "Queued for matchmaking",
          });
        else
          socket.emit("match-queued", { ok: false, error: "Already in queue" });
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

    /**
     * NEW: create-room handler (supports bot opponent)
     *
     * Client may call:
     *  socket.emit("create-room", { minutes, colorPreference, userB: { id:'bot:2-<ts>', username:'Bot' }, botLevel: 2 })
     *
     * If payload.userB.id starts with "bot:" or payload.botLevel present, this will create a server-side
     * bot player entry (no socket). The room is broadcasted and roomManager logic can pick it up and move the bot.
     */
    socket.on("create-room", async (payload = {}) => {
      try {
        const minutes = Math.max(1, Math.floor(Number(payload.minutes || 5)));
        const minutesMs = minutes * 60 * 1000;
        const colorPreference = payload.colorPreference || "random";

        // generate unique roomId
        let roomId = generateRoomCode(8);
        let attempts = 0;
        while (rooms[roomId] && attempts < 20) {
          roomId = generateRoomCode(8);
          attempts++;
        }
        if (rooms[roomId]) {
          socket.emit("create-room-result", {
            ok: false,
            error: "failed-generate-roomid",
          });
          return;
        }

        // try reserve user's activeRoom (if authenticated)
        let reserved = { ok: true, set: false };
        if (socket.user && socket.user.id) {
          try {
            reserved = await tryReserveActiveRoom(socket.user.id, roomId);
            if (!reserved || !reserved.set) {
              socket.emit("create-room-result", {
                ok: false,
                error: "already-in-active-room",
                activeRoom: socket.user.activeRoom,
              });
              return;
            }
          } catch (e) {
            // reservation failure -> abort
            console.error("create-room: tryReserveActiveRoom error", e);
            socket.emit("create-room-result", {
              ok: false,
              error: "reserve-failed",
            });
            return;
          }
        }

        // build room skeleton
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
            minutes,
            minutesMs,
            creatorId: socket.user?.id || null,
            colorPreference,
            createdAt: Date.now(),
          },
          messages: [],
          rematch: null,
        };

        // creator player (socket)
        let creatorUser = null;
        try {
          if (socket.user && socket.user.id) {
            creatorUser = await User.findById(socket.user.id)
              .select("-passwordHash")
              .lean();
            if (creatorUser) creatorUser = ensureAvatarAbs(creatorUser);
          }
        } catch (e) {
          creatorUser = null;
        }

        const creatorPlayer = {
          id: socket.id,
          user:
            creatorUser ||
            (socket.user
              ? { id: socket.user.id || null, username: socket.user.username }
              : { username: "guest" }),
          color: "w",
          online: true,
          disconnectedAt: null,
        };

        // build bot player entry (if payload indicates bot)
        const providedBot = payload.userB || null;
        let botId =
          (providedBot && providedBot.id) ||
          (payload.botId ? String(payload.botId) : null) ||
          null;
        if (!botId) {
          // if userB provided as object with username but no id, create id
          if (providedBot && providedBot.username) {
            botId = `bot:${payload.botLevel || 2}-${Date.now()}`;
          }
        }
        // if payload.botLevel provided and no explicit userB, create botId
        if (!botId && payload.botLevel) {
          botId = `bot:${Number(payload.botLevel) || 2}-${Date.now()}`;
        }

        // If there is no bot requested, fall back to normal room creation (server won't auto-add second player)
        let botPlayer = null;
        if (botId) {
          const botUsername =
            (providedBot && providedBot.username) ||
            "Bot" ||
            `Bot${Date.now()}`;
          const botUser = { id: botId, username: botUsername };
          botPlayer = {
            id: botId,
            user: botUser,
            color: "b",
            online: false,
            disconnectedAt: null,
          };
        }

        // assign colors by preference or random
        if (colorPreference === "white") {
          creatorPlayer.color = "w";
          if (botPlayer) botPlayer.color = "b";
        } else if (colorPreference === "black") {
          creatorPlayer.color = "b";
          if (botPlayer) botPlayer.color = "w";
        } else {
          if (Math.random() < 0.5) {
            creatorPlayer.color = "w";
            if (botPlayer) botPlayer.color = "b";
          } else {
            creatorPlayer.color = "b";
            if (botPlayer) botPlayer.color = "w";
          }
        }

        // push players
        room.players.push(creatorPlayer);
        if (botPlayer) room.players.push(botPlayer);

        // clocks
        room.clocks = {
          w: minutesMs,
          b: minutesMs,
          running: room.chess.turn(),
          lastTick: Date.now(),
        };

        // bot meta in room.settings so roomManager/scheduler can use it
        if (botPlayer) {
          room.settings.bot = {
            enabled: true,
            level: Number(payload.botLevel) || 2,
            id: botPlayer.id,
          };
        }

        // persist in-memory and join socket to room
        rooms[roomId] = room;

        try {
          const sockObj = io.sockets.sockets.get(socket.id);
          if (sockObj) sockObj.join(roomId);
        } catch (e) {}

        // broadcast initial state (this will also persist snapshot and trigger bot scheduler in roomManager)
        broadcastRoomState(roomId);

        // schedule first-move and expiration (if your room manager expects these functions elsewhere)
        try {
          scheduleFirstMoveTimer && scheduleFirstMoveTimer(roomId);
        } catch (e) {}

        // Notify creator
        socket.emit("room-created", {
          ok: true,
          roomId,
          message: "Room created",
        });
      } catch (err) {
        console.error("create-room error", err);
        socket.emit("create-room-result", { ok: false, error: "Server error" });
      }
    });

    // === challenge / accept / decline handlers (unchanged) ===
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
          targetSockets.forEach((sid) =>
            io.to(sid).emit("challenge-received", challengePayload)
          );

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

        // attempt to reserve both users BEFORE creating the room
        let roomId = generateRoomCode(8);
        while (rooms[roomId]) roomId = generateRoomCode(8);

        let reservedInitiator = { ok: true, set: false };
        let reservedAcceptor = { ok: true, set: false };
        const initiatorUserId = pending.fromUserId;
        const acceptorUserId_local = pending.toUserId;

        try {
          if (initiatorUserId) {
            reservedInitiator = await tryReserveActiveRoom(
              initiatorUserId,
              roomId
            );
            if (!reservedInitiator.ok)
              throw reservedInitiator.error || new Error("reserve-init failed");
            if (!reservedInitiator.set) {
              if (initiatorSocket)
                initiatorSocket.emit("challenge-declined", {
                  challengeId,
                  reason: "already-in-active-room",
                });
              if (acceptorSocket)
                acceptorSocket.emit("challenge-accept-response", {
                  ok: false,
                  error: "opponent-busy",
                });
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
              if (reservedInitiator.set && initiatorUserId)
                await releaseActiveRoom(initiatorUserId, roomId);
              throw (
                reservedAcceptor.error || new Error("reserve-accept failed")
              );
            }
            if (!reservedAcceptor.set) {
              if (reservedInitiator.set && initiatorUserId)
                await releaseActiveRoom(initiatorUserId, roomId);
              acceptorSocket.emit("challenge-accept-response", {
                ok: false,
                error: "already-in-active-room",
              });
              delete pendingChallenges[challengeId];
              return;
            }
          }

          // create room object now that reservations are present
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

          // mark original challenge notification for acceptor as read + emit update
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
            )
              await releaseActiveRoom(pending.fromUserId, roomId);
            if (reservedAcceptor && reservedAcceptor.set && pending.toUserId)
              await releaseActiveRoom(pending.toUserId, roomId);
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
        if (initiatorSocket)
          initiatorSocket.emit("challenge-declined", {
            challengeId,
            reason: "opponent-declined",
          });

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

        // mark original challenge notification for decliner as read/declined + emit update
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

    // end registerAll
  },
};
