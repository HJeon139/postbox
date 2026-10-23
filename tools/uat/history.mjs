// What happened in a run, in order: Postbox’s own events for blocks (shown, answered, updated) and sessions (a turn
// starting or ending). Some checks need the history, not the state at one moment: an update that erased an answer
// leaves no trace in the state (#123). A live run follows the server’s event stream from its first event, so nothing
// is lost when the store starts a new log segment; it saves what it kept to events.jsonl, which --recheck reads back.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The event, cut to what the checks read, or null for one they don’t (streamed text, apps, glossary…). */
export function keepEvent(seq, type, data) {
  if (type === 'item.add' || type === 'item.patch') return { seq, type, data };
  // A session event holds the whole session; the checks read only its state, and finishedAt, which a turn clears. The
  // triggers (tools/uat/triggers.mjs) also read Stop’s question about background jobs, and the jobs themselves (#126),
  // when the session has them.
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
      },
    };
  return null;
}

/** A background job, cut to what the triggers read. */
const jobOf = (j) => ({ id: String(j?.id ?? ''), state: j?.state ?? null, kept: j?.kept === true, turnId: j?.turnId ?? null });

/**
 * Follows a Postbox server’s event stream (/api/stream) from its first event, keeping the events the checks read.
 * @param {string} origin
 * @returns {{ events: () => any[], close: () => void }}
 */
export function followEvents(origin) {
  /** @type {any[]} */
  const kept = [];
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
    if (type !== 'item.add' && type !== 'item.patch' && type !== 'session') return;
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
  return { events: () => kept, close: () => abort.abort() };
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
 * A finished run’s history: the events.jsonl a live run saved, or else what is left of Postbox’s own log in its data
 * folder. The store deletes a segment once a snapshot covers it, so the log alone can start partway through a run.
 * @param {string} dir  the run’s folder
 */
export function readHistory(dir) {
  const saved = join(dir, 'events.jsonl');
  if (existsSync(saved)) return lines(readFileSync(saved, 'utf8'));
  const data = join(dir, 'data');
  if (!existsSync(data)) return [];
  return readdirSync(data)
    .filter((n) => /^events-\d+\.jsonl$/.test(n))
    .sort((a, b) => Number(a.slice(7, -6)) - Number(b.slice(7, -6)))
    .flatMap((n) => lines(readFileSync(join(data, n), 'utf8')))
    .map((e) => keepEvent(e.seq, e.type, e.data))
    .filter(Boolean);
}
