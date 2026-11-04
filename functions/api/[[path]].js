import { handle } from "../../server/core.mjs";

/* Cloudflare Pages Function for /api/*. Storage is the D1 database bound as DB:
   one table of key -> JSON. Writes made during a request are sent together in one
   batch after the response, which keeps each request well under D1's query limit.
   Without a DB binding the site still works, with a short-lived in-memory cache. */
const SCHEMA = "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL DEFAULT 0)";
const memory = new Map();
let ready = null;

function makeStore(db) {
  const pending = new Map();
  const prepare = async () => { ready = ready || db.prepare(SCHEMA).run().catch((e) => { ready = null; throw e; }); return ready; };
  return {
    async get(k) {
      if (pending.has(k)) return pending.get(k);
      if (!db) { const v = memory.get(k); return v == null ? null : JSON.parse(v); }
      try {
        await prepare();
        const r = await db.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first();
        return r ? JSON.parse(r.v) : null;
      } catch { return null; }
    },
    async list(prefix) {
      if (!db) return [...memory.keys()].filter((k) => k.startsWith(prefix));
      try {
        await prepare();
        const now = Math.floor(Date.now() / 1000);
        const r = await db.prepare("SELECT k FROM kv WHERE k LIKE ? AND exp > ? ORDER BY exp DESC LIMIT 1500").bind(prefix + "%", now).all();
        return (r.results || []).map((x) => x.k);
      } catch { return []; }
    },
    async set(k, v) {
      if (!db) { memory.set(k, JSON.stringify(v)); if (memory.size > 2000) memory.delete(memory.keys().next().value); return; }
      pending.set(k, v);
    },
    async flush() {
      if (!db || !pending.size) return;
      const now = Math.floor(Date.now() / 1000);
      try {
        await prepare();
        const put = db.prepare("INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)");
        const batch = [...pending].map(([k, v]) => put.bind(k, JSON.stringify(v), (v && v.exp) || now + 30 * 86400));
        if (Math.random() < 0.02) batch.push(db.prepare("DELETE FROM kv WHERE exp < ?").bind(now));
        await db.batch(batch);
      } catch {}
      pending.clear();
    },
  };
}

export async function onRequest(context) {
  const store = makeStore(context.env.DB);
  const res = await handle(context.request, { env: (k) => context.env[k], store });
  context.waitUntil(store.flush());
  return res;
}
