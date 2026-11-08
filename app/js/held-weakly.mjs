// Holding drawn elements without keeping them alive (#866, hotfix 3). An element that has left the page keeps its
// whole old page alive through its parents, so a module that keeps drawn elements to repaint them later held one more
// copy of a long room’s page for each trip into it and back. Each such holder keeps its elements here, weakly: one the
// page has let go of is let go of here too, and its listener stops.

import { client } from './client.mjs';

/**
 * Calls fn with el and each client change while el is alive. Once el has been collected, the listener goes; fn may
 * also stop it sooner with the off it’s given. fn must reach el only through its argument, and must not be made in a
 * scope where another function closes over el: a function shares its scope with every other made beside it, so it
 * would keep el alive.
 * @template {Element} E
 * @param {E} el @param {(el: E, change: any, off: () => void) => void} fn
 * @returns {() => void} off
 */
export function onChangeWhileAlive(el, fn) {
  const ref = new WeakRef(el);
  const listener = (change) => {
    const live = ref.deref();
    if (!live) return off();
    fn(live, change, off);
  };
  // Marked, so a spec counting the page’s listeners can leave out those that go once their element is collected.
  listener.whileAlive = true;
  const off = client.on(listener);
  return off;
}

/** Elements held weakly, in the order they were added: iterating visits those still alive and forgets the rest. */
export class WeakElements {
  /** @type {Set<WeakRef<HTMLElement>>} */
  #refs = new Set();
  /** @param {HTMLElement} el */
  add(el) {
    this.#refs.add(new WeakRef(el));
  }
  get size() {
    return this.#refs.size;
  }
  /** Forgets el, if it’s held. @param {HTMLElement} el */
  delete(el) {
    for (const r of this.#refs) if (r.deref() === el) this.#refs.delete(r);
  }
  *[Symbol.iterator]() {
    for (const r of this.#refs) {
      const el = r.deref();
      if (el) yield el;
      else this.#refs.delete(r);
    }
  }
}
