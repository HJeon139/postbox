// A turn’s end in the work ledger (server/ledger.mjs, #132): what each file it changed looks like now, its effort, and
// what became of the commands and outside calls it left without a result. A graceful shutdown doesn’t wait for it
// past the ledger’s grace (server/runtime-close.mjs): closeLedger writes each unfinished end with what it has, so the
// turn reads as stopped after the restart, not interrupted, and starts no new work (designs/architecture/live-progress.md,
// “A restart mid-turn”).

import { turnEnded } from './ledger-commands.mjs';

/**
 * As Postbox shuts down, once the ledger’s grace is over: every turn’s end still waiting on a read is written with
 * what it has, then `written` (the reply’s line of its work), before the store closes; from here the ledger writes
 * nothing and runs no git. No turn here ends after this: the local ones were stopped before it, and a remote one goes
 * on on its host and is attached again after the restart.
 * @param {import('./ledger.mjs').Ledger} ledger @param {(turn: any) => void} written
 */
export function closeLedger(ledger, written) {
  // One end that can’t be written mustn’t keep the others, or the store’s close that releases the folder, from happening.
  for (const end of [...ledger.ending])
    try {
      end.write();
      written(end.turn);
    } catch (e) {
      console.error(`The work ledger couldn’t record a turn’s end as Postbox shut down: ${e.message}`);
    }
  ledger.closing = true;
}

/**
 * The turn ended: read what each file it changed looks like now, and record the turn’s effort.
 * @param {import('./ledger.mjs').Ledger} ledger @param {any} turn @param {{ status?: string }} [opts]
 * @returns {Promise<string|null>} the turn’s line for the transcript, from shared/work.mjs turnLine
 */
export async function endTurn(ledger, turn, { status = 'done' } = {}) {
  const w = turn.work;
  if (!w || w.ended) return null;
  w.ended = true;
  const end = turnEnd(ledger, turn, status);
  ledger.ending.add(end);
  const run = (async () => {
    await Promise.allSettled(w.pending);
    if (end.written) return;
    end.publish();
    // A host turn has no files to read (they’re on the host), so this is a no-op for it; the guard says so.
    for (const f of w.host ? [] : w.files.values()) {
      const before = await f.before;
      const read = await ledger.io.read(f.path);
      if (end.written) return; // the shutdown wrote the turn’s end without it, and its copy isn’t kept
      await ledger.recordChange(turn, f, before, await ledger.capture(read));
    }
    end.write();
  })();
  await ledger.track(run);
  return null;
}

/**
 * A turn’s end, written once: by the turn, or by closeLedger with what it has.
 * @param {import('./ledger.mjs').Ledger} ledger @param {any} turn @param {string} status
 */
function turnEnd(ledger, turn, status) {
  const w = turn.work;
  let published = false;
  const end = {
    turn,
    written: false,
    /** The commands it watched are let go, and what it published is recorded. */
    publish() {
      if (published) return;
      published = true;
      turnEnded(ledger, w);
      ledger.recordPublishes(turn);
    },
    write() {
      if (end.written) return;
      end.publish();
      end.written = true;
      ledger.ending.delete(end);
      writeEnd(ledger, turn, status);
    },
  };
  return end;
}

/** The turn’s effort on its entry, and its commands and outside calls left without a result. @param {import('./ledger.mjs').Ledger} ledger @param {any} turn @param {string} status */
function writeEnd(ledger, turn, status) {
  const w = turn.work;
  const usage = [...w.usage.values()];
  const priced = usage.filter((u) => typeof u.costUsd === 'number');
  const tokened = usage.filter((u) => u.tokens);
  const sum = (k) => tokened.reduce((n, u) => n + (Number(u.tokens[k]) || 0), 0);
  const t = ledger.entry(w.convId, turn.id);
  const endedAt = ledger.now();
  ledger.patch(w.convId, turn.id, {
    status,
    endedAt,
    ms: endedAt - (t?.startedAt ?? endedAt),
    toolCalls: w.toolCalls,
    costUsd: priced.length ? priced.reduce((n, u) => n + u.costUsd, 0) : null,
    tokens: tokened.length ? { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') } : null,
  });
  // A command with no result when its turn ended: stopped with it, or still running in the background,
  // where Postbox can’t see it end (#129) unless the runtime does (jobUpdate). One you kept running still is.
  for (const id of w.commands.values()) {
    const e = ledger.entry(w.convId, id);
    if (e?.state === 'running') ledger.patch(w.convId, id, { state: status === 'stopped' ? 'stopped' : 'unknown', ms: endedAt - e.startedAt });
    else if (e?.state === 'background') ledger.patch(w.convId, id, { ...(e.keptRunning ? {} : { state: 'unknown' }), leftRunning: true });
  }
  for (const id of w.externals.values()) {
    const e = ledger.entry(w.convId, id);
    if (e?.state === 'running') ledger.patch(w.convId, id, { state: 'unknown' });
  }
}
