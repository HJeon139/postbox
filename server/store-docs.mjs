// How the store’s state maps onto Redis documents (designs/508/design.md, “Storage: a Redis 8 server that Postbox
// bundles and runs”, “How it works”). Every record of a collection is a JSON document under `<kind>:<id>`, with its
// collection’s order in the sorted set `order:<collection>`; each item is `item:<id>`, placed in its conversation by
// the sorted set `thread:<id>:items`, scored by position; the settings are the document `settings`. Each document is
// `{ v, d }`: `d` the value as the reducer keeps it, `v` its shape, lifted to the current one on read (decision 5).
// Pure: which documents an event touches, and the writes that make Redis match a state.

import { map } from '../shared/state.mjs';

/** The shape of every document written now. A newer one is refused on read; an older one is lifted by UPCAST. */
export const DOC_V = 1;

/** @type {Record<number, (d: any) => any>} each lifts a document of shape v to v + 1 */
const UPCAST = {};

/** The key prefix of each collection’s documents. */
export const KIND = Object.freeze({
  projects: 'project',
  personas: 'persona',
  boilerplates: 'boilerplate',
  threads: 'thread',
  sessions: 'session',
  glossary: 'glossary',
  apps: 'app',
  files: 'file',
  datasets: 'dataset',
  schedules: 'schedule',
  hosts: 'host',
  hostStatus: 'hoststatus',
  work: 'work',
});
export const COLLECTIONS = /** @type {(keyof typeof KIND)[]} */ (Object.keys(KIND));

/**
 * @typedef {{ c: 'settings' } | { c: keyof typeof KIND, id: string, move?: boolean }
 *   | { c: 'items', t: string, id: string, add?: boolean, move?: boolean, stubOf?: string }
 *   | { c: 'itemlist', t: string, ids: string[] }} Ref
 */

/**
 * The documents an event changes. Read before the event is applied: removing a conversation needs its item ids.
 * @param {any} s  the state before the event @param {string} type @param {any} d
 * @returns {Ref[]}
 */
export function touched(s, type, d) {
  const one = (c) => [{ c, id: d.id }];
  switch (type) {
    case 'settings':
      return [{ c: 'settings' }];
    case 'project':
    case 'persona':
    case 'thread':
    case 'app':
    case 'file':
    case 'dataset':
      return one(`${type}s`);
    case 'boilerplate':
      return [{ c: 'boilerplates', id: d.id, move: true }];
    case 'session':
    case 'session.patch':
      return one('sessions');
    case 'schedule':
      return one('schedules');
    case 'host':
      return [...one('hosts'), ...one('hostStatus')];
    case 'host.status':
      return one('hostStatus');
    case 'glossary':
      return [{ c: 'glossary', id: d.threadId }];
    case 'work.add':
    case 'work.patch':
      return [{ c: 'work', id: d.convId }];
    case 'item.add':
      return [{ c: 'items', t: d.threadId, id: d.item.id, add: true }];
    case 'item.patch':
    case 'item.text':
      return [{ c: 'items', t: d.threadId, id: d.id }];
    case 'item.move':
      return [
        { c: 'items', t: d.threadId, id: d.stub.id, stubOf: d.id },
        { c: 'items', t: d.threadId, id: d.id, move: true },
      ];
    case 'remove':
      return removed(s, d);
    default:
      return [];
  }
}

/** @param {any} s @param {{ kind: string, id: string }} d @returns {Ref[]} */
function removed(s, d) {
  if (d.kind === 'session') return [{ c: 'sessions', id: d.id }];
  if (d.kind === 'app') return [{ c: 'apps', id: d.id }];
  if (d.kind !== 'thread') return [];
  const ids = (s.items[d.id] ?? []).map((i) => i.id);
  return [
    { c: 'threads', id: d.id },
    { c: 'itemlist', t: d.id, ids },
    { c: 'glossary', id: d.id },
    { c: 'work', id: d.id },
  ];
}

/** A key for de-duplicating refs within one write. @param {Ref} r */
export const refKey = (r) => (r.c === 'settings' ? 'settings' : r.c === 'itemlist' ? `itemlist:${r.t}` : r.c === 'items' ? `item:${r.id}` : `${r.c}:${r.id}`);

/** A document to write. @param {any} d @param {object} [extra] */
const doc = (d, extra) => JSON.stringify({ v: DOC_V, ...extra, d });

/**
 * The writes that make Redis hold these documents as they are in `s` now: ['S', key, json] sets, ['D', key] deletes,
 * ['Z', zset, score, member] and ['ZN', …] (only if absent) place, ['R', zset, member] unplaces.
 * @param {any} s
 * @param {Iterable<{ ref: Ref, seq: number }>} dirty  each ref with the seq of the event that first touched it
 * @param {(t: string, id: string) => any} itemOf  the item in conversation t, or undefined
 * @param {(t: string, id: string) => number | undefined} scoreOf  its position
 * @returns {(string|number)[][]}
 */
export function writesFor(s, dirty, itemOf, scoreOf) {
  const out = [];
  for (const { ref: r, seq } of dirty) {
    if (r.c === 'settings') out.push(['S', 'settings', doc(s.settings)]);
    else if (r.c === 'itemlist') {
      for (const id of r.ids) out.push(['D', `item:${id}`]);
      out.push(['D', `thread:${r.t}:items`], ['R', 'order:items', r.t]);
    } else if (r.c === 'items') {
      const it = itemOf(r.t, r.id);
      const score = scoreOf(r.t, r.id);
      if (it && score !== undefined)
        out.push(['S', `item:${r.id}`, doc(it, { t: r.t })], ['Z', `thread:${r.t}:items`, score, r.id], ['ZN', 'order:items', seq, r.t]);
      else out.push(['D', `item:${r.id}`], ['R', `thread:${r.t}:items`, r.id]);
    } else {
      const v = s[r.c]?.[r.id];
      const key = `${KIND[r.c]}:${r.id}`;
      if (v === undefined) out.push(['D', key], ['R', `order:${r.c}`, r.id]);
      else out.push(['S', key, doc(v)], [r.move ? 'Z' : 'ZN', `order:${r.c}`, seq, r.id]);
    }
  }
  return out;
}

/**
 * A document’s value in the current shape. A document from a newer Postbox is refused, since this one can’t read it.
 * @param {{ v: number, d: any }} raw @param {string} key
 */
export function upcast(raw, key) {
  let { v, d } = raw;
  if (v > DOC_V)
    throw Object.assign(new Error(`${key} was written by a newer Postbox (shape ${v}); this one reads up to ${DOC_V}. Update Postbox.`), { code: 'ENEWER' });
  while (v < DOC_V) d = UPCAST[v++](d);
  return d;
}

/**
 * Item positions per conversation: what `thread:<id>:items` scores by. A new item goes last; a moved one goes last and
 * its stub takes its old place, as the reducer does with the list.
 */
export class Positions {
  /** @param {Positions | null} [base]  a fork reads through to its base, and copies a conversation it changes */
  constructor(base = null) {
    /** @type {Map<string, { at: Map<string, number>, max: number }>} */
    this.byThread = new Map();
    this.base = base;
  }
  /** @param {string} t */
  of(t) {
    let m = this.byThread.get(t);
    if (!m) {
      const b = this.base?.byThread.get(t);
      m = b ? { at: new Map(b.at), max: b.max } : { at: new Map(), max: 0 };
      this.byThread.set(t, m);
    }
    return m;
  }
  /** @param {string} t @param {string} id */
  score(t, id) {
    return (this.byThread.get(t) ?? this.base?.byThread.get(t))?.at.get(id);
  }
  /** @param {string} t @param {string} id @param {number} n */
  set(t, id, n) {
    const m = this.of(t);
    m.at.set(id, n);
    if (n > m.max) m.max = n;
  }
  /** Places what an event adds or moves. @param {Ref[]} refs */
  place(refs) {
    for (const r of refs) {
      if (r.c === 'itemlist') this.byThread.set(r.t, { at: new Map(), max: 0 });
      if (r.c !== 'items') continue;
      const m = this.of(r.t);
      if (r.stubOf !== undefined) {
        const old = m.at.get(r.stubOf);
        if (old !== undefined) this.set(r.t, r.id, old);
      } else if (r.add || (r.move && m.at.has(r.id))) this.set(r.t, r.id, m.max + 1);
    }
  }
  /** A copy for writes that may not happen; merge() keeps what it placed. */
  fork() {
    return new Positions(this);
  }
  /** @param {Positions} f */
  merge(f) {
    for (const [t, m] of f.byThread) this.byThread.set(t, m);
  }
}

/** An empty map of a collection, for reading documents into. */
export const emptyCollection = () => map();
