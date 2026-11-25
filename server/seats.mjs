// Seats (#558, prototype): every actor in a room, an agent or a person, is reached the same way. An @-mention of an
// agent is an entry in its inbox that starts its turn (server/mention-entries.mjs); an @-mention of a person is an
// entry in theirs, which they read or dismiss from their queue, and which counts as “needs you” for them alone.
//
// A person’s seat can be filled the way an agent’s is: by anything with the adapter’s `deliver(seat, message, ctx)`
// (server/adapters/adapter.mjs). A real person has none: the page is how they answer. A scripted person
// (server/adapters/mock-person.mjs) stands in for one in the demo and the tests, and what it writes through `ctx.text`
// is sent as that person’s message through sendMessage, the path the page’s own Send takes.

import { parseMentions } from '../shared/text.mjs';

/** How many times a scripted person answers in one conversation: a script never keeps a chain of wakes going. */
const SCRIPTED_REPLIES = 3;

export class Seats {
  /**
   * @param {{ rt: any, people: import('./people.mjs').People, drivers?: Record<string, { deliver: Function }>, defer?: (fn: () => void) => void }} deps
   *   drivers: what fills a seat, by the person’s `filledBy`
   */
  constructor({ rt, people, drivers = {}, defer = setImmediate }) {
    this.rt = rt;
    this.people = people;
    this.drivers = drivers;
    this.defer = defer;
    /** @type {Map<string, number>} a scripted person’s replies, by person and conversation */
    this.replied = new Map();
  }

  listen() {
    this.rt.bus.on('item.final', (/** @type {any} */ final) => this.mentioned(final));
  }

  /** A whole message, an agent’s or a person’s: each person it @-mentions gets an entry. @param {{ threadId: string, item: any }} final */
  mentioned({ threadId, item }) {
    if ((item.kind !== 'agent' && item.kind !== 'user') || !item.text) return;
    const to = parseMentions(item.text, this.people.handles())
      .map((h) => this.people.byHandle(h))
      .filter((p) => p && p.id !== item.by?.id);
    if (!to.length) return;
    const from = item.kind === 'agent' ? `@${item.handle}` : (item.by?.label ?? 'The person');
    // After the item’s own write settles: this listener runs inside it.
    this.defer(() => {
      // While the store can’t be written, nothing is: the mention stays in the message, and no entry is made for it.
      if (this.rt.store && !this.rt.store.writable) return;
      this.rt.threads.patchItem(threadId, item.id, { forPeople: to.map((p) => ({ id: p.id, handle: p.handle, name: p.name })) });
      for (const p of to) {
        const entry = this.people.enqueue(p, { threadId, itemId: item.id, from });
        const driver = p.filledBy && this.drivers[p.filledBy];
        if (driver)
          this.fill(driver, p, entry, { kind: item.kind, from, handle: item.kind === 'agent' ? item.handle : item.by?.handle, text: item.text }).catch((e) =>
            console.error(`@${p.handle}’s seat failed: ${e.message}`),
          );
      }
    });
  }

  /** A driver takes a person’s entry as an adapter takes a turn, and what it wrote is sent as the person. */
  async fill(/** @type {{ deliver: Function }} */ driver, /** @type {any} */ person, /** @type {any} */ entry, /** @type {any} */ message) {
    const key = `${person.id}\n${entry.threadId}`;
    const n = this.replied.get(key) ?? 0;
    if (n >= SCRIPTED_REPLIES) return;
    this.replied.set(key, n + 1);
    let text = '';
    const stop = new AbortController();
    const ctx = { text: (/** @type {string} */ d) => (text += d), status() {}, activity() {}, signal: stop.signal };
    await driver.deliver({ id: person.id, handle: person.handle }, message, ctx);
    this.people.settle(person, entry.id, 'read');
    if (text.trim()) this.rt.sendMessage(entry.threadId, { text, by: this.people.byline(person) });
  }
}
