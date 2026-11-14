// A thread’s record and its place in its conversation (#101, #110, #121, #796): starting a conversation, the one
// write of a thread that already exists, naming it, the threads it branched from, and the glossary it inherits.
// Moved here from server/threads.mjs, server/threads.mjs and server/conversations.mjs.
//
// The one write of a thread that already exists (#796): it starts from the thread as memory will hold it once what is
// held behind a commit is released (store.pending.thread), never from the published one. A write built from the
// published thread overwrote a write of the same thread still held: a queued wake was lost, and the wake limit stopped
// counting (designs/508/601-held-view.md, “a read that decides a write reads pending”). The thread is put whole, as
// the `thread` event has always carried it, so the reducer, A2’s conversion and the page see no new shape.
// tests/thread-write-guard.test.mjs places every thread write, so a new one goes through here.

import { httpError } from './helpers.mjs';
import { newId } from './store.mjs';

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

/** @param {any} rt @param {{ projectId: string, title: string, personaIds?: string[], kind?: string, parentId?: string|null }} opts */
export function createThread(rt, { projectId, title, personaIds = [], kind = 'thread', parentId = null }) {
  if (!rt.s.projects[projectId]) throw httpError(404, 'That project doesn’t exist.');
  const t = rt.putThread({
    id: newId('th'),
    projectId,
    title: title || 'New conversation',
    kind,
    parentId,
    members: [],
    lastSpeaker: null,
    hops: 0,
    queue: [],
    createdAt: Date.now(),
  });
  for (const pid of personaIds) rt.ensureSession(t.id, pid);
  // As written, with its members: behind a held commit the published state doesn’t have it yet, and the route sends
  // this as its body.
  return rt.store.pending.thread(t.id);
}

export function renameThread(rt, threadId, title) {
  threadToWrite(rt, threadId);
  const name = String(title ?? '')
    .trim()
    .slice(0, 120);
  if (!name) throw httpError(422, 'A conversation needs a name.');
  return updateThread(rt, threadId, { title: name });
}

// A thread’s place in its conversation (#101, #110, #121): the threads it branched from (its lineage), every thread of
// the conversation it belongs to, and the glossary it inherits along its lineage. Moved out of server/runtime.mjs;
// Runtime keeps a method of each name that delegates here.

/**
 * Every thread of a thread’s conversation: its lineage first, then the conversation’s other side and topic threads.
 * What read_conversation { thread } and read_message may read.
 * @param {string} threadId
 */
export function conversationThreads(rt, threadId) {
  const own = rt.lineage(threadId);
  const root = own.at(-1);
  const rest = Object.values(rt.s.threads)
    .filter((t) => !own.includes(t.id) && rt.lineage(t.id).at(-1) === root)
    .map((t) => t.id);
  return [...own, ...rest];
}

/** A thread, then the conversation it branched from, following parentId (a topic or side thread’s is one level), as `thread` reads one. */
export function lineage(rt, threadId, thread = (/** @type {string} */ id) => rt.s.threads[id]) {
  const out = [];
  for (let id = threadId; id && thread(id) && !out.includes(id) && out.length < 8; id = thread(id).parentId) out.push(id);
  return out;
}

/**
 * The terms a thread knows: its own glossary over its parent’s, so a topic thread inherits its conversation’s
 * terms and its own definition wins. The browser’s glossaryOf (app/js/thread.mjs) merges the same way.
 */
export function glossaryFor(rt, threadId) {
  return Object.assign(
    {},
    ...rt
      .lineage(threadId)
      .map((id) => rt.s.glossary[id] ?? {})
      .reverse(),
  );
}
