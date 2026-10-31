// What happened in a run, in order: Postbox’s own events for blocks (shown, answered, updated) and sessions (a turn
// starting or ending). Some checks need the history, not the state at one moment: an update that erased an answer
// leaves no trace in the state (#123). A live run follows the server’s event stream from its first event, so nothing
// is lost when the store starts a new log segment; it saves what it kept to events.jsonl, which --recheck reads back.
// A run on the Redis store (#508) has no log in its data folder, so the stream is also where the messages Postbox sent
// one agent from another are read (received(), for tools/uat/run-files.mjs); the old log is read only for a run made
// on the old store.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { keepEvent } from '../../server/room-events.mjs';
import { messagesOf } from './run-files.mjs';

export { keepEvent };

/**
 * Follows a Postbox server’s event stream (/api/stream) from its first event, keeping the events the checks read,
 * and, apart from them, each host’s status as it changed, with when it arrived (#120): a host-mode fault is judged
 * by these, since a drop and its reconnect can both come between two reads of the state. Keeps every message Postbox
 * sent one agent from another as the sessions’ events carry them (received()), applying each session.patch with the
 * reducer’s own rule (keepEvent, patchSession). When the server says resync (its stream no longer holds the events
 * after `last`), the sessions are read whole from /api/state and the stream resumes from its seq: the history has a
 * gap, and the messages those sessions hold then are kept.
 * @param {string} origin @param {{ fetch?: typeof globalThis.fetch }} [o]  a fetch to use instead of the global, for tests
 * @returns {{
 *   events: () => any[],
 *   hostStates: () => { at: number, id: string, state: string|null }[],
 *   received: () => { handle: string, from: string, text: string, at: number }[],
 *   close: () => void,
 * }}
 */
export function followEvents(origin, { fetch = globalThis.fetch } = {}) {
  /** @type {any[]} */
  const kept = [];
  /** @type {{ at: number, id: string, state: string|null }[]} */
  const hostStates = [];
  let last = 0;
  // Each session as the events so far left it, so a session.patch is kept as a whole session (keepEvent).
  const sessions = new Map();
  /** @type {Map<string, { handle: string, from: string, text: string, at: number }>} */
  const received = new Map();
  const noteMessages = (se) => {
    for (const r of messagesOf(se)) received.set(`${r.handle}|${r.from}|${r.at}|${r.text}`, r);
  };
  const abort = new AbortController();
  /** The sessions as the server holds them now, after a resync. */
  const reseed = async () => {
    const res = await fetch(`${origin}/api/state`, { signal: abort.signal });
    const { seq, state } = await res.json();
    for (const se of Object.values(state?.sessions ?? {})) {
      sessions.set(se.id, se);
      noteMessages(se);
    }
    if (seq > last) last = seq;
  };
  const take = (frame) => {
    const { seq, type, data } = parseFrame(frame);
    if (type === 'resync') return reseed();
    if (!Number.isFinite(seq) || seq === null || seq <= last) return;
    last = seq;
    if (type === 'host.status') {
      try {
        const d = JSON.parse(data);
        if (typeof d?.id === 'string') hostStates.push({ at: Date.now(), id: d.id, state: d.status?.state ?? null });
      } catch {}
      return;
    }
    if (type !== 'item.add' && type !== 'item.patch' && type !== 'item.move' && type !== 'session' && type !== 'session.patch') return;
    try {
      const e = keepEvent(seq, type, JSON.parse(data), sessions);
      if (e) kept.push(e);
      if (e?.type === 'session') noteMessages(sessions.get(e.data.id));
    } catch {}
  };
  follow(origin, abort.signal, take, () => last, fetch);
  return { events: () => kept, hostStates: () => hostStates, received: () => [...received.values()].sort((a, b) => a.at - b.at), close: () => abort.abort() };
}

/**
 * Reads the stream’s frames to `take` until `signal` aborts, reconnecting from the last event seen if the stream drops,
 * as the page does.
 * @param {string} origin @param {AbortSignal} signal @param {(frame: string) => any} take @param {() => number} last
 * @param {typeof globalThis.fetch} fetch
 */
async function follow(origin, signal, take, last, fetch) {
  while (!signal.aborted) {
    try {
      const res = await fetch(`${origin}/api/stream?since=${last()}`, { signal });
      if (!res.body) throw new Error('no body');
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let at = buf.indexOf('\n\n');
        while (at >= 0) {
          await take(buf.slice(0, at));
          buf = buf.slice(at + 2);
          at = buf.indexOf('\n\n');
        }
      }
    } catch {}
    if (!signal.aborted) await new Promise((ok) => setTimeout(ok, 1000).unref());
  }
}

/**
 * Saves a run’s records: the history the checks read, for --recheck, and the state as the run ended, for the verifier.
 * The store is in Redis, which neither can read (#508), and the sessions’ context and messages are in the state.
 * @param {string} dir  the run’s folder @param {{ events: any[], state: any }} facts
 */
export async function saveRecords(dir, facts) {
  await writeFile(join(dir, 'events.jsonl'), facts.events.map((e) => JSON.stringify(e)).join('\n') + (facts.events.length ? '\n' : ''));
  await writeFile(join(dir, 'state.json'), `${JSON.stringify({ seq: facts.state?.seq ?? 0, state: facts.state })}\n`);
}

/** A server-sent event’s frame: its id (seq), event name and data. @param {string} frame */
function parseFrame(frame) {
  let seq = null;
  let type = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('id: ')) seq = Number(line.slice(4));
    else if (line.startsWith('event: ')) type = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  return { seq, type, data };
}

/** Parses JSON Lines, skipping a line that doesn’t parse (the last one, if the file was being written). */
const lines = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });

/**
 * What is left of the old store’s log in a run’s data folder, cut as keepEvent cuts it: a run made on the old store,
 * before the runner saved events.jsonl. A run on the Redis store has no log here; its history is the saved events.jsonl.
 * @param {string} dir
 */
function logged(dir) {
  const data = join(dir, 'data');
  if (!existsSync(data)) return [];
  // The log starts at the store’s last snapshot, which holds each session whole as it was there: a session.patch after
  // it is kept as the whole session it leaves (keepEvent).
  const sessions = new Map(Object.entries(snapshotOf(data)?.sessions ?? {}));
  return readdirSync(data)
    .filter((n) => /^events-\d+\.jsonl$/.test(n))
    .sort((a, b) => Number(a.slice(7, -6)) - Number(b.slice(7, -6)))
    .flatMap((n) => lines(readFileSync(join(data, n), 'utf8')))
    .map((e) => keepEvent(e.seq, e.type, e.data, sessions))
    .filter(Boolean);
}

/** The old store’s snapshot in a data folder, or null when there is none or it can’t be read. @param {string} data */
function snapshotOf(data) {
  try {
    return JSON.parse(readFileSync(join(data, 'snapshot.json'), 'utf8'));
  } catch {
    return null; // no snapshot yet: the log starts at the store’s first event
  }
}

/**
 * A finished run’s history: the events.jsonl a live run saved, or else what is left of the old store’s log in its data
 * folder. That store deleted a segment once a snapshot covered it, so the log alone can start partway through a run. A
 * run saved before the runner kept item.move (#213) takes its moves from the log, where the log still has them.
 * @param {string} dir  the run’s folder
 */
export function readHistory(dir) {
  const saved = join(dir, 'events.jsonl');
  if (!existsSync(saved)) return logged(dir);
  const kept = lines(readFileSync(saved, 'utf8'));
  if (kept.some((e) => e.type === 'item.move')) return kept;
  const moves = logged(dir).filter((e) => e.type === 'item.move');
  return moves.length ? [...kept, ...moves].sort((a, b) => a.seq - b.seq) : kept;
}
