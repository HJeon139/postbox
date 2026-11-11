// Search over a room’s text assets (#516, designs/architecture.md, “Assets”): every live text asset’s newest version,
// split into passages and indexed with BM25 (shared/bm25.mjs), with the stub’s meaning score beside it. One search
// serves an agent’s search_assets (server/asset-tools.mjs), here or on a host, and an app’s assets.search through the
// bridge (server/host-tool.mjs), so the room’s data is one store, whoever reads it.
//
// A room’s index is built from its assets’ bytes the first time it’s searched, and kept until one of its assets has a
// new head: the key is every indexed asset’s id and hash. A few rooms are kept, the most recently searched.

import { search as bm25, buildIndex, semanticStub } from '../shared/bm25.mjs';
import { headOf, roomAssets } from './assets.mjs';

/** How many rooms’ indexes are kept at once. */
const ROOMS_KEPT = 8;
/** The most passages the stub scores when a search asks for meaning alone: it’s too slow to run over a large room. */
const SEMANTIC_POOL = 2000;
/** A search’s bounds, since an agent or an app sends them (#351): its query’s characters, results, and named assets. */
const QUERY_CHARS = 200;
const MAX_RESULTS = 50;
const MAX_NAMED = 50;
const MODES = ['both', 'lexical', 'semantic'];

/** @type {WeakMap<object, Map<string, { key: string, room: any }>>} */
const indexes = new WeakMap();

/**
 * The room’s live text assets, as search reads them: each one’s newest version, if it has bytes still kept.
 * @param {any} state @param {string} room
 */
function textAssets(state, room) {
  return roomAssets(state, room)
    .map((asset) => ({ asset, head: headOf(asset) }))
    .filter(({ head }) => head?.sha256 && head.isText && !head.pruned);
}

/**
 * An asset’s text as passages, each named by its number.
 * @param {string} text @returns {{ part: string, where: string, text: string }[]}
 */
function passagesOf(text) {
  return splitPassages(text).map((t, i) => ({ part: String(i + 1), where: `passage ${i + 1}`, text: t }));
}

/** Paragraph-aware passages of roughly 60 to 180 words; a longer paragraph is cut between sentences. @param {string} text */
export function splitPassages(text, { target = 120, max = 180 } = {}) {
  const paras = text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
  const out = [];
  let cur = [];
  let words = 0;
  const push = () => {
    if (cur.length) out.push(cur.join(' '));
    cur = [];
    words = 0;
  };
  const add = (/** @type {string} */ s, /** @type {number} */ w) => {
    if (words && words + w > max) push();
    cur.push(s);
    words += w;
  };
  for (const p of paras) {
    const w = p.split(/\s+/).length;
    if (w <= max) {
      add(p, w);
      if (words >= target) push();
      continue;
    }
    push();
    for (const s of p.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) ?? [p]) add(s.trim(), s.split(/\s+/).length);
    push();
  }
  push();
  return out;
}

/**
 * The room’s index, built from its text assets’ bytes, or the one kept if none of them changed.
 * @param {any} rt  the Runtime @param {import('./blobs.mjs').Blobs} blobs @param {string} room
 */
async function roomIndex(rt, blobs, room) {
  const live = textAssets(rt.s, room);
  const key = live.map(({ asset, head }) => `${asset.id}@${head.sha256}`).join(' ');
  const kept = indexes.get(rt) ?? new Map();
  indexes.set(rt, kept);
  const hit = kept.get(room);
  if (hit?.key === key) {
    kept.delete(room);
    kept.set(room, hit);
    return hit.room;
  }
  const passages = [];
  for (const { asset, head } of live) {
    const text = (await blobs.get(head.sha256)).toString('utf8');
    for (const p of passagesOf(text))
      passages.push({ id: `${asset.id}:${p.part}`, asset: asset.id, name: asset.name, version: head.v, where: p.where, text: p.text });
  }
  const built = { passages, byId: new Map(passages.map((p) => [p.id, p])), index: buildIndex(passages) };
  kept.delete(room);
  kept.set(room, { key, room: built });
  while (kept.size > ROOMS_KEPT) kept.delete(/** @type {string} */ (kept.keys().next().value));
  return built;
}

/**
 * A search’s arguments, bounded: the query, 1 to 50 results, a mode, and up to 50 assets to keep to, by id or name.
 * @param {any} args
 */
export function searchArgs(args = {}) {
  const query = String(args?.query ?? '').slice(0, QUERY_CHARS);
  const k = Math.max(1, Math.min(MAX_RESULTS, Math.floor(+args?.k || 12)));
  const mode = MODES.includes(args?.mode) ? args.mode : 'both';
  const named = Array.isArray(args?.assets) ? args.assets.slice(0, MAX_NAMED).map(String) : [];
  return { query, k, mode, named };
}

/**
 * Searches the room’s text assets. Each hit names its asset, the version it was read from, and where in it.
 * @param {any} rt  the Runtime @param {import('./blobs.mjs').Blobs} blobs @param {string} room @param {any} args
 * @returns {Promise<any[]>} best first
 */
export async function searchAssets(rt, blobs, room, args) {
  const { query, k, mode, named } = searchArgs(args);
  const { passages, byId, index } = await roomIndex(rt, blobs, room);
  const keep = named.length ? new Set(named) : null;
  const skip = (/** @type {any} */ p) => keep !== null && !keep.has(p.asset) && !keep.has(p.name);
  const hits = new Map();
  if (mode !== 'semantic') {
    for (const h of bm25(index, query, { k: 200 })) {
      const p = byId.get(h.id);
      if (!skip(p)) hits.set(h.id, { ...view(p), lexical: { score: round(h.score), terms: h.terms }, semantic: null });
    }
  }
  if (mode !== 'lexical') {
    const step = Math.max(1, Math.ceil(passages.length / SEMANTIC_POOL));
    const pool = mode === 'semantic' ? passages.filter((_, i) => i % step === 0) : [...hits.keys()].map((id) => byId.get(id));
    for (const p of pool) {
      const s = skip(p) ? 0 : semanticStub(p.text, query);
      if (s >= 0.5) hits.set(p.id, { ...(hits.get(p.id) ?? { ...view(p), lexical: null }), semantic: s });
    }
  }
  const rank = (/** @type {any} */ h) => (h.lexical ? h.lexical.score / 10 : 0) + (h.semantic ?? 0);
  return [...hits.values()]
    .filter((h) => mode === 'both' || (mode === 'lexical' ? h.lexical : h.semantic !== null))
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, k);
}

/**
 * The room’s text assets as an app lists them: each one’s id, name, newest version, size, type and passages.
 * @param {any} rt @param {import('./blobs.mjs').Blobs} blobs @param {string} room
 */
export async function listTextAssets(rt, blobs, room) {
  const { passages } = await roomIndex(rt, blobs, room);
  const per = new Map();
  for (const p of passages) per.set(p.asset, (per.get(p.asset) ?? 0) + 1);
  return textAssets(rt.s, room)
    .map(({ asset, head }) => ({ id: asset.id, name: asset.name, version: head.v, size: head.size, type: head.type, passages: per.get(asset.id) ?? 0 }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

const round = (/** @type {number} */ n) => Math.round(n * 10) / 10;
const view = (/** @type {any} */ p) => ({ id: p.id, asset: p.asset, name: p.name, version: p.version, where: p.where, text: p.text });
