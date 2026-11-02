# AbhiRail

Live train seat status and confirmation chance for every train in your time window.

Live at https://abhirail-app.netlify.app

## How it works

- `public/` is the website: one page, the logo, app icons and an offline shell.
- `netlify/functions/api.mjs` is the server function at `/api/*`. It calls [irctc.dev](https://irctc.dev) with your key, caches answers in Netlify Blobs, and limits requests per visitor.
- The browser never sees the API key.

## Setup

1. In Netlify, import this repo (Add new project → Import an existing project → GitHub → `abhirail`). Netlify reads `netlify.toml`, so no build settings are needed.
2. In Netlify → Site configuration → Environment variables, add `IRCTC_DEV_API_KEY` with your irctc.dev key. Scope: Functions (or All).
3. Trigger a redeploy (Deploys → Trigger deploy → Deploy site).
4. Open the site. The status pill at the top should say "Live data ready".

## API routes

| Route | Purpose | Cache |
|---|---|---|
| `/api/health` | Shows whether the key is set | none |
| `/api/stations?q=` | Station search | 7 days |
| `/api/trains?from=&to=&date=YYYY-MM-DD` | Trains between two stations | 6 hours |
| `/api/availability?train=&from=&to=&date=&class=&quota=` | Seat status for one class | 10 minutes |
| `/api/fare?train=&from=&to=&quota=` | Fares for all classes | 7 days |

## Troubleshooting

Open the site with `#debug` at the end of the address to see the raw API answers under the results.
