// #965’s G1: when Postbox gives up attaching a host turn after a restart (its agent moved, or its backend isn’t
// registered here) and the host’s welcome lists it as running, Postbox asks the host to stop it, and that stop lasts
// until the daemon confirms it, a restart included. Until then, Resume on that host is refused, so no second turn runs
// beside the first on the same session (#872). A stop on another host doesn’t hold a Resume. Built on the rig in
// tests/remote-turns-helpers.mjs; the design is sprint4/965-g1-packet-r1.md v2.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { HANDLERS } from './fake-daemon-handlers.mjs';
import { restarted, rig, settled, sleep, starts, startUp, until } from './remote-turns-helpers.mjs';

/**
 * The fake daemon answers every stop at once. This one records the stop and answers nothing, as a host that hasn’t
 * stopped the turn yet, until the test ends or calls the returned function.
 * @param {import('node:test').TestContext} t
 */
function holdStops(t) {
  const real = HANDLERS.stop;
  HANDLERS.stop = (d, _c, m) => {
    d.stops.push(m.turn);
  };
  const free = () => {
    HANDLERS.stop = real;
  };
  t.after(free);
  return free;
}

/**
 * A Postbox restarted during @coder’s turn on the host, which gives up attaching it. `to`, for a moved agent: this
 * computer, or a second host.
 * @param {{ why: 'moved' | 'unregistered', welcome?: 'running' | 'unkilled' | 'missing', to?: 'here' | 'host' }} o
 */
async function gaveUp({ why, welcome = 'running', to = 'here' }) {
  const { store, d } = restarted({ welcome });
  const r = rig({ store, d });
  const remote = to === 'host' ? { hostId: r.rt.addHost({ name: 'other.example.com' }).id } : null;
  if (why === 'moved') r.store.emit('persona', { ...r.rt.persona(r.se().personaId), remote });
  else arrange.withoutAdapters(r.rt);
  startUp(r);
  await until(() => r.se().remoteTurn?.state === 'interrupted', 'Interrupted');
  await settled(r);
  await sleep(20);
  return { r, d };
}

/** Resume, as the person’s button calls it: null when accepted, else the refusal’s message. */
function resumeRefusal(r) {
  try {
    r.rt.resumeRemote(r.se().id);
    return null;
  } catch (e) {
    return /** @type {any} */ (e).message;
  }
}

for (const why of /** @type {const} */ (['moved', 'unregistered']))
  test(`#965 a turn the host lists as running is asked to stop when Postbox gives up attaching it (${why})`, async () => {
    const { d } = await gaveUp({ why });
    assert.deepEqual(d.stops, ['host-turn-1']);
  });

test('#965 a turn the host has no record of isn’t asked to stop: nothing there runs it', async () => {
  const { d } = await gaveUp({ why: 'unregistered', welcome: 'missing' });
  assert.deepEqual(d.stops, []);
});

test('#965 Resume on the host is refused until it confirms the stop, then accepted', async (t) => {
  const free = holdStops(t);
  const { r, d } = await gaveUp({ why: 'unregistered' });
  assert.deepEqual(d.stops, ['host-turn-1'], 'asked, not yet confirmed');
  const before = starts(d).length;
  assert.equal(resumeRefusal(r), '@coder’s last turn on host.example.com hasn’t confirmed it stopped. Resume once it has.');
  await settled(r);
  assert.equal(starts(d).length, before, 'nothing started beside it');
  // The host stops it now: at its next welcome the stop goes again, and the daemon confirms it.
  free();
  r.link.reconnect();
  await until(() => !(r.se().remoteTurn?.stopping ?? []).length, 'the stop confirmed');
  assert.equal(resumeRefusal(r), null);
});

test('#965 the stop is asked again after a restart before the host confirmed it', async (t) => {
  holdStops(t);
  const { r, d } = await gaveUp({ why: 'unregistered' });
  assert.equal(r.se().remoteTurn.stopping?.length, 1, 'saved on the session');
  r.rt.remote.close();
  d.drop();
  d.connect();
  const again = rig({ store: r.store, d });
  arrange.withoutAdapters(again.rt);
  startUp(again);
  await until(() => d.stops.length === 2, 'asked again');
  assert.deepEqual(d.stops, ['host-turn-1', 'host-turn-1']);
});

test('#965 a stop still waiting on the host the agent moved off doesn’t hold its Resume on the new host', async (t) => {
  holdStops(t);
  const { r, d } = await gaveUp({ why: 'moved', to: 'host' });
  assert.notEqual(r.rt.persona(r.se().personaId).remote?.hostId, r.host.id, 'on another host now');
  assert.deepEqual(d.stops, ['host-turn-1'], 'the old host is asked');
  assert.equal(r.se().remoteTurn.stopping?.length, 1, 'not yet confirmed');
  assert.equal(resumeRefusal(r), null);
});

/**
 * A Postbox restarted with @coder’s turn Interrupted on the host, waiting to resume on its own, and, when `stopping`,
 * a stop asked there for an earlier turn of the session that the host hasn’t confirmed.
 */
async function interruptedWith(t, { stopping }) {
  holdStops(t);
  const { store, d } = restarted({ welcome: 'missing' });
  const r = rig({ store, d });
  const old = r.se().remoteTurn;
  r.rt.updateSession(r.se().id, {
    remoteTurn: {
      ...old,
      state: 'interrupted',
      resume: { why: 'interrupted', at: 1 },
      stopping: stopping ? [{ turn: 'host-turn-0', hostId: r.host.id, at: 1 }] : [],
    },
  });
  d.addTurn('host-turn-0', { exit: null });
  startUp(r);
  r.link.reconnect();
  r.hosts.emit('status', r.host.id, { state: 'connected' });
  await sleep(100);
  return { r, d };
}

test('#965 an Interrupted turn isn’t resumed on its own while its host hasn’t confirmed a stop for the session', async (t) => {
  const { d } = await interruptedWith(t, { stopping: true });
  assert.deepEqual(d.stops, ['host-turn-0'], 'the earlier stop is asked again');
  assert.equal(starts(d).length, 0, 'nothing started beside it');
});

test('#965 control: with no stop waiting, the same Interrupted turn resumes on its own', async (t) => {
  const { d } = await interruptedWith(t, { stopping: false });
  await until(() => starts(d).length === 1, 'a resumed turn');
});
