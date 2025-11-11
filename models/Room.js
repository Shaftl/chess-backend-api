// backend/src/models/Room.js
const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema({
  id: String,
  text: String,
  ts: Number,
  user: {
    id: String,
    username: String,
    displayName: String,
    avatarUrl: String,
  },
});

const PlayerSchema = new mongoose.Schema({
  id: String,
  user: {
    id: String,
    username: String,
    displayName: String,
    avatarUrl: String,
    avatarUrlAbsolute: String,
    country: String,
  },
  color: String,
  online: Boolean,
  disconnectedAt: Number,
});

const RoomSchema = new mongoose.Schema(
  {
    roomId: { type: String, unique: true, required: true },
    fen: String,
    moves: [{ index: Number, move: Object }],
    lastIndex: { type: Number, default: -1 },
    players: { type: [PlayerSchema], default: [] },
    clocks: {
      w: Number,
      b: Number,
      running: String,
      lastTick: Number,
    },
    settings: { type: Object, default: {} },
    messages: { type: [MessageSchema], default: [] },
    finished: { type: Object, default: null },
    rematch: { type: Object, default: null },
    pendingDrawOffer: { type: Object, default: null },
    createdAt: { type: Date, default: () => new Date() },
    updatedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

RoomSchema.index({ updatedAt: -1 });

module.exports = mongoose.models.Room || mongoose.model("Room", RoomSchema);
