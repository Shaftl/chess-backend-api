// backend/bot_worker.js
// Short-lived child worker that computes a move using js-chess-engine (if available)
// or falls back to a simple deterministic chess.js heuristic. Worker processes
// one message then exits (prevents memory accumulation in main process).

process.on("uncaughtException", (err) => {
  try {
    console.error("[bot_worker] uncaughtException", (err && err.stack) || err);
  } catch (e) {}
});
process.on("unhandledRejection", (r) => {
  try {
    console.error("[bot_worker] unhandledRejection", r);
  } catch (e) {}
});

let jsEngine = null;
try {
  jsEngine = require("js-chess-engine");
} catch (e) {
  jsEngine = null;
}

const { Chess } = require("chess.js");

function uciToMoveObj(uci) {
  if (!uci || typeof uci !== "string") return null;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci.slice(4) : undefined;
  const obj = { from, to };
  if (promotion) obj.promotion = promotion;
  return obj;
}

function computeUsingFenSimpleEngine(movesUci = [], opts = {}) {
  try {
    const chess = new Chess();
    if (opts && typeof opts.fen === "string" && opts.fen.length > 0) {
      try {
        chess.load(opts.fen);
      } catch (e) {
        for (const u of movesUci || []) {
          try {
            const mo = uciToMoveObj(u);
            if (mo)
              chess.move({ from: mo.from, to: mo.to, promotion: mo.promotion });
          } catch (e) {}
        }
      }
    } else {
      for (const u of movesUci || []) {
        try {
          const mo = uciToMoveObj(u);
          if (mo)
            chess.move({ from: mo.from, to: mo.to, promotion: mo.promotion });
        } catch (e) {}
      }
    }
    if (chess.isGameOver()) return null;
    const moves = chess.moves({ verbose: true }) || [];
    if (!moves || moves.length === 0) return null;
    moves.sort((a, b) => (b.captured ? 1 : 0) - (a.captured ? 1 : 0));
    const m = moves[0];
    return `${m.from}${m.to}${m.promotion || ""}`;
  } catch (e) {
    return null;
  }
}

async function computeUsingJsEngine(movesUci = [], opts = {}) {
  if (!jsEngine) return null;
  try {
    const Game = jsEngine.Game;
    if (!Game) return null;
    const game = new Game();
    // js-chess-engine expects uppercase squares ("E2")
    for (const u of movesUci || []) {
      if (!u) continue;
      try {
        const from = u.slice(0, 2).toUpperCase();
        const to = u.slice(2, 4).toUpperCase();
        game.move(from, to);
      } catch (e) {}
    }

    let level = 2;
    if (typeof opts.level === "number")
      level = Math.max(0, Math.min(3, Math.floor(opts.level)));
    else if (typeof opts.levelNum === "number")
      level = Math.max(0, Math.min(3, Math.floor(opts.levelNum)));
    else if (typeof opts.movetimeMs === "number") {
      const t = Number(opts.movetimeMs);
      if (t <= 400) level = 0;
      else if (t <= 800) level = 1;
      else if (t <= 2000) level = 2;
      else level = 3;
    }

    const res = game.aiMove(level || 2);
    if (!res || typeof res !== "object") return null;
    const keys = Object.keys(res);
    if (keys.length === 0) return null;
    const from = keys[0];
    const toVal = res[from];
    let toSquare = toVal;
    let prom = "";
    if (typeof toVal === "string" && toVal.length > 2) {
      toSquare = toVal.slice(0, 2);
      prom = toVal.slice(2);
    }
    const uci = `${String(from).slice(0, 2).toLowerCase()}${String(toSquare)
      .slice(0, 2)
      .toLowerCase()}${prom ? String(prom).charAt(0).toLowerCase() : ""}`;
    return uci;
  } catch (e) {
    return null;
  }
}

process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") {
    // nothing to do — exit cleanly
    try {
      process.exit(0);
    } catch (e) {}
    return;
  }
  const { id, moves, opts } = msg;
  try {
    // If opts.fen present -> deterministic fallback
    if (opts && typeof opts.fen === "string" && opts.fen.length > 0) {
      const r = computeUsingFenSimpleEngine(moves || [], opts || {});
      try {
        process.send({ id, ok: true, move: r });
      } catch (e) {}
      try {
        process.exit(0);
      } catch (e) {}
      return;
    }

    // Try js-chess-engine first
    if (jsEngine) {
      try {
        const r = await computeUsingJsEngine(moves || [], opts || {});
        if (r) {
          try {
            process.send({ id, ok: true, move: r });
          } catch (e) {}
          try {
            process.exit(0);
          } catch (e) {}
          return;
        }
      } catch (e) {
        // fallthrough to fallback
      }
    }

    // fallback
    const fallback = computeUsingFenSimpleEngine(moves || [], opts || {});
    try {
      process.send({ id, ok: true, move: fallback });
    } catch (e) {}
    try {
      process.exit(0);
    } catch (e) {}
  } catch (e) {
    try {
      process.send({ id, ok: false });
    } catch (e) {}
    try {
      process.exit(1);
    } catch (e) {}
  }
});
