// The client store and the live connection. It loads the whole state once, then applies numbered events
// from the server-sent event stream with the same reducer the server uses. On a dropped connection the
// browser reconnects with the last number it saw; events at or below it are ignored, so nothing is
// applied twice. If the server no longer has the events, it says "resync" and the state is refetched.

import { apply } from '/shared/state.mjs';

const EVENT_TYPES = [
  'settings',
  'project',
  'persona',
  'boilerplate',
  'thread',
  'session',
  'app',
  'file',
  'schedule',
  'glossary',
  'item.add',
  'item.patch',
  'item.text',
  'remove',
  'notify',
];

export const client = {
  state: null,
  config: null,
  seq: 0,
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
  const { seq, state, config } = await r.json();
  client.state = state;
  client.config = config;
  client.seq = seq;
  client.emit({ type: 'load' });
}

let es = null;
export function connect() {
  es?.close();
  es = new EventSource(`/api/stream?since=${client.seq}`);
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
      client.emit({ type: t, data });
    });
  }
  es.addEventListener('resync', async () => {
    await load();
    connect();
  });
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

/** API calls. Errors carry the server’s plain-English message. */
export async function api(path, body, method = 'POST') {
  let r;
  try {
    r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('You’re offline, so that didn’t go through. It will work again once the connection is back.'), { offline: true });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error ?? `The server answered ${r.status}.`), { status: r.status, fieldErrors: data.fieldErrors });
  return data;
}

export async function uploadFile(file) {
  const r = await fetch('/api/files', {
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
export const sessionsOf = (threadId) => (S().threads[threadId]?.members ?? []).map((id) => S().sessions[id]).filter((x) => x && !x.deleting);
export const itemsOf = (threadId) => S().items[threadId] ?? [];
export const persona = (id) => S().personas[id];
export const busy = (se) => ['think', 'gen', 'tool'].includes(se?.state);
export const liveSessions = () =>
  Object.values(S().sessions).filter(
    (se) => !se.archived && !se.deleting && S().threads[se.threadId] && S().threads[se.threadId].kind !== 'side' && !S().threads[se.threadId].deleting,
  );
export const needsYou = () => liveSessions().filter((se) => se.needs && ['block', 'failed', 'hop', 'permission', 'appsend'].includes(se.needs.kind));

/** The thread’s main state for its rail row: the most urgent of its agents. */
export function threadState(t) {
  const ses = sessionsOf(t.id).filter((x) => !x.archived);
  const rank = { needs: 5, failed: 4, tool: 3, gen: 3, think: 3, idle: 0 };
  return ses.sort((a, b) => (rank[b.state] ?? 0) - (rank[a.state] ?? 0))[0];
}
