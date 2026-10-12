// Builds data/board.json (the Pulse PnL leaderboard) from the public XO Data API.
// XO has no public leaderboard, so this walks every BTC 5min Pulse round in the competition window,
// collects who traded it, and sums each trader's own per-round PnL from their public portfolio.
// Usage: node scripts/build-board.mjs            incremental: new rounds + traders active lately
//        FULL=1 node scripts/build-board.mjs     rebuild the whole window from scratch
//        SEED=../xo-wrapped/users.json node ...  also check a username index (finds traders who only place limit orders)
// Node 18+, no dependencies.
import { writeFile, readFile, rename, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const API = "https://api-mainnet.xo.market/api";
const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const CONFIG = path("../config.json");
const STATE = path("../data/state.json");
const OUT = path("../data/board.json");
const DAYS = path("../data/days.json");
const KEEP_DAYS = 60; // finished days kept in the day-by-day record
const DAY = 864e5;
const ROUND = 5 * 6e4; // a Pulse round lasts five minutes
const RECENT = 3 * DAY; // traders seen this recently are re-checked on every run (limit-order fills leave no public trade)
const MAX_PAGES = 40; // activity pages per round
const SPARK = 96; // points in each trader's PnL line (the race chart and the row sparklines)

class Abort extends Error {}

// XO allows 100 requests per 10 s (x-ratelimit-* headers) and sits behind Cloudflare; stay well under it
const GAP = 125; // ms between request starts, ~8 req/s
let slot = 0, requests = 0;
async function pace() {
  const now = Date.now();
  slot = Math.max(slot + GAP, now);
  if (slot > now) await new Promise((ok) => setTimeout(ok, slot - now));
}
// Anything that isn't data aborts the run, so a rate limit or an outage never turns into "nobody traded".
async function getJSON(url, tries = 6) {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      await pace();
      requests++;
      const r = await fetch(url, { headers: { "User-Agent": "xo-pulse-board" } });
      if (r.status === 404) return null;
      if (r.status === 403 || (r.ok && !(r.headers.get("content-type") || "").includes("json")))
        throw new Abort(`Blocked by XO/Cloudflare (HTTP ${r.status})`);
      if (r.ok) return await r.json();
      last = `HTTP ${r.status}`;
      if (r.status === 429) {
        // the reset header is seconds-to-wait on a normal reply but an epoch timestamp on a 429
        let reset = Number(r.headers.get("retry-after") || r.headers.get("x-ratelimit-reset")) || 10;
        if (reset > 1e9) reset -= Date.now() / 1000;
        slot = Math.max(slot, Date.now() + (Math.min(Math.max(reset, 1), 60) + 1) * 1000);
        continue;
      }
    } catch (e) {
      if (e instanceof Abort) throw e;
      last = e.message;
    }
    await new Promise((ok) => setTimeout(ok, 1500 * 2 ** i));
  }
  throw new Abort(`Giving up on ${url}: ${last}`);
}
const pool = async (items, n, fn) => {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
};
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r2 = (x) => Math.round(x * 100) / 100;

// ---------- window ----------
const cfg = JSON.parse(await readFile(CONFIG, "utf8"));
const now = Date.now();
const tba = !cfg.start; // no dates yet: show a rolling warm-up window
const start = tba ? now - (cfg.previewDays || 7) * DAY : Date.parse(cfg.start);
const end = cfg.end ? Date.parse(cfg.end) : Infinity;
if (Number.isNaN(start) || Number.isNaN(end)) throw new Error("config.json: start/end must be ISO dates or null");
// accounts left off the board (XO's own market maker): never fetched, never ranked
const EXCLUDE = new Set((cfg.exclude || []).map((u) => u.toLowerCase()));
// a round counts when it both opens and settles inside the window
const inWindow = (exp) => exp - ROUND >= start && exp <= end;

// ---------- state ----------
// users: lowercase username -> { u, a (avatar), v (verified), c (rooster colour), p (private),
//                                r: { marketId: [expiresSec, pnl, stake] }, f: { marketId: takerFees } }
// rounds: marketId -> [expiresSec, volumeUSD] for every traded round
// days: "YYYY-MM-DD" (UTC) -> that day's ranking, kept after the day has left the window
// dayTotals: "YYYY-MM-DD" -> [traded rounds, volumeUSD] for that day
// meta: username -> [avatar, verified, colour], so old days can still show who it was
let state = { from: start, scanned: 0, users: {}, rounds: {}, days: {}, dayTotals: {}, meta: {} };
try { state = JSON.parse(await readFile(STATE, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
const FULL = !!process.env.FULL || start < state.from - ROUND; // the window now starts before what we have
if (FULL) state = { from: start, scanned: 0, users: {}, rounds: {}, days: state.days, dayTotals: state.dayTotals, meta: state.meta }; // the day record survives a rebuild
state.days ??= {};
state.dayTotals ??= {};
state.meta ??= {};
const user = (name) => (state.users[name.toLowerCase()] ??= { u: name, a: "", v: 0, c: "", p: 0, r: {}, f: {} });

async function save(board, days) {
  await mkdir(path("../data"), { recursive: true });
  // write to a temp file and rename, so an interrupted write can't truncate the data
  await writeFile(STATE + ".tmp", JSON.stringify(state));
  await rename(STATE + ".tmp", STATE);
  if (!board) return;
  await writeFile(OUT + ".tmp", JSON.stringify(board));
  await rename(OUT + ".tmp", OUT);
  await writeFile(DAYS + ".tmp", JSON.stringify(days));
  await rename(DAYS + ".tmp", DAYS);
}

// ---------- 1. new rounds ----------
// The list is newest-first page by page (rows inside a page are shuffled), so stop at the first page that is entirely old.
// Look back half an hour as well: the list is cached for a few minutes, so a round can show up late or with its volume still at 0.
const since = Math.max(state.scanned - 6 * ROUND, start);
const fresh = [];
for (let page = 1; ; page++) {
  const d = await getJSON(`${API}/markets?marketScope=onlyClobPulse&statuses=CLOSED,RESOLVED&page=${page}&take=50`);
  if (!d || !d.data) throw new Abort("Market list came back empty");
  let newest = 0;
  for (const m of d.data) {
    const exp = Date.parse(m.expiresAt);
    newest = Math.max(newest, exp);
    if (exp > since && exp <= Math.min(end, now) && !state.rounds[m.id]) fresh.push({ id: m.id, exp, vol: Number(m.totalVolumeInUSD || 0) });
  }
  if (newest <= since || !d.meta || !d.meta.hasNextPage) break;
}
console.log(`${fresh.filter((m) => m.vol > 0).length} new traded rounds since ${new Date(since).toISOString()}${FULL ? " (full rebuild)" : ""}`);

// ---------- 2. who traded them ----------
const dirty = new Set();
await pool(fresh.filter((m) => m.vol > 0), 4, async (m) => {
  const fees = new Map(); // lowercase username -> taker fees paid in this round
  for (let page = 1; page <= MAX_PAGES; page++) {
    const d = await getJSON(`${API}/markets/${m.id}/activity?page=${page}&take=50`);
    if (!d || !d.data) break;
    for (const a of d.data) {
      if (a.activityType !== "USER_TRADE" || !a.user || !a.user.username) continue;
      if (EXCLUDE.has(a.user.username.toLowerCase())) continue;
      const s = user(a.user.username);
      s.u = a.user.username;
      s.a = (a.user.profilePictureUrl || "").replace("https://pbs.twimg.com/profile_images/", "");
      s.v = a.user.verified ? 1 : 0;
      s.c = a.user.roosterColor || "";
      const k = s.u.toLowerCase();
      fees.set(k, (fees.get(k) || 0) + Number((a.tradingFee && a.tradingFee.feeInUSD) || 0));
      dirty.add(k);
    }
    if (!d.meta || !d.meta.hasNextPage) break;
  }
  for (const [k, fee] of fees) state.users[k].f[m.id] = r4(fee);
  state.rounds[m.id] = [m.exp / 1000, r2(m.vol)];
});
if (fresh.length) state.scanned = Math.max(state.scanned, ...fresh.map((m) => m.exp));

if (process.env.SEED) {
  for (const [name, avatar, verified] of JSON.parse(await readFile(process.env.SEED, "utf8"))) {
    if (state.users[name.toLowerCase()] || EXCLUDE.has(name.toLowerCase())) continue;
    const s = user(name);
    s.a = avatar || ""; s.v = verified ? 1 : 0; s.seed = 1;
    dirty.add(name.toLowerCase());
  }
}

// A round's PnL is the sum of its positions' `totalPnlInCollateral` (USDC, 6 decimals): settlement plus whatever was
// realised by selling before the round ended. The round-level `totalPnL` only values the shares still held at the end,
// so a position that was sold early shows up there as roughly $0 whatever it actually made or lost.
const roundPnl = (m) => (m.positions || []).reduce((sum, p) => sum + Number(p.totalPnlInCollateral || 0), 0) / 1e6;

// ---------- 3. each trader's rounds ----------
// The portfolio is XO's own per-round PnL, and unlike the trade feed it includes limit-order (maker) fills.
async function refresh(key, all) {
  const s = state.users[key];
  const known = Object.keys(s.r).length > 0;
  const take = all || !known ? (s.seed ? 50 : 500) : 100;
  const name = encodeURIComponent(s.u);
  for (let page = 1; ; page++) {
    // /profiles/<name>/portfolio pages properly; /users/portfolio ignores `page` for Pulse
    const d = await getJSON(`${API}/profiles/${name}/portfolio?marketScope=onlyClobPulse&sortBy=createdAt&sortOrder=DESC&page=${page}&take=${take}`);
    if (!d || !d.data) { s.gone = 1; return; } // renamed or deleted account
    if (page === 1 && !d.data.length) {
      // a private profile answers with an empty portfolio
      const p = await getJSON(`${API}/profiles/${name}`);
      s.p = p && p.isPrivate ? 1 : 0;
      if (s.p) s.r = {}; // went private: don't keep (or publish in state.json) rounds they have since hidden
      return;
    }
    s.p = 0;
    let changed = 0, old = 0;
    for (const m of d.data) {
      const exp = Date.parse(m.expiresAt);
      if (exp - ROUND < start) { old++; continue; }
      if (m.status !== "CLOSED" && m.status !== "RESOLVED") continue; // still open: not settled yet
      const rec = [exp / 1000, r4(roundPnl(m)), r4(m.totalStake || 0)];
      if (!rec[1] && !rec[2]) continue; // an order that never filled
      const prev = s.r[m.id];
      if (!prev || prev[1] !== rec[1] || prev[2] !== rec[2]) changed++;
      s.r[m.id] = rec;
    }
    // newest first: done once a page is entirely before the window, or (when topping up) brings nothing new
    if (!d.meta || !d.meta.hasNextPage || old === d.data.length || (take === 100 && known && !changed)) return;
  }
}
for (const k of Object.keys(state.users)) if (EXCLUDE.has(k)) delete state.users[k];
const todo = Object.keys(state.users).filter((k) => {
  const s = state.users[k];
  if (FULL || dirty.has(k)) return true;
  if (!Object.keys(s.r).length) return true; // not loaded yet, or private: a profile can be made public at any time
  const last = Math.max(0, ...Object.values(s.r).map((x) => x[0])) * 1000;
  return now - last < RECENT;
});
console.log(`Refreshing ${todo.length} of ${Object.keys(state.users).length} traders`);
let done = 0;
await pool(todo, 4, async (k) => {
  await refresh(k, FULL);
  if (++done % 200 === 0) { console.log(`…${done} traders`); await save(); }
});

// ---------- 4. prune + rank ----------
for (const [k, s] of Object.entries(state.users)) {
  for (const id of Object.keys(s.r)) if (s.r[id][0] * 1000 - ROUND < start) delete s.r[id];
  for (const id of Object.keys(s.f)) if (!state.rounds[id] || state.rounds[id][0] * 1000 - ROUND < start) delete s.f[id];
  delete s.seed;
  if (!s.p && !Object.keys(s.r).length && !Object.keys(s.f).length) delete state.users[k]; // nothing in the window
}
for (const id of Object.keys(state.rounds)) if (state.rounds[id][0] * 1000 - ROUND < start) delete state.rounds[id];
state.from = start;

const NET = cfg.metric === "net"; // rank by PnL after taker fees instead of XO's portfolio PnL
const upto = Math.min(now, end);
// "recently" for rank arrows and the recent-PnL column: a day, or an hour when the whole competition is two days or less
const LOOK = end - start <= 2 * DAY ? 36e5 : DAY;
const dayAgo = upto - LOOK;
const rows = [];
let hidden = 0;
for (const s of Object.values(state.users)) {
  if (s.p) { if (Object.keys(s.f).some((id) => inWindow(state.rounds[id][0] * 1000))) hidden++; continue; }
  const list = Object.entries(s.r).map(([id, [t, pnl, stake]]) => ({ id: +id, t: t * 1000, pnl: NET ? pnl - (s.f[id] || 0) : pnl, stake, fee: s.f[id] || 0 }))
    .filter((x) => inWindow(x.t)).sort((a, b) => a.t - b.t);
  if (!list.length) continue;
  let pnl = 0, vol = 0, fees = 0, wins = 0, losses = 0, streak = 0, bestStreak = 0, before = 0, seenBefore = false, best = null, worst = null;
  const spark = new Array(SPARK).fill(null);
  const span = Math.max(upto - start, 1);
  for (const x of list) {
    pnl += x.pnl; vol += x.stake; fees += x.fee;
    if (x.pnl > 0.005) { wins++; streak++; bestStreak = Math.max(bestStreak, streak); }
    else if (x.pnl < -0.005) { losses++; streak = 0; }
    if (x.t <= dayAgo) { before = pnl; seenBefore = true; }
    if (!best || x.pnl > best.pnl) best = x;
    if (!worst || x.pnl < worst.pnl) worst = x;
    spark[Math.min(SPARK - 1, Math.floor(((x.t - start) / span) * SPARK))] = pnl;
  }
  // carry the running total across buckets with no rounds
  let run = 0;
  for (let i = 0; i < SPARK; i++) { if (spark[i] == null) spark[i] = run; else run = spark[i]; spark[i] = r2(spark[i]); }
  rows.push({
    u: s.u, a: s.a, v: s.v, c: s.c,
    pnl: r2(pnl), fees: r2(fees), vol: r2(vol), rounds: list.length, wins, losses,
    streak, bestStreak, d24: r2(pnl - before), before: seenBefore ? before : null,
    best: best.pnl > 0 ? [r2(best.pnl), best.t] : null, worst: worst.pnl < 0 ? [r2(worst.pnl), worst.t] : null,
    last: list[list.length - 1].t, spark,
  });
}
rows.sort((a, b) => b.pnl - a.pnl || b.vol - a.vol);
// rank one LOOK ago. Traders who hadn't played yet stand at $0 there, so a newcomer only moves the people they really passed.
const then = [...rows].sort((a, b) => (b.before || 0) - (a.before || 0) || b.vol - a.vol);
then.forEach((r, i) => { r.prev = r.before == null ? null : i + 1; });
rows.forEach((r, i) => { r.rank = i + 1; delete r.before; });

const played = Object.values(state.rounds).filter(([t]) => inWindow(t * 1000));
const board = {
  updatedAt: Date.now(), // when the run finished, not when it started: a run on GitHub can take minutes
  window: { start, end: Number.isFinite(end) ? end : null, tba, previewDays: tba ? cfg.previewDays || 7 : null },
  metric: NET ? "net" : "pnl",
  look: LOOK,
  totals: { traders: rows.length, hidden, rounds: played.length, volume: r2(played.reduce((s, [, v]) => s + v, 0)) },
  rows,
};

// ---------- 5. day by day ----------
// Who traded best on each UTC day. Today is rebuilt on every run; a finished day keeps being rebuilt while it is
// fully inside the window and then stays as it was.
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const perDay = new Map(); // day -> Map(username -> totals)
const todayKey = dayKey(now), todayStart = Date.parse(todayKey + "T00:00:00Z"), todaySpan = Math.max(now - todayStart, 1);
const todaySpark = {}; // username -> running PnL through today, SPARK points from 00:00 UTC to now (the race chart)
for (const s of Object.values(state.users)) {
  if (s.p) continue;
  state.meta[s.u] = [s.a, s.v, s.c];
  const list = Object.entries(s.r).map(([id, [t, pnl, stake]]) => ({ t: t * 1000, pnl: NET ? pnl - (s.f[id] || 0) : pnl, stake }))
    .filter((x) => inWindow(x.t)).sort((a, b) => a.t - b.t);
  for (const x of list) {
    const k = dayKey(x.t - ROUND); // a round belongs to the day it opened on
    if (!perDay.has(k)) perDay.set(k, new Map());
    const day = perDay.get(k);
    if (!day.has(s.u)) day.set(s.u, { pnl: 0, vol: 0, rounds: 0, wins: 0, losses: 0, streak: 0, bestStreak: 0, best: 0 });
    const a = day.get(s.u);
    a.pnl += x.pnl; a.vol += x.stake; a.rounds++;
    if (x.pnl > 0.005) { a.wins++; a.streak++; a.bestStreak = Math.max(a.bestStreak, a.streak); }
    else if (x.pnl < -0.005) { a.losses++; a.streak = 0; }
    a.best = Math.max(a.best, x.pnl);
    if (k === todayKey) {
      const line = (todaySpark[s.u] ??= new Array(SPARK).fill(null));
      line[Math.min(SPARK - 1, Math.floor(((x.t - todayStart) / todaySpan) * SPARK))] = a.pnl;
    }
  }
}
// carry the running total across the gaps between a trader's rounds
for (const line of Object.values(todaySpark)) {
  let run = 0;
  for (let i = 0; i < SPARK; i++) { if (line[i] == null) line[i] = run; else run = line[i]; line[i] = r2(line[i]); }
}
for (const [k, users] of perDay) {
  if (Date.parse(k + "T00:00:00Z") < start) continue; // the window only covers part of this day
  // row: [username, pnl, volume, rounds, wins, losses, best streak, best round]
  state.days[k] = [...users].map(([u, a]) => [u, r2(a.pnl), r2(a.vol), a.rounds, a.wins, a.losses, a.bestStreak, r2(a.best)])
    .sort((a, b) => b[1] - a[1] || b[2] - a[2]);
}
// how much Pulse was traded each day (every round, private profiles included)
const dayTotals = new Map();
for (const [t, vol] of Object.values(state.rounds)) {
  if (!inWindow(t * 1000)) continue;
  const k = dayKey(t * 1000 - ROUND), a = dayTotals.get(k) || [0, 0];
  a[0]++; a[1] += vol;
  dayTotals.set(k, a);
}
for (const [k, a] of dayTotals) if (Date.parse(k + "T00:00:00Z") >= start) state.dayTotals[k] = [a[0], r2(a[1])];
// nobody who is excluded, or has since made their profile private, stays in the record
for (const k of Object.keys(state.days)) {
  state.days[k] = state.days[k].filter(([u]) => !EXCLUDE.has(u.toLowerCase()) && !(state.users[u.toLowerCase()] || {}).p);
  if (!state.days[k].length) delete state.days[k];
}
for (const k of Object.keys(state.days).sort().slice(0, -KEEP_DAYS)) delete state.days[k];
for (const k of Object.keys(state.dayTotals).sort().slice(0, -KEEP_DAYS)) delete state.dayTotals[k];
// with real dates only the competition's own days are shown; in the warm-up, the last 30
const shownDays = Object.keys(state.days).sort().reverse()
  .filter((k) => (tba ? true : k >= dayKey(start) && k <= dayKey(Math.min(end, now) - 1))).slice(0, tba ? 30 : KEEP_DAYS);
const names = new Set(shownDays.flatMap((k) => state.days[k].map(([u]) => u)));
for (const u of Object.keys(state.meta)) if (!Object.values(state.days).some((rows) => rows.some(([x]) => x === u))) delete state.meta[u];
const days = {
  updatedAt: Date.now(),
  today: dayKey(now),
  users: Object.fromEntries([...names].map((u) => [u, state.meta[u] || ["", 0, ""]])),
  days: shownDays.map((k) => ({ d: k, rounds: (state.dayTotals[k] || [0, 0])[0], volume: (state.dayTotals[k] || [0, 0])[1], rows: state.days[k] })),
  // today's totals even when nobody ranked has traded yet
  todayTotals: state.dayTotals[dayKey(now)] || [0, 0],
  todaySpark: Object.fromEntries(Object.entries(todaySpark).filter(([u]) => !EXCLUDE.has(u.toLowerCase()))),
};

await save(board, days);
console.log(`Done: ${rows.length} ranked traders (+${hidden} private), ${played.length} traded rounds, ${requests} requests`);
