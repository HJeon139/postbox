// What happened in a run, in order: Postbox’s own events for blocks (shown, answered, updated) and sessions (a turn
// starting or ending). Some checks need the history, not the state at one moment: an update that erased an answer
// leaves no trace in the state (#123). A live run follows the server’s event stream from its first event, so nothing
// is lost when the store starts a new log segment; it saves what it kept to events.jsonl, which --recheck reads back.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The event, cut to what the checks read, or null for one they don’t (streamed text, apps, glossary…). */
export function keepEvent(seq, type, data) {
  // An item brought to the newest point (item.move) carries its update as a patch: a block’s new revision (#213).
  if (type === 'item.add' || type === 'item.patch' || type === 'item.move') return { seq, type, data };
  // A session event holds the whole session; the checks read only its state, and finishedAt, which a turn clears. The
  // triggers (tools/uat/triggers.mjs) also read Stop’s question about background jobs, and the jobs themselves (#126),
  // when the session has them, and a remote turn’s host (#120).
  if (type === 'session' && data?.id)
    return {
      seq,
      type,
      data: {
        id: data.id,
        state: data.state ?? null,
        finishedAt: data.finishedAt ?? null,
        updatedAt: data.updatedAt ?? null,
        ...(Object.hasOwn(data, 'stopAsk') ? { stopAsk: data.stopAsk ? { at: data.stopAsk.at ?? null, jobs: data.stopAsk.jobs ?? null } : null } : {}),
        ...(Array.isArray(data.jobs) ? { jobs: data.jobs.slice(0, 50).map(jobOf) } : {}),
        // A turn on a remote host (#120): which host, its turn there, and Postbox’s own turn, for the host-mode checks.
        ...(data.remoteTurn?.turn ? { remoteTurn: remoteOf(data.remoteTurn) } : {}),
      },
    };
  return null;
}

/** A session’s remote turn, cut to what the checks read (tools/uat/remote-facts.mjs). */
const remoteOf = (r) => ({ hostId: r.hostId ?? null, turn: r.turn, rtTurn: r.rtTurn ?? null, state: r.state ?? null });

/** A background job, cut to what the triggers read. */
const jobOf = (j) => ({ id: String(j?.id ?? ''), state: j?.state ?? null, kept: j?.kept === true, turnId: j?.turnId ?? null });

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
    if (type !== 'item.add' && type !== 'item.patch' && type !== 'item.move' && type !== 'session') return;
    try {
      const e = keepEvent(seq, type, JSON.parse(data));
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
  return readdirSync(data)
    .filter((n) => /^events-\d+\.jsonl$/.test(n))
    .sort((a, b) => Number(a.slice(7, -6)) - Number(b.slice(7, -6)))
    .flatMap((n) => lines(readFileSync(join(data, n), 'utf8')))
    .map((e) => keepEvent(e.seq, e.type, e.data))
    .filter(Boolean);
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
