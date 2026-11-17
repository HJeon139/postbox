// What a message names that Work’s viewer can open (#1446): a room asset, by its id or its name, or a file the
// conversation’s agents changed, by its path or file name. The page’s links in messages and the pane both read it.
// Ids are looked up in the conversation’s own room and work only, so an id from another conversation names nothing
// (#31).

import { nameKey, own, roomOf } from './state-assets.mjs';

/** An asset id as Postbox writes them: as_ and 8 letters or digits (server/ids.mjs). */
export const ASSET_ID = /\bas_[A-Za-z0-9]{8}\b/g;

/** The most parents conversationOf follows, as roomOf does. */
const MAX_DEPTH = 8;

/**
 * The conversation a thread belongs to: itself, or the one its side or topic thread hangs from, which holds its Work.
 * @param {Record<string, any>} threads @param {string} threadId
 */
export function conversationOf(threads, threadId) {
  let id = threadId;
  for (let i = 0; i < MAX_DEPTH && (threads[id]?.kind === 'side' || threads[id]?.kind === 'topic') && threads[threads[id].parentId]; i++)
    id = threads[id].parentId;
  return id;
}

/**
 * An asset of the conversation’s room whose newest version keeps bytes, or null.
 * @param {any} state @param {string} convId @param {string} id
 */
export function roomAsset(state, convId, id) {
  const asset = own(state.assets, id);
  if (!asset || asset.room !== roomOf(state.threads, convId)) return null;
  return asset.versions[asset.head - 1]?.sha256 ? asset : null;
}

/** The room’s live assets, newest version first. @param {any} state @param {string} convId */
export function roomAssets(state, convId) {
  const index = own(state.assetRooms, roomOf(state.threads, convId));
  if (!index) return [];
  const at = (/** @type {any} */ a) => a.versions[a.head - 1]?.at ?? 0;
  return Object.values(index.names)
    .map((id) => own(state.assets, id))
    .filter(Boolean)
    .sort((a, b) => at(b) - at(a));
}

/**
 * Whether a conversation has anything a message could name: a live asset in its room, or a changed file in its work.
 * @param {any} state @param {string} convId
 */
export function hasRefs(state, convId) {
  const index = own(state.assetRooms, roomOf(state.threads, convId));
  if (index && Object.keys(index.names).length) return true;
  return (state.work?.[convId] ?? []).some((e) => e.kind === 'file');
}

/** @typedef {{ at: string, kind: 'asset' | 'file' }} Ref */

/**
 * @typedef {{ paths: Map<string, string>, names: Map<string, string | null>, byId: Map<string, any> }} FileIndex
 *   paths: each path to its file’s id; names: each file name to its file’s id, or null for one two files share; byId:
 *   each changed file’s entry
 */

/** Each conversation’s file index, kept while its work list is the same array at the same length. */
const fileIndexes = new WeakMap();

/**
 * The conversation’s changed files, by path, file name and id. Built once per change to its work list: a file’s path,
 * name and kind never change once recorded, so a list of the same length gives the same index.
 * @param {any} state @param {string} convId @returns {FileIndex}
 */
function filesOf(state, convId) {
  const entries = state.work?.[convId] ?? [];
  const kept = fileIndexes.get(entries);
  if (kept?.length === entries.length) return kept.index;
  /** @type {FileIndex} */
  const index = { paths: new Map(), names: new Map(), byId: new Map() };
  for (const e of entries) {
    if (e.kind !== 'file') continue;
    index.byId.set(e.id, e);
    for (const k of [e.path, e.rel]) if (k) index.paths.set(k, e.id);
    const base = e.rel?.replace(/^.*\//, '');
    if (base) index.names.set(base, index.names.has(base) && index.names.get(base) !== e.id ? null : e.id);
  }
  if (entries.length) fileIndexes.set(entries, { length: entries.length, index });
  return index;
}

/**
 * A lookup for one conversation as the state is now: what a piece of text names, or null. A file goes by its path, its
 * path in the project, or its file name when only one changed file has it.
 * @param {any} state @param {string} convId
 * @returns {(text: string) => Ref | null}
 */
export function refLookup(state, convId) {
  const index = own(state.assetRooms, roomOf(state.threads, convId));
  const { paths, names } = filesOf(state, convId);
  return (text) => {
    const t = text.trim();
    if (/^as_[A-Za-z0-9]{8}$/.test(t)) return roomAsset(state, convId, t) ? { at: t, kind: 'asset' } : null;
    const asset = index ? own(index.names, nameKey(t)) : undefined;
    if (asset) return { at: asset, kind: 'asset' };
    const file = paths.get(t) ?? names.get(t);
    return file ? { at: file, kind: 'file' } : null;
  };
}

/** Inline code in a message’s Markdown: what links in a reply are made from (app/js/room-links.mjs). */
const CODE = /`([^`\n]+)`/g;

/** How many In this chat ranks at most: past it, the list isn’t a short list any more. */
export const RELEVANT_MAX = 50;

/** @typedef {Ref & { when: number, name: string }} Relevant */

/**
 * The conversation’s last n messages, the person’s and the agents’, oldest first.
 * @param {any[]} items  the conversation’s newest items the page holds, oldest first @param {number} [n]
 */
export function lastSaid(items, n = 10) {
  const out = [];
  for (let i = items.length - 1; i >= 0 && out.length < n; i--) {
    const it = items[i];
    if ((it.kind === 'user' || it.kind === 'agent') && typeof it.text === 'string') out.push(it);
  }
  return out.reverse();
}

/**
 * The work list’s last `turns` turns, newest first, and where the oldest of them starts in it: a turn’s entries come
 * after its own, so nothing before that index is theirs. Reads from the end, never the whole list.
 * @param {any[]} entries @param {number} turns
 */
function lastTurns(entries, turns) {
  const list = [];
  let from = entries.length;
  for (let i = entries.length - 1; i >= 0 && list.length < turns; i--)
    if (entries[i].kind === 'turn') {
      list.push(entries[i]);
      from = i;
    }
  return { list, from };
}

/**
 * Whether a turn wrote an asset version: the ledger keeps no asset entries, so a version goes to the turn whose agent
 * wrote it while the turn ran. @param {any} turn @param {any} v
 */
const wroteIn = (turn, v) => v.author === turn.handle && v.at >= turn.startedAt && v.at <= turn.startedAt + (turn.ms ?? Number.POSITIVE_INFINITY);

/**
 * What the chat is about now (#1446): the assets and changed files named in the conversation’s last messages, the
 * person’s and the agents’, and those touched in its last turns (a file the ledger has it change, an asset version its
 * agent wrote while it ran). Each once, at the later of when it was named and when it was touched, newest first, at
 * most RELEVANT_MAX, with the name the pane shows.
 * @param {any} state @param {string} convId @param {any[]} items  the conversation’s newest items, oldest first
 * @param {{ messages?: number, turns?: number }} [opts]
 * @returns {Relevant[]}
 */
export function relevantRefs(state, convId, items, { messages = 10, turns = 2 } = {}) {
  const find = refLookup(state, convId);
  const { byId } = filesOf(state, convId);
  /** @type {Map<string, Relevant>} */
  const seen = new Map();
  const note = (/** @type {Ref | null} */ ref, /** @type {number} */ when) => {
    if (!ref || (seen.get(ref.at)?.when ?? -1) >= when) return;
    const name = ref.kind === 'file' ? byId.get(ref.at)?.rel : roomAsset(state, convId, ref.at)?.name;
    if (name) seen.set(ref.at, { ...ref, when, name });
  };
  for (const it of lastSaid(items, messages)) {
    for (const m of it.text.matchAll(CODE)) note(find(m[1]), it.at ?? 0);
    for (const m of it.text.matchAll(ASSET_ID)) note(find(m[0]), it.at ?? 0);
  }
  const entries = state.work?.[convId] ?? [];
  const recent = lastTurns(entries, turns);
  const ids = new Set(recent.list.map((t) => t.id));
  // Newest first, so a turn that touched thousands of files gives its latest, and stops at the cap.
  for (let i = entries.length - 1; i > recent.from && seen.size < RELEVANT_MAX * 2; i--) {
    const c = entries[i];
    if (c.kind === 'change' && ids.has(c.turnId)) note({ at: c.fileId, kind: 'file' }, c.at ?? 0);
  }
  if (recent.list.length)
    for (const a of roomAssets(state, convId)) {
      const v = a.versions[a.head - 1];
      if (recent.list.some((t) => wroteIn(t, v))) note({ at: a.id, kind: 'asset' }, v.at);
    }
  return [...seen.values()].sort((a, b) => b.when - a.when).slice(0, RELEVANT_MAX);
}

/**
 * What In this chat reads of the conversation’s messages: each of the last ten’s id, status and length. The pane
 * draws In this chat again only when this changes, not on every step or reaction (#1446 review).
 * @param {any[]} items
 */
export const saidKey = (items) =>
  lastSaid(items)
    .map((i) => `${i.id}:${i.status ?? ''}:${i.text.length}`)
    .join('|');
