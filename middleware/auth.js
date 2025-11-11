const jwt = require("jsonwebtoken");

/**
 * tryRequire(pathsArray)
 * Try multiple require() paths and return the first successful module.
 * If none found, rethrow the MODULE_NOT_FOUND error (or throw a clear error).
 */
function tryRequire(paths) {
  let lastErr = null;
  for (const p of paths) {
    try {
      return require(p);
    } catch (err) {
      // keep only MODULE_NOT_FOUND; rethrow other errors immediately
      if (err && err.code && err.code === "MODULE_NOT_FOUND") {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  // If we reach here none matched — throw a helpful message
  const msg = `tryRequire: none of the paths resolved: ${paths.join(", ")}`;
  const e = new Error(msg);
  e.code = "MODULE_NOT_FOUND";
  throw e;
}

// Try common relative paths so file works whether project root is backend/ or project/
const User = tryRequire([
  "../../models/User",
  "../models/User",
  "../../backend/models/User",
]);

const geoModule = tryRequire([
  "../../helpers/geo",
  "../helpers/geo",
  "../../backend/helpers/geo",
]);

const { fetchGeoForIp, normalizeIp, isLoopbackOrLocal } = geoModule;

// ---------- helpers for IP detection & geo (used by REST middleware) ----------
function detectClientIpFromReq(req) {
  const hdrs = [
    "x-client-ip",
    "x-forwarded-for",
    "x-real-ip",
    "cf-connecting-ip",
    "true-client-ip",
    "fastly-client-ip",
    "x-cluster-client-ip",
    "forwarded",
  ];

  for (const h of hdrs) {
    const v = req.headers[h];
    if (!v) continue;
    const first = v.split(",")[0].trim();
    const ip = normalizeIp(first);
    if (ip) return ip;
  }

  if (req.ip) {
    const ip = normalizeIp(req.ip);
    if (ip) return ip;
  }

  const sockIp =
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    (req.socket?.address && typeof req.socket.address === "function"
      ? req.socket.address().address
      : null) ||
    null;
  if (sockIp) {
    const ip = normalizeIp(sockIp);
    if (ip) return ip;
  }

  return "";
}

async function updateUserIpIfChangedFromReq(req, userId) {
  try {
    const detected = detectClientIpFromReq(req);
    const geo = await fetchGeoForIp(detected);
    const ipToSave = geo.ip || (detected ? detected : null);
    if (!ipToSave) return;

    const u = await User.findById(userId).exec();
    if (!u) return;
    if (u.lastIp && u.lastIp === ipToSave) return; // no change

    if (ipToSave) u.lastIp = ipToSave;
    if (geo.country) u.country = geo.country;
    await u.save();
  } catch (err) {
    console.error("updateUserIpIfChangedFromReq error", err);
  }
}
// ---------- end helpers ----------

// Helper: parse token from Authorization header or cookie header
function getTokenFromReq(req) {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2) return parts[1];
  }
  const cookieHeader = req.headers && req.headers.cookie;
  if (cookieHeader) {
    const parts = cookieHeader.split(";");
    for (const p of parts) {
      const kv = p.split("=").map((s) => s.trim());
      if (kv[0] === "token") {
        return decodeURIComponent(kv[1] || "");
      }
    }
  }
  return null;
}

// simple express auth middleware (same jwt secret as sockets)
// UPDATED: verify token AND update user's lastIp/country if it changed
async function restAuthMiddleware(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: "Missing auth" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    // try to update DB user ip/country (awaited so subsequent handlers see updated values)
    try {
      await updateUserIpIfChangedFromReq(req, decoded.id);
    } catch (err) {
      console.error("restAuthMiddleware IP update error", err);
    }

    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function verifyToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded;
  } catch (e) {
    return null;
  }
}

module.exports = {
  detectClientIpFromReq,
  updateUserIpIfChangedFromReq,
  restAuthMiddleware,
  verifyToken,
};
