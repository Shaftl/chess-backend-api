// backend/socket/applyCups.js
// Robust, idempotent cups application for finished games.
// Exports an async function: applyCups(context, gameIdOrDoc)

const mongoose = require("mongoose");

module.exports = async function applyCups(context, gameIdOrDoc) {
  const Game = context.Game;
  const User = context.User;
  const ratingUtils = context.ratingUtils || null;
  const notifyUser = context.notifyUser || (() => {});
  const log = context.log || console;

  if (!Game || !User) {
    throw new Error("applyCups: missing Game or User in context");
  }

  try {
    // Resolve game doc
    let gameDoc = null;
    if (gameIdOrDoc && typeof gameIdOrDoc === "object" && gameIdOrDoc._id) {
      gameDoc = gameIdOrDoc;
    } else if (typeof gameIdOrDoc === "string") {
      if (/^[a-fA-F0-9]{24}$/.test(gameIdOrDoc)) {
        try {
          gameDoc = await Game.findById(gameIdOrDoc).lean().exec();
        } catch (e) {
          gameDoc = null;
        }
      }
      if (!gameDoc) {
        try {
          gameDoc = await Game.findOne({ roomId: gameIdOrDoc })
            .sort({ createdAt: -1 })
            .lean()
            .exec();
        } catch (e) {
          gameDoc = null;
        }
      }
    } else {
      gameDoc = await Game.findOne({
        "finished._finalized": true,
        cupsProcessed: { $ne: true },
      })
        .sort({ createdAt: -1 })
        .lean()
        .exec();
    }

    if (!gameDoc) {
      log.warn("[applyCups] no Game doc found to process");
      return { ok: false, reason: "no-game" };
    }

    // If already processed, skip
    if (gameDoc.cupsProcessed) {
      log.info("[applyCups] game already processed:", String(gameDoc._id));
      return { ok: false, reason: "already-processed" };
    }

    const finished = gameDoc.finished || {};
    const players = Array.isArray(gameDoc.players) ? gameDoc.players : [];

    // If draw-like, mark processed and return
    const resLower = String(finished.result || "").toLowerCase();
    const reasonLower = String(finished.reason || "").toLowerCase();
    if (
      resLower === "draw" ||
      reasonLower.includes("draw") ||
      reasonLower.includes("stalemate") ||
      reasonLower.includes("threefold") ||
      reasonLower.includes("insufficient") ||
      reasonLower.includes("abandoned")
    ) {
      try {
        await Game.updateOne(
          { _id: gameDoc._id },
          { $set: { cupsProcessed: true } }
        ).exec();
      } catch (e) {}
      log.info(
        "[applyCups] draw/abandoned — marked processed",
        String(gameDoc._id)
      );
      return { ok: true, reason: "draw" };
    }

    // helper: is ObjectId-like
    const looksLikeObjectId = (v) =>
      !!(v && typeof v === "string" && /^[a-fA-F0-9]{24}$/.test(v));
    // extract candidate identifiers from a player record
    const getCandidateIds = (p) => {
      if (!p) return [];
      const out = [];
      try {
        if (p.user) {
          if (p.user.id) out.push(String(p.user.id));
          if (p.user._id) out.push(String(p.user._id));
          if (p.user.username) out.push(String(p.user.username));
          if (p.user.displayName) out.push(String(p.user.displayName));
        }
        if (p.id) out.push(String(p.id));
        if (p.username) out.push(String(p.username));
      } catch (e) {}
      return out.filter(Boolean);
    };

    // attempt resolution functions
    const findUserByIdOrCandidate = async (candidate) => {
      if (!candidate) return null;
      // If looks like ObjectId try by _id
      if (looksLikeObjectId(candidate)) {
        try {
          const found = await User.findById(candidate)
            .select("cups username")
            .exec();
          if (found) return found;
        } catch (e) {}
      }
      // otherwise try username/displayName
      try {
        const found = await User.findOne({
          $or: [{ username: candidate }, { displayName: candidate }],
        })
          .select("cups username")
          .exec();
        if (found) return found;
      } catch (e) {}
      return null;
    };

    // Determine winner/loser player entries (prefer ids then color then username)
    let winnerEntry = null,
      loserEntry = null;

    // 1) if finished contains winnerId/loserId use those to find player entries
    if (finished.winnerId) {
      winnerEntry = players.find((p) => {
        const ids = getCandidateIds(p);
        return ids.includes(String(finished.winnerId));
      });
    }
    if (finished.loserId) {
      loserEntry = players.find((p) => {
        const ids = getCandidateIds(p);
        return ids.includes(String(finished.loserId));
      });
    }

    // 2) by winnerColor/loserColor
    if (!winnerEntry && finished.winnerColor) {
      winnerEntry = players.find(
        (p) => String(p.color) === String(finished.winnerColor)
      );
    }
    if (!loserEntry && finished.loserColor) {
      loserEntry = players.find(
        (p) => String(p.color) === String(finished.loserColor)
      );
    }

    // 3) try winner/loser fields as username
    if (
      !winnerEntry &&
      finished.winner &&
      !["w", "b"].includes(String(finished.winner).toLowerCase())
    ) {
      const wf = String(finished.winner).toLowerCase();
      winnerEntry = players.find((p) => {
        const ids = getCandidateIds(p).map(String);
        return ids.some((x) => String(x).toLowerCase() === wf);
      });
    }
    if (
      !loserEntry &&
      finished.loser &&
      !["w", "b"].includes(String(finished.loser).toLowerCase())
    ) {
      const lf = String(finished.loser).toLowerCase();
      loserEntry = players.find((p) => {
        const ids = getCandidateIds(p).map(String);
        return ids.some((x) => String(x).toLowerCase() === lf);
      });
    }

    // 4) as last resort, if exactly two players pick by presence/exclusion
    if ((!winnerEntry || !loserEntry) && players.length === 2) {
      if (!winnerEntry) winnerEntry = players[0];
      if (!loserEntry)
        loserEntry = players.find((p) => p !== winnerEntry) || players[1];
    }

    // Now attempt to load corresponding User docs
    let winnerUser = null,
      loserUser = null;

    // Helper to try all candidate ids from an entry
    const resolveUserFromEntry = async (entry) => {
      if (!entry) return null;
      const candidates = getCandidateIds(entry);
      for (const c of candidates) {
        const u = await findUserByIdOrCandidate(c).catch(() => null);
        if (u) return u;
      }
      return null;
    };

    try {
      if (winnerEntry) winnerUser = await resolveUserFromEntry(winnerEntry);
      if (loserEntry) loserUser = await resolveUserFromEntry(loserEntry);
    } catch (e) {
      // silently continue, we'll try other possibilities below
    }

    // Extra fallback: brute-force user lookup by any username field present in players array
    if (!winnerUser) {
      for (const p of players) {
        const names = getCandidateIds(p).filter((x) => !looksLikeObjectId(x));
        for (const nm of names) {
          const u = await findUserByIdOrCandidate(nm).catch(() => null);
          if (u) {
            // pick the player that matches name (best-effort)
            const lower = String(nm).toLowerCase();
            const pnames = getCandidateIds(p)
              .map(String)
              .map((s) => s.toLowerCase());
            if (pnames.includes(lower)) {
              winnerUser = u;
              winnerEntry = p;
              break;
            }
          }
        }
        if (winnerUser) break;
      }
    }
    if (!loserUser) {
      for (const p of players) {
        const names = getCandidateIds(p).filter((x) => !looksLikeObjectId(x));
        for (const nm of names) {
          const u = await findUserByIdOrCandidate(nm).catch(() => null);
          if (u) {
            const lower = String(nm).toLowerCase();
            const pnames = getCandidateIds(p)
              .map(String)
              .map((s) => s.toLowerCase());
            if (pnames.includes(lower)) {
              loserUser = u;
              loserEntry = p;
              break;
            }
          }
        }
        if (loserUser) break;
      }
    }

    // If we still don't have both users, do NOT mark processed: leave game for retry and log clearly
    if (!winnerUser || !loserUser) {
      log.warn(
        "[applyCups] could not resolve both users — leaving unprocessed for retry",
        {
          gameId: String(gameDoc._id),
          winnerEntry,
          loserEntry,
        }
      );
      return {
        ok: false,
        reason: "could-not-resolve-users",
        winnerEntry,
        loserEntry,
      };
    }

    // Prevent same-user winner/loser
    if (String(winnerUser._id) === String(loserUser._id)) {
      log.warn(
        "[applyCups] resolved winner & loser to same user — leaving unprocessed",
        { gameId: String(gameDoc._id) }
      );
      return { ok: false, reason: "same-user", userId: String(winnerUser._id) };
    }

    // Build moves array for analysis
    const movesRaw = Array.isArray(gameDoc.moves) ? gameDoc.moves : [];
    const toUci = (m) => {
      if (!m) return null;
      if (typeof m === "string") return m;
      if (m.move && typeof m.move === "string") return m.move;
      if (m.move && m.move.from && m.move.to)
        return `${m.move.from}${m.move.to}${m.move.promotion || ""}`;
      if (m.from && m.to) return `${m.from}${m.to}${m.promotion || ""}`;
      return null;
    };
    const movesUci = movesRaw.map(toUci).filter(Boolean);

    // Compute delta, prefer stockfish/ratingUtils
    let delta = 12;
    try {
      if (
        ratingUtils &&
        typeof ratingUtils.runStockfishAnalysis === "function" &&
        typeof ratingUtils.computeDeltaForWinner === "function"
      ) {
        let analysis = null;
        try {
          analysis = await ratingUtils.runStockfishAnalysis(
            movesUci,
            parseInt(process.env.STOCKFISH_DEPTH || "12", 10),
            parseInt(process.env.STOCKFISH_TIMEOUT || "4000", 10)
          );
        } catch (e) {
          analysis = null;
        }

        // determine winner color, prefer finished.winnerColor or winnerEntry.color
        let winnerColor =
          finished.winnerColor || (winnerEntry && winnerEntry.color) || null;
        const winnerACPL = analysis
          ? winnerColor === "w"
            ? analysis.acplWhite || 200
            : analysis.acplBlack || 200
          : 200;
        const loserACPL = analysis
          ? winnerColor === "w"
            ? analysis.acplBlack || 200
            : analysis.acplWhite || 200
          : 200;
        const maxSwingCp = analysis ? analysis.maxSwingCp || 0 : 0;

        delta = ratingUtils.computeDeltaForWinner(
          Number(winnerUser.cups ?? 1200),
          Number(loserUser.cups ?? 1200),
          winnerACPL,
          loserACPL,
          maxSwingCp,
          /*gamesplayed*/ 50
        );
        delta = Math.max(1, Math.round(delta || 12));
      } else {
        // fallback elo-like
        const w = Number(winnerUser.cups ?? 1200);
        const l = Number(loserUser.cups ?? 1200);
        const expected = 1 / (1 + Math.pow(10, (l - w) / 400));
        const K = 20;
        delta = Math.max(1, Math.round(K * (1 - expected)));
        if (delta < 10) delta = 10;
      }
    } catch (e) {
      delta = 12;
    }

    // perform atomic updates
    try {
      const winnerBefore = Number(winnerUser.cups ?? 0);
      const loserBefore = Number(loserUser.cups ?? 0);

      await User.findByIdAndUpdate(winnerUser._id, {
        $inc: { cups: Number(delta) },
      }).exec();
      await User.findByIdAndUpdate(loserUser._id, {
        $inc: { cups: -Number(delta) },
      }).exec();

      // mark Game as processed
      try {
        await Game.updateOne(
          { _id: gameDoc._id },
          { $set: { cupsProcessed: true, cupsDelta: Number(delta) } }
        ).exec();
      } catch (e) {}

      // notify users (best-effort)
      try {
        notifyUser(String(winnerUser._id), "cups-changed", {
          cups: Number(winnerBefore + delta),
          delta: Number(delta),
        });
      } catch (e) {}
      try {
        notifyUser(String(loserUser._id), "cups-changed", {
          cups: Number(Math.max(0, loserBefore - delta)),
          delta: -Number(delta),
        });
      } catch (e) {}

      log.info("[applyCups] applied cups:", {
        gameId: String(gameDoc._id),
        delta: Number(delta),
        winner: {
          id: winnerUser._id,
          username: winnerUser.username,
          before: winnerBefore,
          after: Math.max(0, winnerBefore + delta),
        },
        loser: {
          id: loserUser._id,
          username: loserUser.username,
          before: loserBefore,
          after: Math.max(0, loserBefore - delta),
        },
      });

      return {
        ok: true,
        delta: Number(delta),
        winner: winnerUser._id,
        loser: loserUser._id,
      };
    } catch (e) {
      log.error("[applyCups] error applying cups:", e);
      // Do not mark processed so retries are possible
      throw e;
    }
  } catch (err) {
    console.error("[applyCups] fatal error:", err);
    throw err;
  }
};
