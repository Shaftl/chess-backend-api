// backend/ratingUtils.js
// Robust Stockfish helper: safe spawn attempt + fallback to npm 'stockfish' (wasm)
// Exports: runStockfishAnalysis(moves, depth, timeoutPerEval) and computeDeltaForWinner

const { spawn } = require("child_process");

async function tryRequireStockfishPkg() {
  try {
    return require("stockfish");
  } catch (e) {
    return null;
  }
}

/**
 * spawnOrWasmEngine()
 * Returns an object { type: "spawn"|"wasm", send(cmd), readUntil(marker, timeout), quit() }
 * or null if cannot create any engine.
 */
async function spawnOrWasmEngine() {
  const stockfishCmd = process.env.STOCKFISH_CMD || "stockfish";

  // Attempt to spawn native binary but attach an 'error' handler immediately
  try {
    const spawnResult = await new Promise((resolve) => {
      let settled = false;
      try {
        const e = spawn(stockfishCmd, [], { stdio: "pipe" });
        e.stdin.setDefaultEncoding("utf-8");

        const onError = (err) => {
          // spawn failed (ENOENT etc). cleanup and resolve null
          try {
            e.removeListener("error", onError);
          } catch (er) {}
          settled = true;
          // ensure child is killed if somehow exists
          try {
            e.kill();
          } catch (er) {}
          resolve(null);
        };

        // Attach early error handler (prevents unhandled 'error')
        e.once("error", onError);

        // If no immediate error occurs within a short tick window, assume spawn is ok.
        // This doesn't guarantee the engine fully started, but prevents ENOENT crash.
        setTimeout(() => {
          if (settled) return;
          try {
            e.removeListener("error", onError);
          } catch (er) {}
          // Prepare send/read/quit helpers
          const send = (cmd) => {
            try {
              e.stdin.write(cmd + "\n");
            } catch (err) {}
          };
          const readUntil = (marker = "bestmove", timeout = 4000) =>
            new Promise((resolveRead) => {
              let out = "";
              const onData = (b) => {
                out += String(b.toString());
                if (out.includes(marker)) {
                  cleanup();
                  resolveRead(out);
                }
              };
              const onErrData = () => {};
              const cleanup = () => {
                try {
                  e.stdout.off("data", onData);
                  e.stderr.off("data", onErrData);
                } catch (er) {}
              };
              try {
                e.stdout.on("data", onData);
                e.stderr.on("data", onErrData);
              } catch (er) {}
              setTimeout(() => {
                cleanup();
                resolveRead(out);
              }, timeout);
            });
          const quit = () => {
            try {
              send("quit");
            } catch (er) {}
            try {
              e.kill();
            } catch (er) {}
          };
          resolve({
            type: "spawn",
            engine: e,
            send,
            readUntil,
            quit,
          });
        }, 50); // tiny window to catch immediate spawn errors like ENOENT
      } catch (err) {
        // spawn threw synchronously (rare) -> resolve null
        resolve(null);
      }
    });

    if (spawnResult) return spawnResult;
  } catch (e) {
    // continue to wasm fallback
  }

  // fallback: try npm 'stockfish' package (wasm)
  const stockfishPkg = await tryRequireStockfishPkg();
  if (!stockfishPkg) return null;

  try {
    const wasmEngine =
      typeof stockfishPkg === "function" ? stockfishPkg() : stockfishPkg;
    let listeners = [];
    const onMessage = (ev) => {
      let data = ev;
      if (Array.isArray(ev) && ev.length) data = ev.join(" ");
      if (ev && typeof ev === "object" && typeof ev.data === "string")
        data = ev.data;
      try {
        listeners.forEach((fn) => {
          try {
            fn(String(data));
          } catch (e) {}
        });
      } catch (e) {}
    };

    try {
      // attach common event hooks if available
      if (typeof wasmEngine.onmessage === "undefined") {
        wasmEngine.onmessage = (m) => onMessage(m);
      } else {
        // overwrite safe handler
        wasmEngine.onmessage = (m) => onMessage(m);
      }
    } catch (e) {
      // ignore
    }

    const send = (cmd) => {
      try {
        if (typeof wasmEngine.postMessage === "function")
          wasmEngine.postMessage(cmd);
        else if (typeof wasmEngine.send === "function") wasmEngine.send(cmd);
        else if (typeof wasmEngine === "function") wasmEngine(cmd);
      } catch (e) {}
    };

    const readUntil = (marker = "bestmove", timeout = 4000) =>
      new Promise((resolve) => {
        let out = "";
        const onData = (text) => {
          const s = String(text || "");
          out += s + "\n";
          if (out.includes(marker)) {
            cleanup();
            resolve(out);
          }
        };
        listeners.push(onData);
        const cleanup = () => {
          listeners = listeners.filter((l) => l !== onData);
        };
        setTimeout(() => {
          cleanup();
          resolve(out);
        }, timeout);
      });

    const quit = () => {
      try {
        if (typeof wasmEngine.postMessage === "function")
          wasmEngine.postMessage("quit");
        if (typeof wasmEngine.terminate === "function") wasmEngine.terminate();
      } catch (e) {}
    };

    return { type: "wasm", engine: wasmEngine, send, readUntil, quit };
  } catch (err) {
    return null;
  }
}

/**
 * runStockfishAnalysis(moves, depth=12, timeoutPerEval=4000)
 * - moves: array of UCI strings e.g. ["e2e4","e7e5","g1f3", ...]
 * Returns null on failure, or an object:
 * { acplWhite, acplBlack, blundersWhite, blundersBlack, maxSwingCp, cpScores }
 */
async function runStockfishAnalysis(
  moves = [],
  depth = 12,
  timeoutPerEval = 4000
) {
  if (!Array.isArray(moves) || moves.length === 0) return null;

  const session = await spawnOrWasmEngine();
  if (!session) return null;

  const send = session.send;
  const readUntil = session.readUntil;
  const quit = session.quit;

  try {
    send("uci");
    await readUntil("uciok", 2000);
    send("isready");
    await readUntil("readyok", 2000);

    const cpScores = [];
    const prefixes = [];
    let prefixMoves = [];
    for (let i = 0; i < moves.length; i++) {
      prefixMoves.push(moves[i]);
      prefixes.push(prefixMoves.slice());
    }

    for (const pmoves of prefixes) {
      const movesString = pmoves.join(" ");
      send(`position startpos moves ${movesString}`);
      send(`go depth ${depth}`);
      const raw = await readUntil("bestmove", timeoutPerEval);

      const lines = raw.split("\n").reverse();
      let found = null;
      for (const L of lines) {
        const mCp = L.match(/score cp (-?\d+)/);
        if (mCp) {
          found = { type: "cp", val: parseInt(mCp[1], 10) };
          break;
        }
        const mMate = L.match(/score mate (-?\d+)/);
        if (mMate) {
          const mate = parseInt(mMate[1], 10);
          found = { type: "mate", val: mate > 0 ? 20000 : -20000 };
          break;
        }
      }

      if (found) cpScores.push(found.val);
      else cpScores.push(null);
    }

    const deltas = [];
    for (let i = 0; i < cpScores.length; i++) {
      const prev = i === 0 ? 0 : cpScores[i - 1] || 0;
      const curr = cpScores[i] || 0;
      deltas.push(Math.abs(curr - prev));
    }

    const whiteDeltas = [];
    const blackDeltas = [];
    for (let i = 0; i < deltas.length; i++) {
      if (i % 2 === 0) whiteDeltas.push(deltas[i]);
      else blackDeltas.push(deltas[i]);
    }

    const avg = (arr) =>
      arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const acplWhite = Math.round(avg(whiteDeltas));
    const acplBlack = Math.round(avg(blackDeltas));

    const BLUNDER_THRESHOLD = 150;
    const blundersWhite = whiteDeltas.filter(
      (d) => d >= BLUNDER_THRESHOLD
    ).length;
    const blundersBlack = blackDeltas.filter(
      (d) => d >= BLUNDER_THRESHOLD
    ).length;

    const maxSwingCp = deltas.length ? Math.max(...deltas) : 0;

    try {
      quit();
    } catch (e) {}

    return {
      acplWhite,
      acplBlack,
      blundersWhite,
      blundersBlack,
      maxSwingCp,
      cpScores,
    };
  } catch (err) {
    try {
      quit();
    } catch (e) {}
    return null;
  }
}

/**
 * computeDeltaForWinner
 * unchanged from your previous logic (keeps API)
 */
function computeDeltaForWinner(
  winnerRating = 1200,
  loserRating = 1200,
  winnerACPL = 200,
  loserACPL = 200,
  maxSwingCp = 0,
  winnerGamesPlayed = 50
) {
  const expected = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  const K = winnerGamesPlayed < 30 ? 40 : 20;
  const baseDelta = Math.max(1, Math.round(K * (1 - expected)));

  const acplThreshold = 120;
  const qScore = Math.max(0, (acplThreshold - winnerACPL) / acplThreshold);
  const swingNorm = Math.min(1, Math.abs(maxSwingCp) / 400);

  const multiplier = 1 + qScore * 0.9 + swingNorm * 0.5;

  const finalDelta = Math.round(baseDelta * multiplier);
  return Math.max(1, finalDelta);
}

module.exports = { runStockfishAnalysis, computeDeltaForWinner };
