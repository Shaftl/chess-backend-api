// backend/models/User.js
const mongoose = require("mongoose");

const FriendSchema = new mongoose.Schema({
  id: { type: String },
  username: { type: String },
  addedAt: { type: Date, default: Date.now },
});

const FriendRequestSchema = new mongoose.Schema({
  reqId: { type: String, required: true, unique: true },
  fromUserId: { type: String, required: true },
  fromUsername: { type: String },
  ts: { type: Number, default: () => Date.now() },
  status: { type: String, default: "pending" }, // 'pending', 'accepted', 'declined'
});

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },

  // profile fields
  displayName: { type: String },
  avatarUrl: { type: String },
  bio: { type: String },
  country: { type: String },
  cups: { type: Number, default: 0 },

  // friendship
  friends: { type: [FriendSchema], default: [] },
  incomingFriendRequests: { type: [FriendRequestSchema], default: [] },

  // persist last known IP (set on register)
  lastIp: { type: String, default: null },

  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("User", UserSchema);
