// What happened in a run, in order: Postbox’s own events for blocks (shown, answered, updated) and sessions (a turn
// starting or ending). Some checks need the history, not the state at one moment: an update that erased an answer
// leaves no trace in the state (#123). A live run follows the server’s event stream from its first event, so nothing
// is lost when the store starts a new log segment; it saves what it kept to events.jsonl, which --recheck reads back.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keepEvent } from '../../server/room-events.mjs';

export { keepEvent };

/**
 * Follows a Postbox server’s event stream (/api/stream) from its first event, keeping the events the checks read,
 * and, apart from them, each host’s status as it changed, with when it arrived (#120): a host-mode fault is judged
 * by these, since a drop and its reconnect can both come between two reads of the state.
 * @param {string} origin
 * @returns {{ events: () => any[], hostStates: () => { at: number, id: string, state: string|null }[], close: () => void }}
 */
export function followEvents(origin) {
  /** @type {any[]} */
  const kept = [];
  /** @type {{ at: number, id: string, state: string|null }[]} */
  const hostStates = [];
  let last = 0;
  // Each session as the events so far left it, so a session.patch is kept as a whole session (keepEvent).
  const sessions = new Map();
  const abort = new AbortController();
  const take = (frame) => {
    let seq = null;
    let type = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('id: ')) seq = Number(line.slice(4));
      else if (line.startsWith('event: ')) type = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
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
    } catch {}
  };
  (async () => {
    // Reconnect from the last event seen if the stream drops, as the page does.
    while (!abort.signal.aborted) {
      try {
        const res = await fetch(`${origin}/api/stream?since=${last}`, { signal: abort.signal });
        if (!res.body) throw new Error('no body');
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let at = buf.indexOf('\n\n');
          while (at >= 0) {
            take(buf.slice(0, at));
            buf = buf.slice(at + 2);
            at = buf.indexOf('\n\n');
          }
        }
      } catch {}
      if (!abort.signal.aborted) await new Promise((ok) => setTimeout(ok, 1000).unref());
    }
  })();
  return { events: () => kept, hostStates: () => hostStates, close: () => abort.abort() };
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

/** What is left of Postbox’s own log in a run’s data folder, cut as keepEvent cuts it. @param {string} dir */
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

/** The store’s snapshot in a data folder, or null when there is none or it can’t be read. @param {string} data */
function snapshotOf(data) {
  try {
    return JSON.parse(readFileSync(join(data, 'snapshot.json'), 'utf8'));
  } catch {
    return null; // no snapshot yet: the log starts at the store’s first event
  }
}

/**
 * A finished run’s history: the events.jsonl a live run saved, or else what is left of Postbox’s own log in its data
 * folder. The store deletes a segment once a snapshot covers it, so the log alone can start partway through a run. A
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
