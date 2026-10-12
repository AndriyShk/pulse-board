# Pulse Board

Repo: github.com/AndriyShk/pulse-board (the local folder is still called `xo-pulse`).

Community leaderboard for the [XO Market](https://beta.xo.market) Pulse PnL competition: every BTC Up or Down 5m trader, ranked by net profit / loss. Find your rank, share it as a card, see who's climbing.

- `index.html`: the whole site (static, no build step). Referral link, prizes and the prize-zone size are constants at the top of its script.
- `config.json`: competition window. `start` / `end` are ISO dates; while `start` is `null` the board is a rolling warm-up of the last `previewDays`. `metric` is `pnl` (XO's portfolio PnL, the default) or `net` (minus taker fees). `exclude` lists usernames kept off the board (XO's own market maker, `predictiontalk`).
- `scripts/build-board.mjs`: the indexer. Walks the Pulse rounds in the window, finds who traded, sums each trader's per-round PnL from their public portfolio, writes `data/board.json` (what the page reads) and `data/state.json` (so the next run only fetches what is new).
- `data/days.json`: the day-by-day record (who traded best on each UTC day), written by the same indexer run. Finished days are kept in `state.json` after they leave the window, for up to 60 days.
- `.github/workflows/board.yml`: runs the indexer every ~5 min and force-pushes the result to the `data` branch. The page reads `board.json` from raw.githubusercontent, so data updates never redeploy the site.
- Vercel Web Analytics: the snippet at the end of `<head>` in `index.html`; it also has to be switched on in the Vercel project (Analytics tab → Enable).
- `api/data.js`: serves `board.json` / `days.json` from the `data` branch through the GitHub API, because raw.githubusercontent caches a file for 5 minutes. The page reads through it and falls back to the raw file.
- `api/nudge.js`: GitHub's schedule is unreliable; when the page sees old data it calls this, and with a `GH_TOKEN` env var (fine-grained, Actions: write on this repo) it starts the workflow again.
- `scripts/publish.sh`: push local data to the `data` branch by hand.
- `dev.mjs`: local preview. `node dev.mjs` → http://localhost:8772; it also re-runs the indexer every 5 minutes, so the local board stays fresh.

## What counts

- A round counts when it opens and settles inside the window.
- PnL per round is the sum of the positions' `totalPnlInCollateral` from `/api/profiles/<user>/portfolio?marketScope=onlyClobPulse`: XO's own numbers, including limit-order fills and shares sold before the round ended, with fees left out. (The round-level `totalPnL` ignores what was realised by selling early.)
- This is the same accounting as "Net profit / loss" on XO's Pulse page. That figure is `lifetimePnLClobPulseMarkets` from `/api/profiles/<user>/clob-pulse-pnl` (lifetime only, no date filter) plus open positions; summing our per-round PnL over a trader's whole history reproduces it to the cent (checked on 2026-10-10: 19660.17 both ways over 5,494 rounds).
- Private profiles answer with an empty portfolio, so they are not ranked (the page says how many).
- Rank arrows and the recent-PnL column look back 24 hours, or 1 hour when the whole competition is two days or less.

## Setting the dates

Put the dates into `config.json` and push **before** the competition starts; the workflow then keeps the window filled in as rounds settle. If the window has to start in the past, run a full rebuild at home and publish it:

```sh
FULL=1 node scripts/build-board.mjs && scripts/publish.sh
```

## XO API notes

- 100 requests / 10 s; the indexer keeps to ~8 req/s. An incremental run is about 60 requests.
- `/markets` takes at most 50 rows; pages are newest-first but rows inside a page are shuffled.
- `/markets/<id>/activity` lists taker trades only. Maker fills show up only in the portfolio.
- `/users/portfolio` ignores `page` for Pulse; `/profiles/<user>/portfolio` pages correctly.
