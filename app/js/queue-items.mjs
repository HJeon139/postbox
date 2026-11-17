// The items an open queue needs and the page hasn’t loaded (#1456): a message from another thread, or from outside the
// range the page holds, and a card the person answered. Fetched through the conversation’s items route, only for the
// rows in view and a few at a time, so a long queue costs what the person looks at; kept until the queue closes.

import { fetchRange } from './item-ranges.mjs';

/** The most item requests one queue has open at once. */
export const AT_ONCE = 4;

/**
 * What a row wants fetched: its entry’s item, when the page lacks it.
 * @typedef {{ threadId: string, itemId: string }} Want
 */

/** A queue’s fetched items. Its rows carry their entry (`_entry`), whose `q.want` names the item they lack. */
export class QueueItems {
  /** @param {() => void} changed  called when an item lands, for the queue to repaint */
  constructor(changed) {
    this.changed = changed;
    /** @type {Map<string, any>} each fetched item by id */
    this.got = new Map();
    /** @type {Map<string, Want>} each item asked for and not yet come, by id; a reply to one dropped since is let go */
    this.asking = new Map();
    /** @type {Want[]} asked for, waiting for a free request */
    this.waiting = [];
    this.open = 0;
    this.observer = new IntersectionObserver((seen) => {
      for (const { target, isIntersecting } of seen) {
        const row = /** @type {any} */ (target);
        row._inView = isIntersecting;
        if (isIntersecting) this.ask(row);
        else this.drop(row);
      }
    });
  }

  /** The fetched item with this id, if it has come. @param {string} itemId */
  item(itemId) {
    return this.got.get(itemId);
  }

  /** Follows a new row into and out of view. @param {Element} row */
  watch(row) {
    this.observer.observe(row);
  }

  /** After a row is filled: asks for its item if it’s in view and wants one. @param {any} row */
  fill(row) {
    if (row._inView) this.ask(row);
  }

  /** Drops a fetched copy that’s out of date, such as a message the person just edited. @param {string} itemId */
  forget(itemId) {
    this.got.delete(itemId);
    this.asking.delete(itemId);
  }

  /** The queue closed: nothing more is asked for, and a reply still on its way paints nothing. */
  close() {
    this.observer.disconnect();
    this.asking.clear();
    this.waiting.length = 0;
  }

  /** Asks for a row’s item once, if it wants one. @param {any} row */
  ask(row) {
    const want = /** @type {Want | null} */ (row._entry?.q.want);
    if (!want || this.got.has(want.itemId) || this.asking.has(want.itemId)) return;
    this.asking.set(want.itemId, want);
    this.waiting.push(want);
    this.pump();
  }

  /** A row scrolled out of view before its turn gives its place up. @param {any} row */
  drop(row) {
    const want = row._entry?.q.want;
    const at = want ? this.waiting.findIndex((w) => w.itemId === want.itemId) : -1;
    if (at < 0) return;
    this.waiting.splice(at, 1);
    this.asking.delete(want.itemId);
  }

  /** Starts what waits, up to AT_ONCE requests at a time. */
  pump() {
    while (this.open < AT_ONCE && this.waiting.length) this.fetch(/** @type {Want} */ (this.waiting.shift()));
  }

  /** @param {Want} want */
  fetch({ threadId, itemId }) {
    this.open++;
    fetchRange(threadId, `?around=${encodeURIComponent(itemId)}&limit=1`)
      .then((answer) => {
        const item = answer.items.find((it) => it.id === itemId);
        // Not asked for any more: the queue closed, or the person edited it, while it was on its way.
        if (!item || !this.asking.has(itemId)) return;
        this.asking.delete(itemId);
        this.got.set(itemId, item);
        this.changed();
      })
      // The row keeps its placeholder, and asks no more: the item was deleted, or the server is gone, which the page
      // says on its own.
      .catch(() => {})
      .finally(() => {
        this.open--;
        this.pump();
      });
  }
}
