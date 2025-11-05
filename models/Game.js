// backend/models/Game.js
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

const GameSchema = new mongoose.Schema({
  roomId: { type: String, unique: true, required: true },
  fen: String,
  moves: [{ index: Number, move: Object }],
  players: [
    {
      id: String,
      user: { id: String, username: String },
      color: String,
      online: Boolean,
    },
  ],
  clocks: {
    w: Number,
    b: Number,
    running: String,
  },
  messages: [MessageSchema],
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Game", GameSchema);
