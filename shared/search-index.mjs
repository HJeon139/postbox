// An incremental BM25 index over a conversation’s items (#866, W4): the same tokens and scores as shared/bm25.mjs’s
// buildIndex and search, but one item’s text can be put or dropped without rebuilding the rest. put and drop are
// O(that item’s tokens); search is O(items × query terms).

import { tokenize } from './bm25.mjs';

/** @typedef {{ len: number, tf: Map<string, number> }} Entry */

export class SearchIndex {
  constructor() {
    /** @type {Map<string, Entry>} */
    this.entries = new Map();
    /** @type {Map<string, number>} */
    this.df = new Map();
    this.totalLen = 0;
    /** How many entries were written, for the tests that pin incremental updates. */
    this.writes = 0;
  }
  /** An item’s text, replacing what it had; empty text drops it. @param {string} id @param {string} text */
  put(id, text) {
    this.drop(id);
    const toks = tokenize(text);
    if (!toks.length) return;
    /** @type {Map<string, number>} */
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.entries.set(id, { len: toks.length, tf });
    this.totalLen += toks.length;
    this.writes++;
  }
  /** @param {string} id */
  drop(id) {
    const e = this.entries.get(id);
    if (!e) return;
    for (const t of e.tf.keys()) {
      const n = (this.df.get(t) ?? 1) - 1;
      if (n) this.df.set(t, n);
      else this.df.delete(t);
    }
    this.totalLen -= e.len;
    this.entries.delete(id);
  }
  /**
   * The best matches, as shared/bm25.mjs’s search scores them.
   * @param {string} query @param {{ k?: number, k1?: number, b?: number }} [o]
   * @returns {{ id: string, score: number, terms: string[] }[]}
   */
  search(query, { k = 20, k1 = 1.2, b = 0.75 } = {}) {
    const q = [...new Set(tokenize(query))];
    const N = this.entries.size;
    if (!q.length || !N) return [];
    const avgdl = this.totalLen / N;
    const idf = new Map(q.map((t) => [t, Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5))]));
    const hits = [];
    for (const [id, e] of this.entries) {
      let score = 0;
      const terms = [];
      for (const t of q) {
        const f = e.tf.get(t);
        if (!f) continue;
        terms.push(t);
        score += (idf.get(t) ?? 0) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * e.len) / avgdl)));
      }
      if (score > 0) hits.push({ id, score, terms });
    }
    return hits.sort((x, y) => y.score - x.score).slice(0, k);
  }
}
