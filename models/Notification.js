const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true }, // recipient
    type: { type: String, required: true }, // e.g. friend_request, draw_offer, rematch, challenge, etc.
    title: { type: String, default: null },
    body: { type: String, default: null },
    data: { type: Object, default: {} }, // structured payload (reqId, roomId, fromUserId, challengeId...)
    fromUserId: { type: String, default: null },
    read: { type: Boolean, default: false },
    status: { type: String, default: null }, // e.g. 'accepted', 'declined', 'accepted_partial', ...
    deliveredAt: { type: Number, default: null },
    createdAt: { type: Number, default: () => Date.now() },
    updatedAt: { type: Number, default: () => Date.now() },
  },
  { timestamps: false }
);

NotificationSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports =
  mongoose.models.Notification ||
  mongoose.model("Notification", NotificationSchema);
