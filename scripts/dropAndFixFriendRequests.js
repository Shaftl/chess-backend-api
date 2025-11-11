// scripts/dropAndFixFriendRequests.js
const mongoose = require("mongoose");
const path = require("path");

// adjust path if your models are in a different relative location
const User = require(path.join(__dirname, "..", "backend", "models", "User"));

async function dropIndexIfExists() {
  const coll = mongoose.connection.db.collection("users");
  const idxs = await coll.indexes(); // returns array
  // find index that has the key incomingFriendRequests.reqId
  const target = idxs.find((i) =>
    Object.keys(i.key || {}).some((k) => k === "incomingFriendRequests.reqId")
  );
  if (target) {
    console.log("Found index:", target.name, "- dropping it...");
    await coll.dropIndex(target.name);
    console.log("Dropped index:", target.name);
  } else {
    console.log("No index on incomingFriendRequests.reqId found.");
  }
}

async function fixUsers() {
  const users = await User.find().exec();
  let fixedCount = 0;
  for (const u of users) {
    const arr = u.incomingFriendRequests || [];
    let changed = false;
    const seen = new Set();

    for (let i = 0; i < arr.length; i++) {
      const fr = arr[i];
      // if missing/empty/null => assign a new id
      if (
        !fr ||
        !fr.reqId ||
        typeof fr.reqId !== "string" ||
        fr.reqId.trim() === ""
      ) {
        arr[i] = {
          ...fr,
          reqId: new mongoose.Types.ObjectId().toString(),
        };
        changed = true;
      }
      // if duplicate within same user's array -> reassign
      if (seen.has(arr[i].reqId)) {
        arr[i].reqId = new mongoose.Types.ObjectId().toString();
        changed = true;
      }
      seen.add(arr[i].reqId);
    }

    if (changed) {
      u.incomingFriendRequests = arr;
      await u.save();
      fixedCount++;
    }
  }
  console.log(
    `Patched ${fixedCount} user(s) (assigned missing/duplicate reqId values).`
  );
}

async function main() {
  try {
    const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/chessapp";
    console.log("Connecting to", uri);
    await mongoose.connect(uri);
    console.log("Connected to MongoDB.");

    await dropIndexIfExists();
    await fixUsers();

    await mongoose.disconnect();
    console.log("Done. Disconnected.");
    process.exit(0);
  } catch (err) {
    console.error("Script error:", err);
    process.exit(1);
  }
}

main();
