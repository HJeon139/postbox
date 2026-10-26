// The runtime’s remote turns (#120, G10; tests/remote-turns.test.mjs says how): the stops the daemon confirms before
// a host can go.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restarted, rig, running, settled, sleep, starts, startUp, until } from './remote-turns-helpers.mjs';

// ── 8. Stops the daemon confirms, renames, and backends only on a host ─────────────────

test('#120 G10: a turn whose link gave up keeps its host: removing it is refused until the daemon confirms the turn stopped', async () => {
  const r = rig();
  const turn = await running(r);
  r.link.giveUp();
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'lost', 'still on the host, as far as Postbox knows');
  await assert.rejects(r.rt.removeHost(r.host.id, { waitMs: 50 }), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /^host\.example\.com can’t be reached, so its running turns can’t be stopped; Postbox keeps the host until they can be\./);
    return true;
  });
  assert.ok(r.store.state.hosts[r.host.id], 'the host is kept');
  assert.deepEqual(r.hosts.calls.forget, [], 'and its token');
  assert.deepEqual(r.hosts.calls.remove, [], 'and Postbox wasn’t removed there');
  assert.equal(r.d.turns.get(turn).exit, null, 'the turn runs on there');
  assert.equal(r.se().remoteTurn.state, 'stopping', 'given up, but not done');
  assert.deepEqual(
    r.se().remoteTurn.stopping.map((x) => x.turn),
    [turn],
    'kept for a restart',
  );
  // Back: the stop goes at the welcome, the daemon’s `ended` confirms it, and then the host can go.
  r.link.reconnect();
  await until(() => r.d.stops.includes(turn), 'the stop on the host');
  await until(() => r.se().remoteTurn.state === 'done', 'the stop confirmed');
  assert.deepEqual(r.se().remoteTurn.stopping, []);
  assert.deepEqual(await r.rt.removeHost(r.host.id, { waitMs: 50 }), { ok: true, stopped: 0 });
  assert.deepEqual(r.hosts.calls.remove, [r.host.id]);
  assert.deepEqual(r.hosts.calls.forget, [r.host.id]);
  assert.equal(r.store.state.hosts[r.host.id], undefined);
  assert.equal(r.hosts.calls.need.length, r.hosts.calls.release.length, 'every need released');
});

test('#120 G10: after a restart, a stop asked before it and not confirmed is asked again, and a welcome that doesn’t list the turn confirms it', async () => {
  const { store, d } = restarted({ welcome: 'missing' });
  const se = Object.values(store.state.sessions)[0];
  const hostId = Object.values(store.state.hosts)[0].id;
  store.emit('session', { ...se, remoteTurn: { ...se.remoteTurn, state: 'stopping', stopping: [{ turn: 'host-turn-1', hostId, at: 1 }] } });
  const r = rig({ store, d });
  startUp(r);
  await until(() => r.se().remoteTurn.state === 'done', 'the welcome’s word');
  assert.deepEqual(r.se().remoteTurn.stopping, []);
  assert.equal(r.store.items(r.t.id).filter((i) => i.kind === 'agent' && i.status === 'failed').length, 0, 'not Interrupted: it was stopped');
});

test('#120 G10: a no-turn answer to the stop of a turn whose start went unconfirmed before a drop confirms it, since the daemon then refuses that start; the host can go', async () => {
  const r = rig();
  // The start reaches a channel that drops before the daemon has it: on the host it may still arrive.
  const send = r.link.send;
  /** @type {any[]} */
  const held = [];
  r.link.send = (msg) => {
    if (msg.type !== 'start') return send(msg);
    if (!r.link.connected) return false;
    held.push(msg);
    return true;
  };
  r.rt.sendMessage(r.t.id, { text: 'hi' });
  await until(() => held.length === 1, 'the start');
  const turn = held[0].turn;
  r.link.connected = false;
  r.rt.stop(r.se().id);
  r.link.send = send;
  await until(() => r.se().remoteTurn.stopping?.length === 1, 'the stop asked');
  assert.deepEqual(
    r.se().remoteTurn.stopping.map((x) => [x.turn, x.unconfirmed]),
    [[turn, true]],
    'kept for a restart, with its start unconfirmed',
  );
  // The welcome doesn’t list it, which says nothing while the start may still arrive: the stop goes, and the daemon’s
  // no-turn answer is its word that the turn won’t run there.
  r.link.reconnect();
  await until(() => r.d.sent.some((m) => m.type === 'error' && m.re === 'stop' && m.code === 'no-turn' && m.turn === turn), 'the no-turn answer');
  await settled(r);
  await until(() => r.se().remoteTurn.state === 'done', 'the stop confirmed');
  assert.deepEqual(r.se().remoteTurn.stopping, []);
  assert.equal(r.rt.remote.busyOn(r.host.id), false);
  assert.equal(r.hosts.calls.need.length, r.hosts.calls.release.length, 'every need released');
  assert.deepEqual(await r.rt.removeHost(r.host.id, { waitMs: 50 }), { ok: true, stopped: 0 });
  assert.equal(r.store.state.hosts[r.host.id], undefined);
});

test('#120 G10: Stop on a turn whose start never reached a connected link is done at once: no stop is kept, and the host can be renamed and removed', async () => {
  const r = rig();
  // The link drops after the welcome, just as the start goes: it’s never written, so nothing can be on the host.
  const send = r.link.send;
  r.link.send = (msg) => {
    if (msg.type === 'start') r.link.connected = false;
    return send(msg);
  };
  r.rt.sendMessage(r.t.id, { text: 'hi' });
  await until(() => !r.link.connected && r.rt.turns.size === 1, 'the start to find the link down');
  await sleep(5);
  r.rt.stop(r.se().id);
  await settled(r);
  assert.equal(starts(r.d).length, 0, 'the start never went');
  assert.deepEqual(r.se().remoteTurn.stopping, [], 'no stop to confirm');
  assert.equal(r.se().remoteTurn.state, 'done');
  assert.equal(r.rt.remote.busyOn(r.host.id), false);
  assert.equal(r.hosts.calls.need.length, r.hosts.calls.release.length, 'the host isn’t kept needed');
  assert.equal(r.rt.updateHost(r.host.id, { name: 'renamed.example.com' }).name, 'renamed.example.com');
  assert.deepEqual(await r.rt.removeHost(r.host.id, { waitMs: 50 }), { ok: true, stopped: 0 });
  assert.equal(r.store.state.hosts[r.host.id], undefined);
  assert.deepEqual(r.d.stops, []);
});

test('#120 G10: a turn whose preparation fails before any start ends done, and no stop goes to the host', async () => {
  // A host without Claude Code: the adapter refuses once the turn has its host turn ID, before its start.
  const r = rig({ daemon: { harnesses: ['codex'] } });
  r.rt.sendMessage(r.t.id, { text: 'hi' });
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'agent' && i.status === 'failed'), 'the refusal');
  await settled(r);
  assert.match(r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'failed').error, /^Claude Code isn’t installed on the host\./);
  assert.ok(r.se().remoteTurn.turn, 'it had its host turn ID');
  assert.equal(r.se().remoteTurn.state, 'done');
  assert.deepEqual(r.se().remoteTurn.stopping, []);
  assert.equal(starts(r.d).length, 0);
  assert.equal(r.link.sent.filter((m) => m.type === 'stop').length, 0, 'no stop for a turn the host never had');
  assert.equal(r.rt.remote.busyOn(r.host.id), false);
  assert.equal(r.hosts.calls.need.length, r.hosts.calls.release.length, 'every need released');
});

test('#120 G10: a host whose token is gone from this computer isn’t removed while a turn may run there: the stop and the host are kept', async () => {
  const r = rig();
  const turn = await running(r);
  r.link.giveUp();
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'lost');
  // As the host manager does for a host with no token here: no link, and not-installed.
  r.hosts.link = () => {
    throw Object.assign(new Error('This Postbox has no token for it.'), { code: 'not-installed' });
  };
  await assert.rejects(r.rt.removeHost(r.host.id, { waitMs: 50 }), (e) => {
    assert.equal(e.status, 409);
    assert.equal(
      e.message,
      'host.example.com’s token isn’t on this computer any more, so Postbox can’t reach it to stop 1 running turn: @coder. Install Postbox on host.example.com again to stop them, then remove it.',
    );
    return true;
  });
  assert.ok(r.store.state.hosts[r.host.id], 'the host is kept');
  assert.deepEqual(r.hosts.calls.forget, []);
  assert.equal(r.se().remoteTurn.state, 'stopping', 'given up, but not done');
  assert.deepEqual(
    r.se().remoteTurn.stopping.map((x) => x.turn),
    [turn],
    'its stop is kept, for when the host can be reached',
  );
  assert.ok(r.rt.remote.busyOn(r.host.id));
});
