// Builds data/days.json, the only data file the page reads, from the public XO Data API.
// XO has no public leaderboard, so this walks the BTC 5min Pulse rounds in the window, collects who traded them,
// reads each trader's own per-round PnL from their public portfolio, and ranks every UTC day.
// Usage: node scripts/build-board.mjs            incremental: new rounds + traders active lately
//        FULL=1 node scripts/build-board.mjs     rebuild the whole window from scratch
// Node 18+, no dependencies.
import { writeFile, readFile, rename, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const API = "https://api-mainnet.xo.market/api";
const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const CONFIG = path("../config.json");
const STATE = path("../data/state.json");
const OUT = path("../data/days.json");
const DAY = 864e5;
const ROUND = 5 * 6e4; // a Pulse round lasts five minutes
const RECENT = 3 * DAY; // traders seen this recently are re-checked on every run (limit-order fills leave no public trade)
const MAX_PAGES = 40; // activity pages per round
const SPARK = 96; // points in each trader's PnL line for today (the race chart)
const COMP_SPARK = 168; // points in each trader's line over a competition (two weeks: one every two hours)
const KEEP_DAYS = 60; // finished days kept in the record
const SHOWN_DAYS = 30; // days the page lists when no competition is on

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
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10); // UTC day, "YYYY-MM-DD"
const dayOf = (expSec) => dayKey(expSec * 1000 - ROUND); // a round belongs to the day it opened on

// ---------- window ----------
const cfg = JSON.parse(await readFile(CONFIG, "utf8"));
const now = Date.now();
// A competition is an event switched on in config.json ("event": { "enabled": true, ... } plus start/end, UTC).
// The daily statistics always cover the last `windowDays`; while a competition is set, the window also reaches back to
// its start, so its whole run stays in the record. The competition gets its own ranking (`event` in days.json).
const event = cfg.event && cfg.event.enabled && cfg.start ? cfg.event : null;
const evStart = event ? Date.parse(cfg.start) : null;
const evEnd = event && cfg.end ? Date.parse(cfg.end) : Infinity;
if (Number.isNaN(evStart) || Number.isNaN(evEnd)) throw new Error("config.json: start/end must be ISO dates or null");
const start = Math.min(now - (cfg.windowDays || 7) * DAY, event ? evStart : Infinity);
const end = Infinity;
// accounts left off the board (XO's own market maker): never fetched, never ranked
const EXCLUDE = new Set((cfg.exclude || []).map((u) => u.toLowerCase()));
const NET = cfg.metric === "net"; // rank by PnL after taker fees instead of XO's portfolio PnL
// a round counts when it both opens and settles inside the window (the competition uses the same rule for its own dates)
const inWindow = (exp) => exp - ROUND >= start && exp <= end;
const inEvent = (exp) => !!event && exp - ROUND >= evStart && exp <= evEnd;

// ---------- state ----------
// users: lowercase username -> { u, a (avatar), v (verified), c (rooster colour), p (private),
//                                r: { marketId: [expiresSec, pnl, stake] }, f: { marketId: takerFees } }
// rounds: marketId -> [expiresSec, volumeUSD] for every traded round in the window
// days: "YYYY-MM-DD" (UTC) -> that day's ranking, kept after the day has left the window
// meta: username -> [avatar, verified, colour], so old days can still show who it was
let state = { from: start, scanned: 0, users: {}, rounds: {}, days: {}, meta: {} };
try { state = { ...state, ...JSON.parse(await readFile(STATE, "utf8")) }; } catch (e) { if (e.code !== "ENOENT") throw e; }
const FULL = !!process.env.FULL || start < state.from - ROUND; // the window now starts before what we have
if (FULL) state = { from: start, scanned: 0, users: {}, rounds: {}, days: state.days, meta: state.meta }; // the day record survives a rebuild
const user = (name) => (state.users[name.toLowerCase()] ??= { u: name, a: "", v: 0, c: "", p: 0, r: {}, f: {} });

// write to a temp file and rename, so an interrupted write can't truncate the data
async function write(file, value) {
  await mkdir(path("../data"), { recursive: true });
  await writeFile(file + ".tmp", JSON.stringify(value));
  await rename(file + ".tmp", file);
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

// ---------- 3. each trader's rounds ----------
// A round's PnL is the sum of its positions' `totalPnlInCollateral` (USDC, 6 decimals): settlement plus whatever was
// realised by selling before the round ended. The round-level `totalPnL` only values the shares still held at the end,
// so a position that was sold early shows up there as roughly $0 whatever it actually made or lost.
const roundPnl = (m) => (m.positions || []).reduce((sum, p) => sum + Number(p.totalPnlInCollateral || 0), 0) / 1e6;

// The portfolio is XO's own per-round PnL, and unlike the trade feed it includes limit-order (maker) fills.
async function refresh(key, all) {
  const s = state.users[key];
  const known = Object.keys(s.r).length > 0;
  const take = all || !known ? 500 : 100;
  const name = encodeURIComponent(s.u);
  for (let page = 1; ; page++) {
    // /profiles/<name>/portfolio pages properly; /users/portfolio ignores `page` for Pulse
    const d = await getJSON(`${API}/profiles/${name}/portfolio?marketScope=onlyClobPulse&sortBy=createdAt&sortOrder=DESC&page=${page}&take=${take}`);
    // renamed or deleted: the name is gone (a rename comes back under the new name), so its rounds go too, or the
    // same trades would be ranked twice; a 404 that was only a hiccup heals on the next run, which reads them all again
    if (!d) { s.r = {}; return; }
    if (!d.data) return;
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
    if (!d.meta || !d.meta.hasNextPage || old === d.data.length || (take === 100 && !changed)) return;
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
  if (++done % 200 === 0) { console.log(`…${done} traders`); await write(STATE, state); }
});

// ---------- 4. drop what has left the window ----------
for (const [k, s] of Object.entries(state.users)) {
  for (const id of Object.keys(s.r)) if (!inWindow(s.r[id][0] * 1000)) delete s.r[id];
  for (const id of Object.keys(s.f)) if (!state.rounds[id] || !inWindow(state.rounds[id][0] * 1000)) delete s.f[id];
  if (!s.p && !Object.keys(s.r).length && !Object.keys(s.f).length) delete state.users[k]; // nothing in the window
}
for (const id of Object.keys(state.rounds)) if (!inWindow(state.rounds[id][0] * 1000)) delete state.rounds[id];
state.from = start;

// ---------- 5. rank every day ----------
// Today is rebuilt on every run; a finished day keeps being rebuilt while it is fully inside the window and then stays as it was.
const today = dayKey(now), todayStart = Date.parse(today + "T00:00:00Z"), todaySpan = Math.max(now - todayStart, 1);
const perDay = new Map(); // day -> Map(username -> totals)
const todaySpark = {}; // username -> running PnL through today, SPARK points from 00:00 UTC to now
for (const s of Object.values(state.users)) {
  if (s.p) continue;
  state.meta[s.u] = [s.a, s.v, s.c];
  const list = Object.entries(s.r).map(([id, [t, pnl, stake]]) => ({ t, pnl: NET ? pnl - (s.f[id] || 0) : pnl, stake })).sort((a, b) => a.t - b.t);
  for (const x of list) {
    const k = dayOf(x.t);
    if (!perDay.has(k)) perDay.set(k, new Map());
    const day = perDay.get(k);
    if (!day.has(s.u)) day.set(s.u, { pnl: 0, vol: 0, rounds: 0, wins: 0, losses: 0, streak: 0, bestStreak: 0, best: 0 });
    const a = day.get(s.u);
    a.pnl += x.pnl; a.vol += x.stake; a.rounds++;
    if (x.pnl > 0.005) { a.wins++; a.streak++; a.bestStreak = Math.max(a.bestStreak, a.streak); }
    else if (x.pnl < -0.005) { a.losses++; a.streak = 0; }
    a.best = Math.max(a.best, x.pnl);
    if (k === today) {
      const line = (todaySpark[s.u] ??= new Array(SPARK).fill(null));
      line[Math.min(SPARK - 1, Math.floor(((x.t * 1000 - todayStart) / todaySpan) * SPARK))] = a.pnl;
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
// nobody who is excluded, or has since made their profile private, stays in the record
for (const k of Object.keys(state.days)) {
  state.days[k] = state.days[k].filter(([u]) => !EXCLUDE.has(u.toLowerCase()) && !(state.users[u.toLowerCase()] || {}).p);
  if (!state.days[k].length) delete state.days[k];
}
for (const k of Object.keys(state.days).sort().slice(0, -KEEP_DAYS)) delete state.days[k];
// ---------- 5b. the competition ----------
// Every round that opens and settles between its start and end, whatever UTC day that is (it starts at 12:00).
// row: [username, pnl, volume, rounds, wins, losses, best streak, best round], best first
let comp = null, cSpanOf = () => 1;
if (event) {
  const crow = [], cspark = {};
  // the competition's race chart: running PnL from the start to the last update (or the end), COMP_SPARK points
  const cEnd = Math.min(now, evEnd), cSpan = Math.max(cEnd - evStart, 1);
  cSpanOf = () => cSpan;
  for (const s of Object.values(state.users)) {
    if (s.p || EXCLUDE.has(s.u.toLowerCase())) continue;
    const list = Object.entries(s.r).filter(([, [t]]) => inEvent(t * 1000))
      .map(([id, [t, pnl, stake]]) => ({ t, pnl: NET ? pnl - (s.f[id] || 0) : pnl, stake })).sort((a, b) => a.t - b.t);
    if (!list.length) continue;
    const a = { pnl: 0, vol: 0, rounds: 0, wins: 0, losses: 0, streak: 0, bestStreak: 0, best: 0 };
    const line = new Array(COMP_SPARK).fill(null);
    for (const x of list) {
      a.pnl += x.pnl; a.vol += x.stake; a.rounds++;
      if (x.pnl > 0.005) { a.wins++; a.streak++; a.bestStreak = Math.max(a.bestStreak, a.streak); }
      else if (x.pnl < -0.005) { a.losses++; a.streak = 0; }
      a.best = Math.max(a.best, x.pnl);
      line[Math.min(COMP_SPARK - 1, Math.max(0, Math.floor(((x.t * 1000 - evStart) / cSpan) * COMP_SPARK)))] = a.pnl;
    }
    let run = 0;
    for (let i = 0; i < COMP_SPARK; i++) { if (line[i] == null) line[i] = run; else run = line[i]; line[i] = r2(line[i]); }
    cspark[s.u] = line;
    state.meta[s.u] = [s.a, s.v, s.c];
    crow.push([s.u, r2(a.pnl), r2(a.vol), a.rounds, a.wins, a.losses, a.bestStreak, r2(a.best)]);
  }
  crow.sort((a, b) => b[1] - a[1] || b[2] - a[2]);
  comp = {
    name: event.name || "PnL competition", prizes: event.prizes || null, url: event.url || null, slug: event.slug || null, start: evStart, end: Number.isFinite(evEnd) ? evEnd : null,
    rows: crow,
    spark: cspark, // username -> running PnL, from the start to `sparkTo`
    sparkTo: cEnd,
    rounds: Object.values(state.rounds).filter(([t]) => inEvent(t * 1000)).length, // rounds anyone traded, private profiles included
    hidden: Object.values(state.users).filter((s) => s.p && Object.keys(s.f).some((id) => state.rounds[id] && inEvent(state.rounds[id][0] * 1000))).length,
  };
}

// ---------- 5c. XO's official contest board ----------
// Only traders who joined the contest, scored from their trades after joining (XO's own numbers). XO keeps no history,
// so every run records each trader's score when it changed; the race chart is drawn from that record.
// state.official: username -> [[unixSeconds, score], ...]
if (comp && event.slug) {
  try {
    const items = [];
    for (let page = 1; page <= 20; page++) {
      const d = await getJSON(`${API}/contests/${encodeURIComponent(event.slug)}/leaderboard?page=${page}&pageSize=50`);
      if (!d || !d.items) break;
      items.push(...d.items);
      if (!d.items.length || items.length >= (d.total || 0)) break;
    }
    const detail = await getJSON(`${API}/contests/${encodeURIComponent(event.slug)}`).catch(() => null);
    state.official ??= {};
    const at = Math.floor(now / 1000);
    for (const it of items) {
      const h = (state.official[it.username] ??= []), last = h[h.length - 1], v = r2(Number(it.score || 0));
      if (!last || last[1] !== v) h.push([at, v]);
    }
    const spark = {};
    for (const [u, h] of Object.entries(state.official)) {
      if (!items.some((it) => it.username === u)) continue; // left the board
      const line = new Array(COMP_SPARK);
      for (let i = 0, j = -1; i < COMP_SPARK; i++) {
        const t = (evStart + ((i + 1) / COMP_SPARK) * cSpanOf()) / 1000;
        while (j + 1 < h.length && h[j + 1][0] <= t) j++;
        line[i] = j < 0 ? 0 : h[j][1];
      }
      spark[u] = line;
    }
    comp.official = { spark, sparkTo: Math.min(now, evEnd) };
    console.log(`official board: ${items.length} traders`);
    // XO's board as of the last run that read it. The page reads XO directly and falls back on this copy, so the final
    // standings stay up if XO stops serving the board after the end. An empty answer never replaces a full one.
    if (items.length) {
      const keep = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
      state.board = {
        updatedAt: now,
        detail: detail ? keep(detail, ["budgetCp", "budgetUsdc", "participantCount", "prizeBands", "minQualifyingVolumeUsdc", "minTradeUsdc", "eligibility"]) : state.board?.detail ?? null,
        items: items.map((it) => keep(it, ["username", "profilePictureUrl", "pnlUsdc", "score", "volumeUsdc", "qualified", "rank"])),
        official: comp.official,
      };
    }

    // ---------- 5d. volume XO would count, for traders not on its board ----------
    // XO's public board lists only qualified traders, so for everyone else we estimate the volume it counts the way it
    // does: their Pulse fills of at least the minimum size since the start (exact for anyone who joined before it).
    // Checked against XO's own "Counted volume" on 2026-10-20: 79.44 here, 79.42 there. Incremental: newest first,
    // stopping at the last fill already counted. state.cvol: username -> { v: volume, t: newest fill (ms), k: keys at t }
    const minFill = detail && detail.minTradeUsdc != null ? Number(detail.minTradeUsdc) : 5;
    state.cvol ??= {};
    const onBoard = new Set(items.filter((it) => it.qualified).map((it) => it.username.toLowerCase()));
    const contestants = comp.rows.map(([u]) => u).filter((u) => !onBoard.has(u.toLowerCase()));
    await pool(contestants, 4, async (u) => {
      const c = (state.cvol[u] ??= { v: 0, t: 0, k: [] }), seenAt = new Set(c.k);
      let newest = c.t, keys = [...c.k], add = 0;
      outer: for (let page = 1; page <= 30; page++) {
        const d = await getJSON(`${API}/profiles/${encodeURIComponent(u)}/activities?marketScope=onlyClobPulse&sortBy=executedAt&sortOrder=DESC&page=${page}&take=100`);
        if (!d || !d.data || !d.data.length) break;
        for (const a of d.data) {
          const t = Date.parse(a.date), key = `${a.date}|${a.positionType}|${a.volumeInUSD}|${a.description}`;
          if (t < evStart || t < c.t || (t === c.t && seenAt.has(key))) break outer;
          if (t > evEnd) continue;
          if (a.activityType === "user" && (a.positionType === "BUY" || a.positionType === "SELL") && Number(a.volumeInUSD) >= minFill) add += Number(a.volumeInUSD);
          if (t > newest) { newest = t; keys = [key]; } else if (t === newest) keys.push(key);
        }
        if (!d.meta || !d.meta.hasNextPage) break;
      }
      c.v = r2(c.v + add); c.t = newest; c.k = keys;
    });
    comp.cvol = Object.fromEntries(contestants.filter((u) => state.cvol[u]).map((u) => [u, state.cvol[u].v]));
  } catch (e) { console.log("official board skipped:", e.message); }
  if (state.board) {
    comp.board = { updatedAt: state.board.updatedAt, detail: state.board.detail, items: state.board.items };
    comp.official ??= state.board.official; // XO didn't answer this run: the chart keeps the last record
  }
}

const listed = new Set([...Object.values(state.days).flatMap((rows) => rows.map(([u]) => u)), ...(comp ? comp.rows.map(([u]) => u) : [])]);
for (const u of Object.keys(state.meta)) if (!listed.has(u)) delete state.meta[u];

// ---------- 6. the page's file ----------
// the most recent days; the competition has its own ranking below
const shown = Object.keys(state.days).sort().reverse().slice(0, SHOWN_DAYS);
const names = new Set([...shown.flatMap((k) => state.days[k].map(([u]) => u)), ...(comp ? comp.rows.map(([u]) => u) : [])]);
const todayRounds = Object.values(state.rounds).filter(([t]) => dayOf(t) === today).length;
const out = {
  updatedAt: Date.now(), // when the run finished, not when it started: a run on GitHub can take minutes
  today,
  event: comp,
  // private profiles that traded today: not ranked, but the page says how many there are
  hidden: Object.values(state.users).filter((s) => s.p && Object.keys(s.f).some((id) => state.rounds[id] && dayOf(state.rounds[id][0]) === today)).length,
  users: Object.fromEntries([...names].map((u) => [u, state.meta[u] || ["", 0, ""]])),
  days: shown.map((k) => ({ d: k, rows: state.days[k] })),
  todayRounds, // rounds anyone traded today, private profiles and the market maker included
  todaySpark,
};

await write(STATE, state);
await write(OUT, out);
console.log(`Done: ${(state.days[today] || []).length} ranked today (+${out.hidden} private), ${todayRounds} traded rounds today, ${shown.length} days listed${comp ? `, competition: ${comp.rows.length} ranked over ${comp.rounds} rounds` : ""}, ${requests} requests`);
