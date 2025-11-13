AND THIS IS THE SECOND HALF THE CONTINUE HALF OF SOCKET.JS 
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

    // play-again / rematch (kept intact)
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
          // NEW: create a NEW room for the rematch (do not reuse old roomId)
          try {
            const res = await roomManager.createRematchFrom(roomId);
            if (res && res.ok && res.roomId) {
              const newRoomId = res.roomId;

              // clear rematch on old room (keep historical data untouched)
              try {
                if (rooms[roomId]) {
                  rooms[roomId].rematch = null;
                  broadcastRoomState(roomId);
                }
              } catch (e) {}

              // notify new room: play-again started
              io.to(newRoomId).emit("play-again", {
                ok: true,
                started: true,
                message: "Rematch started",
                roomId: newRoomId,
              });

              // emit player-assigned for clients in new room
              try {
                const newRoom = rooms[newRoomId];
                if (newRoom && Array.isArray(newRoom.players)) {
                  for (const p of newRoom.players) {
                    try {
                      io.to(p.id).emit("player-assigned", { color: p.color });
                    } catch (e) {}
                  }
                }
              } catch (e) {}

              // Persist rematch-started notifications to participants (new room id)
              try {
                const newRoom = rooms[newRoomId];
                if (newRoom && Array.isArray(newRoom.players)) {
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
                }
              } catch (e) {
                console.error("createNotification (rematch_started) failed", e);
              }
            } else {
              // fallback
              broadcastRoomState(roomId);
              socket.emit("play-again", {
                ok: false,
                started: false,
                error: "rematch-create-failed",
              });
            }
          } catch (err) {
            console.error("createRematchFrom error", err);
            socket.emit("play-again", {
              ok: false,
              started: false,
              error: "Server error",
            });
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

module.exports = { initSockets };  SO NOW U HAVE MY SOCKET.JS COMPELETE OK BASE THIS  SHOW THE FINAL FIX OF SOCKET.JS REMOVE ALL FUNCTIOANTLIY AND LOGIC ABOUT ACTIVE ROOM U KNOW SO PLEASE DO IT AND SHOW THE FINAL FIX OF SOCKET.JS NO PART OR PART OR PLACEHOLDER I WANT THE COMPELETE COMPLETE I MEAN MY CODE ABOUT 3000+ LINES OF CODE YOUR CODE ALSO SHOULD JUST REMOVE THE ACTIVE ROOM FUNCTIOANTLIY AND LOGIC SO SHOW ALL THE FUNCTIOANTLY NO REMOVE OR CHANGE OKAY SO I WANT THE COMPELETE VERSION