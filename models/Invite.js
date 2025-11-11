const mongoose = require("mongoose");

const InviteSchema = new mongoose.Schema(
  {
    fromUserId: { type: String, required: true },
    fromUsername: { type: String },
    toUserId: { type: String, required: true },
    toUsername: { type: String },
    minutes: { type: Number, default: 5 },
    colorPreference: { type: String, default: "random" },
    status: { type: String, default: "pending" }, // pending | accepted | declined
    roomId: { type: String, default: null }, // filled if a room was created on accept
    createdAt: { type: Number, default: () => Date.now() },
    updatedAt: { type: Number, default: () => Date.now() },
    acceptedAt: { type: Number, default: null },
    declinedAt: { type: Number, default: null },
  },
  { timestamps: false }
);

InviteSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports =
  mongoose.models.Invite || mongoose.model("Invite", InviteSchema);
