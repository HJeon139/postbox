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
 * A lookup for one conversation as the state is now: what a piece of text names, or null. A file goes by its path, its
 * path in the project, or its file name when only one changed file has it.
 * @param {any} state @param {string} convId
 * @returns {(text: string) => Ref | null}
 */
export function refLookup(state, convId) {
  const index = own(state.assetRooms, roomOf(state.threads, convId));
  /** @type {Map<string, string>} each path to its file’s id */
  const paths = new Map();
  /** @type {Map<string, string | null>} each file name to its file’s id, or null for one two files share */
  const names = new Map();
  for (const e of state.work?.[convId] ?? []) {
    if (e.kind !== 'file') continue;
    for (const k of [e.path, e.rel]) if (k) paths.set(k, e.id);
    const base = e.rel?.replace(/^.*\//, '');
    if (base) names.set(base, names.has(base) && names.get(base) !== e.id ? null : e.id);
  }
  return (text) => {
    const t = text.trim();
    if (/^as_[A-Za-z0-9]{8}$/.test(t)) return roomAsset(state, convId, t) ? { at: t, kind: 'asset' } : null;
    const asset = index ? own(index.names, nameKey(t)) : undefined;
    if (asset) return { at: asset, kind: 'asset' };
    const file = paths.get(t) ?? names.get(t);
    return file ? { at: file, kind: 'file' } : null;
  };
}
