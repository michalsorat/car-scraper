# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**Bazos Auto Skener** — a Node.js web app that scrapes today's new car listings from [auto.bazos.sk](https://auto.bazos.sk) (Slovak car marketplace), filters them by criteria, and ranks them by a scoring algorithm.

## Commands

```bash
npm install      # first time only
npm start        # starts server at http://localhost:3000
```

Then open `http://localhost:3000` in the browser and click "Spustiť skenovanie".

## Architecture

Three files contain all the logic:

- **`server.js`** — Express server, serves `public/` as static files, exposes `GET /api/scrape` as a Server-Sent Events (SSE) endpoint that streams scraping progress and results to the browser.
- **`scraper.js`** — All scraping logic. Exports `runScraper(emit, isAborted)`. Fetches bazos.sk directly (no CORS proxies needed — server-side). Uses `node-html-parser` for HTML parsing.
- **`public/index.html`** — Browser UI. Connects to `/api/scrape` via `EventSource`, renders cards as `result` events arrive. Contains all CSS and rendering logic.

### SSE event types emitted by scraper
| event | data |
|---|---|
| `progress` | `{pct, label}` |
| `log` | `{msg}` |
| `stats` | `{total, pass, pages}` |
| `summary` | `{total, pass, pages}` — emitted once before results |
| `result` | full car object with `rank`, `scores`, `totalScore` |
| `noResults` | `{reason: 'empty' | 'filter'}` |
| `error` | `{msg}` |
| `done` | `{}` |

### Scraping flow (5 phases in `scraper.js`)
1. Paginate overview pages until an older-than-today listing is found
2. Fetch each listing's detail page
3. Filter: power ≥ 110 kW, mileage ≤ 100,000 km, year ≥ 2021
4. Score each car (fuel type, power tier, mileage tier, year tier, price/kW ratio)
5. Sort by `totalScore` desc and emit `result` events

### Parsing strategy (3-tier fallback in `parseDetailPage`)
1. Table rows (`td`/`th` pairs) — most reliable
2. Text blocks via CSS selectors (`.listainzeratu`, `#popis`, etc.)
3. Raw regex on full page text

### Filtering criteria (hardcoded in `scraper.js` CONFIG)
- Price: 23,000–35,000 € (in the search URL query string)
- Power: ≥ 110 kW
- Mileage: ≤ 100,000 km
- Year: ≥ 2021
- Only listings with today's date
