// Serves the published data file (days.json) straight from the repo's `data` branch.
// raw.githubusercontent caches a file for 5 minutes whatever you ask for; the GitHub API does not, so the page
// reads through this function instead and sees a refresh within seconds.
// GET /api/data   (edge-cached 20 s, so GitHub is asked at most a few times a minute)
const REPO = 'AndriyShk/pulse-board';

export default async function handler(req, res) {
  // any query string would be a fresh cache key, i.e. a way to make this function call GitHub on every request
  if (Object.keys(req.query || {}).length) return res.status(400).json({ error: 'no parameters' });
  const get = (token) => fetch(`https://api.github.com/repos/${REPO}/contents/days.json?ref=data`, {
    headers: { accept: 'application/vnd.github.raw', 'user-agent': 'pulse-board', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(6000),
  });
  try {
    // with GH_TOKEN the rate limit is 5000/h; without it (or if the token is refused) the public limit still works for a while
    let r = await get(process.env.GH_TOKEN);
    if (!r.ok && process.env.GH_TOKEN) { console.log(`data: GitHub answered ${r.status} with the token, retrying without`); r = await get(); }
    if (!r.ok) { console.log(`data: GitHub answered ${r.status}`); return res.status(502).json({ error: 'unavailable' }); }
    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=60');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(await r.text());
  } catch (e) {
    console.error('data failed', e);
    res.status(502).json({ error: 'unavailable' });
  }
}
