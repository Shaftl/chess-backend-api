// backend/socket/handlers/webrtcHandlers.js
// WebRTC signalling helpers (offer/answer/ice/hangup) + relay helper
// Fixed: when a user has multiple sockets/devices, avoid relaying offer/answer
// to the wrong socket (which caused setRemoteDescription InvalidStateError).
// Strategy:
//  - If targetId matches an actual socket id, emit directly to that socket.
//  - If targetId is a user id, get their sockets and prefer sockets that are
//    present in the same room's players list (if roomId provided).
//  - For 'webrtc-offer' and 'webrtc-answer', only forward to a single best-match
//    socket to avoid state mismatch; for ice/hangup we can forward to all matches.

module.exports = {
  registerAll(socket, context) {
    const { io, rooms, getSocketsForUserId } = context;

    /**
     * Relay helper
     * @param {string} targetId - either a socket.id or a userId (depends on caller)
     * @param {string} eventName - event to emit ('webrtc-offer', 'webrtc-answer', 'webrtc-ice', 'webrtc-hangup')
     * @param {object} payload - payload to send
     * @param {string} [roomId] - optional room id to help pick the right socket for a given user
     * @returns {boolean} whether any delivery was attempted
     */
    function relayToSocketOrUser(targetId, eventName, payload, roomId = null) {
      try {
        // 1) If targetId is an actual socket id that is connected, emit directly
        const directSock = io && io.sockets && io.sockets.sockets.get(targetId);
        if (directSock) {
          io.to(targetId).emit(eventName, payload);
          return true;
        }

        // 2) Otherwise treat targetId as a user id and retrieve all socket ids for that user
        const sids =
          typeof getSocketsForUserId === "function"
            ? getSocketsForUserId(targetId)
            : null;

        if (!Array.isArray(sids) || sids.length === 0) return false;

        // 3) If a roomId is provided and room exists, prefer sockets that are in the room's players list
        let candidateSids = sids.slice(); // copy
        try {
          if (
            roomId &&
            rooms &&
            rooms[roomId] &&
            Array.isArray(rooms[roomId].players)
          ) {
            const playerSet = new Set(
              (rooms[roomId].players || []).map((p) => p?.id).filter(Boolean)
            );
            const inRoom = candidateSids.filter((sid) => playerSet.has(sid));
            if (inRoom.length > 0) candidateSids = inRoom;
          }
        } catch (e) {
          // non-fatal — fall back to all sids
        }

        // 4) For offer/answer we must avoid sending to multiple sockets (causes state mismatch).
        //    Pick the best single candidate (first one) and emit only to that socket.
        const singleTargetEvents = new Set(["webrtc-offer", "webrtc-answer"]);
        if (singleTargetEvents.has(eventName)) {
          const targetSid = candidateSids[0];
          if (targetSid) {
            io.to(targetSid).emit(eventName, payload);
            return true;
          }
          return false;
        }

        // 5) For other events (ice/hangup), emit to all candidate sockets (useful for multi-device)
        for (const sid of candidateSids) {
          try {
            io.to(sid).emit(eventName, payload);
          } catch (e) {
            // ignore single-sid failures
          }
        }
        return true;
      } catch (e) {
        console.error("relayToSocketOrUser error:", e);
        return false;
      }
    }

    socket.on("webrtc-offer", ({ roomId, toSocketId, offer }) => {
      try {
        const payload = { fromSocketId: socket.id, offer };
        if (toSocketId) {
          // explicit socket/user target provided by client
          relayToSocketOrUser(toSocketId, "webrtc-offer", payload, roomId);
          return;
        }
        if (roomId && rooms[roomId]) {
          const opponent = (rooms[roomId].players || []).find(
            (p) => p.id !== socket.id && (p.color === "w" || p.color === "b")
          );
          if (opponent && opponent.id) {
            relayToSocketOrUser(opponent.id, "webrtc-offer", payload, roomId);
          }
        }
      } catch (e) {
        console.error("webrtc-offer relay error:", e);
      }
    });

    socket.on("webrtc-answer", ({ roomId, toSocketId, answer }) => {
      try {
        const payload = { fromSocketId: socket.id, answer };
        if (toSocketId) {
          relayToSocketOrUser(toSocketId, "webrtc-answer", payload, roomId);
          return;
        }
        if (roomId && rooms[roomId]) {
          const opponent = (rooms[roomId].players || []).find(
            (p) => p.id !== socket.id && (p.color === "w" || p.color === "b")
          );
          if (opponent && opponent.id) {
            relayToSocketOrUser(opponent.id, "webrtc-answer", payload, roomId);
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
          relayToSocketOrUser(toSocketId, "webrtc-ice", payload, roomId);
          return;
        }
        if (roomId && rooms[roomId]) {
          const opponent = (rooms[roomId].players || []).find(
            (p) => p.id !== socket.id && (p.color === "w" || p.color === "b")
          );
          if (opponent && opponent.id) {
            // ICE can be useful to multiple sockets for that user, so allow multi-target relay
            relayToSocketOrUser(opponent.id, "webrtc-ice", payload, roomId);
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
          relayToSocketOrUser(toSocketId, "webrtc-hangup", payload, roomId);
          return;
        }
        if (roomId && rooms[roomId]) {
          const opponent = (rooms[roomId].players || []).find(
            (p) => p.id !== socket.id && (p.color === "w" || p.color === "b")
          );
          if (opponent && opponent.id) {
            relayToSocketOrUser(opponent.id, "webrtc-hangup", payload, roomId);
          }
        }
      } catch (e) {
        console.error("webrtc-hangup relay error:", e);
      }
    });
  }, // end registerAll
};
