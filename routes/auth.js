const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const router = express.Router();
const fetchLib = global.fetch ? global.fetch : require("node-fetch");

const {
  fetchGeoForIp,
  normalizeIp,
  isLoopbackOrLocal,
} = require("../helpers/geo");

/**
 * Cookie helper for consistent cross-site behavior
 * - When running under HTTPS / production we set SameSite=None and Secure=true so browsers accept cross-site cookies.
 * - For local dev (http) we keep SameSite=lax and secure=false so cookies work on localhost.
 */
function makeCookieOptions(req) {
  const forwardedProto = (req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const isSecure =
    req.secure ||
    forwardedProto === "https" ||
    process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    sameSite: isSecure ? "none" : "lax",
    secure: !!isSecure,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: "/",
    // domain: process.env.COOKIE_DOMAIN || undefined, // uncomment if you need a specific domain
  };
}

/**
 * tryRequire(pathsArray)
 * Try multiple require() paths and return the first successful module.
 * If none found, rethrow the MODULE_NOT_FOUND error (or throw a clear error).
 *
 * NOTE: In this file we already require ../models/User above, so tryRequire usage from
 * the prior version is not strictly needed here. Kept helper out of other modules.
 */
function tryRequire(paths) {
  let lastErr = null;
  for (const p of paths) {
    try {
      return require(p);
    } catch (err) {
      if (err && err.code && err.code === "MODULE_NOT_FOUND") {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  const msg = `tryRequire: none of the paths resolved: ${paths.join(", ")}`;
  const e = new Error(msg);
  e.code = "MODULE_NOT_FOUND";
  throw e;
}

function makeToken(user) {
  return jwt.sign(
    { id: user._id, username: user.username },
    process.env.JWT_SECRET
  );
}

function absoluteAvatarUrl(req, avatarUrl) {
  if (!avatarUrl) return null;
  if (/^https?:\/\//i.test(avatarUrl)) return avatarUrl;
  const base =
    process.env.BACKEND_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}${avatarUrl}`;
}

function detectClientIp(req) {
  const hdrs = [
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

function getTokenFromReq(req) {
  const authHeader =
    req.headers["authorization"] || req.headers["Authorization"];
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

async function updateUserIpIfChanged(req, userId) {
  try {
    const clientIpDetected = detectClientIp(req);
    const geo = await fetchGeoForIp(clientIpDetected);
    const ipToSave = geo.ip || (clientIpDetected ? clientIpDetected : null);

    if (!ipToSave) return;

    const u = await User.findById(userId).exec();
    if (!u) return;
    if (u.lastIp && u.lastIp === ipToSave) return;

    if (ipToSave) u.lastIp = ipToSave;
    if (geo.country) u.country = geo.country;
    await u.save();
  } catch (err) {
    console.error("updateUserIpIfChanged error", err);
  }
}

/* register */
router.post("/register", async (req, res) => {
  try {
    const { username, email, password, clientIp, dob } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: "Missing fields" });

    let parsedDob = null;
    if (dob) {
      const d = new Date(dob);
      if (!isNaN(d.getTime())) {
        if (d <= new Date()) parsedDob = d;
      }
    }

    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) return res.status(400).json({ error: "User exists" });

    const hash = await bcrypt.hash(password, 10);
    const user = new User({
      username,
      email,
      passwordHash: hash,
      displayName: username,
      dob: parsedDob,
    });

    const supplied = typeof clientIp === "string" ? normalizeIp(clientIp) : "";
    const serverDetected = detectClientIp(req) || "";
    const ipToLookup =
      supplied && !isLoopbackOrLocal(supplied)
        ? supplied
        : serverDetected || "";
    const geo = await fetchGeoForIp(ipToLookup);
    const ipToSave =
      geo.ip || (supplied ? supplied : serverDetected ? serverDetected : null);

    if (ipToSave) user.lastIp = ipToSave;
    if (geo.country) user.country = geo.country;

    await user.save();
    const token = makeToken(user);

    const cookieOptions = makeCookieOptions(req);
    res.cookie("token", token, cookieOptions);

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl || null,
        avatarUrlAbsolute: absoluteAvatarUrl(req, user.avatarUrl),
        bio: user.bio,
        country: user.country,
        cups: user.cups,
        lastIp: user.lastIp || null,
        dob: user.dob ? user.dob.toISOString() : null,
      },
      country: geo.country,
      flagUrl: geo.flagUrl,
      ip: geo.ip || ipToSave || null,
    });
  } catch (err) {
    console.error("register error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* login */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Missing fields" });

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ error: "Invalid credentials" });

    const token = makeToken(user);

    const cookieOptions = makeCookieOptions(req);
    res.cookie("token", token, cookieOptions);

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl || null,
        avatarUrlAbsolute: absoluteAvatarUrl(req, user.avatarUrl),
        bio: user.bio,
        country: user.country,
        cups: user.cups,
        lastIp: user.lastIp || null,
        dob: user.dob ? user.dob.toISOString() : null,
      },
    });
  } catch (err) {
    console.error("login error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* logout */
router.post("/logout", (req, res) => {
  try {
    res.clearCookie("token", makeCookieOptions(req));
    res.json({ ok: true });
  } catch (err) {
    console.error("logout error", err);
    res.status(500).json({ error: "Server error" });
  }
});

async function authMiddleware(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: "Missing auth" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    try {
      await updateUserIpIfChanged(req, decoded.id);
    } catch (err) {
      console.error("authMiddleware update IP error", err);
    }
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

router.get("/me", authMiddleware, async (req, res) => {
  try {
    const u = await User.findById(req.user.id).lean();
    if (!u) return res.status(404).json({ error: "Not found" });

    const flagUrl = u.country
      ? `https://flagcdn.com/w80/${u.country.toLowerCase()}.png`
      : null;

    res.json({
      id: u._id,
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      avatarUrl: u.avatarUrl || null,
      avatarUrlAbsolute: absoluteAvatarUrl(req, u.avatarUrl),
      bio: u.bio,
      country: u.country,
      cups: u.cups,
      lastIp: u.lastIp || null,
      flagUrl,
      dob: u.dob ? u.dob.toISOString() : null,
    });
  } catch (err) {
    console.error("/me error", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.put("/profile", authMiddleware, async (req, res) => {
  try {
    const { displayName, bio, cups, country, avatarUrl, dob } = req.body;
    const u = await User.findById(req.user.id);
    if (!u) return res.status(404).json({ error: "Not found" });

    if (typeof displayName === "string") u.displayName = displayName;
    if (typeof bio === "string") u.bio = bio;
    if (typeof cups === "number") u.cups = cups;
    if (typeof country === "string") u.country = country.toUpperCase();
    if (typeof avatarUrl === "string") u.avatarUrl = avatarUrl;

    if (dob) {
      const d = new Date(dob);
      if (!isNaN(d.getTime()) && d <= new Date()) {
        u.dob = d;
      }
    }

    await u.save();
    res.json({
      id: u._id,
      username: u.username,
      displayName: u.displayName,
      avatarUrl: u.avatarUrl || null,
      avatarUrlAbsolute: absoluteAvatarUrl(req, u.avatarUrl),
      bio: u.bio,
      country: u.country,
      cups: u.cups,
      lastIp: u.lastIp || null,
      dob: u.dob ? u.dob.toISOString() : null,
    });
  } catch (err) {
    console.error("/profile PUT error", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/location", async (req, res) => {
  try {
    const ip = (
      req.headers["x-forwarded-for"] ||
      req.connection.remoteAddress ||
      ""
    )
      .split(",")[0]
      .trim();
    const targetIp = ip === "::1" || ip === "127.0.0.1" ? "" : ip;
    const geo = await fetchGeoForIp(targetIp);
    res.json({ country: geo.country, flagUrl: geo.flagUrl });
  } catch (err) {
    console.error("location error", err);
    res.json({ country: null, flagUrl: null });
  }
});

module.exports = router;
