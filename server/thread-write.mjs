// The one write of a thread that already exists (#796): it starts from the thread as memory will hold it once what is
// held behind a commit is released (store.pending.thread), never from the published one. A write built from the
// published thread overwrote a write of the same thread still held: a queued wake was lost, and the wake limit stopped
// counting (designs/508/601-held-view.md, “a read that decides a write reads pending”). The thread is put whole, as
// the `thread` event has always carried it, so the reducer, A2’s conversion and the page see no new shape.
// tests/thread-write-guard.test.mjs places every thread write, so a new one goes through here.

import { httpError } from './helpers.mjs';

/**
 * Writes one thread: its pending state with `change` applied. `change` is the fields to set, or a function of the
 * pending thread that returns them, or null to write nothing, so a field read to decide the write is read pending
 * too. A thread that doesn’t exist, published or held, isn’t written. Returns the thread as written, or undefined.
 * @param {import('./runtime.mjs').Runtime} rt @param {string} id
 * @param {Record<string, unknown> | ((t: any) => Record<string, unknown> | null)} change
 */
export function updateThread(rt, id, change) {
  const t = rt.store.pending.thread(id);
  if (!t) return undefined;
  const patch = typeof change === 'function' ? change(t) : change;
  if (!patch) return undefined;
  const next = { ...t, ...patch };
  rt.store.emit('thread', next);
  return next;
}

/**
 * The thread a write is about to change, as memory will hold it, or a 404 when it doesn’t exist there: one just started
 * behind a held commit isn’t published yet, and one just deleted still is (#796’s class). A route that sends what the
 * write returns then answers with the thread, or this refusal, never with nothing.
 * @param {import('./runtime.mjs').Runtime} rt @param {string} id
 */
export function threadToWrite(rt, id) {
  const t = rt.store.pending.thread(id);
  if (!t) throw httpError(404, 'That thread doesn’t exist. It may have been deleted.');
  return t;
}

/** Every thread, as memory will hold them once what is held is released: for a sweep whose finds decide writes. */
export const pendingThreads = (/** @type {import('./runtime.mjs').Runtime} */ rt) => Object.values(rt.store.pending.threads());
