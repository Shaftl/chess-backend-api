// backend/socket/handlers/inviteHandlers.js
// Robust invite accept flow: when an invite is accepted we create a real room (if missing),
// persist the roomId into the invite doc (if present), join sockets and notify both parties.
// This file integrates with your existing context/roomManager shape and uses the Invite model
// when available. It is defensive: works whether client sends inviteId or just user ids.

const Invite = require("../../models/Invite"); // adjust path if your model lives elsewhere

module.exports = {
  registerAll(socket, context) {
    const {
      io,
      roomManager,
      getSocketsForUserId,
      notificationService,
      User,
      notifyUser,
      generateRoomCode,
    } = context;

    // Lightweight emit for an outgoing invite (inviter -> target user)
    // Payload: { toUserId, roomId?, minutes?, colorPreference?, meta? }
    socket.on("invite-friend", async (payload = {}, cb) => {
      try {
        const {
          toUserId,
          roomId = null,
          minutes = 5,
          colorPreference = "random",
          meta = null,
        } = payload;
        const fromUser = socket.user || {
          id: socket.id,
          username: socket.user?.username || "guest",
        };

        // emit to target user's socket-room so all devices receive it
        try {
          io.to(`user:${String(toUserId)}`).emit("friend-invite", {
            fromUser,
            roomId,
            minutes,
            colorPreference,
            meta,
          });
        } catch (e) {
          console.warn("invite-friend: emit failed", e);
        }

        // Optionally persist invite for inbox / history if Invite model exists
        if (Invite) {
          try {
            const doc = new Invite({
              fromUserId: String(fromUser.id || fromUser._id || ""),
              fromUsername:
                fromUser.username || fromUser.displayName || "Guest",
              toUserId: String(toUserId || ""),
              toUsername: null,
              minutes: Number(minutes) || 5,
              colorPreference: colorPreference || "random",
              status: "pending",
              roomId: roomId || null,
              meta: meta || null,
            });
            await doc.save();
          } catch (e) {
            // non-fatal
            console.warn("invite-friend: failed to persist invite", e);
          }
        }

        if (typeof cb === "function") cb({ ok: true });
      } catch (err) {
        console.error("invite-friend error", err);
        if (typeof cb === "function") cb({ ok: false, error: "server-error" });
      }
    });

    // Accept an invite (socket flow). Payload options:
    // { inviteId, fromUserId, minutes, colorPreference }
    // Behavior:
    //  - If inviteId present -> load invite doc and prefer its data (from/to/minutes/colorPref)
    //  - Create a room (via roomManager.createRoom) for both players (userA=inviter, userB=acceptor)
    //  - Persist roomId into invite doc (if loaded)
    //  - Join sockets into the room and emit invite-accepted/match-found events with roomId
    socket.on("accept-invite", async (payload = {}, cb) => {
      try {
        const {
          inviteId = null,
          fromUserId = null,
          minutes = 5,
          colorPreference = "random",
        } = payload;
        const acceptor = socket.user || {
          id: socket.id,
          username: socket.user?.username || "guest",
        };
        let inviterId = fromUserId;
        let inviteDoc = null;
        let inviteMinutes = Number(minutes) || 5;
        let inviteColorPref = colorPreference || "random";

        // If inviteId provided, load it and prefer its data
        if (inviteId && Invite) {
          try {
            inviteDoc = await Invite.findById(inviteId).exec();
            if (inviteDoc) {
              inviterId = String(inviteDoc.fromUserId || inviterId || "");
              inviteMinutes = Number(inviteDoc.minutes || inviteMinutes);
              inviteColorPref = inviteDoc.colorPreference || inviteColorPref;
            }
          } catch (e) {
            console.warn("accept-invite: failed to load inviteId", e);
          }
        }

        // If still no inviterId, and fromUserId provided, use it
        if (!inviterId && fromUserId) inviterId = String(fromUserId);

        // Create a room for inviter <-> acceptor
        let createdRoomId = null;
        try {
          const res = await roomManager.createRoom({
            minutes: Math.max(1, Math.floor(Number(inviteMinutes || minutes))),
            colorPreference: inviteColorPref || "random",
            userA: inviterId ? { id: inviterId } : null,
            userB: acceptor && acceptor.id ? { id: acceptor.id } : null,
          });

          if (res && (res.roomId || res.id)) {
            createdRoomId = res.roomId || res.id;
          }
        } catch (e) {
          console.error("accept-invite: roomManager.createRoom failed", e);
        }

        // Fallback: if createRoom didn't return, make a minimal fallback room in memory (best-effort)
        if (!createdRoomId) {
          try {
            let fallback = generateRoomCode
              ? generateRoomCode(8)
              : `R${Date.now().toString(36)}`;
            // avoid collision
            let attempts = 0;
            while (
              roomManager.rooms &&
              roomManager.rooms[fallback] &&
              attempts < 12
            ) {
              fallback = generateRoomCode
                ? generateRoomCode(8)
                : `R${Date.now().toString(36)}${attempts}`;
              attempts++;
            }

            const pAUser =
              inviterId && typeof User === "function"
                ? await User.findById(inviterId)
                    .lean()
                    .exec()
                    .catch(() => null)
                : null;
            const pBUser =
              acceptor && acceptor.id && typeof User === "function"
                ? await User.findById(acceptor.id)
                    .lean()
                    .exec()
                    .catch(() => null)
                : null;

            const r = {
              players: [
                {
                  id: inviterId || `u:${inviterId || "inviter"}`,
                  user: pAUser || {
                    id: inviterId,
                    username: pAUser?.username || "guest",
                  },
                  color: "w",
                  online: !!(inviterId && roomManager.onlineUsers[inviterId]),
                  disconnectedAt: null,
                },
                {
                  id: acceptor.id || `u:${acceptor.id || "acceptor"}`,
                  user: pBUser || {
                    id: acceptor.id,
                    username: acceptor?.username || "guest",
                  },
                  color: "b",
                  online: !!(
                    acceptor &&
                    acceptor.id &&
                    roomManager.onlineUsers[acceptor.id]
                  ),
                  disconnectedAt: null,
                },
              ],
              moves: [],
              chess: new (require("chess.js").Chess)(),
              fen: null,
              lastIndex: -1,
              clocks: {
                w:
                  Math.max(1, Math.floor(Number(inviteMinutes || minutes))) *
                  60 *
                  1000,
                b:
                  Math.max(1, Math.floor(Number(inviteMinutes || minutes))) *
                  60 *
                  1000,
                running: "w",
                lastTick: Date.now(),
              },
              paused: false,
              disconnectTimers: {},
              firstMoveTimer: null,
              pendingDrawOffer: null,
              finished: null,
              settings: {
                minutes: Math.max(
                  1,
                  Math.floor(Number(inviteMinutes || minutes))
                ),
                minutesMs:
                  Math.max(1, Math.floor(Number(inviteMinutes || minutes))) *
                  60 *
                  1000,
                creatorId: inviterId || null,
                colorPreference: inviteColorPref || "random",
                createdAt: Date.now(),
              },
              messages: [],
              rematch: null,
            };

            roomManager.rooms[fallback] = r;
            createdRoomId = fallback;
            // schedule timers and persist
            try {
              roomManager.scheduleFirstMoveTimer(createdRoomId);
              roomManager.scheduleRoomExpiration(createdRoomId);
              roomManager.broadcastRoomState(createdRoomId);
            } catch (e) {}
          } catch (e) {
            console.error("accept-invite fallback room creation failed", e);
            createdRoomId = null;
          }
        }

        // Persist createdRoomId into invite document (if it exists)
        if (inviteDoc && createdRoomId) {
          try {
            inviteDoc.roomId = createdRoomId;
            inviteDoc.status = "accepted";
            inviteDoc.acceptedAt = Date.now();
            inviteDoc.updatedAt = Date.now();
            await inviteDoc.save();
          } catch (e) {
            console.warn("accept-invite: failed to update invite doc", e);
          }
        }

        // Join sockets: acceptor's socket already present; make other sockets join
        try {
          // acceptor joins
          try {
            socket.join(createdRoomId);
          } catch (e) {}

          // inviter sockets join
          if (inviterId) {
            const inviterSids =
              typeof getSocketsForUserId === "function"
                ? getSocketsForUserId(String(inviterId))
                : roomManager.getSocketsForUserId
                ? roomManager.getSocketsForUserId(String(inviterId))
                : [];
            if (Array.isArray(inviterSids) && inviterSids.length) {
              for (const sid of inviterSids) {
                try {
                  const sock = io.sockets.sockets.get(sid);
                  if (sock) sock.join(createdRoomId);
                } catch (e) {}
              }
            }
          }
        } catch (e) {
          console.warn("accept-invite: join sockets failed", e);
        }

        // Notify both parties (socket + presence-room)
        try {
          // To inviter(s)
          if (inviterId) {
            try {
              io.to(`user:${String(inviterId)}`).emit("invite-accepted", {
                ok: true,
                roomId: createdRoomId,
                byUser: acceptor,
                minutes: inviteMinutes,
                colorPreference: inviteColorPref,
              });
            } catch (e) {}
            try {
              // For backward compatibility with "match-found" flow
              io.to(`user:${String(inviterId)}`).emit("match-found", {
                ok: true,
                roomId: createdRoomId,
                message: "Invite accepted — joining room",
              });
            } catch (e) {}
          }

          // To acceptor (current socket)
          try {
            socket.emit("invite-accepted", {
              ok: true,
              roomId: createdRoomId,
              byUser: acceptor,
              minutes: inviteMinutes,
              colorPreference: inviteColorPref,
            });
          } catch (e) {}
        } catch (e) {
          console.warn("accept-invite: notify emit failed", e);
        }

        // Persist a notification for inviter if notificationService available
        try {
          if (
            inviterId &&
            notificationService &&
            typeof notificationService.createNotification === "function"
          ) {
            await notificationService.createNotification(
              String(inviterId),
              "invite_accepted",
              "Invite accepted",
              `${
                acceptor.username || acceptor.displayName || "A player"
              } accepted your invite.`,
              { roomId: createdRoomId }
            );
          }
        } catch (e) {
          console.warn("accept-invite: createNotification failed", e);
        }

        if (typeof cb === "function") cb({ ok: true, roomId: createdRoomId });
      } catch (err) {
        console.error("accept-invite error", err);
        if (typeof cb === "function") cb({ ok: false, error: "server-error" });
      }
    }); // end accept-invite handler
  }, // end registerAll
};
