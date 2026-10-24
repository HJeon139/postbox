// Postbox’s `remove` (daemon.mjs’s header, #120): every running turn stopped and waited for, then ~/.postbox-remote
// deleted (cleanup.mjs), `removed` said, and the daemon’s exit.

import { TURN_FILES, validateRunnerRecord } from '../../../shared/remote-protocol.mjs';
import { readJson } from './daemon-files.mjs';
import { fail, send } from './daemon-reply.mjs';
import { scan } from './daemon-scan.mjs';
import { stopTurn } from './daemon-stop.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */

/**
 * `remove`: stops every running turn, waits for them to end (Stop’s grace period, then REMOVE_WAIT_MS at most),
 * deletes ~/.postbox-remote (cleanup.mjs refuses one that isn’t the home folder’s own), says `removed`, and exits.
 * @param {Daemon} d @param {Conn} c
 */
export async function remove(d, c) {
  d.removing = true;
  const bad = await d.cleanup.rootProblem();
  if (bad) {
    d.removing = false;
    return fail(c, 'internal', bad, 'remove');
  }
  const still = await stopAll(d);
  // A runner still alive after Stop (stuck in the kernel, say) keeps everything: deleting its records and the token
  // would leave it running with nothing on either machine able to stop it. The laptop keeps the host, and the person
  // can remove it again once the turn has ended.
  if (still.length) {
    d.removing = false;
    const n = still.length;
    const why = `${n === 1 ? 'Turn' : 'Turns'} ${still.join(', ')} ${n === 1 ? 'was' : 'were'} still running ${Math.round((d.stopGraceMs + d.removeWaitMs) / 1000)} s after Stop, so nothing was removed.`;
    d.log(why);
    return fail(c, 'internal', why, 'remove');
  }
  for (const x of d.conns) for (const f of x.follows.values()) f.stop();
  try {
    await d.cleanup.removeAll((pid) => d.kill(pid, 'SIGTERM'));
  } catch (e) {
    d.removing = false;
    return fail(c, 'internal', `Couldn’t remove Postbox from this host: ${e.message}`, 'remove');
  }
  await send(c, 'removed', {});
  for (const x of [...d.conns]) x.close();
  d.closed = true;
  if (d.idleTimer) d.timers.clearTimeout(d.idleTimer);
  if (d.sweepTimer) d.timers.clearTimeout(d.sweepTimer);
  d.onRemoved();
}

/**
 * Stops every running turn and waits for their runners to go, for Stop’s grace period and REMOVE_WAIT_MS at most.
 * Returns the turns whose runner is still there.
 * @param {Daemon} d @returns {Promise<string[]>}
 */
async function stopAll(d) {
  // A start already under way on another connection finishes first (no new one gets past `removing`), so its turn
  // is scanned and stopped like the rest, never launched from files this removal deleted.
  while (d.starting.size) await Promise.all(d.starting.values());
  const records = [];
  for (const t of (await scan(d)).filter((x) => x.state === 'running')) {
    await stopTurn(d, t.turn);
    const rec = validateRunnerRecord(await readJson(d.p.turn(t.turn, TURN_FILES.runner)));
    if (rec.ok) records.push({ turn: t.turn, rec: rec.msg });
  }
  const live = async () => {
    const still = [];
    // By the runner’s own process, not exit.json: after its SIGKILL the daemon writes exit.json itself, whether or not
    // the runner actually went.
    for (const r of records) if (await d.proc.sameProcess(r.rec)) still.push(r.turn);
    return still;
  };
  let still = await live();
  for (let i = Math.ceil((d.stopGraceMs + d.removeWaitMs) / d.pollMs); still.length && i > 0; i--) {
    await new Promise((resolve) => setTimeout(resolve, d.pollMs).unref());
    still = await live();
  }
  return still;
}
