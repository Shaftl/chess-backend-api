// backend/socket/applyCups.js
// applyCupsForFinishedRoom moved from your file. Expects context with Game, User, ratingUtils, helpers, etc.

async function applyCupsForFinishedRoom(context, roomId) {
  try {
    if (!roomId) return;

    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    let gameDoc = null;
    const { Game, User } = context;

    // 1) Try: roomId field starts with roomId
    try {
      const re = new RegExp("^" + esc(roomId) + "(?:-|$)");
      gameDoc = await Game.findOne({ roomId: { $regex: re } })
        .sort({ createdAt: -1 })
        .exec();
      if (gameDoc) {
        console.log(
          "[applyCups] found Game by roomId prefix:",
          gameDoc._id?.toString(),
          "roomIdField:",
          gameDoc.roomId
        );
      }
    } catch (e) {
      console.error("[applyCups] lookup by roomId prefix failed:", e);
    }

    if (!gameDoc) {
      try {
        gameDoc = await Game.findOne({ room: roomId })
          .sort({ createdAt: -1 })
          .exec();
        if (gameDoc)
          console.log(
            "[applyCups] found Game by field 'room':",
            gameDoc._id?.toString()
          );
      } catch (e) {}
    }
    if (!gameDoc) {
      try {
        gameDoc = await Game.findOne({ "meta.roomId": roomId })
          .sort({ createdAt: -1 })
          .exec();
        if (gameDoc)
          console.log(
            "[applyCups] found Game by field 'meta.roomId':",
            gameDoc._id?.toString()
          );
      } catch (e) {}
    }

    if (!gameDoc) {
      try {
        const reId = new RegExp("^" + esc(roomId) + "-");
        gameDoc = await Game.findOne({ _id: { $regex: reId } })
          .sort({ createdAt: -1 })
          .exec();
        if (gameDoc)
          console.log(
            "[applyCups] found Game by _id prefix:",
            gameDoc._id?.toString()
          );
      } catch (e) {
        console.error("[applyCups] lookup by _id prefix failed:", e);
      }
    }

    if (!gameDoc) {
      try {
        gameDoc = await Game.findOne({})
          .sort({ createdAt: -1 })
          .limit(1)
          .exec();
        if (gameDoc)
          console.log(
            "[applyCups] fallback: picked most recent Game:",
            gameDoc._id?.toString()
          );
      } catch (e) {}
    }

    if (!gameDoc) {
      console.warn("[applyCups] no Game found for roomId:", roomId);
      return;
    }

    if (gameDoc.cupsProcessed) {
      console.log(
        "[applyCups] game already processed for cups:",
        gameDoc._id?.toString()
      );
      return;
    }

    const finished = gameDoc.finished || {};
    const result = finished.result || null;
    const reason = (finished.reason || "").toLowerCase();

    if (
      result === "draw" ||
      reason.includes("draw") ||
      reason.includes("stalemate") ||
      reason.includes("threefold") ||
      reason.includes("insufficient")
    ) {
      try {
        await Game.updateOne(
          { _id: gameDoc._id },
          { $set: { cupsProcessed: true } }
        ).exec();
      } catch (e) {
        console.error("[applyCups] mark cupsProcessed (draw) failed:", e);
      }
      console.log(
        "[applyCups] draw/stalemate/insufficient — skipping cups for game:",
        gameDoc._id?.toString()
      );
      return;
    }

    let winnerColor = finished.winner || null;
    const players = Array.isArray(gameDoc.players) ? gameDoc.players : [];

    let winnerEntry = null;
    let loserEntry = null;

    if (winnerColor === "w" || winnerColor === "b") {
      winnerEntry = players.find(
        (p) => String(p.color) === String(winnerColor)
      );
      loserEntry = players.find(
        (p) => (p.color === "w" || p.color === "b") && p.color !== winnerColor
      );
    } else if (finished.winnerId || finished.loserId) {
      const wid = finished.winnerId || finished.winner;
      const lid = finished.loserId || finished.loser;
      winnerEntry = players.find(
        (p) => String(p.user?.id || p.user?._id || p.id) === String(wid)
      );
      loserEntry = players.find(
        (p) => String(p.user?.id || p.user?._id || p.id) === String(lid)
      );
    } else {
      if (winnerColor) {
        const lower = String(winnerColor).toLowerCase();
        winnerEntry =
          players.find(
            (p) =>
              (p.user &&
                ((p.user.username &&
                  String(p.user.username).toLowerCase() === lower) ||
                  (p.user.displayName &&
                    String(p.user.displayName).toLowerCase() === lower))) ||
              (p.username && String(p.username).toLowerCase() === lower)
          ) || null;
      }
      if (!winnerEntry && players.length === 2) {
        winnerEntry = players[0];
        loserEntry = players[1];
      } else if (winnerEntry && !loserEntry) {
        loserEntry = players.find((p) => p !== winnerEntry) || null;
      }
    }

    if (!winnerEntry && players.length === 2) {
      winnerEntry = players[0];
      loserEntry = players[1];
    }
    if (!loserEntry && players.length === 2) {
      loserEntry = players.find((p) => p !== winnerEntry) || players[1] || null;
    }

    const winnerUserId =
      winnerEntry?.user?.id ||
      winnerEntry?.user?._id ||
      winnerEntry?.id ||
      null;
    const loserUserId =
      loserEntry?.user?.id || loserEntry?.user?._id || loserEntry?.id || null;

    if (!winnerUserId || !loserUserId) {
      try {
        await Game.updateOne(
          { _id: gameDoc._id },
          { $set: { cupsProcessed: true } }
        ).exec();
      } catch (e) {}
      console.warn(
        "[applyCups] missing player user ids; marked processed. game:",
        gameDoc._id?.toString()
      );
      return;
    }

    const users = await User.find({
      _id: { $in: [winnerUserId, loserUserId].map(String) },
    }).exec();
    const winnerUser = users.find(
      (u) => String(u._id) === String(winnerUserId)
    );
    const loserUser = users.find((u) => String(u._id) === String(loserUserId));

    if (!winnerUser || !loserUser) {
      try {
        await Game.updateOne(
          { _id: gameDoc._id },
          { $set: { cupsProcessed: true } }
        ).exec();
      } catch (e) {}
      console.warn(
        "[applyCups] could not load user docs; marked processed. game:",
        gameDoc._id?.toString()
      );
      return;
    }

    const winnerCups =
      typeof winnerUser.cups === "number" ? winnerUser.cups : 0;
    const loserCups = typeof loserUser.cups === "number" ? loserUser.cups : 0;

    let delta = 10;
    try {
      if (
        typeof context.ratingUtils !== "undefined" &&
        context.ratingUtils &&
        typeof context.ratingUtils.computeDeltaForWinner === "function"
      ) {
        const maybe = context.ratingUtils.computeDeltaForWinner(
          winnerCups,
          loserCups
        );
        const n = Number(maybe);
        if (Number.isFinite(n)) delta = Math.max(1, Math.floor(n));
      }
    } catch (e) {
      console.warn(
        "[applyCups] ratingUtils.computeDeltaForWinner failed, falling back to delta=10",
        e
      );
      delta = 10;
    }

    const winnerNew = winnerCups + delta;
    const loserNew = Math.max(0, loserCups - delta);

    try {
      await User.updateOne(
        { _id: winnerUser._id },
        { $set: { cups: winnerNew } }
      ).exec();
      await User.updateOne(
        { _id: loserUser._id },
        { $set: { cups: loserNew } }
      ).exec();
    } catch (e) {
      console.error("[applyCups] failed to update user cups:", e);
    }

    try {
      await Game.updateOne(
        { _id: gameDoc._id },
        { $set: { cupsProcessed: true, cupsDelta: delta } }
      ).exec();
    } catch (e) {
      console.error("[applyCups] failed to mark game cupsProcessed:", e);
    }

    console.log(
      `[applyCups] applied delta=${delta} — winner ${
        winnerUser._id
      } (${winnerCups}->${winnerNew}), loser ${
        loserUser._id
      } (${loserCups}->${loserNew}) for game ${gameDoc._id?.toString()}`
    );
  } catch (err) {
    console.error("applyCupsForFinishedRoom error", err);
  }
}

module.exports = { applyCupsForFinishedRoom };
