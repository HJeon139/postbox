// The items the page holds of each open conversation (#1155): one contiguous range of its list, loaded from the server
// (/api/threads/:id/items) when the conversation opens and grown as you scroll or jump, never every item of every
// conversation. Pure: app/js/client.mjs applies the stream’s events through gate(), and app/js/open-threads.mjs loads.
//
// A range knows where it starts in the conversation, how many items the conversation has, and the seq its last load
// was as of: the stream’s events at or before that seq are in the load already. While a load is in flight, the item
// events the page hears for that conversation are kept, and those after the load’s seq are applied again once it lands,
// so nothing the page heard meanwhile is lost or applied twice.

import { itemOf, noteReplaced, positionOf } from '/shared/item-index.mjs';
import { apply } from '/shared/state.mjs';

/**
 * @typedef {{ type: string, data: any, seq: number, applied: boolean }} Heard
 * @typedef {{ start: number, total: number, seq: number, loads: number, heard: Heard[], beyond?: { items: Record<string, any[]> }, head?: any[], tail?: any[] }} Range
 * @typedef {{ threadId: string, seq: number, start: number, total: number, items: any[], head?: any[] }} Answer
 */

/** A conversation’s items from the server: the latest, or before, after or around an item. @param {string} threadId @param {string} [query] */
export async function fetchRange(threadId, query = '') {
  const r = await fetch(`/api/threads/${encodeURIComponent(threadId)}/items${query}`, { cache: 'no-store' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Postbox couldn’t load this conversation’s messages. Reload the page.');
  return /** @type {Promise<Answer>} */ (r.json());
}

/** Whether a range reaches the conversation’s newest item. @param {any[]} list @param {Range} r */
export const atEnd = (list, r) => r.start + list.length >= r.total;

/**
 * What the page does with an item event for a conversation: apply it, or not (it’s in a load already, or names an item
 * the range doesn’t hold, which a load will bring as it is then), keep it apart (an item added past the range’s end,
 * keepBeyond), or load the latest range again (an item moved to an end the range holds, from a place it doesn’t).
 * Keeps the event while a load is in flight.
 * @param {any} state @param {Map<string, Range>} ranges @param {string} type @param {any} d @param {number} seq
 * @returns {'apply' | 'skip' | 'reload' | 'beyond'}
 */
export function gate(state, ranges, type, d, seq) {
  const r = ranges.get(d.threadId);
  if (!r) return 'skip';
  // Applied only where the range held its item: one a load in flight brings gets it again when the load lands.
  const held = type === 'item.add' || positionOf(state.items[d.threadId] ?? [], d.id) >= 0;
  const verdict = judge(state, r, type, d, seq);
  if (r.loads > 0) r.heard.push({ type, data: d, seq, applied: verdict === 'apply' && held });
  keepBeyond(r, type, d, verdict);
  keepHead(r, type, d);
  keepTail(r, type, d);
  return verdict;
}

/**
 * The conversation's first items, kept apart for Home (a load's head, place), current from their own events: a patch or text
 * applies, and a moved item leaves its stub in its place, as off a range's end. An add goes past them.
 * @param {Range} r @param {string} type @param {any} d
 */
function keepHead(r, type, d) {
  const at = r.head && type !== 'item.add' ? positionOf(r.head, d.id) : -1;
  if (at < 0 || !r.head) return;
  if (type === 'item.move') {
    r.head[at] = d.stub;
    noteReplaced(r.head, at);
  } else apply({ items: { [d.threadId]: r.head } }, type, d);
}

/**
 * The conversation's newest items, kept apart for End once Home has put the head in their place (placeHead): current
 * from their own events as the range they were, which reached the end, so an add joins them, and a move ends there.
 * @param {Range} r @param {string} type @param {any} d
 */
function keepTail(r, type, d) {
  if (!r.tail) return;
  const kept = { items: { [d.threadId]: r.tail } };
  if (type === 'item.add') apply(kept, type, { ...d, item: structuredClone(d.item) });
  else if (positionOf(r.tail, d.id) >= 0) apply(kept, type, d);
}

/**
 * Puts the kept head in place as the range, as a load of the first items would, with no load: says whether it could
 * (there's a head, and no load in flight whose events it would have to wait for). The range it replaces, if it held
 * the newest items, is kept as the tail, for End.
 * @param {any} state @param {Map<string, Range>} ranges @param {string} threadId @param {number} seq  the page's place
 */
export function placeHead(state, ranges, threadId, seq) {
  const r = ranges.get(threadId);
  if (!r?.head || r.loads > 0) return false;
  const list = state.items[threadId] ?? [];
  const tail = atEnd(list, r) ? list : undefined;
  state.items[threadId] = r.head;
  Object.assign(r, { start: 0, seq, head: undefined, tail });
  return true;
}

/**
 * Puts the kept tail back as the range, with no load, as End: says whether it could. The range it replaces, the first
 * items, is kept as the head again, for the next Home.
 * @param {any} state @param {Map<string, Range>} ranges @param {string} threadId @param {number} seq  the page's place
 */
export function placeTail(state, ranges, threadId, seq) {
  const r = ranges.get(threadId);
  if (!r?.tail || r.loads > 0) return false;
  const list = state.items[threadId] ?? [];
  const head = r.start === 0 ? list : r.head;
  state.items[threadId] = r.tail;
  Object.assign(r, { start: r.total - r.tail.length, seq, tail: undefined, head, beyond: undefined });
  return true;
}

/** How many of the items added past a range’s end it keeps apart: the latest, enough for a reply and what follows it. */
const BEYOND = 20;

/**
 * The items added past the range’s end while you read higher up, kept apart from its list (which stays one contiguous
 * run), and kept current by their own events, so the page counts them as unseen and still voices a reply as it
 * streams (#866). A load that reaches the end lets them go (place).
 * @param {Range} r @param {string} type @param {any} d @param {string} verdict
 */
function keepBeyond(r, type, d, verdict) {
  if (verdict === 'beyond') {
    const kept = ((r.beyond ??= { items: {} }).items[d.threadId] ??= []);
    kept.push(structuredClone(d.item));
    if (kept.length > BEYOND) kept.splice(0, kept.length - BEYOND);
  } else if (r.beyond && type !== 'item.add' && itemOf(r.beyond.items[d.threadId] ?? [], d.id)) apply(r.beyond, type, d);
}

/** An item added past a conversation’s range, as it is now; undefined when there’s none. @param {Range | undefined} r @param {string} threadId @param {string} id */
export const beyondItem = (r, threadId, id) => itemOf(r?.beyond?.items[threadId] ?? [], id) ?? undefined;

/** @param {any} state @param {Range} r @param {string} type @param {any} d @param {number} seq @returns {'apply' | 'skip' | 'reload' | 'beyond'} */
function judge(state, r, type, d, seq) {
  if (seq && seq <= r.seq) return 'skip';
  const list = state.items[d.threadId] ?? [];
  const end = atEnd(list, r);
  if (type === 'item.add') {
    r.total++;
    return end ? 'apply' : 'beyond';
  }
  if (type !== 'item.move') return 'apply';
  // A move puts the item last and leaves a stub in its place: the conversation has one more (shared/state.mjs, moveItem).
  r.total++;
  return moveIn(list, end, d);
}

/**
 * An item moved to the newest point (item.move): applied where the range holds the end and the item; where it holds the
 * end but not the item, the latest range is loaded again; off the end, its stub takes its place and nothing more.
 * @param {any[]} list @param {boolean} end @param {any} d @returns {'apply' | 'skip' | 'reload'}
 */
function moveIn(list, end, d) {
  const at = positionOf(list, d.id);
  if (end) return at < 0 ? 'reload' : 'apply';
  if (at >= 0) {
    list[at] = d.stub;
    noteReplaced(list, at);
  }
  return 'skip';
}

/** Starts a load for a conversation: its events are kept until it lands. @param {Map<string, Range>} ranges @param {string} threadId */
export function loading(ranges, threadId) {
  let r = ranges.get(threadId);
  if (!r) {
    r = { start: 0, total: 0, seq: Number.POSITIVE_INFINITY, loads: 0, heard: [] };
    ranges.set(threadId, r);
  }
  r.loads++;
  return r;
}

/**
 * Puts a load in place: in place of the range ('replace'), or joined to it above ('before') or below ('after'). Then
 * applies again the events heard since the load’s seq that it couldn’t hold: every one, for a replaced range; for a
 * joined one, those not applied to the range it had. A load from another history (an answer as of a seq the page passed
 * on another epoch) is the caller’s to refuse, and a joined one that doesn’t touch the range isn’t placed. Says whether
 * to load the latest range again.
 * @param {any} state @param {Map<string, Range>} ranges @param {Answer} answer @param {'replace' | 'before' | 'after'} how
 * @returns {boolean}
 */
export function place(state, ranges, answer, how) {
  const r = ranges.get(answer.threadId);
  if (!r) return false;
  r.loads = Math.max(0, r.loads - 1);
  const list = state.items[answer.threadId] ?? [];
  // A load past an edge joins only where it touches the range: one asked for an edge the range no longer has (a
  // replace landed first) would leave a hole in it. The latest range is loaded again instead.
  const touches = how === 'before' ? answer.start + answer.items.length === r.start : answer.start === r.start + list.length;
  if (how !== 'replace' && !touches) {
    if (!r.loads) r.heard = [];
    return true;
  }
  if (how === 'replace') {
    state.items[answer.threadId] = answer.items.slice();
    Object.assign(r, { start: answer.start, total: answer.total, seq: answer.seq });
    // The first items, when they came with it, kept for Home with what was heard after the load's seq.
    if (answer.head) {
      r.head = answer.head.slice();
      for (const e of r.heard) if (e.seq > answer.seq) keepHead(r, e.type, e.data);
    }
  } else if (how === 'before') {
    const fresh = answer.items.filter((it) => positionOf(list, it.id) < 0);
    state.items[answer.threadId] = [...fresh, ...list];
    r.start -= fresh.length;
  } else {
    state.items[answer.threadId] = [...list, ...answer.items.filter((it) => positionOf(list, it.id) < 0)];
  }
  const again = r.heard.filter((e) => e.seq > answer.seq && (how === 'replace' || !e.applied));
  // A range that reaches the end has the newest items itself: what was kept of them apart goes.
  if (atEnd(state.items[answer.threadId], r)) Object.assign(r, { beyond: undefined, tail: undefined });
  if (!r.loads) r.heard = [];
  return replay(state, r, answer, again, how);
}

/**
 * Applies again what a load couldn’t hold. Each message added after the load’s seq was the conversation’s next in turn,
 * from the load’s total on, so it’s added where the range reaches that place. Says whether to load the latest range
 * again (an item moved to an end the range holds, from a place it doesn’t).
 * @param {any} state @param {Range} r @param {Answer} answer @param {Heard[]} again @param {'replace' | 'before' | 'after'} how
 * @returns {boolean}
 */
function replay(state, r, answer, again, how) {
  let next = answer.total;
  let reload = false;
  for (const e of again) {
    const list = state.items[answer.threadId];
    if (e.type === 'item.add') {
      if (how === 'replace') r.total++;
      if (how !== 'before' && r.start + list.length === next && positionOf(list, e.data.item.id) < 0) apply(state, e.type, e.data);
      next++;
    } else if (e.type === 'item.move') {
      // A move adds to the conversation's end as an add does, so the place of the next add counts it.
      if (how === 'replace') r.total++;
      const verdict = moveIn(list, r.start + list.length === next, e.data);
      if (verdict === 'apply') apply(state, e.type, e.data);
      reload ||= verdict === 'reload';
      next++;
    } else apply(state, e.type, e.data);
  }
  return reload;
}

/** Forgets a conversation the page closed: its items and its range. @param {any} state @param {Map<string, Range>} ranges @param {string} threadId */
export function forget(state, ranges, threadId) {
  ranges.delete(threadId);
  delete state.items[threadId];
}
