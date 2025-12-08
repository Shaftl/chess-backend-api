// backend/lib/jsChessEngineAdapter.js
// Adapter around js-chess-engine returning { from, to, promotion? } in lower-case (e.g. 'e2','e4')
// Uses stateless aiMove(boardConfiguration, level) which accepts a FEN string or JSON board config.

let adapter = {};
try {
  // prefer CommonJS require (works in Node)
  adapter.engine = require("js-chess-engine");
} catch (err) {
  // If require fails, engine will be null and module will fall back to a lightweight random fallback.
  adapter.engine = null;
}

function mapJsChessEngineMoveToServer(moveObj) {
  // moveObj example: { "H7": "H5" }
  // Take the first entry
  if (!moveObj || typeof moveObj !== "object") return null;
  const keys = Object.keys(moveObj);
  if (!keys || keys.length === 0) return null;
  const from = keys[0];
  const to = moveObj[from];
  if (!from || !to) return null;
  // convert to lowercase algebraic (js-chess-engine uses uppercase files)
  const fromLc = String(from).toLowerCase();
  const toLc = String(to).toLowerCase();
  return { from: fromLc, to: toLc };
}

/**
 * aiMoveFromFen
 * - fenOrConfig: FEN string or engine configuration (js-chess-engine accepts both)
 * - level: integer 0..4 (js-chess-engine uses 0..4; we'll clamp if needed)
 *
 * returns { from, to } or null on failure.
 */
async function aiMoveFromFen(fenOrConfig, level = 2) {
  try {
    const lvl = Math.max(0, Math.min(4, Number.isFinite(+level) ? +level : 2));

    if (adapter.engine && typeof adapter.engine.aiMove === "function") {
      // stateless aiMove: accepts FEN or board config
      const moveObj = adapter.engine.aiMove(fenOrConfig, lvl);
      const mapped = mapJsChessEngineMoveToServer(moveObj);
      return mapped;
    }

    // fallback: if engine missing, do a very fast pseudo-random move selection from provided config/fen
    // Minimal fallback: derive possible moves using engine.moves() if available, else return null.
    if (adapter.engine && typeof adapter.engine.moves === "function") {
      const moves = adapter.engine.moves(fenOrConfig) || {};
      // picks a random move from moves object
      const fromKeys = Object.keys(moves);
      if (fromKeys.length === 0) return null;
      const from = fromKeys[Math.floor(Math.random() * fromKeys.length)];
      const tos = moves[from];
      if (!Array.isArray(tos) || tos.length === 0) return null;
      const to = tos[Math.floor(Math.random() * tos.length)];
      return { from: String(from).toLowerCase(), to: String(to).toLowerCase() };
    }

    // final fallback (no js-chess-engine): return null so caller can handle
    return null;
  } catch (err) {
    // don't throw — caller will handle null
    console.error(
      "jsChessEngineAdapter.aiMoveFromFen error:",
      err && err.message
    );
    return null;
  }
}

module.exports = {
  aiMoveFromFen,
};
