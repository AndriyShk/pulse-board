// The live round's Up and Down prices: the best ask on each side of XO's order book.
// Since 2026-10-15 the order book answers browsers only on XO's own sites, so the page asks here instead.
// GET /api/price?up=<tokenId>&down=<tokenId> → { up, down }   (edge-cached 5 s: one call to XO per 5 s per round,
// however many people are watching)
const BOOK = 'https://orderbooks.xo.market';
const TOKEN = /^\d{1,80}$/; // outcome token ids are uint256 numbers

export default async function handler(req, res) {
  const q = req.query || {};
  // exactly ?up=&down=: anything else would be a fresh cache key and a free call to XO
  if (Object.keys(q).length !== 2 || !TOKEN.test(q.up || '') || !TOKEN.test(q.down || '')) return res.status(400).json({ error: 'bad tokens' });
  const ask = (token) => fetch(`${BOOK}/price?token_id=${token}&side=SELL`, { headers: { 'user-agent': 'pulse-board' }, signal: AbortSignal.timeout(3000) })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((j) => Number(j.price));
  try {
    const [up, down] = await Promise.all([ask(q.up), ask(q.down)]);
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=5');
    res.status(200).json({ up, down });
  } catch (e) {
    console.log(`price: the order book didn't answer (${e.message})`);
    res.setHeader('Cache-Control', 's-maxage=2');
    res.status(502).json({ error: 'unavailable' });
  }
}
