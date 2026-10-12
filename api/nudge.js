// GitHub often delays or skips the board workflow's */10 schedule. The page calls this when its data looks old;
// with a GH_TOKEN env var (fine-grained, Actions: write on this repo) it starts the workflow again,
// at most once every 4 minutes. Without the token it does nothing.
// GET /api/nudge → { started }   (edge-cached 60 s, so visitors can't spam GitHub)
const REPO = 'AndriyShk/pulse-board';

export default async function handler(req, res) {
  // any query string would be a fresh cache key, i.e. a way to make this function call GitHub on every request
  if (Object.keys(req.query || {}).length) return res.status(400).json({ started: false });
  res.setHeader('Cache-Control', 's-maxage=60');
  const token = process.env.GH_TOKEN;
  // why nothing started goes to the function log, never to the visitor
  if (!token) { console.log('nudge: GH_TOKEN is not set in this deployment'); return res.status(200).json({ started: false }); }
  const gh = (path, opt = {}) => fetch(`https://api.github.com/repos/${REPO}${path}`, { ...opt, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'pulse-board' }, signal: AbortSignal.timeout(4000) });
  try {
    const list = await gh('/actions/workflows/board.yml/runs?per_page=1');
    if (!list.ok) console.log(`nudge: listing runs answered ${list.status} (token needs Actions: read and write on ${REPO})`);
    const runs = list.ok ? await list.json() : {};
    const last = runs.workflow_runs && runs.workflow_runs[0];
    if (last && Date.now() - Date.parse(last.created_at) < 4 * 6e4) return res.status(200).json({ started: false });
    const r = await gh('/actions/workflows/board.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
    if (!r.ok) console.log(`nudge: starting the workflow answered ${r.status}`);
    res.status(200).json({ started: r.ok });
  } catch (e) {
    console.error('nudge failed', e);
    res.status(200).json({ started: false });
  }
}
