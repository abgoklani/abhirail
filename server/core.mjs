/* AbhiRail server core. Runs unchanged on Cloudflare Pages Functions and Netlify Functions:
   the platform wrapper passes in env (k => value) and a store ({ get(k), set(k, v) }). */

const BASE = "https://api.irctc.dev";
const TTL = {
  stations: 7 * 24 * 3600,
  trains: 6 * 3600,
  schedule: 7 * 24 * 3600,
  availability: 10 * 60,
  fare: 7 * 24 * 3600,
};
let env = () => undefined;
let store = null;

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
// Answers that mean "irctc.dev has no live data for this", not "try again"
const UNAVAILABLE = new Set(["SEAT_AVAILABILITY_ERROR", "NOT_FOUND", "TRAIN_NOT_FOUND", "CLASS_NOT_AVAILABLE", "INVALID_CLASS", "NO_AVAILABILITY"]);
let limitSeen = null;

class Upstream extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// Seat status for a journey weeks away changes slowly; close to the date it changes fast.
// Sharing one answer between everyone who asks within this window is what keeps credits flat as users grow.
function availTtl(iso) {
  const ist = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(iso) - Date.parse(ist)) / 864e5);
  return days <= 1 ? 5 * 60 : days <= 3 ? 10 * 60 : days <= 10 ? 20 * 60 : 30 * 60;
}

async function cached(kind, key, loader, opts = {}) {
  const cache = store;
  const now = Math.floor(Date.now() / 1000);
  const k = kind + "/" + key;
  let hit = null;
  try { hit = await cache.get(k); } catch {}
  if (hit && hit.exp > now && !(opts.maxAge && now - hit.at > opts.maxAge)) {
    if (hit.notFound) throw new Upstream(404, hit.code || "NOT_FOUND", hit.message || "Not found.");
    return { data: hit.data, cachedAt: hit.at };
  }
  let data;
  try {
    data = await loader();
  } catch (e) {
    if (e instanceof Upstream && (e.status === 404 || UNAVAILABLE.has(e.code))) {
      const ttl = e.status === 404 ? 6 * 3600 : 20 * 60;
      try { await cache.set(k, { notFound: true, code: e.code, message: e.message, at: now, exp: now + ttl }); } catch {}
    }
    throw e;
  }
  // An empty train list may be a hiccup upstream, so it is kept for 30 minutes, not hours.
  const ttl = opts.ttl || (kind === "trains" && Array.isArray(data) && !data.length ? 30 * 60 : TTL[kind]);
  try { await cache.set(k, { data, at: now, exp: now + ttl }); } catch {}
  return { data, cachedAt: now };
}

async function upstream(path, params, deadline, noRetry429) {
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
    if (res.status === 429 || res.headers.get("x-ratelimit-limit") || res.headers.get("ratelimit-limit")) {
      const h = {};
      for (const [hk, hv] of res.headers) if (/ratelimit|retry-after/i.test(hk)) h[hk] = hv;
      if (res.status === 429 || !limitSeen || limitSeen.status !== 429 || Date.now() - limitSeen.at > 120000) limitSeen = { at: Date.now(), status: res.status, path: path.replace(/\d{5}/, "#"), headers: h };
    }
    if (res.status === 429 && attempt < 2 && !noRetry429) {
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
    const err = new Upstream(res.status || 502, code, (body && (body.message || body.error)) || "The railway data service returned an error.");
    if (res.status === 429) { err.retryAfter = Number(res.headers.get("retry-after")) || null; if (limitSeen) limitSeen.message = err.message; }
    throw err;
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

/* One stored row per train, stations, class and quota holds:
   d: the latest status for each journey date (every irctc.dev answer covers ~6 dates), and
   h: a history of snapshots per date, so AbhiRail can see how fast a waitlist is moving.
   A new snapshot is added when the status changes or 6 hours have passed.
   Keeping it in one row means one read and one write per availability call. */
const HIST_KEEP = 40, HIST_GAP = 6 * 3600;
const istDay = (offset = 0) => new Date(Date.now() + 5.5 * 3600e3 + offset * 864e5).toISOString().slice(0, 10);

/* Outcomes: when a journey date drops out of the window, AbhiRail keeps how far that date's
   waitlist had cleared at the last snapshot before charting (F = waitlisted tickets confirmed).
   A new booking whose booking position is B was confirmed on past dates where F >= B. */
const wlNums = (s) => [...String(s || "").toUpperCase().matchAll(/(?:[A-Z]*WL)\s*(\d+)/g)].map((x) => +x[1]);
const weekday = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();
function finalizeDate(row, d) {
  const h = row.h[d] || [];
  if (!h.length) return;
  const last = h[h.length - 1];
  const chartDay = Date.parse(d + "T00:00:00+05:30") / 1000;
  if (last[0] < chartDay - 2 * 86400) return; // no snapshot close enough to charting
  const maxB = Math.max(0, ...h.map((x) => wlNums(x[1])[0] || 0));
  const s = String(last[1]).toUpperCase();
  let F = null;
  if (/AVAIL|CNF/.test(s)) F = maxB; // every waitlisted ticket cleared
  else if (!/REGRET/.test(s)) { const n = wlNums(s); if (n.length >= 2) F = n[0] - n[n.length - 1]; }
  if (F == null || maxB === 0) return;
  row.o = (row.o || []).filter((x) => x[0] !== d);
  row.o.push([d, weekday(d), F, maxB]);
  if (row.o.length > 60) row.o = row.o.slice(-60);
}
function empirical(outcomes, status, date) {
  const n = wlNums(status);
  if (!outcomes || !outcomes.length || n.length < 1 || /REGRET/i.test(status)) return null;
  const B = n[0], wd = weekday(date);
  let yes = 0, all = 0, same = 0;
  outcomes.forEach((o) => { const w = o[1] === wd ? 2 : 1; all += w; if (o[1] === wd) same++; if (o[2] >= B) yes += w; });
  return { n: outcomes.length, same, p: Math.round((yes / all) * 100) / 100 };
}

async function getAvailability(train, from, to, date, cls, quota, deadline, maxAge, byCollector) {
  const key = "av/" + [train, from, to, cls, quota].join("-");
  let row = null;
  try { row = await store.get(key); } catch {}
  if (!row || typeof row !== "object") row = { d: {}, h: {} };
  row.d = row.d || {}; row.h = row.h || {};
  const now = Math.floor(Date.now() / 1000);
  const hit = row.d[date];
  if (hit) {
    const age = now - hit[0];
    const ttl = hit[2] ? 20 * 60 : availTtl(date);
    if (age < ttl && !(maxAge && age > maxAge)) {
      if (hit[2]) throw new Upstream(404, hit[2], "No live seat data for this train.");
      return { data: { status: hit[1] }, cachedAt: hit[0], hist: row.h[date] || [], outcomes: row.o || [] };
    }
  }
  let b;
  try {
    b = await upstream("/api/v1/trains/" + train + "/availability", { from, to, date: toDMY(date), class: cls, quota }, deadline, true);
  } catch (e) {
    if (e instanceof Upstream && (e.status === 404 || UNAVAILABLE.has(e.code))) {
      row.d[date] = [now, null, e.code];
      try { await store.set(key, row); } catch {}
    }
    throw e;
  }
  const list = Array.isArray(b.availability) ? b.availability : (b.data && b.data.availability) || [];
  let status = null;
  list.forEach((a) => {
    const d = /^\d{2}-\d{2}-\d{4}$/.test(a.date || "") ? a.date.split("-").reverse().join("-") : a.date;
    if (!d || !ISO.test(d)) return;
    if (d === date) status = a.status;
    row.d[d] = [now, a.status, null];
    if (a.status && /WL|AVAIL|RAC|REGRET/i.test(a.status)) {
      const h = row.h[d] || (row.h[d] = []);
      const last = h[h.length - 1];
      if (!last || last[1] !== a.status || now - last[0] >= HIST_GAP) {
        h.push([now, a.status]);
        if (h.length > HIST_KEEP) row.h[d] = [h[0]].concat(h.slice(-(HIST_KEEP - 1)));
      }
    }
  });
  if (!row.d[date]) row.d[date] = [now, null, null];
  const oldest = istDay(-2);
  Object.keys(row.h).forEach((d) => { if (d < istDay(0)) finalizeDate(row, d); });
  Object.keys(row.d).forEach((d) => { if (d < oldest) delete row.d[d]; });
  Object.keys(row.h).forEach((d) => { if (d < oldest) delete row.h[d]; });
  // exp marks the last time a person (not the collector) looked at this train; the collector follows rows for 30 days after that.
  if (!byCollector || !row.exp) row.exp = now + 30 * 86400;
  try { await store.set(key, row); } catch {}
  return { data: { status }, cachedAt: now, hist: row.h[date] || [], outcomes: row.o || [] };
}

// Optional access code (Netlify env ACCESS_CODE). The page sends it in the x-abhirail-code header.
async function codeOk(req) {
  const want = env("ACCESS_CODE");
  if (!want) return true;
  const got = (req.headers.get("x-abhirail-code") || "").trim().toLowerCase();
  const h = async (x) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(x))));
  const [a, b] = await Promise.all([h(got), h(want.trim().toLowerCase())]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* Daily collector (called by a scheduled GitHub Action at night). Re-checks every train, class
   and quota the family checked in the last 30 days, once a day, using the nearest journey date
   it runs on; each answer covers ~14 dates. Capped by COLLECT_DAILY (default 300) checks a day.
   It only ever touches already-searched trains, so calling it needs no access code. */
async function collect() {
  if (!store.list) return json({ ok: false, code: "UNSUPPORTED", message: "Collector needs the D1 store." }, 501);
  const today = istDay(0), budget = Number(env("COLLECT_DAILY")) || 300;
  let st = null;
  try { st = await store.get("collect/state"); } catch {}
  if (!st || st.day !== today) st = { day: today, done: [], calls: 0 };
  const done = new Set(st.done);
  if (st.calls >= budget) return json({ ok: true, finished: true, calls: st.calls, reason: "daily budget used" });
  const keys = (await store.list("av/")).filter((k) => !done.has(k));
  if (!keys.length) return json({ ok: true, finished: true, calls: st.calls });
  const started = Date.now();
  let checked = 0, paused = false;
  for (const k of keys) {
    if (checked >= 12 || st.calls >= budget || Date.now() - started > 40000) break;
    const [train, from, to, cls, quota] = k.slice(3).split("-");
    let row = null;
    try { row = await store.get(k); } catch {}
    done.add(k);
    if (!row || !TRAIN.test(train) || !CLASSES.has(cls)) continue;
    // Start from tomorrow so every upcoming date gets a snapshot close to charting;
    // if the train doesn't run tomorrow, fall back to the nearest date it is known to run.
    const known = Object.keys(row.d || {}).filter((d) => d > istDay(1) && row.d[d][1]).sort();
    const tries = [istDay(1)].concat(known.slice(0, 1));
    for (const day of tries) {
      try {
        const a = await getAvailability(train, from, to, day, cls, quota, Date.now() + 15000, 3 * 3600, true);
        if (a.cachedAt >= Math.floor(started / 1000)) { st.calls++; checked++; await new Promise((r) => setTimeout(r, 2100)); }
        break;
      } catch (e) {
        if (e instanceof Upstream && (e.code === "RATE_LIMIT_EXCEEDED" || BLOCKING.has(e.code))) { done.delete(k); paused = true; break; }
        st.calls++; checked++;
        if (!(e instanceof Upstream && (e.status === 404 || UNAVAILABLE.has(e.code)))) break;
      }
    }
    if (paused) break;
  }
  st.done = [...done];
  try { await store.set("collect/state", Object.assign(st, { exp: Math.floor(Date.now() / 1000) + 3 * 86400 })); } catch {}
  const left = keys.filter((k) => !done.has(k)).length;
  return json({ ok: true, finished: left === 0 || st.calls >= budget, checked, calls: st.calls, left, paused });
}

export async function handle(req, ctx) {
  env = ctx.env;
  store = ctx.store;
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const q = url.searchParams;
  if (req.method !== "GET") return fail(405, "METHOD", "Only GET is supported.");
  const unlocked = await codeOk(req);
  if (route === "health") return json({ ok: true, keySet: Boolean(env("IRCTC_DEV_API_KEY")), seatsPerMinute: Number(env("SEATS_PER_MINUTE")) || 9, codeRequired: Boolean(env("ACCESS_CODE")), codeOk: unlocked, limitSeen: unlocked ? limitSeen : null });
  if (!unlocked && route !== "collect") return fail(401, "CODE_REQUIRED", "Enter the access code to use AbhiRail.");

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
      const maxAge = q.get("fresh") === "1" ? 5 * 60 : 0; // "Refresh seats" accepts answers up to 5 minutes old
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
      let next = 0, retryAfter = 0;
      const worker = async () => {
        while (next < cls.length) {
          const i = next++, c = cls[i];
          if (deadline - Date.now() < 2000) { seats[i] = { class: c, status: null, fare: fares[c] ?? null, error: "TIMEOUT" }; continue; }
          try {
            const a = await getAvailability(train, from, to, date, c, quota, deadline, maxAge);
            at = Math.max(at, a.cachedAt);
            seats[i] = { class: c, status: a.data.status, fare: fares[c] ?? null };
            const emp = empirical(a.outcomes, a.data.status, date);
            if (emp) seats[i].emp = emp;
            const h = a.hist || [];
            if (a.data.status && /WL/i.test(a.data.status) && h.length && Math.floor(Date.now() / 1000) - h[0][0] >= 6 * 3600) seats[i].since = h[0];
          } catch (e) {
            if (e instanceof Upstream && BLOCKING.has(e.code)) throw e;
            if (e && e.retryAfter) retryAfter = Math.max(retryAfter, e.retryAfter);
            const code = (e && e.code) || "ERROR";
            seats[i] = { class: c, status: null, fare: fares[c] ?? null, error: UNAVAILABLE.has(code) ? "UNAVAILABLE" : code };
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      return json({ ok: true, data: { fares, classes: cls, seats, known: carried.length > 0, retryAfter: retryAfter || null }, cachedAt: at || null });
    }

    if (route === "collect") return await collect();

    // Instant results: whatever AbhiRail already knows (from earlier searches and the nightly
    // collector) for many trains at once, read from storage only: no railway call, no credits.
    if (route === "peek") {
      const date = q.get("date") || "", quota = (q.get("quota") || "GN").toUpperCase();
      const items = (q.get("items") || "").split(",").map((x) => x.split(":"))
        .filter((a) => a.length === 3 && TRAIN.test(a[0]) && CODE.test(a[1]) && CODE.test(a[2])).slice(0, 60);
      const cls = (q.get("classes") || "1A,2A,3A,3E,CC,EC,SL,2S").split(",").filter((c) => CLASSES.has(c));
      if (!ISO.test(date) || !items.length) return fail(400, "BAD_REQUEST", "Nothing to look up.");
      const keys = [];
      items.forEach(([t, f, o]) => { keys.push("fare/" + [t, f, o, quota].join("-")); cls.forEach((c) => keys.push("av/" + [t, f, o, c, quota].join("-"))); });
      let rows = {};
      if (store.getMany) rows = await store.getMany(keys);
      else await Promise.all(keys.map(async (k) => { try { rows[k] = await store.get(k); } catch {} }));
      const now = Math.floor(Date.now() / 1000), out = {};
      items.forEach(([t, f, o]) => {
        const fr = rows["fare/" + [t, f, o, quota].join("-")];
        const fd = fr && fr.data && !fr.notFound ? fr.data : null;
        const seats = [];
        cls.forEach((c) => {
          const r = rows["av/" + [t, f, o, c, quota].join("-")];
          const e = r && r.d && r.d[date];
          if (!e || now - e[0] > 24 * 3600) return;
          const x = { class: c, status: e[1], at: e[0] };
          if (e[2]) x.error = UNAVAILABLE.has(e[2]) ? "UNAVAILABLE" : e[2];
          const emp = empirical(r.o, e[1], date); if (emp) x.emp = emp;
          const h = (r.h && r.h[date]) || [];
          if (e[1] && /WL/i.test(e[1]) && h.length && now - h[0][0] >= 6 * 3600) x.since = h[0];
          seats.push(x);
        });
        if (seats.length) out[t] = { fares: fd ? fd.fares : {}, classes: fd ? fd.classes : [], seats, at: Math.min(...seats.map((x) => x.at)) };
      });
      return json({ ok: true, data: out });
    }

    if (route === "schedule") {
      const train = q.get("train") || "";
      if (!TRAIN.test(train)) return fail(400, "BAD_REQUEST", "Enter a 5-digit train number.");
      const r = await cached("schedule", train, async () => {
        const b = await upstream("/api/v1/trains/" + train, {});
        return b.data || b;
      });
      return json({ ok: true, data: r.data, cachedAt: r.cachedAt });
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
}
