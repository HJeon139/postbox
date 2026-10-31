// The client store and the live connection. It loads the whole state once, then applies numbered events
// from the server-sent event stream with the same reducer the server uses. On a dropped connection the
// browser reconnects with the last number it saw; events at or below it are ignored, so nothing is
// applied twice. If the server no longer has the events, it says "resync" and the state is refetched.
// The numbers count within a history epoch, which the state names and the stream request echoes: after
// a restart the server runs on a new one, and says "resync" to a page from the old one, whose numbers may
// name events the server never kept (server/live-streams.mjs). The page's epoch is the one its loaded
// state came with, never one heard on the stream alone.

import { needsYouNow, whereNeeds } from '/shared/needs.mjs';
import { apply, ownState } from '/shared/state.mjs';

const EVENT_TYPES = [
  'settings',
  'project',
  'persona',
  'boilerplate',
  'thread',
  'session',
  'session.patch',
  'app',
  'file',
  'dataset',
  'schedule',
  'host',
  'host.status',
  'glossary',
  'item.add',
  'item.patch',
  'item.move',
  'item.text',
  'work.add',
  'work.patch',
  'remove',
  'notify',
];

export const client = {
  state: null,
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
  const { seq, epoch, state, config, store } = await r.json();
  client.state = ownState(state);
  client.config = config;
  client.seq = seq;
  client.epoch = epoch ?? '';
  client.store = store ?? null;
  client.emit({ type: 'load' });
}

let es = null;
export function connect() {
  es?.close();
  es = new EventSource(`/api/stream?since=${client.seq}&epoch=${encodeURIComponent(client.epoch)}`);
  es.onopen = () => {
    const was = client.connection;
    client.connection = 'open';
    client.attempts = 0;
    client.emit({ type: 'connection', was });
  };
  es.onerror = () => {
    client.attempts++;
    client.connection = 'reconnecting';
    client.emit({ type: 'connection' });
    // EventSource retries by itself, resending Last-Event-ID. If it gave up, start again.
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, Math.min(8000, 1000 * client.attempts));
  };
  for (const t of EVENT_TYPES) {
    es.addEventListener(t, (e) => {
      const seq = Number(e.lastEventId);
      if (seq && seq <= client.seq) return;
      const data = JSON.parse(e.data);
      apply(client.state, t, data);
      client.seq = seq || client.seq;
      // A session’s change comes as only its changed fields (designs/508, “Store events”); listeners hear the whole
      // session, as they did when the server sent it whole.
      if (t === 'session.patch') {
        const se = client.state.sessions[data.id];
        if (se) client.emit({ type: 'session', data: se });
      } else client.emit({ type: t, data });
    });
  }
  // The epoch the stream runs on, its first frame. The page’s epoch is only ever the one that came with a state it
  // loaded: a frame naming another means the state the page shows is from a history the server no longer runs on, so it
  // loads the state again, as a resync does. Taking the epoch from the frame would, if that load then failed, send the
  // new epoch with the old state on the next reconnect, which the server would accept at an equal seq.
  es.addEventListener('epoch', (e) => {
    if ((JSON.parse(e.data) ?? '') !== client.epoch) resync();
  });
  es.addEventListener('resync', resync);
  // The store’s status, unnumbered: each time it can’t save, or can again (app/js/store-line.mjs).
  es.addEventListener('status', (e) => {
    client.store = JSON.parse(e.data);
    client.emit({ type: 'store' });
  });
}

// Loads the state again and reconnects on the epoch it came with; one at a time, so the epoch frame and the resync
// frame the server sends together load once. While the load fails, the page keeps its state and its epoch, and
// connects again shortly: naming the old epoch, it’s told to resync again, until a load succeeds.
let resyncing = null;
function resync() {
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
export const threadsOf = (projectId) =>
  Object.values(S().threads).filter((t) => t.projectId === projectId && t.kind !== 'side' && t.kind !== 'topic' && !t.deleting);
export const topicsOf = (projectId) => Object.values(S().threads).filter((t) => t.projectId === projectId && t.kind === 'topic' && S().threads[t.parentId]);
/** Where a thread of any kind opens: a conversation in the main pane, a side or topic thread in the panel beside its conversation. */
export const hrefOf = (threadId) => {
  const t = S().threads[threadId];
  return t && (t.kind === 'side' || t.kind === 'topic') ? `#/t/${t.parentId}/side/${t.id}` : `#/t/${threadId}`;
};
/** A thread’s whole address, to share (#121): Copy link and the composer’s # give it, and an agent reads its id. */
export const threadLink = (threadId) => new URL(hrefOf(threadId), location.href).href;
export const sessionsOf = (threadId) => (S().threads[threadId]?.members ?? []).map((id) => S().sessions[id]).filter((x) => x && !x.deleting);
export const itemsOf = (threadId) => S().items[threadId] ?? [];
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
  ...Object.values(S().sessions).filter((se) => se.sideTurn?.threadId === threadId && !se.deleting && !sessionsOf(threadId).includes(se)),
];
/** Where a session needs you, or is at work: the side thread its ask or turn is in, else its own thread. */
export const whereOf = (se) => whereNeeds(S(), se);
// Side-thread sessions count with the rest (#121): one waiting on a permission prompt needs you as much as any.
export const liveSessions = () =>
  Object.values(S().sessions).filter((se) => {
    const t = S().threads[se.threadId];
    return !se.archived && !se.deleting && t && !t.deleting && !(t.kind === 'side' && (!S().threads[t.parentId] || S().threads[t.parentId].deleting));
  });
// Every kind its ring pulses for: a refused step and a tool it asked for too (#285).
export const needsYou = () => liveSessions().filter(needsYouNow);

/** The thread’s main state for its rail row: the most urgent of its agents, its side threads’ included (#121). */
export function threadState(t) {
  const ses = [...sessionsOf(t.id), ...sideSessionsOf(t.id)].filter((x) => !x.archived);
  const rank = { needs: 5, failed: 4, tool: 3, gen: 3, think: 3, stopping: 1, idle: 0 };
  return ses.sort((a, b) => (rank[b.state] ?? 0) - (rank[a.state] ?? 0))[0];
}
