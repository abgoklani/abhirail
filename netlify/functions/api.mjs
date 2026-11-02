import { getStore } from "@netlify/blobs";

const BASE = "https://api.irctc.dev";
const TTL = {
  stations: 7 * 24 * 3600,
  trains: 6 * 3600,
  availability: 10 * 60,
  fare: 7 * 24 * 3600,
};
const env = (k) => (globalThis.Netlify && globalThis.Netlify.env ? globalThis.Netlify.env.get(k) : process.env[k]);

const memory = new Map();

function store(name) {
  try {
    return getStore({ name, consistency: "eventual" });
  } catch {
    return {
      async get(k, o) { const v = memory.get(name + ":" + k); return v == null ? null : (o && o.type === "json" ? JSON.parse(v) : v); },
      async setJSON(k, v) { memory.set(name + ":" + k, JSON.stringify(v)); },
    };
  }
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}
function fail(status, code, message) {
  return json({ ok: false, code, message }, status);
}

const CODE = /^[A-Z0-9]{2,6}$/;
const TRAIN = /^\d{5}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const CLASSES = new Set(["1A", "2A", "3A", "3E", "CC", "EC", "SL", "2S", "FC", "EV", "VS"]);
const QUOTAS = new Set(["GN", "TQ", "PT", "SS", "LD"]);
const toDMY = (iso) => iso.split("-").reverse().join("-");

async function cached(kind, key, loader) {
  const cache = store("rail-cache");
  const now = Math.floor(Date.now() / 1000);
  let hit = null;
  try { hit = await cache.get(kind + "/" + key, { type: "json" }); } catch {}
  if (hit && hit.exp > now) {
    if (hit.notFound) throw new Upstream(404, "NOT_FOUND", hit.message || "Not found.");
    return { data: hit.data, cachedAt: hit.at, cached: true };
  }
  let data;
  try {
    data = await loader();
  } catch (e) {
    if (e instanceof Upstream && e.status === 404) {
      try { await cache.setJSON(kind + "/" + key, { notFound: true, message: e.message, at: now, exp: now + 6 * 3600 }); } catch {}
    }
    throw e;
  }
  try { await cache.setJSON(kind + "/" + key, { data, at: now, exp: now + TTL[kind] }); } catch {}
  return { data, cachedAt: now, cached: false };
}

class Upstream extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function upstream(path, params) {
  const key = env("IRCTC_DEV_API_KEY");
  if (!key) throw new Upstream(500, "NO_KEY", "The railway data key is not set up yet.");
  const url = new URL(BASE + path);
  Object.entries(params || {}).forEach(([k, v]) => { if (v != null && v !== "") url.searchParams.set(k, v); });
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(url, { headers: { Authorization: "Bearer " + key, "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    } catch {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 600)); continue; }
      throw new Upstream(503, "UPSTREAM_DOWN", "The railway data service did not respond.");
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 0) { await new Promise((r) => setTimeout(r, 800)); continue; }
    break;
  }
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok || (body && body.success === false)) {
    const code = (body && body.code) || ({ 401: "UNAUTHORIZED", 402: "INSUFFICIENT_CREDITS", 404: "NOT_FOUND", 429: "RATE_LIMIT_EXCEEDED" }[res.status]) || "UPSTREAM_ERROR";
    throw new Upstream(res.status || 502, code, (body && (body.message || body.error)) || "The railway data service returned an error.");
  }
  return body;
}

export default async (req, context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const q = url.searchParams;
  if (req.method !== "GET") return fail(405, "METHOD", "Only GET is supported.");
  if (route === "health") return json({ ok: true, keySet: Boolean(env("IRCTC_DEV_API_KEY")) });

  try {
    if (route === "stations") {
      const term = (q.get("q") || "").trim().slice(0, 40);
      if (term.length < 2) return fail(400, "BAD_REQUEST", "Type at least 2 letters.");
      const r = await cached("stations", term.toLowerCase(), async () => {
        return (await upstream("/api/v1/trains/stations", { q: term })).data || [];
      });
      return json({ ok: true, data: r.data, cachedAt: r.cachedAt });
    }

    if (route === "trains") {
      const from = (q.get("from") || "").toUpperCase(), to = (q.get("to") || "").toUpperCase(), date = q.get("date") || "";
      if (!CODE.test(from) || !CODE.test(to) || !ISO.test(date)) return fail(400, "BAD_REQUEST", "Check the stations and date.");
      const r = await cached("trains", from + "-" + to + "-" + date, async () => {
        const b = await upstream("/api/v1/trains/search", { from, to, date });
        return Array.isArray(b.data) ? b.data : (b.data && b.data.trains) || [];
      });
      return json({ ok: true, data: r.data, cachedAt: r.cachedAt });
    }

    if (route === "availability") {
      const train = q.get("train") || "", from = (q.get("from") || "").toUpperCase(), to = (q.get("to") || "").toUpperCase();
      const date = q.get("date") || "", cls = (q.get("class") || "3A").toUpperCase(), quota = (q.get("quota") || "GN").toUpperCase();
      if (!TRAIN.test(train) || !CODE.test(from) || !CODE.test(to) || !ISO.test(date) || !CLASSES.has(cls) || !QUOTAS.has(quota)) return fail(400, "BAD_REQUEST", "Check the train, stations, date and class.");
      const r = await cached("availability", [train, from, to, date, cls, quota].join("-"), async () => {
        const b = await upstream("/api/v1/trains/" + train + "/availability", { from, to, date: toDMY(date), class: cls, quota });
        const list = Array.isArray(b.availability) ? b.availability : (b.data && b.data.availability) || [];
        const day = list.find((a) => a.date === date || a.date === toDMY(date)) || null;
        return { status: day ? day.status : null, days: list.slice(0, 6), trainName: b.trainName || null };
      });
      return json({ ok: true, data: r.data, cachedAt: r.cachedAt });
    }

    if (route === "fare") {
      const train = q.get("train") || "", from = (q.get("from") || "").toUpperCase(), to = (q.get("to") || "").toUpperCase(), quota = (q.get("quota") || "GN").toUpperCase();
      if (!TRAIN.test(train) || !CODE.test(from) || !CODE.test(to) || !QUOTAS.has(quota)) return fail(400, "BAD_REQUEST", "Check the train and stations.");
      const r = await cached("fare", [train, from, to, quota].join("-"), async () => {
        const b = await upstream("/api/v1/trains/" + train + "/fare", { from, to, class: "all", quota });
        const fares = {};
        (b.fares || (b.data && b.data.fares) || []).forEach((f) => { if (f && f.class) fares[f.class] = f.totalFare ?? (f.breakup && f.breakup.total) ?? null; });
        const classes = (b.availableClasses || []).map((c) => c.code || c).filter(Boolean);
        return { fares, classes };
      });
      return json({ ok: true, data: r.data, cachedAt: r.cachedAt });
    }

    return fail(404, "NOT_FOUND", "Unknown address.");
  } catch (e) {
    if (e instanceof Upstream) return fail(e.status >= 400 && e.status < 600 ? e.status : 502, e.code, e.message);
    return fail(500, "SERVER", "Something went wrong on the server.");
  }
};

export const config = {
  path: "/api/*",
  rateLimit: { windowLimit: 150, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
