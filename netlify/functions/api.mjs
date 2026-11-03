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
let cacheStore = null;
function store() {
  if (cacheStore) return cacheStore;
  try {
    cacheStore = getStore({ name: "rail-cache", consistency: "eventual" });
  } catch {
    cacheStore = {
      async get(k) { const v = memory.get(k); return v == null ? null : JSON.parse(v); },
      async setJSON(k, v) { memory.set(k, JSON.stringify(v)); },
    };
  }
  return cacheStore;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
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
const BLOCKING = new Set(["NO_KEY", "UNAUTHORIZED", "INVALID_API_KEY", "API_KEY_EXPIRED", "MISSING_API_KEY", "INSUFFICIENT_CREDITS"]);
const toDMY = (iso) => iso.split("-").reverse().join("-");

class Upstream extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function cached(kind, key, loader) {
  const cache = store();
  const now = Math.floor(Date.now() / 1000);
  const k = kind + "/" + key;
  let hit = null;
  try { hit = await cache.get(k, { type: "json" }); } catch {}
  if (hit && hit.exp > now) {
    if (hit.notFound) throw new Upstream(404, "NOT_FOUND", hit.message || "Not found.");
    return { data: hit.data, cachedAt: hit.at };
  }
  let data;
  try {
    data = await loader();
  } catch (e) {
    if (e instanceof Upstream && e.status === 404) {
      try { await cache.setJSON(k, { notFound: true, message: e.message, at: now, exp: now + 6 * 3600 }); } catch {}
    }
    throw e;
  }
  try { await cache.setJSON(k, { data, at: now, exp: now + TTL[kind] }); } catch {}
  return { data, cachedAt: now };
}

async function upstream(path, params, deadline) {
  const key = env("IRCTC_DEV_API_KEY");
  if (!key) throw new Upstream(500, "NO_KEY", "The railway data key is not set up yet.");
  const url = new URL(BASE + path);
  Object.entries(params || {}).forEach(([k, v]) => { if (v != null && v !== "") url.searchParams.set(k, v); });
  let res;
  const left = () => (deadline ? deadline - Date.now() : 20000);
  for (let attempt = 0; attempt < 3; attempt++) {
    const budget = Math.min(9000, left());
    if (budget < 1500) throw new Upstream(504, "TIMEOUT", "The railway data service is slow right now.");
    try {
      res = await fetch(url, { headers: { Authorization: "Bearer " + key, accept: "application/json" }, signal: AbortSignal.timeout(budget) });
    } catch {
      if (attempt === 0 && left() > 4000) { await new Promise((r) => setTimeout(r, 400)); continue; }
      throw new Upstream(504, "TIMEOUT", "The railway data service is slow right now.");
    }
    if (res.status === 429 && attempt < 2) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * (attempt + 1) + Math.random() * 500, 3000);
      if (left() - wait < 3000) break;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status >= 500 && attempt === 0 && left() > 4000) { await new Promise((r) => setTimeout(r, 600)); continue; }
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

function getFare(train, from, to, quota, deadline) {
  return cached("fare", [train, from, to, quota].join("-"), async () => {
    const b = await upstream("/api/v1/trains/" + train + "/fare", { from, to, class: "all", quota }, deadline);
    const fares = {};
    (b.fares || (b.data && b.data.fares) || []).forEach((f) => { if (f && f.class) fares[String(f.class).toUpperCase()] = f.totalFare ?? (f.breakup && f.breakup.total) ?? null; });
    const classes = (b.availableClasses || []).map((c) => String(c.code || c).toUpperCase()).filter(Boolean);
    return { fares, classes };
  });
}

function getAvailability(train, from, to, date, cls, quota, deadline) {
  return cached("availability", [train, from, to, date, cls, quota].join("-"), async () => {
    const b = await upstream("/api/v1/trains/" + train + "/availability", { from, to, date: toDMY(date), class: cls, quota }, deadline);
    const list = Array.isArray(b.availability) ? b.availability : (b.data && b.data.availability) || [];
    const now = Math.floor(Date.now() / 1000);
    await Promise.all(list.map(async (a) => {
      const d = /^\d{2}-\d{2}-\d{4}$/.test(a.date || "") ? a.date.split("-").reverse().join("-") : a.date;
      if (!d || d === date || !ISO.test(d)) return;
      try { await store().setJSON("availability/" + [train, from, to, d, cls, quota].join("-"), { data: { status: a.status, days: [], trainName: b.trainName || null }, at: now, exp: now + TTL.availability }); } catch {}
    }));
    const day = list.find((a) => a.date === date || a.date === toDMY(date)) || null;
    return { status: day ? day.status : null, days: list.slice(0, 6), trainName: b.trainName || null };
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const q = url.searchParams;
  if (req.method !== "GET") return fail(405, "METHOD", "Only GET is supported.");
  if (route === "health") return json({ ok: true, keySet: Boolean(env("IRCTC_DEV_API_KEY")) });

  try {
    if (route === "stations") {
      const term = (q.get("q") || "").trim().slice(0, 40);
      if (term.length < 2) return fail(400, "BAD_REQUEST", "Type at least 2 letters.");
      const r = await cached("stations", term.toLowerCase(), async () => (await upstream("/api/v1/trains/stations", { q: term })).data || []);
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

    if (route === "seats") {
      const train = q.get("train") || "", from = (q.get("from") || "").toUpperCase(), to = (q.get("to") || "").toUpperCase();
      const date = q.get("date") || "", quota = (q.get("quota") || "GN").toUpperCase();
      const wanted = (q.get("classes") || "").toUpperCase().split(",").filter((c) => CLASSES.has(c));
      if (!TRAIN.test(train) || !CODE.test(from) || !CODE.test(to) || !ISO.test(date) || !QUOTAS.has(quota)) return fail(400, "BAD_REQUEST", "Check the train, stations and date.");
      const deadline = Date.now() + 22000;
      let fares = {}, carried = [], at = 0;
      try {
        const f = await getFare(train, from, to, quota, Date.now() + 8000);
        fares = f.data.fares || {}; carried = [...new Set([...(f.data.classes || []), ...Object.keys(fares)])].filter((c) => CLASSES.has(c));
      } catch (e) {
        if (e instanceof Upstream && BLOCKING.has(e.code)) throw e;
      }
      let cls = carried.length ? carried : (wanted.length ? wanted.filter((c) => ["1A", "2A", "3A", "CC", "SL"].includes(c)) : ["SL", "3A", "2A", "1A"]);
      if (wanted.length) cls = cls.filter((c) => wanted.includes(c));
      const seats = new Array(cls.length);
      let next = 0;
      const worker = async () => {
        while (next < cls.length) {
          const i = next++, c = cls[i];
          if (deadline - Date.now() < 2000) { seats[i] = { class: c, status: null, fare: fares[c] ?? null, error: "TIMEOUT" }; continue; }
          try {
            const a = await getAvailability(train, from, to, date, c, quota, deadline);
            at = Math.max(at, a.cachedAt);
            seats[i] = { class: c, status: a.data.status, fare: fares[c] ?? null };
          } catch (e) {
            if (e instanceof Upstream && BLOCKING.has(e.code)) throw e;
            seats[i] = { class: c, status: null, fare: fares[c] ?? null, error: (e && e.code) || "ERROR" };
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      return json({ ok: true, data: { fares, classes: cls, seats, known: carried.length > 0 }, cachedAt: at || null });
    }

    if (route === "availability") {
      const train = q.get("train") || "", from = (q.get("from") || "").toUpperCase(), to = (q.get("to") || "").toUpperCase();
      const date = q.get("date") || "", cls = (q.get("class") || "3A").toUpperCase(), quota = (q.get("quota") || "GN").toUpperCase();
      if (!TRAIN.test(train) || !CODE.test(from) || !CODE.test(to) || !ISO.test(date) || !CLASSES.has(cls) || !QUOTAS.has(quota)) return fail(400, "BAD_REQUEST", "Check the train, stations, date and class.");
      const r = await getAvailability(train, from, to, date, cls, quota);
      return json({ ok: true, data: r.data, cachedAt: r.cachedAt });
    }

    if (route === "fare") {
      const train = q.get("train") || "", from = (q.get("from") || "").toUpperCase(), to = (q.get("to") || "").toUpperCase(), quota = (q.get("quota") || "GN").toUpperCase();
      if (!TRAIN.test(train) || !CODE.test(from) || !CODE.test(to) || !QUOTAS.has(quota)) return fail(400, "BAD_REQUEST", "Check the train and stations.");
      const r = await getFare(train, from, to, quota);
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
