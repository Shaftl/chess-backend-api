// backend/services/stockfishEngine.js
// Worker-pool + safe fallback computeBestMove implementation.
// Uses persistent child workers (bot_worker.js) to avoid repeated fork leaks.
// If pool is busy or worker times out, falls back to a tiny in-process engine.

const path = require("path");
const { fork } = require("child_process");
const { Chess } = require("chess.js");

const WORKER_COUNT = Math.max(1, Number(process.env.BOT_WORKER_COUNT || 2));
const WORKER_TIMEOUT_MARGIN = 1000; // ms extra beyond movetime
const JOB_QUEUE_LIMIT = 100; // max queued jobs; if exceeded we run fallback immediately

/* -------------------------
   Tiny deterministic fallback engine (in-process)
   ------------------------- */

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
          const mo = uciToMoveObj(u);
          if (mo) {
            try {
              chess.move({ from: mo.from, to: mo.to, promotion: mo.promotion });
            } catch (e) {}
          }
        }
      }
    } else {
      for (const u of movesUci || []) {
        const mo = uciToMoveObj(u);
        if (mo) {
          try {
            chess.move({ from: mo.from, to: mo.to, promotion: mo.promotion });
          } catch (e) {}
        }
      }
    }

    if (chess.isGameOver()) return null;
    const moves = chess.moves({ verbose: true }) || [];
    if (!moves || moves.length === 0) return null;
    // simple heuristic: captures first
    moves.sort((a, b) => (b.captured ? 1 : 0) - (a.captured ? 1 : 0));
    const m = moves[0];
    return `${m.from}${m.to}${m.promotion || ""}`;
  } catch (e) {
    return null;
  }
}

/* -------------------------
   Worker pool implementation
   ------------------------- */

const workerPath = path.join(__dirname, "..", "bot_worker.js");

class WorkerWrapper {
  constructor(id) {
    this.id = id;
    this.child = null;
    this.busy = false;
    this.currentJob = null;
    this.lastUsed = Date.now();
    this.spawn();
  }

  spawn() {
    // spawn with stdio ignoring stdout/stderr to avoid parent buffers
    try {
      this.child = fork(workerPath, [], {
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch (e) {
      this.child = null;
      return;
    }

    this.child.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      const job = this.currentJob;
      if (!job || !msg.id || msg.id !== job.id) {
        // unexpected message - ignore
        return;
      }
      // deliver result
      clearTimeout(job.timeoutTimer);
      this.busy = false;
      this.currentJob = null;
      this.lastUsed = Date.now();
      try {
        job.resolve(msg.ok ? msg.move || null : null);
      } catch (e) {}
      // dispatch next queued job (pool manager handles)
      dispatchNext();
    });

    this.child.on("error", (err) => {
      // fail current job and respawn
      if (this.currentJob) {
        clearTimeout(this.currentJob.timeoutTimer);
        try {
          this.currentJob.reject(err);
        } catch (e) {}
        this.currentJob = null;
      }
      this.busy = false;
      safeKillChild(this.child);
      this.child = null;
      // respawn a replacement after tiny backoff
      setTimeout(() => this.spawn(), 200);
    });

    this.child.on("exit", (code, signal) => {
      // if currentJob pending, reject it, then respawn
      if (this.currentJob) {
        clearTimeout(this.currentJob.timeoutTimer);
        try {
          this.currentJob.reject(
            new Error(`worker exited (${code},${signal})`)
          );
        } catch (e) {}
        this.currentJob = null;
      }
      this.busy = false;
      this.child = null;
      // respawn
      setTimeout(() => this.spawn(), 200);
    });
  }

  isAlive() {
    return !!(this.child && !this.child.killed);
  }

  async compute(movesUci, opts, timeoutMs) {
    if (!this.isAlive()) {
      // spawn synchronous and fallback if not available immediately
      try {
        this.spawn();
      } catch (e) {}
      if (!this.isAlive()) {
        return null;
      }
    }

    return new Promise((resolve, reject) => {
      if (!this.isAlive()) return resolve(null);
      const id = `${Date.now()}-${Math.floor(Math.random() * 10000)}-${
        this.id
      }`;
      this.busy = true;
      this.currentJob = { id, resolve, reject, timeoutTimer: null };

      // job timeout
      const t = Math.max(
        1200,
        Number(opts.movetimeMs || opts.movetime || 800) + WORKER_TIMEOUT_MARGIN,
        timeoutMs || 0
      );
      this.currentJob.timeoutTimer = setTimeout(() => {
        // if worker hasn't responded in time, reject and kill child (defensive)
        try {
          this.currentJob.reject(new Error("worker-timeout"));
        } catch (e) {}
        this.currentJob = null;
        this.busy = false;
        try {
          if (this.child) safeKillChild(this.child);
        } catch (e) {}
        // dispatch next jobs
        dispatchNext();
      }, t);

      // send job to worker
      try {
        this.child.send({ id, moves: movesUci || [], opts: opts || {} });
      } catch (e) {
        clearTimeout(this.currentJob.timeoutTimer);
        this.currentJob = null;
        this.busy = false;
        return resolve(null);
      }
    });
  }
}

function safeKillChild(child) {
  try {
    if (!child) return;
    // remove listeners then kill
    try {
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
    } catch (e) {}
    try {
      if (!child.killed) child.kill();
    } catch (e) {}
  } catch (e) {}
}

// pool & queue
const pool = [];
const jobQueue = []; // items: { moves, opts, resolve, reject, queuedAt }

for (let i = 0; i < WORKER_COUNT; i++) pool.push(new WorkerWrapper(i));

function pickFreeWorker() {
  for (const w of pool) {
    if (w && w.isAlive() && !w.busy) return w;
  }
  return null;
}

function dispatchNext() {
  if (jobQueue.length === 0) return;
  const free = pickFreeWorker();
  if (!free) return;
  const job = jobQueue.shift();
  // call worker.compute
  free
    .compute(job.moves, job.opts, job.timeoutMs || 0)
    .then((move) => job.resolve(move))
    .catch((err) => {
      // fallback to tiny engine if worker failed
      try {
        const fallback = computeUsingFenSimpleEngine(
          job.moves || [],
          job.opts || {}
        );
        job.resolve(fallback);
      } catch (e) {
        job.resolve(null);
      }
    });
}

/* -------------------------
   Public API: computeBestMove
   - queues job to worker pool. If pool idle worker available, uses it.
   - if queue length beyond limit, uses in-process fallback immediately (prevents backlog & memory growth).
   ------------------------- */

async function computeBestMove(movesUci = [], opts = {}) {
  try {
    // If authoritative FEN provided, prefer deterministic in-process engine (safer)
    if (opts && typeof opts.fen === "string" && opts.fen.length > 0) {
      const r = computeUsingFenSimpleEngine(movesUci || [], opts || {});
      return r || null;
    }

    // If pool empty or jobQueue huge -> fallback quickly
    if (jobQueue.length >= JOB_QUEUE_LIMIT) {
      return computeUsingFenSimpleEngine(movesUci || [], opts || {});
    }

    // Try immediate assignment to a free worker
    const free = pickFreeWorker();
    if (free) {
      try {
        const move = await free.compute(movesUci || [], opts || {});
        if (move) return move;
        // if nil, fallback
        return computeUsingFenSimpleEngine(movesUci || [], opts || {});
      } catch (e) {
        return computeUsingFenSimpleEngine(movesUci || [], opts || {});
      }
    }

    // otherwise push into queue and return a promise that resolves when dispatched/resolved
    return await new Promise((resolve) => {
      const queuedAt = Date.now();
      jobQueue.push({
        moves: movesUci || [],
        opts: opts || {},
        resolve,
        reject: (err) => resolve(null),
        queuedAt,
        timeoutMs: Math.max(
          1200,
          Number(opts.movetimeMs || opts.movetime || 800) +
            WORKER_TIMEOUT_MARGIN
        ),
      });
      // attempt dispatch (in case a worker freed up very recently)
      try {
        dispatchNext();
      } catch (e) {}
      // also set a safety timer: if still in queue beyond timeout, resolve via fallback
      setTimeout(() => {
        // if still queued, remove it and fallback
        const idx = jobQueue.findIndex((j) => j.queuedAt === queuedAt);
        if (idx !== -1) {
          const job = jobQueue.splice(idx, 1)[0];
          try {
            const fallback = computeUsingFenSimpleEngine(
              job.moves || [],
              job.opts || {}
            );
            job.resolve(fallback);
          } catch (e) {
            job.resolve(null);
          }
        }
      }, Math.max(2000, Number(opts.movetimeMs || opts.movetime || 800) + 2000));
    });
  } catch (e) {
    return null;
  }
}

/* -------------------------
   Cleanup on parent exit
   ------------------------- */

function shutdownPool() {
  try {
    for (const w of pool) {
      try {
        if (w && w.child) safeKillChild(w.child);
      } catch (e) {}
    }
  } catch (e) {}
}

process.on("exit", shutdownPool);
process.on("SIGINT", () => {
  shutdownPool();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdownPool();
  process.exit(0);
});

module.exports = { computeBestMove };
