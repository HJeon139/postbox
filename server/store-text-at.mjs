// An item.text as the event log writes it (designs/architecture/live-progress.md, “Commit points”). A running reply’s
// stored chunk carries `at`, where its words start in the item, so a page that had some of them live adds only what it
// lacks (shared/state.mjs, item.text). The log is ordered and complete, so there a chunk that starts at its item’s end
// says nothing with `at`: it’s written without it, and a load appends it, as the reducer does with any item.text
// without `at`. Only the line written leaves it out; the event the store keeps for since() and the streams has it.

import { itemOf } from '../shared/item-index.mjs';

/**
 * One event as the log writes it, from the state before it: an item.text whose `at` is its item’s end then, without it.
 * The same rule as written(), for an emit, which writes one event at a time. @param {any} state @param {any} ev
 */
export function writtenOne(state, ev) {
  const d = ev.data;
  if (ev.type !== 'item.text' || typeof d?.at !== 'number') return ev;
  if (d.at !== (itemOf(state.items?.[d.threadId] ?? [], d.id)?.text ?? '').length) return ev;
  const { at, ...data } = d;
  return { ...ev, data };
}

/**
 * The events as the log writes them, from the state before them: an item.text whose `at` is its item’s end then, the
 * words before it in the same events counted, without its `at`. Every other event as it is.
 * @param {any} state @param {any[]} events
 */
export function written(state, events) {
  /** @type {Map<string, number>} what each item’s text will reach, by the chunks before this one */
  const ends = new Map();
  return events.map((ev) => {
    if (ev.type !== 'item.text' || typeof ev.data?.at !== 'number') return ev;
    const key = `${ev.data.threadId} ${ev.data.id}`;
    const end = ends.get(key) ?? (itemOf(state.items?.[ev.data.threadId] ?? [], ev.data.id)?.text ?? '').length;
    ends.set(key, Math.max(end, ev.data.at + String(ev.data.text ?? '').length));
    if (ev.data.at !== end) return ev;
    const { at, ...data } = ev.data;
    return { ...ev, data };
  });
}
