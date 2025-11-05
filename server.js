// backend/server.js
require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");
const jwt = require("jsonwebtoken");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const authRoutes = require("./routes/auth");
const gameRoutes = require("./routes/game");
const Game = require("./models/Game");
const User = require("./models/User");

const {
  fetchGeoForIp,
  normalizeIp,
  isLoopbackOrLocal,
} = require("./helpers/geo");

const app = express();
const server = http.createServer(app);

const CLIENT_ORIGIN = process.env.SOCKET_ORIGIN || "http://localhost:3000";

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

// IMPORTANT: trust proxy so req.ip/x-forwarded-for work when behind a proxy/load-balancer
app.set("trust proxy", true);

// uploads directory
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Serve uploaded files from both /uploads and /api/uploads so frontends using either path work
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/api/uploads", express.static(UPLOADS_DIR));

app.use("/api/auth", authRoutes);
app.use("/api/game", gameRoutes);

mongoose
  .connect(process.env.MONGODB_URI || "mongodb://localhost:27017/chessapp", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("Mongo connect error", err));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const safe = file.originalname
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_.-]/g, "");
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({ storage });

// ---------- helpers for IP detection & geo (used by REST middleware) ----------
function detectClientIpFromReq(req) {
  const hdrs = [
    "x-client-ip",
    "x-forwarded-for",
    "x-real-ip",
    "cf-connecting-ip",
    "true-client-ip",
    "fastly-client-ip",
    "x-cluster-client-ip",
    "forwarded",
  ];

  for (const h of hdrs) {
    const v = req.headers[h];
    if (!v) continue;
    const first = v.split(",")[0].trim();
    const ip = normalizeIp(first);
    if (ip) return ip;
  }

  if (req.ip) {
    const ip = normalizeIp(req.ip);
    if (ip) return ip;
  }

  const sockIp =
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    (req.socket?.address && typeof req.socket.address === "function"
      ? req.socket.address().address
      : null) ||
    null;
  if (sockIp) {
    const ip = normalizeIp(sockIp);
    if (ip) return ip;
  }

  return "";
}

async function updateUserIpIfChangedFromReq(req, userId) {
  try {
    const detected = detectClientIpFromReq(req); // may be "" or loopback
    const geo = await fetchGeoForIp(detected);
    const ipToSave = geo.ip || (detected ? detected : null);
    if (!ipToSave) return;

    const u = await User.findById(userId).exec();
    if (!u) return;
    if (u.lastIp && u.lastIp === ipToSave) return; // no change

    if (ipToSave) u.lastIp = ipToSave;
    if (geo.country) u.country = geo.country;
    await u.save();
  } catch (err) {
    console.error("updateUserIpIfChangedFromReq error", err);
  }
}
// ---------- end helpers ----------

// simple express auth middleware (same jwt secret as sockets)
// UPDATED: verify token AND update user's lastIp/country if it changed
async function restAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing auth" });
  const parts = authHeader.split(" ");
  if (parts.length !== 2)
    return res.status(401).json({ error: "Invalid auth header" });
  const token = parts[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    // try to update DB user ip/country (awaited so subsequent handlers see updated values)
    try {
      await updateUserIpIfChangedFromReq(req, decoded.id);
    } catch (err) {
      console.error("restAuthMiddleware IP update error", err);
    }

    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// upload avatar endpoint (multipart/form-data, field name 'avatar')
app.post(
  "/api/auth/upload-avatar",
  restAuthMiddleware,
  upload.single("avatar"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const u = await User.findById(req.user.id);
      if (!u) return res.status(404).json({ error: "User not found" });
      // store relative URL
      const rel = `/uploads/${req.file.filename}`;
      u.avatarUrl = rel;
      await u.save();

      // return both relative (for DB) and absolute (helpful for clients)
      const base =
        process.env.BACKEND_BASE_URL ||
        `http://localhost:${process.env.PORT || 4000}`;
      const abs = `${base}${rel}`;

      res.json({ avatarUrl: rel, avatarUrlAbsolute: abs });
    } catch (err) {
      console.error("upload-avatar error", err);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

/**
 rooms[roomId] = { ... }
**/
const rooms = {};
const DEFAULT_MS = 5 * 60 * 1000;
const DISCONNECT_GRACE_MS = 10 * 1000;
const FIRST_MOVE_TIMEOUT_MS = 30 * 1000;
const MAX_CHAT_MESSAGES = 500;

const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN },
});

function verifyToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded;
  } catch (e) {
    return null;
  }
}

/**
 * generateRoomCode(len) - short unique-ish code
 */
function generateRoomCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * assignColorsForRematch(room)
 * For a rematch, preserve colors for players who were colored; if not enough, assign first two
 */
function assignColorsForRematch(room) {
  if (!room || !room.players) return;
  // keep existing colors for players that had w/b, otherwise assign by presence order
  const hadW = room.players.find((p) => p.color === "w");
  const hadB = room.players.find((p) => p.color === "b");
  if (hadW && hadB) {
    // keep as-is for players who previously had colors
    room.players.forEach((p) => {
      if (p.color !== "w" && p.color !== "b") p.color = "spectator";
    });
    return;
  }

  // Otherwise assign first two present as w & b
  for (const p of room.players) p.color = "spectator";
  if (room.players.length >= 1) room.players[0].color = "w";
  if (room.players.length >= 2) room.players[1].color = "b";
}

/**
 * broadcastRoomState(roomId)
 * includes pendingDrawOffer and chat messages (limited)
 */
function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // Build pendingDrawOffer payload (if any) with minimal user info
  let pending = null;
  if (room.pendingDrawOffer) {
    let offerer = null;
    if (room.pendingDrawOffer.fromUserId) {
      offerer = room.players.find(
        (p) => p.user && p.user.id === room.pendingDrawOffer.fromUserId
      );
    }
    if (!offerer && room.pendingDrawOffer.fromSocketId) {
      offerer = room.players.find(
        (p) => p.id === room.pendingDrawOffer.fromSocketId
      );
    }
    if (offerer && offerer.user) {
      const u = offerer.user;
      pending = {
        from: {
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          avatarUrl: u.avatarUrl || u.avatarUrlAbsolute || u.avatar || null,
        },
      };
    }
  }

  // rematch info
  let rematch = null;
  if (room.rematch) {
    rematch = {
      initiatorSocketId: room.rematch.initiatorSocketId || null,
      initiatorUserId: room.rematch.initiatorUserId || null,
      acceptedBy: room.rematch.acceptedBy
        ? Object.keys(room.rematch.acceptedBy)
        : [],
    };
  }

  // limit chat messages to most recent MAX_CHAT_MESSAGES
  const msgs = (room.messages || []).slice(
    -Math.min(MAX_CHAT_MESSAGES, room.messages.length)
  );

  io.to(roomId).emit("room-update", {
    players: room.players.map((p) => ({
      id: p.id,
      user: p.user,
      color: p.color,
      online: !!p.online,
    })),
    moves: room.moves,
    fen: room.chess ? room.chess.fen() : room.fen,
    lastIndex: room.lastIndex,
    clocks: room.clocks
      ? { w: room.clocks.w, b: room.clocks.b, running: room.clocks.running }
      : null,
    finished: room.finished || null,
    pendingDrawOffer: pending,
    settings: room.settings || null,
    messages: msgs,
    pendingRematch: rematch,
  });
}

function clearDisconnectTimer(room, socketId) {
  if (!room || !room.disconnectTimers) return;
  const t = room.disconnectTimers[socketId];
  if (t) {
    clearTimeout(t);
    delete room.disconnectTimers[socketId];
  }
}

function clearFirstMoveTimer(room) {
  if (!room) return;
  if (room.firstMoveTimer) {
    clearTimeout(room.firstMoveTimer);
    room.firstMoveTimer = null;
  }
}

async function saveFinishedGame(roomId) {
  try {
    const room = rooms[roomId];
    if (!room || !room.finished) return;
    const savedId = `${roomId}-${Date.now()}`;
    const doc = new Game({
      roomId: savedId,
      fen: room.fen || (room.chess ? room.chess.fen() : null),
      moves: room.moves || [],
      players: (room.players || []).map((p) => ({
        id: p.user?.id || p.id,
        user: p.user || { username: p.user?.username || "guest" },
        color: p.color,
        online: !!p.online,
      })),
      clocks: room.clocks
        ? { w: room.clocks.w, b: room.clocks.b, running: room.clocks.running }
        : null,
      messages: room.messages || [],
      createdAt: room.finished.finishedAt
        ? new Date(room.finished.finishedAt)
        : new Date(),
    });
    await doc.save();
    console.log("Saved finished game to Mongo:", savedId);
  } catch (err) {
    console.error("Error saving finished game to Mongo:", err);
  }
}

function scheduleFirstMoveTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.lastIndex !== -1 || room.finished) return;
  clearFirstMoveTimer(room);
  const turn = room.chess ? room.chess.turn() : null;
  if (!turn) return;
  room.firstMoveTimer = setTimeout(async () => {
    if (room.lastIndex === -1 && !room.paused && !room.finished) {
      room.paused = true;
      room.finished = {
        reason: "first-move-timeout",
        result: "draw",
        message: `No first move within ${
          FIRST_MOVE_TIMEOUT_MS / 1000
        }s — game drawn`,
        finishedAt: Date.now(),
      };
      io.to(roomId).emit("game-over", { ...room.finished });
      broadcastRoomState(roomId);
      await saveFinishedGame(roomId);
    }
    room.firstMoveTimer = null;
  }, FIRST_MOVE_TIMEOUT_MS);
}

// ----------------- NEW: online users & challenge/friend maps -----------------
/**
 * onlineUsers: { [userId]: { sockets: Set(socketId), username } }
 * pendingChallenges: { [challengeId]: { fromSocketId, toUserId, minutes, colorPreference } }
 * pendingFriendRequests: { [reqId]: { fromUserId, toUserId } }
 */
const onlineUsers = {};
const pendingChallenges = {};
const pendingFriendRequests = {};

function addOnlineSocketForUser(userId, socketId, username) {
  if (!userId) return;
  onlineUsers[userId] = onlineUsers[userId] || { sockets: new Set(), username };
  onlineUsers[userId].sockets.add(socketId);
  onlineUsers[userId].username = username || onlineUsers[userId].username;
}

function removeOnlineSocketForUser(userId, socketId) {
  if (!userId || !onlineUsers[userId]) return;
  onlineUsers[userId].sockets.delete(socketId);
  if (onlineUsers[userId].sockets.size === 0) {
    delete onlineUsers[userId];
  }
}

function getSocketsForUserId(userId) {
  if (!userId || !onlineUsers[userId]) return [];
  return Array.from(onlineUsers[userId].sockets);
}
// ---------------------------------------------------------------------------

// global tick
let lastGlobalTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const delta = now - lastGlobalTick;
  lastGlobalTick = now;

  Object.keys(rooms).forEach((roomId) => {
    const room = rooms[roomId];
    if (!room || !room.clocks || !room.clocks.running || room.paused) return;

    const running = room.clocks.running;
    room.clocks[running] = Math.max(0, room.clocks[running] - delta);
    room.clocks.lastTick = now;

    io.to(roomId).emit("clock-update", {
      w: room.clocks.w,
      b: room.clocks.b,
      running: room.clocks.running,
    });

    if (room.clocks[running] <= 0 && !room.finished) {
      const winner = running === "w" ? "b" : "w";
      room.paused = true;
      room.clocks.running = null;
      room.finished = {
        reason: "timeout",
        winner,
        loser: running,
        message: `${winner.toUpperCase()} wins by timeout`,
        finishedAt: Date.now(),
      };
      io.to(roomId).emit("game-over", { ...room.finished });
      clearFirstMoveTimer(room);
      Object.keys(room.disconnectTimers || {}).forEach((sid) =>
        clearDisconnectTimer(room, sid)
      );
      broadcastRoomState(roomId);
      saveFinishedGame(roomId).catch(() => {});
    }
  });
}, 500);

// ----------------- REST: players list (new) -----------------
app.get("/api/players", async (req, res) => {
  try {
    // return all users with online flag
    const users = await User.find().select("-passwordHash -__v").lean();
    const list = users.map((u) => ({
      id: u._id.toString(),
      username: u.username,
      displayName: u.displayName || null,
      avatarUrl: u.avatarUrl || null,
      country: u.country || null,
      cups: u.cups || 0,
      online: !!onlineUsers[u._id?.toString()],
      friends: u.friends || [],
    }));
    res.json(list);
  } catch (err) {
    console.error("GET /api/players error", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------- socket handling -----------------
io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  const token = socket.handshake.auth && socket.handshake.auth.token;
  const decodedUser = verifyToken(token);
  if (decodedUser) {
    socket.user = { id: decodedUser.id, username: decodedUser.username };
    addOnlineSocketForUser(decodedUser.id, socket.id, decodedUser.username);
  } else {
    socket.user = null;
  }

  //
  // CREATE ROOM
  //
  socket.on(
    "create-room",
    ({ roomId: requestedRoomId, minutes, colorPreference, user }) => {
      try {
        let minutesNum =
          typeof minutes === "number"
            ? Math.max(1, Math.floor(minutes))
            : Math.floor(DEFAULT_MS / 60000);
        const minutesMs = minutesNum * 60 * 1000;

        // choose or generate roomId, ensure uniqueness
        let roomId =
          requestedRoomId && String(requestedRoomId).trim()
            ? String(requestedRoomId).trim()
            : generateRoomCode();
        if (rooms[roomId]) {
          for (let i = 0; i < 6 && rooms[roomId]; i++)
            roomId = generateRoomCode();
          if (rooms[roomId]) {
            socket.emit("room-created", {
              ok: false,
              error: "Unable to create unique room",
            });
            return;
          }
        }

        // initialize room
        rooms[roomId] = {
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

        // create player object for creator and auto-assign a color based on preference
        let assignedColor = "spectator";
        if (socket.user) {
          const playerObj = {
            id: socket.id,
            user: socket.user || user || { username: "guest" },
            color: "spectator",
            online: true,
            disconnectedAt: null,
          };

          const pref = room.settings.colorPreference;
          const wTaken = room.players.some((p) => p.color === "w");
          const bTaken = room.players.some((p) => p.color === "b");

          if (pref === "white" && !wTaken) assignedColor = "w";
          else if (pref === "black" && !bTaken) assignedColor = "b";
          else {
            if (!wTaken) assignedColor = "w";
            else if (!bTaken) assignedColor = "b";
            else assignedColor = "spectator";
          }

          playerObj.color = assignedColor;
          room.players.push(playerObj);
          socket.emit("player-assigned", { color: playerObj.color });
        } else {
          const playerObj = {
            id: socket.id,
            user: user || { username: "guest" },
            color: "spectator",
            online: true,
            disconnectedAt: null,
          };
          room.players.push(playerObj);
          assignedColor = "spectator";
          socket.emit("player-assigned", { color: "spectator" });
        }

        // no clocks yet, will start when two players join and are colored
        broadcastRoomState(roomId);

        socket.join(roomId);
        socket.emit("room-created", {
          ok: true,
          roomId,
          settings: room.settings,
          assignedColor,
        });
        console.log(
          "Room created:",
          roomId,
          "by",
          socket.user?.username || socket.id
        );
      } catch (err) {
        console.error("create-room error", err);
        socket.emit("room-created", { ok: false, error: "Server error" });
      }
    }
  );

  //
  // JOIN ROOM
  //
  socket.on("join-room", ({ roomId, user }) => {
    if (!roomId) return;
    socket.join(roomId);

    rooms[roomId] = rooms[roomId] || {
      players: [],
      moves: [],
      chess: null,
      fen: null,
      lastIndex: -1,
      clocks: null,
      paused: false,
      disconnectTimers: {},
      firstMoveTimer: null,
      pendingDrawOffer: null,
      finished: null,
      settings: null,
      messages: [],
      rematch: null,
    };

    const room = rooms[roomId];

    if (!room.chess) {
      room.chess = room.fen ? new Chess(room.fen) : new Chess();
      room.fen = room.chess.fen();
      room.lastIndex = room.moves.length
        ? room.moves[room.moves.length - 1].index
        : -1;
    }

    let existing = null;
    if (socket.user && socket.user.id) {
      existing = room.players.find(
        (p) => p.user && p.user.id === socket.user.id
      );
    }
    if (!existing) existing = room.players.find((p) => p.id === socket.id);

    if (existing) {
      clearDisconnectTimer(room, existing.id);
      existing.id = socket.id;
      existing.user = socket.user ||
        existing.user ||
        user || { username: "guest" };
      existing.online = true;
      existing.disconnectedAt = null;
    } else {
      let assignedColor = "spectator";
      if (socket.user) {
        const wTaken = room.players.some((p) => p.color === "w");
        const bTaken = room.players.some((p) => p.color === "b");
        if (!wTaken) assignedColor = "w";
        else if (!bTaken) assignedColor = "b";
        else assignedColor = "spectator";
      } else {
        assignedColor = "spectator";
      }

      const playerObj = {
        id: socket.id,
        user: socket.user || user || { username: "guest" },
        color: assignedColor,
        online: true,
        disconnectedAt: null,
      };
      room.players.push(playerObj);
      socket.emit("player-assigned", { color: playerObj.color });
    }

    clearDisconnectTimer(room, socket.id);

    const coloredPlayers = room.players.filter(
      (p) => p.color === "w" || p.color === "b"
    );

    // If room has configured time settings, use those for clocks
    if (!room.clocks && !room.finished) {
      if (coloredPlayers.length === 2) {
        const minutes =
          room.settings?.minutes || Math.floor(DEFAULT_MS / 60000);
        const ms = room.settings?.minutesMs || minutes * 60 * 1000;
        room.clocks = {
          w: ms,
          b: ms,
          running: room.chess.turn(),
          lastTick: Date.now(),
        };
        scheduleFirstMoveTimer(roomId);
      }
    } else {
      if (
        coloredPlayers.length === 2 &&
        !room.clocks?.running &&
        !room.finished
      ) {
        room.clocks.running = room.chess.turn();
        room.clocks.lastTick = Date.now();
        room.paused = false;
        scheduleFirstMoveTimer(roomId);
      }
    }

    broadcastRoomState(roomId);

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
  });

  //
  // MAKE MOVE
  //
  socket.on("make-move", ({ roomId, move }) => {
    if (!roomId || !move) return;
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
    const result = chess.move(move);
    if (!result) {
      socket.emit("invalid-move", { reason: "illegal move on server", move });
      socket.emit("room-update", {
        players: room.players.map((p) => ({
          id: p.id,
          user: p.user,
          color: p.color,
          online: !!p.online,
        })),
        moves: room.moves,
        fen: chess.fen(),
        lastIndex: room.lastIndex,
        clocks: room.clocks
          ? { w: room.clocks.w, b: room.clocks.b, running: room.clocks.running }
          : null,
        finished: room.finished || null,
        messages: (room.messages || []).slice(
          -Math.min(MAX_CHAT_MESSAGES, room.messages.length)
        ),
      });
      return;
    }

    room.lastIndex = (room.lastIndex ?? -1) + 1;
    const record = { index: room.lastIndex, move };
    room.moves.push(record);
    room.fen = chess.fen();

    clearFirstMoveTimer(room);

    if (!room.clocks) {
      room.clocks = {
        w: DEFAULT_MS,
        b: DEFAULT_MS,
        running: chess.turn(),
        lastTick: Date.now(),
      };
    } else {
      room.clocks.running = chess.turn();
      room.clocks.lastTick = Date.now();
    }

    if (room.pendingDrawOffer) {
      if (
        room.pendingDrawOffer.fromSocketId === player.id ||
        (player.user && room.pendingDrawOffer.fromUserId === player.user.id)
      ) {
        room.pendingDrawOffer = null;
      }
    }

    socket.to(roomId).emit("opponent-move", {
      ...record,
      fen: room.fen,
      clocks: {
        w: room.clocks.w,
        b: room.clocks.b,
        running: room.clocks.running,
      },
    });
    broadcastRoomState(roomId);
  });

  //
  // RESIGN
  //
  socket.on("resign", async ({ roomId }) => {
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    const playerIdx = room.players.findIndex((p) => p.id === socket.id);
    if (playerIdx === -1) return;
    const player = room.players[playerIdx];

    if (player.color === "w" || player.color === "b") {
      const winnerColor = player.color === "w" ? "b" : "w";
      room.paused = true;
      room.clocks && (room.clocks.running = null);
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
      await saveFinishedGame(roomId);
    }

    room.players = room.players.filter((p) => p.id !== socket.id);
    broadcastRoomState(roomId);
  });

  //
  // OFFER DRAW
  //
  socket.on("offer-draw", ({ roomId }) => {
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
      // send direct event to opponent socket so they can show modal immediately
      io.to(opponent.id).emit("draw-offered", { from: player.user });
    }
    broadcastRoomState(roomId);
  });

  //
  // ACCEPT DRAW
  //
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
    room.clocks && (room.clocks.running = null);
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
  });

  //
  // DECLINE DRAW
  //
  socket.on("decline-draw", ({ roomId }) => {
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    room.pendingDrawOffer = null;
    broadcastRoomState(roomId);
  });

  //
  // CHAT: send-chat
  //
  socket.on("send-chat", ({ roomId, text }) => {
    try {
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room) return;
      if (!text || typeof text !== "string") return;
      const trimmed = text.trim().slice(0, 2000); // limit length
      if (!trimmed) return;

      const msg = {
        id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        text: trimmed,
        ts: Date.now(),
        user: socket.user || { username: socket.user?.username || "guest" },
      };

      room.messages = room.messages || [];
      room.messages.push(msg);
      // cap messages
      if (room.messages.length > MAX_CHAT_MESSAGES) {
        room.messages = room.messages.slice(-MAX_CHAT_MESSAGES);
      }

      // emit to room and broadcast full state
      io.to(roomId).emit("chat-message", msg);
      broadcastRoomState(roomId);
    } catch (err) {
      console.error("send-chat error", err);
    }
  });

  //
  // PLAYER TIMEOUT (external trigger)
  //
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
      room.clocks.running = null;
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

  //
  // REQUEST SYNC
  //
  socket.on("request-sync", ({ roomId }) => {
    if (!roomId || !rooms[roomId]) {
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
    const r = rooms[roomId];
    socket.emit("room-update", {
      players: r.players.map((p) => ({
        id: p.id,
        user: p.user,
        color: p.color,
        online: !!p.online,
      })),
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
              avatarUrl: u.avatarUrl || u.avatarUrlAbsolute || u.avatar || null,
            },
          };
        }
        return null;
      })(),
      settings: r.settings || null,
      messages: (r.messages || []).slice(
        -Math.min(MAX_CHAT_MESSAGES, r.messages.length)
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

  //
  // LEAVE ROOM
  //
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
      room.clocks && (room.clocks.running = null);
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

    room.players = room.players.filter((p) => p.id !== socket.id);
    broadcastRoomState(roomId);
  });

  //
  // SAVE GAME (client-triggered)
  //
  socket.on("save-game", ({ roomId, fen, moves, players }) => {
    io.to(roomId).emit("game-saved", { ok: true });
  });

  //
  // PLAY AGAIN (offer)
  //
  socket.on("play-again", ({ roomId }) => {
    try {
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room) return;

      // only create rematch if there is a finished game (or at least moves)
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

      // create or update rematch state and mark initiator as accepted immediately
      room.rematch = room.rematch || {
        initiatorSocketId: socket.id,
        initiatorUserId: player.user?.id || null,
        acceptedBy: {},
      };
      room.rematch.initiatorSocketId = socket.id;
      room.rematch.initiatorUserId = player.user?.id || null;

      // Mark initiator as accepted immediately so opponent's accept completes the rematch.
      room.rematch.acceptedBy = room.rematch.acceptedBy || {};
      room.rematch.acceptedBy[socket.id] = true;

      // notify opponent directly (so the modal shows instantly)
      const opponent = room.players.find(
        (p) => p.color !== player.color && (p.color === "w" || p.color === "b")
      );
      if (opponent) {
        io.to(opponent.id).emit("rematch-offered", {
          from: player.user || { username: "Guest" },
        });
      }

      // ack to offerer (offer created but not started)
      socket.emit("play-again", {
        ok: true,
        started: false,
        message: "Rematch requested",
      });

      // broadcast so UIs can show pendingRematch
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

  //
  // ACCEPT PLAY AGAIN
  //
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

      // Determine required acceptors: require the two colored players to accept.
      const coloredPlayers = room.players.filter(
        (p) => p.color === "w" || p.color === "b"
      );
      const coloredIds = coloredPlayers.map((p) => p.id).filter(Boolean);

      // Build accepted keys list
      const acceptedKeys = Object.keys(room.rematch.acceptedBy || {});

      // If there are 2 colored players require both; if there's only 1 colored player (rare) require initiator + that player
      let required = [];
      if (coloredIds.length === 2) {
        required = coloredIds;
      } else if (coloredIds.length === 1) {
        // require the colored player and the initiator (avoid requiring someone not present)
        required = Array.from(
          new Set([room.rematch.initiatorSocketId, coloredIds[0]])
        ).filter(Boolean);
      } else {
        // fallback: require initiator only
        required = [room.rematch.initiatorSocketId].filter(Boolean);
      }

      // Ensure required is non-empty and all required have accepted
      const allAccepted =
        required.length > 0 &&
        required.every((id) => acceptedKeys.includes(id));

      if (allAccepted) {
        // Reassign colors (preserve colored players if possible)
        assignColorsForRematch(room);

        // Reset the game state
        room.chess = new Chess();
        room.fen = room.chess.fen();
        room.moves = [];
        room.lastIndex = -1;
        room.finished = null;
        room.pendingDrawOffer = null;
        room.paused = false;

        // Reset clocks if present in settings or fallback
        if (room.settings && room.settings.minutesMs) {
          const ms = room.settings.minutesMs;
          room.clocks = {
            w: ms,
            b: ms,
            running: room.chess.turn(),
            lastTick: Date.now(),
          };
        } else {
          room.clocks = room.clocks
            ? {
                w: DEFAULT_MS,
                b: DEFAULT_MS,
                running: room.chess.turn(),
                lastTick: Date.now(),
              }
            : null;
        }

        // clear rematch state now we're starting
        room.rematch = null;

        // broadcast new room state
        broadcastRoomState(roomId);

        // signal rematch started to all clients with a clear started:true flag
        io.to(roomId).emit("play-again", {
          ok: true,
          started: true,
          message: "Rematch started",
        });

        // send player-assigned events for clients to immediately set orientation
        for (const p of room.players) {
          io.to(p.id).emit("player-assigned", { color: p.color });
        }

        scheduleFirstMoveTimer(roomId);
      } else {
        // still waiting for the other player(s)
        broadcastRoomState(roomId);
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

  //
  // DECLINE PLAY AGAIN
  //
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
      // clear rematch state
      room.rematch = null;
      broadcastRoomState(roomId);
    } catch (err) {
      console.error("decline-play-again error", err);
    }
  });

  //
  // ------------------ NEW: CHALLENGE (invite) FLOW ------------------
  //
  socket.on(
    "challenge",
    ({ toUserId, minutes = 5, colorPreference = "random" }) => {
      try {
        if (!toUserId) {
          socket.emit("challenge-response", {
            ok: false,
            error: "Missing target",
          });
          return;
        }
        // Must be authenticated to challenge
        if (!socket.user || !socket.user.id) {
          socket.emit("challenge-response", {
            ok: false,
            error: "Auth required",
          });
          return;
        }
        // If target not online, immediate decline
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
          // target offline -> notify initiator
          socket.emit("challenge-declined", { challengeId, reason: "offline" });
          delete pendingChallenges[challengeId];
          return;
        }

        // notify target(s) of incoming challenge (only target should show modal)
        const challengePayload = {
          challengeId,
          from: { id: socket.user.id, username: socket.user.username },
          minutes: pendingChallenges[challengeId].minutes,
          colorPreference: pendingChallenges[challengeId].colorPreference,
        };
        targetSockets.forEach((sid) => {
          io.to(sid).emit("challenge-received", challengePayload);
        });

        // confirm the initiator that challenge was sent (pending)
        socket.emit("challenge-sent", { ok: true, challengeId });
      } catch (err) {
        console.error("challenge error", err);
        socket.emit("challenge-response", { ok: false, error: "Server error" });
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

      // ensure the acceptor is the intended recipient and their socket is current
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
        // initiator disconnected -> decline
        socket.emit("challenge-declined", {
          challengeId,
          reason: "initiator-offline",
        });
        delete pendingChallenges[challengeId];
        return;
      }

      // Create a new room and put both sockets in it
      let roomId = generateRoomCode(8);
      while (rooms[roomId]) roomId = generateRoomCode(8);

      // Create room structure with two players assigned according to colorPreference
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

      // fetch user objects if available
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

      // build player entries (id = socket.id) and assign colors by preference
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

      // apply colorPreference
      if (pending.colorPreference === "white") {
        initiatorPlayer.color = "w";
        acceptorPlayer.color = "b";
      } else if (pending.colorPreference === "black") {
        initiatorPlayer.color = "b";
        acceptorPlayer.color = "w";
      } else {
        // random assign: keep as above or flip randomly
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

      // clocks based on minutes
      room.clocks = {
        w: room.settings.minutesMs,
        b: room.settings.minutesMs,
        running: room.chess.turn(),
        lastTick: Date.now(),
      };

      rooms[roomId] = room;

      // make sure both sockets join the new room
      const initiatorSockObj = io.sockets.sockets.get(pending.fromSocketId);
      const acceptorSockObj = acceptorSocket;
      if (initiatorSockObj) initiatorSockObj.join(roomId);
      if (acceptorSockObj) acceptorSockObj.join(roomId);

      // broadcast room state & notify both users that rematch started (or challenge accepted)
      broadcastRoomState(roomId);

      // emit responses to both participants: include roomId so client can navigate/join
      const payload = {
        ok: true,
        challengeId,
        roomId,
        message: "Challenge accepted — room created",
        assignedColors: {
          [pending.fromUserId]: initiatorPlayer.color,
          [pending.toUserId]: acceptorPlayer.color,
        },
      };
      initiatorSockObj && initiatorSockObj.emit("challenge-accepted", payload);
      acceptorSockObj && acceptorSockObj.emit("challenge-accepted", payload);

      // cleanup pending challenge
      delete pendingChallenges[challengeId];
    } catch (err) {
      console.error("accept-challenge error", err);
      socket.emit("challenge-accept-response", {
        ok: false,
        error: "Server error",
      });
    }
  });

  socket.on("decline-challenge", ({ challengeId }) => {
    try {
      const pending = pendingChallenges[challengeId];
      if (!pending) {
        socket.emit("challenge-decline-response", {
          ok: false,
          error: "No such challenge",
        });
        return;
      }
      // notify initiator if still connected
      const initiatorSocket = io.sockets.sockets.get(pending.fromSocketId);
      if (initiatorSocket) {
        initiatorSocket.emit("challenge-declined", {
          challengeId,
          reason: "opponent-declined",
        });
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

  //
  // ------------------ NEW: FRIEND (simple) FLOW ------------------
  //
  socket.on("send-friend-request", async ({ toUserId }) => {
    try {
      if (!socket.user || !socket.user.id) {
        socket.emit("friend-request-response", {
          ok: false,
          error: "Not authenticated",
        });
        return;
      }
      if (!toUserId) {
        socket.emit("friend-request-response", {
          ok: false,
          error: "Missing target",
        });
        return;
      }

      const fromUserId = socket.user.id;
      const reqId = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      pendingFriendRequests[reqId] = {
        fromUserId,
        toUserId,
        createdAt: Date.now(),
      };

      const targetSockets = getSocketsForUserId(toUserId);
      if (targetSockets.length === 0) {
        socket.emit("friend-request-response", {
          ok: false,
          error: "User offline",
        });
        delete pendingFriendRequests[reqId];
        return;
      }

      // notify recipient(s)
      const payload = {
        reqId,
        from: { id: fromUserId, username: socket.user.username },
      };
      targetSockets.forEach((sid) =>
        io.to(sid).emit("friend-request-received", payload)
      );
      socket.emit("friend-request-response", { ok: true, reqId });
    } catch (err) {
      console.error("send-friend-request error", err);
      socket.emit("friend-request-response", {
        ok: false,
        error: "Server error",
      });
    }
  });

  socket.on("respond-friend-request", async ({ reqId, accept }) => {
    try {
      const req = pendingFriendRequests[reqId];
      if (!req) {
        socket.emit("friend-request-responded", {
          ok: false,
          error: "Request not found",
        });
        return;
      }
      const fromUserId = req.fromUserId;
      const toUserId = req.toUserId;
      if (!socket.user || socket.user.id !== toUserId) {
        socket.emit("friend-request-responded", {
          ok: false,
          error: "Not authorized",
        });
        return;
      }

      const fromSockets = getSocketsForUserId(fromUserId);
      if (accept) {
        // persist friendship minimally: add each other to friends array
        await User.updateOne(
          { _id: fromUserId },
          {
            $addToSet: {
              friends: { id: toUserId, username: socket.user.username },
            },
          }
        ).catch(() => {});
        await User.updateOne(
          { _id: toUserId },
          {
            $addToSet: {
              friends: {
                id: fromUserId,
                username: (await User.findById(fromUserId).lean()).username,
              },
            },
          }
        ).catch(() => {});

        // notify initiator
        fromSockets.forEach((sid) =>
          io
            .to(sid)
            .emit("friend-request-accepted", {
              reqId,
              by: { id: toUserId, username: socket.user.username },
            })
        );
        socket.emit("friend-request-responded", { ok: true, accepted: true });
      } else {
        // notify initiator declined
        fromSockets.forEach((sid) =>
          io
            .to(sid)
            .emit("friend-request-declined", {
              reqId,
              by: { id: toUserId, username: socket.user.username },
            })
        );
        socket.emit("friend-request-responded", { ok: true, accepted: false });
      }

      delete pendingFriendRequests[reqId];
    } catch (err) {
      console.error("respond-friend-request error", err);
      socket.emit("friend-request-responded", {
        ok: false,
        error: "Server error",
      });
    }
  });

  //
  // DISCONNECT
  //
  socket.on("disconnect", () => {
    // remove from onlineUsers map
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
              room.clocks && (room.clocks.running = null);
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
              await saveFinishedGame(rId);
            } else {
              // no online opponent — leave offline
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

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
