// backend/socket/handlers/friendHandlers.js
// Friend request handlers, accept/decline, remove friend

module.exports = {
  registerAll(socket, context) {
    const { io, User, notificationService, getSocketsForUserId, Notification } =
      context;

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
            io
              .to(sid)
              .emit("friend-request-accepted", {
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

          // mark original friend_request notification for the accepter as read + emit update
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
            io
              .to(sid)
              .emit("friend-request-declined", {
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

          // mark original friend_request notification for the decliner as read + emit update
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
  }, // end registerAll
};
