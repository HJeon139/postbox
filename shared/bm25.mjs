// Lexical search with BM25, plus a stub semantic score. Pure and dependency-free.

const STOP = new Set(('a about after again all also am an and any are as at be been before being but by can could did do does for from had has have he her him his how i if in into is it its just me more most my no not now of on one only or other our out over she should so some such than ' +
  'that the their them then there these they this those through to too up upon very was we were what when where which while who why will with would you your').split(' '));

export function tokenize(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9]+(?:['’][a-z]+)?/g)?.map((t) => t.replace(/['’].*$/, '')).filter((t) => t.length > 1 && !STOP.has(t)) ?? [];
}

/**
 * @param {{ id: string, text: string }[]} docs
 */
export function buildIndex(docs) {
  const df = new Map();
  const entries = docs.map(({ id, text }) => {
    const tf = new Map();
    const toks = tokenize(text);
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return { id, len: toks.length, tf };
  });
  const avgdl = entries.reduce((a, e) => a + e.len, 0) / Math.max(1, entries.length);
  return { entries, df, avgdl, N: entries.length };
}

/**
 * @returns {{ id: string, score: number, terms: string[] }[]} best first
 */
export function search(index, query, { k = 20, k1 = 1.2, b = 0.75 } = {}) {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return [];
  const idf = new Map(q.map((t) => {
    const n = index.df.get(t) ?? 0;
    return [t, Math.log(1 + (index.N - n + 0.5) / (n + 0.5))];
  }));
  const hits = [];
  for (const e of index.entries) {
    let score = 0;
    const terms = [];
    for (const t of q) {
      const f = e.tf.get(t);
      if (!f) continue;
      terms.push(t);
      score += idf.get(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * e.len) / index.avgdl)));
    }
    if (score > 0) hits.push({ id: e.id, score, terms });
  }
  return hits.sort((x, y) => y.score - x.score).slice(0, k);
}

// The stub stands in for a real embedding model until you connect your own index. It expands the
// query with a small table of related words and scores overlap from 0 to 1, so "hope after loss" can
// find a passage that never uses the word "hope". Results are labeled as coming from the stub.
const RELATED = {
  hope: ['wish', 'longing', 'expect', 'expectation', 'faith', 'promise', 'dream'],
  loss: ['lost', 'grief', 'sorrow', 'mourning', 'death', 'gone', 'parting', 'absence', 'silence'],
  grief: ['sorrow', 'mourning', 'tears', 'loss', 'weep', 'grieve', 'wretched'],
  love: ['affection', 'heart', 'attachment', 'tenderness', 'devotion', 'beloved'],
  sea: ['ocean', 'whale', 'ship', 'waves', 'voyage', 'water', 'sailor'],
  money: ['fortune', 'income', 'pounds', 'wealth', 'debt', 'poor', 'rich'],
  marriage: ['married', 'marry', 'wedding', 'husband', 'wife', 'engagement'],
  memory: ['remember', 'remembrance', 'recollection', 'past', 'forgotten'],
  letter: ['letters', 'wrote', 'write', 'note', 'pen', 'post'],
  nature: ['woods', 'pond', 'trees', 'birds', 'forest', 'spring', 'winter'],
};

export function semanticStub(text, query) {
  const doc = new Set(tokenize(text));
  const q = tokenize(query);
  if (!q.length || !doc.size) return 0;
  let total = 0;
  for (const t of q) {
    if (doc.has(t)) { total += 1; continue; }
    const rel = RELATED[t] ?? Object.entries(RELATED).find(([, ws]) => ws.includes(t))?.[1] ?? [];
    const hits = rel.filter((w) => doc.has(w)).length;
    total += Math.min(0.85, hits * 0.3);
  }
  return Math.round(Math.min(1, total / q.length) * 100) / 100;
}
