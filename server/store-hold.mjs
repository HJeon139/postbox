// Emits made while a commit waits (#508’s design, “Storage”, “How it works”; review finding 1 on #525).
//
// The rule: one order everywhere. A commit’s events come before every emit made after commit() was called, in Redis,
// in the stream every browser reads, and in the server’s own state. Such an emit is still applied at once, so the
// server reads its own writes, but it is held: numbered, broadcast and written only once no commit waits. The hold
// keeps, from just before a held emit first changes it, each record (and each conversation’s item list) as it was:
// - a commit stages its documents, and writes what earlier emits left unwritten, from those values, never from a held
//   emit’s, so Redis never holds an emit the stream doesn’t;
// - when a commit’s events, or events another process wrote, are applied while emits are held and change something a
//   held emit changed, the state is put back to those values, the written events are applied, and the held emits are
//   applied again from their JSON, in order. The state is then what the stream replays to: written events, then emits.
// Events that change nothing a held emit changed are applied on top, since the two orders give the same state.

import { apply, map } from '../shared/state.mjs';
import { touched } from './store-docs.mjs';

/** A deep copy that keeps a record map’s null prototype (a conversation’s glossary). @param {any} v */
const copy = (v) => {
  const c = structuredClone(v);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === null) Object.setPrototypeOf(c, null);
  return c;
};

/** What two changes meet on: a record, the settings, or a conversation’s list of items. @param {any} r */
const keyOf = (r) => (r.c === 'settings' ? 'settings' : r.c === 'items' || r.c === 'itemlist' ? `list:${r.t}` : `${r.c}\n${r.id}`);

export class Hold {
  constructor() {
    /** @type {{ ev: { seq: number, type: string, data: any }, json: string, refs: any[] }[]} emits held, in order */
    this.emits = [];
    this.clear();
  }

  clear() {
    /** @type {any} the settings before the hold changed them */
    this.settings = undefined;
    /** @type {Map<string, Map<string, { had: boolean, v: any }>>} collection → id → the record before */
    this.recs = new Map();
    /** @type {Map<string, { had: boolean, list: any[] }>} conversation → its list before (shallow) */
    this.lists = new Map();
    /** @type {Map<string, any>} `<conversation>\n<id>` → the item before */
    this.items = new Map();
  }

  /** Keeps, the first time, what these refs let the reducer change. Called before the held emit is applied. */
  save(s, refs) {
    for (const r of refs) {
      if (r.c === 'settings') this.settings ??= copy(s.settings);
      else if (r.c === 'items' || r.c === 'itemlist') {
        if (!this.lists.has(r.t)) this.lists.set(r.t, { had: r.t in s.items, list: [...(s.items[r.t] ?? [])] });
        const k = `${r.t}\n${r.id}`;
        if (r.c === 'items' && !this.items.has(k)) this.items.set(k, copy(s.items[r.t]?.find((it) => it.id === r.id)));
      } else {
        const m = this.recs.get(r.c) ?? this.recs.set(r.c, new Map()).get(r.c);
        if (!m?.has(r.id)) m?.set(r.id, { had: r.id in s[r.c], v: copy(s[r.c][r.id]) });
      }
    }
  }

  /** Whether events with these refs change something a held emit changed. @param {any[]} refs */
  meets(refs) {
    if (!this.emits.length) return false;
    const mine = new Set(this.emits.flatMap((h) => h.refs.map(keyOf)));
    return refs.some((r) => mine.has(keyOf(r)));
  }

  /** A conversation’s list as it was, with copies of its items as they were. @param {string} t */
  listOf(t) {
    const was = /** @type {{ had: boolean, list: any[] }} */ (this.lists.get(t));
    const before = (it) => this.items.get(`${t}\n${it.id}`);
    return was.had ? was.list.map((it) => (before(it) === undefined ? it : copy(before(it)))) : undefined;
  }

  /** Writes the values from before the hold into a state: a shallow copy of the real one, or the real one. */
  into(s) {
    if (this.settings) s.settings = copy(this.settings);
    for (const [c, m] of this.recs)
      for (const [id, { had, v }] of m)
        if (had) s[c][id] = copy(v);
        else delete s[c][id];
    for (const t of this.lists.keys()) {
      const list = this.listOf(t);
      if (list) s.items[t] = list;
      else delete s.items[t];
    }
    return s;
  }

  /** The state as it was before the held emits, sharing everything they didn’t change; for staging a commit. */
  view(s) {
    const v = { ...s };
    for (const c of this.recs.keys()) v[c] = map({ ...s[c] });
    if (this.lists.size) v.items = map({ ...s.items });
    return this.into(v);
  }

  /** An item of the view, by conversation and id. @param {any} v @param {(t: string, id: string) => any} itemOf */
  itemOf(v, itemOf) {
    return (t, id) => (this.lists.has(t) ? v.items[t]?.find((it) => it.id === id) : itemOf(t, id));
  }

  /**
   * Puts the state back to before the held emits, runs `written` (which applies events Redis holds), then applies the
   * held emits again, in order, keeping what they change anew.
   * @param {import('./store.mjs').Store} store @param {() => void} written
   */
  rebase(store, written) {
    const s = store.state;
    this.into(s);
    for (const t of this.lists.keys()) for (const it of s.items[t] ?? []) store.index.set(it.id, { t, it });
    written();
    this.clear();
    for (const h of this.emits) {
      const data = JSON.parse(h.json);
      h.refs = touched(s, h.ev.type, data);
      this.save(s, h.refs);
      apply(s, h.ev.type, data);
      store.track(h.ev.type, data, h.refs);
    }
  }
}
