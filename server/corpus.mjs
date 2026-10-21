// The demo corpus: public-domain books from Project Gutenberg, split into passages and indexed with
// BM25. Semantic scores come from the stub in shared/bm25.mjs until a real index is connected.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildIndex, search as bm25, semanticStub } from '../shared/bm25.mjs';

const BOOKS = {
  persuasion: { title: 'Persuasion', author: 'Jane Austen', year: 1817 },
  middlemarch: { title: 'Middlemarch', author: 'George Eliot', year: 1871 },
  'moby-dick': { title: 'Moby-Dick', author: 'Herman Melville', year: 1851 },
  emma: { title: 'Emma', author: 'Jane Austen', year: 1815 },
  walden: { title: 'Walden', author: 'Henry David Thoreau', year: 1854 },
  dubliners: { title: 'Dubliners', author: 'James Joyce', year: 1914 },
};

const CHAPTER = /^\s*(?:CHAPTER|Chapter)\s+([IVXLC]+|\d+)\b\.?\s*(.*)$/;

export class Corpus {
  constructor() { this.passages = []; this.byId = new Map(); this.books = []; this.index = null; }

  async loadDir(dir) {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.txt')).sort();
    for (const f of files) {
      const id = f.replace(/\.txt$/, '');
      this.addBook(id, await readFile(join(dir, f), 'utf8'), BOOKS[id] ?? { title: id, author: 'Unknown', year: null });
    }
    this.reindex();
    return this;
  }

  /** Adds a plain-text document, for example a file you added to the corpus. */
  addBook(id, raw, meta) {
    const body = stripGutenberg(raw);
    const chapters = splitChapters(body);
    let n = 0;
    for (const ch of chapters) {
      for (const text of splitPassages(ch.text)) {
        const p = { id: `${id}:${++n}`, book: id, title: meta.title, author: meta.author, year: meta.year, chapter: ch.label, text };
        this.passages.push(p);
        this.byId.set(p.id, p);
      }
    }
    this.books.push({ id, ...meta, passages: n, chapters: chapters.length });
  }

  reindex() { this.index = buildIndex(this.passages); }

  /**
   * @param {string} query
   * @param {{ mode?: 'both'|'lexical'|'semantic', k?: number, books?: string[] }} [opts]
   */
  search(query, { mode = 'both', k = 12, books } = {}) {
    const allowed = books?.length ? new Set(books) : null;
    const hits = new Map();
    if (mode !== 'semantic') {
      for (const h of bm25(this.index, query, { k: 200 })) {
        const p = this.byId.get(h.id);
        if (allowed && !allowed.has(p.book)) continue;
        hits.set(h.id, { ...view(p), lexical: { score: round(h.score), terms: h.terms }, semantic: null });
      }
    }
    if (mode !== 'lexical') {
      // The stub is too slow to run over every passage, so it rescores lexical neighbors plus a sample.
      const pool = mode === 'semantic' ? this.passages.filter((_, i) => i % 7 === 0) : [...hits.keys()].map((id) => this.byId.get(id));
      for (const p of pool) {
        if (allowed && !allowed.has(p.book)) continue;
        const s = semanticStub(p.text, query);
        if (s < 0.5) continue;
        const prev = hits.get(p.id) ?? { ...view(p), lexical: null };
        hits.set(p.id, { ...prev, semantic: s });
      }
    }
    const rank = (h) => (h.lexical ? h.lexical.score / 10 : 0) + (h.semantic ?? 0);
    return [...hits.values()].filter((h) => mode === 'both' || (mode === 'lexical' ? h.lexical : h.semantic !== null))
      .sort((a, b) => rank(b) - rank(a)).slice(0, k);
  }

  read(id) { const p = this.byId.get(id); return p ? view(p) : null; }

  stats() { return { books: this.books.map(({ id, title, author, year, passages, chapters }) => ({ id, title, author, year, passages, chapters })), passages: this.passages.length }; }
}

const round = (n) => Math.round(n * 10) / 10;
const view = (p) => ({ id: p.id, book: p.book, title: p.title, author: p.author, year: p.year, chapter: p.chapter, text: p.text });

export function stripGutenberg(raw) {
  const text = raw.replace(/\r\n?/g, '\n');
  const start = text.search(/^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK.*$/im);
  const end = text.search(/^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK.*$/im);
  const from = start >= 0 ? text.indexOf('\n', start) + 1 : 0;
  return text.slice(from, end >= 0 ? end : undefined).trim();
}

/** Chapters by "CHAPTER n" headings, or by short all-caps headings (Walden, Dubliners). Front matter before the first heading is dropped. */
export function splitChapters(body) {
  const lines = body.split('\n');
  const marks = [];
  // When chapter numbers start again (Emma's three volumes), labels name the volume too.
  let vol = 1, prev = 0;
  const numbered = [];
  lines.forEach((l, i) => { const m = l.match(CHAPTER); if (m) numbered.push({ i, n: toNumber(m[1]) }); });
  // Contents entries sit within a few lines of a neighbor; real chapter headings don’t.
  const body2 = numbered.filter((m, k) => !((numbered[k + 1] && numbered[k + 1].i - m.i < 4) || (numbered[k - 1] && m.i - numbered[k - 1].i < 4)));
  const resets = body2.some((m, k) => k && m.n <= body2[k - 1].n);
  for (const m of body2) {
    if (m.n <= prev) vol++;
    prev = m.n;
    marks.push({ i: m.i, label: resets ? `vol. ${vol}, ch. ${m.n}` : `ch. ${m.n}` });
  }
  if (marks.length < 3) {
    // Headings named in a "Contents" list, found again later as lines of their own (Walden).
    marks.length = 0;
    const c = lines.findIndex((l) => /^\s*contents\s*$/i.test(l));
    if (c >= 0) {
      const names = [];
      for (let i = c + 1, blanks = 0; i < lines.length && blanks < 3; i++) {
        const t = lines[i].trim();
        if (!t) { if (names.length) blanks++; continue; }
        blanks = 0;
        names.push(t);
      }
      const wanted = new Set(names.map((n) => n.toLowerCase()));
      const after = c + names.length + 2;
      lines.forEach((l, i) => {
        if (i > after && wanted.has(l.trim().toLowerCase()) && !lines[i - 1]?.trim() && !lines[i + 1]?.trim()) marks.push({ i, label: l.trim() });
      });
    }
  }
  if (marks.length < 3) {
    marks.length = 0;
    lines.forEach((l, i) => {
      const t = l.trim();
      const isolated = !lines[i - 1]?.trim() && !lines[i + 1]?.trim();
      if (isolated && t.length > 3 && t.length < 48 && t === t.toUpperCase() && /[A-Z]{3}/.test(t) && !/^(CONTENTS|PREFACE|INTRODUCTION|FINIS|THE END)\b/.test(t)) {
        marks.push({ i, label: titleCase(t.replace(/[.]$/, '')) });
      }
    });
  }
  // A table of contents repeats the headings; keep only the last run, where the text follows.
  const seen = new Map();
  for (const m of marks) seen.set(m.label, m);
  const real = [...seen.values()].sort((a, b) => a.i - b.i);
  if (!real.length) return [{ label: 'text', text: body }];
  return real.map((m, k) => ({ label: m.label, text: lines.slice(m.i + 1, real[k + 1]?.i ?? lines.length).join('\n') }))
    .filter((c) => c.text.trim().split(/\s+/).length > 40);
}

/** Paragraph-aware passages of roughly 60 to 180 words. */
export function splitPassages(text, { target = 120, max = 180 } = {}) {
  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').replace(/_/g, '').trim()).filter((p) => p && !/^\[?Illustration/i.test(p));
  const out = [];
  let cur = [];
  let words = 0;
  const push = () => { if (cur.length) out.push(cur.join(' ')); cur = []; words = 0; };
  for (const p of paras) {
    const w = p.split(/\s+/).length;
    if (w > max) {
      push();
      const sentences = p.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) ?? [p];
      for (const s of sentences) {
        const sw = s.split(/\s+/).length;
        if (words + sw > max) push();
        cur.push(s.trim()); words += sw;
      }
      push();
      continue;
    }
    if (words && words + w > max) push();
    cur.push(p); words += w;
    if (words >= target) push();
  }
  push();
  return out.filter((p) => p.split(/\s+/).length >= 12);
}

function toNumber(s) {
  if (/^\d+$/.test(s)) return +s;
  const v = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let n = 0;
  for (let i = 0; i < s.length; i++) n += v[s[i]] < (v[s[i + 1]] ?? 0) ? -v[s[i]] : v[s[i]];
  return n;
}
const titleCase = (s) => s.toLowerCase().replace(/(^|\s)(\w)/g, (m, a, b) => a + b.toUpperCase());
