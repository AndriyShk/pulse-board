# Pulse Board

Repo: github.com/AndriyShk/pulse-board (the local folder is still called `xo-pulse`).

Today's trading in [XO Market](https://beta.xo.market) Pulse (BTC Up or Down 5m), day by day: who's in profit, a race chart of the leaders, the top three, and a ranking for every day. Find your rank and share it as a card. A competition can be switched on as an event.

- `index.html`: the whole site (static, no build step). The referral link is a constant at the top of its script.
- `config.json`: `event` turns a competition on and off. With `"enabled": false` (the default) the site is plain Pulse statistics and nothing mentions a competition or prizes. To run one, set `"enabled": true`, give `start` / `end` as ISO dates (UTC) and, when known, `event.prizes` (e.g. `"$5,000 USDC"`), then push: the page shows the event chips, dates, prizes and a countdown, and the day strip covers the event's days. `windowDays` is how far back days are (re)built without an event. `metric` is `pnl` (XO's portfolio PnL, the default) or `net` (minus taker fees). `exclude` lists usernames kept off the board (XO's own market maker, `predictiontalk`).
- `scripts/build-board.mjs`: the indexer. Walks the Pulse rounds in the window, finds who traded, sums each trader's per-round PnL from their public portfolio and ranks every UTC day. Writes `data/days.json` and `data/state.json` (so the next run only fetches what is new; gitignored).
- `data/days.json`: the only data file the page reads: today's ranking and chart lines, the past days (up to 30 listed, 60 kept in `state.json`), today's totals and the event settings. The copy in the repo is only a fallback.
- `.github/workflows/board.yml`: runs the indexer every ~5 min and force-pushes the result to the `data` branch, so data updates never redeploy the site.
- `api/data.js`: serves `days.json` from the `data` branch through the GitHub API, because raw.githubusercontent caches a file for 5 minutes. The page reads through it and falls back to the raw file.
- `api/nudge.js`: GitHub's schedule is unreliable; when the page sees old data it calls this, and with a `GH_TOKEN` env var (fine-grained, Actions: write on this repo) it starts the workflow again.
- `scripts/publish.sh`: push local data to the `data` branch by hand.
- `dev.mjs`: local preview. `node dev.mjs` → http://localhost:8772; it also re-runs the indexer every 5 minutes, so the local data stays fresh.
- `og/og-src.html`: source of `og.png`, the link preview image.
- Vercel Web Analytics: the snippet at the end of `<head>` in `index.html`; it also has to be switched on in the Vercel project (Analytics tab → Enable).

## What counts

- A round belongs to the UTC day it opened on, and counts when it opens and settles inside the window.
- PnL per round is the sum of the positions' `totalPnlInCollateral` from `/api/profiles/<user>/portfolio?marketScope=onlyClobPulse`: XO's own numbers, including limit-order fills and shares sold before the round ended, with fees left out. (The round-level `totalPnL` ignores what was realised by selling early.)
- This is the same accounting as "Net profit / loss" on XO's Pulse page. That figure is `lifetimePnLClobPulseMarkets` from `/api/profiles/<user>/clob-pulse-pnl` (lifetime only, no date filter) plus open positions; summing our per-round PnL over a trader's whole history reproduces it to the cent (checked on 2026-10-10: 19660.17 both ways over 5,494 rounds).
- Private profiles answer with an empty portfolio, so they are not ranked (the page says how many).

## Running a competition

Put the dates into `config.json` and push **before** the competition starts; the workflow then keeps the window filled in as rounds settle. If the window has to start in the past, run a full rebuild at home (a full crawl is thousands of requests, which Cloudflare blocks from GitHub's servers) and publish it:

```sh
FULL=1 node scripts/build-board.mjs && scripts/publish.sh
```

## XO API notes

- 100 requests / 10 s; the indexer keeps to ~8 req/s. An incremental run is about 60 requests.
- `/markets` takes at most 50 rows; pages are newest-first but rows inside a page are shuffled.
- `/markets/<id>/activity` lists taker trades only. Maker fills show up only in the portfolio.
- `/users/portfolio` ignores `page` for Pulse; `/profiles/<user>/portfolio` pages correctly.
