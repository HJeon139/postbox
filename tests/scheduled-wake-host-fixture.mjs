// The rig for a scheduled wake whose own turn is on a host across a restart (#466; tests/scheduled-wake-host-*.test.mjs):
// tests/remote-turns-helpers.mjs's remote rig, a wake fired onto its host, and Postbox started again on the same store.

import { failure } from '../server/remote/ssh-failures.mjs';
import { fireScheduledWake, rearmWakes } from '../server/scheduled-wakes.mjs';
import { Store } from '../server/store.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';
import { HOST, rig, starts, until } from './remote-turns-helpers.mjs';

export const unreachable = () => failure('unreachable', HOST, { code: 255, stderr: `ssh: connect to host ${HOST} port 22: Network is unreachable` });

/** A wake whose own turn runs on the host, then Postbox stops with it still there and starts again on the same store. */
export async function wakeOnHostThenRestart({ removeHost = false } = {}) {
  const d = createFakeDaemon({ autoEnd: false });
  const first = rig({ store: new Store(null), d });
  const sc = first.rt.schedule(first.se().id, { inMs: 60_000, note: 'Check the host.' });
  clearTimeout(first.rt.timers.get(sc.id));
  fireScheduledWake(first.rt, sc);
  await until(() => starts(d).length === 1, 'the wake’s turn to start on the host');
  await until(() => first.store.state.schedules[sc.id]?.turnId === first.se().remoteTurn?.rtTurn, 'the schedule to name its turn');
  const hostTurn = starts(d)[0].turn;
  first.rt.remote.close();
  d.drop();
  d.connect();
  const r = rig({ store: first.store, d });
  // The host removed while Postbox was down (after the rig, which would add one again): Postbox can’t reach it any more.
  if (removeHost) r.store.emit('host', { id: r.host.id, removed: true });
  // server/index.mjs’s order: the schedules are re-armed, then the host turns restored.
  rearmWakes(r.rt);
  return { r, sc, d, hostTurn };
}

export const line = (r, sc) => r.store.item(sc.threadId, sc.itemId);
/** The agent moved off its host, to run on this computer. @param {any} r */
export const moveOff = (r) => {
  const p = r.rt.personas.forSession(r.se());
  r.store.emit('persona', { ...p, remote: null });
};
