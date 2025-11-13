const mongoose = require("mongoose");

const FriendSchema = new mongoose.Schema({
  id: { type: String },
  username: { type: String },
  addedAt: { type: Date, default: Date.now },
});

const FriendRequestSchema = new mongoose.Schema({
  reqId: {
    type: String,
    required: true,
    default: () => new mongoose.Types.ObjectId().toString(),
  },
  fromUserId: { type: String, required: true },
  fromUsername: { type: String },
  ts: { type: Number, default: () => Date.now() },
  status: { type: String, default: "pending" },
});

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },

  displayName: { type: String },
  avatarUrl: { type: String },

  bio: { type: String },
  country: { type: String },
  cups: { type: Number, default: 0 },

  dob: { type: Date, default: null },

  friends: { type: [FriendSchema], default: [] },
  incomingFriendRequests: { type: [FriendRequestSchema], default: [] },

  lastIp: { type: String, default: null },

  // NEW: persistent single-active-room guard

  // NEW: user's current session id (string). Used to invalidate old JWTs when user logs in again.
  currentSession: { type: String, default: null },

  // NEW: simple status: 'idle' | 'playing' | other states you may add later

  createdAt: { type: Date, default: Date.now },
});

UserSchema.pre("save", function (next) {
  if (this.dob && this.dob instanceof Date) {
    const now = new Date();
    if (this.dob > now) this.dob = null;
  }
  next();
});

module.exports = mongoose.model("User", UserSchema);
