# Halton Home Board — Live

Live rental investigation board for Fergus, Acton, Milton, Oakville, and Burlington.
On-demand crawler pulls candidates from REALTOR.ca, Skyline Living, and Apartments.com
and feeds them into a manual review queue.

## Architecture

```
/index.html       single-file mobile-first frontend (vanilla JS, localStorage)
/api/crawl.js     Vercel serverless function: cheerio crawlers + REALTOR.ca API
/package.json     cheerio dependency
/vercel.json      function timeout + cache headers
```

The repo deploys as-is to Vercel. The frontend is a static file served at `/`,
and the crawler runs at `/api/crawl`.

## How the crawler works

`POST/GET /api/crawl` runs three crawlers in parallel via `Promise.allSettled`:

1. **Skyline Living** — fetches each city's building list page, then each
   building's detail page, and parses the cheapest listed suite price with cheerio.
2. **REALTOR.ca** — calls the public `PropertySearch_Post` JSON endpoint
   used by realtor.ca itself, with a bounding box per target town.
3. **Apartments.com** — fetches each city's `max-1350` results page and parses
   the SSR'd placards with cheerio.

Each crawler is wrapped in try/catch — one failing source never breaks the
response. The frontend dedupes results against its `approved`, `pending`, and
`rejected` sets in localStorage.

> ⚠️ REALTOR.ca and Apartments.com both have anti-bot defenses. The crawler may
> get rate-limited or temporarily blocked from Vercel's shared IP pool. The
> Skyline crawler is the most reliable.

## Frontend behaviour

- **Floating refresh button (FAB)** — bottom-right, pulses when there are
  pending candidates, spins while crawling. A click hits `/api/crawl`.
- **Auto-crawl** — runs on page load if the last crawl is older than 5 minutes.
- **Review queue** — between the banner and the main list. Each candidate has
  Approve / Reject / View buttons.
- **Approve** → adds to the main list with a NEW badge for 7 days.
- **Reject** → suppresses the candidate permanently (stored by URL key).
- **Statuses** — `to_contact → contacted → viewing → shortlist → passed`.

All state is in `localStorage` under keys prefixed `halton_*_v2`.

## Deploy

The repo is already wired to Vercel via the GitHub integration. After committing,
push `main` and Vercel will deploy automatically. Function logs are visible in
the Vercel dashboard.

## Roadmap

- Auto-cron crawl every 30 min via Vercel Cron + Vercel KV
- Per-source toggles in the UI
- "Why this matches" auto-generated reason field
- Distance-from-work chip
- Manual entry form for Facebook Marketplace finds (excluded from auto-crawl)
