// The client store and the live connection. It loads the whole state once, then applies numbered events
// from the server-sent event stream with the same reducer the server uses. On a dropped connection the
// browser reconnects with the last number it saw; events at or below it are ignored, so nothing is
// applied twice. If the server no longer has the events, it says "resync" and the state is refetched.
// The numbers count within a history epoch, which the state names and the stream request echoes: after
// a restart the server runs on a new one, and says "resync" to a page from the old one, whose numbers may
// name events the server never kept (server/live-streams.mjs). The page's epoch is the one its loaded
// state came with, never one heard on the stream alone.

import { itemOf, positionOf } from '/shared/item-index.mjs';
import { needsYouNow, whereNeeds } from '/shared/needs.mjs';
import { apply, ownState, PUBLIC_EVENT_TYPES, STREAM } from '/shared/state.mjs';
import { fetchRange, gate, loading, place } from './item-ranges.mjs';

// The event types the page hears: every public type in shared/state.mjs's table, and the cursor the server sends in
// place of any other (server/public-state.mjs).
const EVENT_TYPES = [STREAM.cursor, ...PUBLIC_EVENT_TYPES];

export const client = {
  state: null,
  // Each thread’s header facts (shared/thread-header.mjs, #1155), from /api/state and then the stream’s header frames.
  headers: {},
  // The conversations the page has open, each with how many views show it, and the range of items it holds of each
  // (app/js/item-ranges.mjs, app/js/open-threads.mjs). The page holds no other conversation’s items.
  /** @type {Map<string, number>} */
  open: new Map(),
  /** @type {Map<string, import('./item-ranges.mjs').Range>} */
  ranges: new Map(),
  config: null,
  seq: 0,
  epoch: '',
  // Whether the server can save changes, and why not (ST-3): { writable, cause: { code, message } | null, lost, warning,
  // retrying, savedThrough }, from /api/state and then the stream’s `status` frames (app/js/store-line.mjs).
  store: null,
  connection: 'connecting',
  attempts: 0,
  listeners: new Set(),
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  emit(change) {
    for (const fn of this.listeners) fn(change);
  },
};

export async function load() {
  const r = await fetch('/api/state', { cache: 'no-store' });
  if (!r.ok) throw new Error('Postbox’s server didn’t answer. Check that it’s running, then reload.');
  const { seq, epoch, state, config, store, headers } = await r.json();
  const next = ownState(state);
  await refill(next, epoch);
  client.state = next;
  client.headers = headers ?? {};
  client.config = config;
  client.seq = seq;
  client.epoch = epoch ?? '';
  client.store = store ?? null;
  client.emit({ type: 'load' });
}

/**
 * Loads each open conversation’s items again into a state the page is about to take (a resync): the range it held, or
 * its latest when that held the newest item, so what you read stays and nothing is loaded twice. One that fails, or
 * comes from another history, is loaded fresh by its view.
 * @param {any} next @param {string} epoch
 */
async function refill(next, epoch) {
  const ranges = new Map();
  await Promise.all(
    [...client.open.keys()].map(async (id) => {
      const r = client.ranges.get(id);
      const list = client.state?.items[id] ?? [];
      const mid = r && r.start + list.length < r.total ? list[list.length >> 1]?.id : null;
      const answer = await fetchRange(id, mid ? `?around=${encodeURIComponent(mid)}` : '').catch(() => null);
      if (!answer || (answer.epoch ?? epoch) !== epoch) return;
      loading(ranges, id);
      place(next, ranges, answer, 'replace');
    }),
  );
  client.ranges = ranges;
}

/**
 * One numbered frame from the stream: an event the page applies, or a cursor that only moves its place on.
 * @param {string} t @param {MessageEvent} e
 */
function hear(t, e) {
  const seq = Number(e.lastEventId);
  if (seq && seq <= client.seq) return;
  // A cursor stands for an event the page doesn't see: it moves the page's place on, and nothing else.
  if (t === STREAM.cursor) {
    client.seq = seq || client.seq;
    return;
  }
  const data = JSON.parse(e.data);
  // An item’s change applies only to a range the page holds (app/js/item-ranges.mjs).
  const verdict = t.startsWith('item.') ? gate(client.state, client.ranges, t, data, seq) : 'apply';
  client.seq = seq || client.seq;
  if (verdict === 'reload') client.emit({ type: 'range.stale', data: { threadId: data.threadId } });
  if (verdict === 'beyond') client.emit({ type: 'item.beyond', data: { threadId: data.threadId, item: data.item } });
  if (verdict !== 'apply') return;
  apply(client.state, t, data);
  // A session’s change comes as only its changed fields (designs/508, “Store events”); listeners hear the whole
  // session, as they did when the server sent it whole.
  if (t === 'session.patch') {
    const se = client.state.sessions[data.id];
    if (se) client.emit({ type: 'session', data: se });
  } else client.emit({ type: t, data });
}

let es = null;
/**
 * Opens the page's stream, in place of any open one. `quiet`: the page's own reconnect for the conversations it has
 * open (reopen), which from open to open tells the rest of the page nothing, as the outbox and app checks hear a
 * connection's return. @param {{ quiet?: boolean }} [o]
 */
export function connect({ quiet = false } = {}) {
  es?.close();
  // Item events only for the conversations open here (#1155); every other event, and each thread’s header, for all.
  const open = encodeURIComponent([...client.open.keys()].join(','));
  es = new EventSource(`/api/stream?since=${client.seq}&epoch=${encodeURIComponent(client.epoch)}&open=${open}`);
  es.onopen = () => {
    const was = client.connection;
    client.connection = 'open';
    client.attempts = 0;
    if (!quiet || was !== 'open') client.emit({ type: 'connection', was });
  };
  es.onerror = () => {
    client.attempts++;
    client.connection = 'reconnecting';
    client.emit({ type: 'connection' });
    // EventSource retries by itself, resending Last-Event-ID. If it gave up, start again.
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, Math.min(8000, 1000 * client.attempts));
  };
  for (const t of EVENT_TYPES) es.addEventListener(t, (e) => hear(t, /** @type {MessageEvent} */ (e)));
  // The epoch the stream runs on, its first frame. The page’s epoch is only ever the one that came with a state it
  // loaded: a frame naming another means the state the page shows is from a history the server no longer runs on, so it
  // loads the state again, as a resync does. Taking the epoch from the frame would, if that load then failed, send the
  // new epoch with the old state on the next reconnect, which the server would accept at an equal seq.
  es.addEventListener(STREAM.epoch, (e) => {
    if ((JSON.parse(e.data) ?? '') !== client.epoch) void resync();
  });
  es.addEventListener(STREAM.resync, resync);
  // A thread’s header, unnumbered: it follows the event that changed it, and null says the thread was removed.
  es.addEventListener(STREAM.header, (e) => {
    const { threadId, header } = JSON.parse(e.data);
    if (header) client.headers[threadId] = header;
    else delete client.headers[threadId];
    client.emit({ type: 'header', data: { threadId, header } });
  });
  // The store’s status, unnumbered: each time it can’t save, or can again (app/js/store-line.mjs).
  es.addEventListener(STREAM.status, (e) => {
    client.store = JSON.parse(e.data);
    client.emit({ type: 'store' });
  });
}

/**
 * Opens the stream again with the conversations open now (app/js/open-threads.mjs), at most once a task, so closing one
 * and opening another reconnects once. Not before the page’s first connect, nor during a resync, which connects itself.
 */
let reopening = false;
export function reopen() {
  if (reopening) return;
  reopening = true;
  queueMicrotask(() => {
    reopening = false;
    if (es && !resyncing) connect({ quiet: true });
  });
}

// Loads the state again and reconnects on the epoch it came with; one at a time, so the epoch frame and the resync
// frame the server sends together load once. While the load fails, the page keeps its state and its epoch, and
// connects again shortly: naming the old epoch, it’s told to resync again, until a load succeeds.
let resyncing = null;
function resync() {
  es?.close(); // the old stream stops applying another history’s events onto this state while the load runs
  resyncing ??= load()
    .then(connect, () => {
      client.attempts++;
      client.connection = 'reconnecting';
      client.emit({ type: 'connection' });
      setTimeout(connect, Math.min(8000, 1000 * client.attempts));
    })
    .finally(() => {
      resyncing = null;
    });
  return resyncing;
}

// Browsers allow 6 connections per host over HTTP/1.1, and each open tab’s stream holds one. Close the
// stream when this page goes away (including into the back/forward cache) and reopen it when it returns.
addEventListener('pagehide', () => {
  es?.close();
  es = null;
});
addEventListener('pageshow', (e) => {
  if (e.persisted && client.state) connect();
});

/**
 * A write with the page’s token (#74), which the browser sends as a cookie. The server makes a new token each time
 * it starts, so after a restart this page’s cookie is stale: loading the page again (`/`) gets the new one, then
 * the write is tried once more.
 * @param {string} path @param {RequestInit} init
 */
async function write(path, init) {
  const r = await fetch(path, init);
  if (r.status !== 403 || init.method === 'GET') return r;
  const data = await r
    .clone()
    .json()
    .catch(() => ({}));
  if (data.code !== 'token') return r;
  await fetch('/', { cache: 'no-store' });
  return fetch(path, init);
}

/** API calls. Errors carry the server’s plain-English message, and for a host’s failure what to do next (#120). */
export async function api(path, body, method = 'POST') {
  let r;
  try {
    r = await write(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('You’re offline, so that didn’t go through. It will work again once the connection is back.'), { offline: true });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok)
    throw Object.assign(new Error(data.error ?? `The server answered ${r.status}.`), {
      status: r.status,
      fieldErrors: data.fieldErrors,
      code: data.code,
      next: data.next ?? null,
    });
  return data;
}

export async function uploadFile(file) {
  const r = await write('/api/files', {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name || 'pasted') },
    body: file,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? 'The upload failed.');
  return data;
}

// ── Selectors ───────────────────────────────────────────────────────────────────────────

export const S = () => client.state;
/** A project’s conversations: direct messages and rooms. Side threads and topic threads hang off them. */
export const threadsOf = (projectId) => Object.values(S().threads).filter((t) => t.projectId === projectId && t.kind !== 'side' && t.kind !== 'topic');
export const topicsOf = (projectId) => Object.values(S().threads).filter((t) => t.projectId === projectId && t.kind === 'topic' && S().threads[t.parentId]);
/** Where a thread of any kind opens: a conversation in the main pane, a side or topic thread in the panel beside its conversation. */
export const hrefOf = (threadId) => {
  const t = S().threads[threadId];
  return t && (t.kind === 'side' || t.kind === 'topic') ? `#/t/${t.parentId}/side/${t.id}` : `#/t/${threadId}`;
};
/** A thread’s whole address, to share (#121): Copy link and the composer’s # give it, and an agent reads its id. */
export const threadLink = (threadId) => new URL(hrefOf(threadId), location.href).href;
export const sessionsOf = (threadId) => (S().threads[threadId]?.members ?? []).map((id) => S().sessions[id]).filter(Boolean);
export const itemsOf = (threadId) => S().items[threadId] ?? [];
/** @type {import('/shared/thread-header.mjs').ThreadHeader} */
const NO_HEADER = Object.freeze({ count: 0, lastAt: null, speakers: [], asks: [], blocks: {} });
/** A thread’s header facts: what the page shows about it without its items (#1155). */
export const headerOf = (threadId) => client.headers[threadId] ?? NO_HEADER;
/** The item with this id in a conversation, in O(1) through the store’s index (#712b). */
export const itemIn = (threadId, id) => itemOf(itemsOf(threadId), id);
/** Where that item sits in its conversation’s list, or -1, in O(1) (#712b). */
export const placeIn = (threadId, id) => positionOf(itemsOf(threadId), id);
export const persona = (id) => S().personas[id];
export const busy = (se) => ['think', 'gen', 'tool'].includes(se?.state);
/**
 * Stops an agent’s turn (#126). With background jobs running, the server asks first (#129): it resolves to { ask }, and
 * the ask shows in the agent’s conversation (se.stopAsk). jobs answers it, 'stop' or 'keep', for the turn it asked about.
 * @param {{ id: string }} se @param {'stop' | 'keep' | null} [jobs] @param {string | null} [turnId]
 */
export const stopSession = (se, jobs = null, turnId = null) =>
  api(`/api/sessions/${se.id}/stop`, jobs ? { jobs, ...(turnId ? { turnId } : {}) } : {}).then((r) => r?.result ?? null);
/**
 * The sessions of a conversation’s side threads (#121): forks that answered while their session was busy, and from
 * before #110, the sessions each wake started there. Topic threads aren’t in it: the person forked those.
 */
export const sideSessionsOf = (threadId) =>
  Object.values(S().threads)
    .filter((t) => t.kind === 'side' && t.parentId === threadId)
    .flatMap((t) => sessionsOf(t.id));
/** The sessions speaking in a thread: its own, and any session whose turn is in it now (a side thread’s, #110). */
export const sessionsAt = (threadId) => [
  ...sessionsOf(threadId),
  ...Object.values(S().sessions).filter((se) => se.sideTurn?.threadId === threadId && !sessionsOf(threadId).includes(se)),
];
/** Where a session needs you, or is at work: the side thread its ask or turn is in, else its own thread. */
export const whereOf = (se) => whereNeeds(S(), se);
// Side-thread sessions count with the rest (#121): one waiting on a permission prompt needs you as much as any.
export const liveSessions = () =>
  Object.values(S().sessions).filter((se) => {
    const t = S().threads[se.threadId];
    return !se.archived && t && !(t.kind === 'side' && !S().threads[t.parentId]);
  });
// Every kind its ring pulses for: a refused step and a tool it asked for too (#285).
export const needsYou = () => liveSessions().filter(needsYouNow);

/** The thread’s main state for its rail row: the most urgent of its agents, its side threads’ included (#121). */
export function threadState(t) {
  const ses = [...sessionsOf(t.id), ...sideSessionsOf(t.id)].filter((x) => !x.archived);
  const rank = { needs: 5, failed: 4, tool: 3, gen: 3, think: 3, stopping: 1, idle: 0 };
  return ses.sort((a, b) => (rank[b.state] ?? 0) - (rank[a.state] ?? 0))[0];
}
