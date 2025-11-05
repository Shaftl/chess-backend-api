// backend/helpers/geo.js
const geoip = require("geoip-lite");
const NodeCache = require("node-cache");
const fetchLib = global.fetch ? global.fetch : require("node-fetch");

const cache = new NodeCache({ stdTTL: 60 * 60, checkperiod: 120 }); // 1 hour

function normalizeIp(ip) {
  if (!ip) return "";
  if (ip.includes("::ffff:")) ip = ip.split("::ffff:").pop();
  ip = ip.split("%")[0];
  return ip.trim();
}

function isLoopbackOrLocal(ip) {
  if (!ip) return true;
  if (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
    ip.startsWith("169.254.")
  ) {
    return true;
  }
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) {
    return true;
  }
  return false;
}

function getFlagUrl(countryCode) {
  if (!countryCode) return null;
  return `https://flagcdn.com/w80/${String(countryCode).toLowerCase()}.png`;
}

/**
 * fetchGeoForIp(targetIp, { allowExternalFallback = true })
 * - Local lookup via geoip-lite first (no external calls, no rate limits)
 * - Optional ipapi.co fallback (beware rate-limit if you use free tier)
 * Returns: { country, flagUrl, ip, source, note? }
 */
async function fetchGeoForIp(targetIp, { allowExternalFallback = true } = {}) {
  try {
    const ip = normalizeIp(targetIp || "");
    const cacheKey = `geo:${ip || "auto"}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    // local lookup
    if (ip && !isLoopbackOrLocal(ip)) {
      const lookup = geoip.lookup(ip);
      if (lookup && lookup.country) {
        const out = {
          country: lookup.country,
          flagUrl: getFlagUrl(lookup.country),
          ip,
          source: "local",
        };
        cache.set(cacheKey, out);
        return out;
      }
    }

    if (!allowExternalFallback) {
      const out = {
        country: null,
        flagUrl: null,
        ip: ip || null,
        source: "none",
      };
      cache.set(cacheKey, out);
      return out;
    }

    // ipapi fallback
    const url =
      ip && !isLoopbackOrLocal(ip)
        ? `https://ipapi.co/${ip}/json/`
        : `https://ipapi.co/json/`;

    const fetcher = fetchLib || global.fetch;
    if (!fetcher)
      return { country: null, flagUrl: null, ip: ip || null, source: "none" };

    const r = await fetcher(url);
    const text = await r.text();

    if (r.status === 429) {
      // rate-limited: fallback to geoip result if available
      const lookup = ip ? geoip.lookup(ip) : null;
      const out = {
        country: lookup && lookup.country ? lookup.country : null,
        flagUrl: lookup && lookup.country ? getFlagUrl(lookup.country) : null,
        ip: ip || null,
        source: "local",
        note: "ipapi rate-limited (429)",
      };
      cache.set(cacheKey, out);
      return out;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const lookup = ip ? geoip.lookup(ip) : null;
      const out = {
        country: lookup && lookup.country ? lookup.country : null,
        flagUrl: lookup && lookup.country ? getFlagUrl(lookup.country) : null,
        ip: ip || null,
        source: "local",
        note: "ipapi returned non-JSON",
      };
      cache.set(cacheKey, out);
      return out;
    }

    const country = parsed.country_code || parsed.country || null;
    const ipResp = parsed.ip || parsed.ip_address || ip || null;
    const out = {
      country,
      flagUrl: country ? getFlagUrl(country) : null,
      ip: ipResp,
      source: "ipapi",
    };
    cache.set(cacheKey, out);
    return out;
  } catch (err) {
    try {
      const lookup = targetIp ? geoip.lookup(targetIp) : null;
      const out = {
        country: lookup && lookup.country ? lookup.country : null,
        flagUrl: lookup && lookup.country ? getFlagUrl(lookup.country) : null,
        ip: targetIp || null,
        source: "local",
        note: "error during external lookup",
      };
      return out;
    } catch (e) {
      return {
        country: null,
        flagUrl: null,
        ip: targetIp || null,
        source: "none",
      };
    }
  }
}

module.exports = {
  fetchGeoForIp,
  normalizeIp,
  isLoopbackOrLocal,
};
