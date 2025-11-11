// scripts/fixFriendRequests.js
const mongoose = require("mongoose");
const User = require("../models/User"); // adjust path if needed
const { v4: uuidv4 } = require("uuid");

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/chessapp";
  await mongoose.connect(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  const users = await User.find({}).lean();
  let fixed = 0;

  for (const u of users) {
    let changed = false;
    const seen = new Set();
    const newIncoming = (u.incomingFriendRequests || []).map((fr) => {
      // ensure reqId present
      if (!fr.reqId || typeof fr.reqId !== "string" || fr.reqId.trim() === "") {
        fr.reqId = uuidv4();
        changed = true;
      }
      // if duplicate (within doc) or already seen across doc, give new id
      if (seen.has(fr.reqId)) {
        fr.reqId = uuidv4();
        changed = true;
      }
      seen.add(fr.reqId);
      return fr;
    });

    if (changed) {
      await User.updateOne(
        { _id: u._id },
        { $set: { incomingFriendRequests: newIncoming } }
      );
      fixed++;
    }
  }

  console.log(`Fixed ${fixed} user documents`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
