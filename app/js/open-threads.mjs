// Loading a conversation’s items just in time (#1155): a transcript that opens loads the conversation’s latest items, one
// that scrolls past what’s loaded loads the next range, and a jump to an item loads the range around it first. The
// page holds items only of the conversations it shows (client.open), and its stream sends item events only for those.
// Each conversation’s loads run one after another, so a later one is placed after an earlier one.

import { positionOf } from '/shared/item-index.mjs';
import { client, reopen } from './client.mjs';
import { atEnd, fetchRange, forget, loading, place, placeHead } from './item-ranges.mjs';
import { windowOn } from './window-flag.mjs';

/** How many items a load asks for: about what the transcript window mounts as it opens. */
const PAGE = 200;

/** @type {Map<string, Promise<unknown>>} */
const queues = new Map();

/**
 * Runs a load for a conversation after the ones before it; places its answer and tells the page, unless the
 * conversation was closed, or the state replaced (a resync, which loads its ranges itself), meanwhile.
 * The query is read when the load runs, if it's a function: null then loads nothing.
 * @param {string} threadId @param {string | (() => string | null)} query @param {'replace' | 'before' | 'after'} how
 */
function load(threadId, query, how) {
  const run = async () => {
    // A conversation deleted meanwhile has nothing to load: the server would answer 404.
    if (!client.open.has(threadId) || !client.state.threads[threadId]) return;
    const q = typeof query === 'function' ? query() : query;
    if (q === null) return;
    const ranges = client.ranges;
    const range = loading(ranges, threadId);
    const answer = await fetchRange(threadId, q).catch(() => null);
    // Closed meanwhile, and maybe opened again with a range of its own: this answer is for the range it was asked for.
    if (client.ranges !== ranges || !client.open.has(threadId) || ranges.get(threadId) !== range) return;
    if (!answer || (answer.epoch ?? client.epoch) !== client.epoch) {
      const r = ranges.get(threadId);
      if (r) r.loads = Math.max(0, r.loads - 1);
      return;
    }
    const stale = place(client.state, ranges, answer, how);
    client.emit({ type: 'range', data: { threadId, how } });
    if (stale) void load(threadId, `?limit=${PAGE}`, 'replace');
  };
  const next = (queues.get(threadId) ?? Promise.resolve()).then(run);
  queues.set(threadId, next);
  return next;
}

/**
 * How many conversations whose last view closed stay warm: their range kept, and the stream still sending their item
 * events, so going back to one is as quick as on main, which held every item, with no load. Past it, the one closed
 * longest ago lets its items go. A view drawn again in the same task (an agent joining) is one of these too.
 */
const WARM = 3;
/** The warm conversations, the one closed longest ago first. @type {Set<string>} */
const warm = new Set();

/** Lets a conversation's items, range and loads go, and the stream stop sending its item events. @param {string} threadId */
function release(threadId) {
  warm.delete(threadId);
  client.open.delete(threadId);
  queues.delete(threadId);
  forget(client.state, client.ranges, threadId);
  reopen();
}

/**
 * A view of the conversation opened: the first loads its items (every one with the transcript window off, which mounts
 * them all), and the stream starts sending its item events; a warm one has them already. @param {string} threadId
 */
export function openThread(threadId) {
  const views = client.open.get(threadId) ?? 0;
  client.open.set(threadId, views + 1);
  if (warm.delete(threadId) || views) return;
  reopen();
  // With its first items, if the range doesn't start there: Home is in place before any key can reach it.
  void load(threadId, windowOn() ? `?limit=${PAGE}&head=${PAGE}` : '?limit=all', 'replace');
}

/**
 * A view of the conversation closed: with the last, it stays warm, and the one closed longest ago past WARM lets its
 * items go. @param {string} threadId
 */
export function closeThread(threadId) {
  const views = (client.open.get(threadId) ?? 1) - 1;
  client.open.set(threadId, views);
  if (views > 0) return;
  warm.add(threadId);
  for (const id of warm) if (warm.size > WARM) release(id);
}

// A conversation deleted lets its items go at once, warm or not.
client.on((ch) => {
  if (ch.type === 'remove' && ch.data?.kind === 'thread' && warm.has(ch.data.id)) release(ch.data.id);
});

/** Loads an open conversation’s latest items again, in place of the range it holds. @param {string} threadId */
export async function refresh(threadId) {
  if (client.open.has(threadId)) await load(threadId, `?limit=${windowOn() ? PAGE : 'all'}`, 'replace');
}

/**
 * Opens a conversation and resolves once its first load has landed (or failed), for a view that mounts with its items,
 * as one the page holds already does: drawn empty first and filled a fetch later, it laid out twice and showed nothing
 * meanwhile (#1155). The caller closes it once the view has opened it too. @param {string} threadId
 */
export async function whenLoaded(threadId) {
  openThread(threadId);
  await queues.get(threadId);
}

/** Loads an open conversation’s first items, for Home, in place of the range it holds. @param {string} threadId */
export async function toFirst(threadId) {
  if (!client.open.has(threadId)) return;
  // The head kept since the conversation opened, when there's one: Home with no load.
  if (placeHead(client.state, client.ranges, threadId, client.seq)) {
    const anchor = client.state.items[threadId][0]?.id;
    client.emit({ type: 'range', data: { threadId, how: 'replace', anchor } });
  } else await load(threadId, `?first&limit=${PAGE}`, 'replace');
}

/** Whether a conversation’s first load has landed, so an empty list means it has no items. @param {string} threadId */
export const loaded = (threadId) => Number.isFinite(client.ranges.get(threadId)?.seq ?? Number.POSITIVE_INFINITY);

/** Whether the server has items past the loaded range, above or below. @param {string} threadId @param {'before' | 'after'} side */
export function more(threadId, side) {
  const r = client.ranges.get(threadId);
  const list = client.state.items[threadId] ?? [];
  if (!r || !loaded(threadId) || !list.length) return false;
  return side === 'before' ? r.start > 0 : !atEnd(list, r);
}

/** @type {Set<string>} */
const growing = new Set();
/** Loads the next range past an edge of what’s loaded, once at a time per edge. @param {string} threadId @param {'before' | 'after'} side */
export function grow(threadId, side) {
  const key = `${threadId}\n${side}`;
  if (growing.has(key) || !edgeQuery(threadId, side)) return;
  growing.add(key);
  // The edge is read when the load runs: a load queued before it may replace the range (a reload, Home, a jump).
  void load(threadId, () => edgeQuery(threadId, side), side).finally(() => growing.delete(key));
}

/**
 * The query for the range past an edge of what the page holds now, or null when there's nothing more there.
 * @param {string} threadId @param {'before' | 'after'} side
 */
function edgeQuery(threadId, side) {
  const list = client.state.items[threadId] ?? [];
  const edge = side === 'before' ? list[0] : list.at(-1);
  return edge && more(threadId, side) ? `?${side}=${encodeURIComponent(edge.id)}&limit=${PAGE}` : null;
}

/**
 * Makes sure an item is loaded before a jump to it: waits for its conversation to open (a jump may navigate there
 * first), then loads the range around it if the page doesn’t hold it. Resolves whether it’s held.
 * @param {string | null | undefined} threadId @param {string} itemId
 */
export async function reach(threadId, itemId) {
  if (!threadId) return false;
  const held = () => positionOf(client.state.items[threadId] ?? [], itemId) >= 0;
  for (const end = Date.now() + 3000; !client.open.has(threadId) && Date.now() < end; ) await new Promise((r) => requestAnimationFrame(r));
  await queues.get(threadId);
  if (held() || !client.open.has(threadId)) return held();
  await load(threadId, `?around=${encodeURIComponent(itemId)}&limit=${PAGE}`, 'replace');
  return held();
}

// An item moved to an end the range holds, from a place it doesn’t: the latest range again (item-ranges.mjs).
client.on((ch) => {
  if (ch.type === 'range.stale') void load(ch.data.threadId, `?limit=${PAGE}`, 'replace');
});
