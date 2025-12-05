// backend/routes/bot.js
const express = require("express");
const router = express.Router();
const botManager = require("../botManager");
const { restAuthMiddleware } = require("../middleware/auth");

// POST /api/bot/create
// body: { minutes, playAs, movetimeMs, depth, limitStrength, elo, botName, level, engine }
router.post("/create", restAuthMiddleware, async (req, res) => {
  try {
    // Debug logging to help track issues
    console.info("[POST /api/bot/create] req.user:", !!req.user, {
      id: req.user?.id,
      username: req.user?.username,
    });
    console.info("[POST /api/bot/create] body:", req.body || {});

    const uid = req.user && req.user.id;
    if (!uid) {
      return res.status(401).json({ ok: false, error: "Missing auth" });
    }

    const user = {
      id: uid,
      username: req.user.username || req.user?.displayName || "user",
    };

    // minutes may be top-level or nested in req.body.level.minutes
    const minutes = Math.max(
      1,
      Math.floor(
        Number(
          req.body.minutes || (req.body.level && req.body.level.minutes) || 5
        )
      )
    );

    // playAs (white|black|random) - accept either playAs or colorPreference
    const playAs =
      req.body.playAs ||
      req.body.colorPreference ||
      (req.body.level && req.body.level.playAs) ||
      "random";

    // Normalize level fields: allow either top-level movetimeMs/depth/elo or `level` object
    const levelFromBody =
      req.body.level && typeof req.body.level === "object"
        ? req.body.level
        : {};
    const level = {
      movetimeMs: Number(
        req.body.movetimeMs ||
          req.body.movetime ||
          levelFromBody.movetimeMs ||
          levelFromBody.movetime ||
          800
      ),
      depth:
        typeof req.body.depth === "number"
          ? Number(req.body.depth)
          : typeof levelFromBody.depth === "number"
          ? Number(levelFromBody.depth)
          : null,
      limitStrength:
        typeof req.body.limitStrength !== "undefined"
          ? !!req.body.limitStrength
          : !!levelFromBody.limitStrength,
      elo:
        typeof req.body.elo !== "undefined"
          ? Number(req.body.elo)
          : typeof levelFromBody.elo !== "undefined"
          ? Number(levelFromBody.elo)
          : undefined,
      // pass any engine preference to botManager (e.g. 'jsengine')
      engine: req.body.engine || levelFromBody.engine || "jsengine",
      // allow a numeric 'level' field (0..3) to be passed through
      levelNum:
        typeof req.body.levelNum === "number"
          ? Number(req.body.levelNum)
          : typeof levelFromBody.levelNum === "number"
          ? Number(levelFromBody.levelNum)
          : typeof req.body.level === "number"
          ? Number(req.body.level)
          : typeof levelFromBody.level === "number"
          ? Number(levelFromBody.level)
          : undefined,
    };

    if (isNaN(minutes) || minutes < 1) {
      return res.status(400).json({ ok: false, error: "invalid-minutes" });
    }

    // core call to botManager
    const r = await botManager.createBotRoomForUser(user, {
      minutes,
      playAs,
      level,
      botName: req.body.botName || req.body.name || "JS-Engine",
    });

    if (!r || !r.ok) {
      console.warn(
        "[POST /api/bot/create] createBotRoomForUser returned error:",
        r
      );
      return res
        .status(500)
        .json({ ok: false, error: r && r.error ? r.error : "create-failed" });
    }

    return res.json({ ok: true, roomId: r.roomId });
  } catch (err) {
    console.error("[POST /api/bot/create] unexpected error:", err);
    const payload =
      process.env.NODE_ENV === "production"
        ? { ok: false, error: "server-error" }
        : { ok: false, error: err.message || "server-error", stack: err.stack };
    return res.status(500).json(payload);
  }
});

module.exports = router;
