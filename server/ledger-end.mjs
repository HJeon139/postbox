// A turn’s end in the work ledger (server/ledger.mjs, #132): what each file it changed looks like now, its effort, and
// what became of the commands and outside calls it left without a result.

import { turnEnded } from './ledger-commands.mjs';

/**
 * The turn ended: read what each file it changed looks like now, and record the turn’s effort.
 * @param {import('./ledger.mjs').Ledger} ledger @param {any} turn @param {{ status?: string }} [opts]
 * @returns {Promise<string|null>} the turn’s line for the transcript, from shared/work.mjs turnLine
 */
export async function endTurn(ledger, turn, { status = 'done' } = {}) {
  const w = turn.work;
  if (!w || w.ended) return null;
  w.ended = true;
  const run = (async () => {
    await Promise.allSettled(w.pending);
    turnEnded(ledger, w);
    ledger.recordPublishes(turn);
    // A host turn has no files to read (they’re on the host), so this is a no-op for it; the guard says so.
    for (const f of w.host ? [] : w.files.values()) {
      const before = await f.before;
      const after = await ledger.capture(await ledger.io.read(f.path));
      await ledger.recordChange(turn, f, before, after);
    }
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
  })();
  await ledger.track(run);
  return null;
}
