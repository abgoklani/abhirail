import { getStore } from "@netlify/blobs";
import { handle } from "../../server/core.mjs";

const env = (k) => (globalThis.Netlify && globalThis.Netlify.env ? globalThis.Netlify.env.get(k) : process.env[k]);
const memory = new Map();
let blobStore = null;
function store() {
  if (blobStore) return blobStore;
  try {
    const s = getStore({ name: "rail-cache", consistency: "eventual" });
    blobStore = {
      async get(k) { try { return await s.get(k, { type: "json" }); } catch { return null; } },
      async set(k, v) { try { await s.setJSON(k, v); } catch {} },
    };
  } catch {
    blobStore = {
      async get(k) { const v = memory.get(k); return v == null ? null : JSON.parse(v); },
      async set(k, v) { memory.set(k, JSON.stringify(v)); },
    };
  }
  return blobStore;
}

export default (req) => handle(req, { env, store: store() });

export const config = {
  path: "/api/*",
  rateLimit: { windowLimit: 150, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
