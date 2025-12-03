// backend/socket/handlers/webrtcHandlers.js
// WebRTC signalling helpers (offer/answer/ice/hangup) + relay helper

module.exports = {
  registerAll(socket, context) {
    const { io, rooms, getSocketsForUserId } = context;

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

    socket.on("webrtc-offer", ({ roomId, toSocketId, offer }) => {
      try {
        const payload = { fromSocketId: socket.id, offer };
        if (toSocketId) {
          relayToSocketOrUser(toSocketId, "webrtc-offer", payload);
          return;
        }
        if (roomId && rooms[roomId]) {
          const opponent = (rooms[roomId].players || []).find(
            (p) => p.id !== socket.id && (p.color === "w" || p.color === "b")
          );
          if (opponent && opponent.id)
            relayToSocketOrUser(opponent.id, "webrtc-offer", payload);
        }
      } catch (e) {
        console.error("webrtc-offer relay error:", e);
      }
    });

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
          if (opponent && opponent.id)
            relayToSocketOrUser(opponent.id, "webrtc-answer", payload);
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
          if (opponent && opponent.id)
            relayToSocketOrUser(opponent.id, "webrtc-ice", payload);
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
          if (opponent && opponent.id)
            relayToSocketOrUser(opponent.id, "webrtc-hangup", payload);
        }
      } catch (e) {
        console.error("webrtc-hangup relay error:", e);
      }
    });
  }, // end registerAll
};
