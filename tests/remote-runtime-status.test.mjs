// Remote hosts in the runtime (#120; tests/remote-runtime.test.mjs says how): each host’s status reaching the page, and
// noticing that this computer woke.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { WAKE_CHECK_MS, WAKE_GAP_MS, watchWake } from '../server/remote/wake.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { fakeClock, mock, setup } from './remote-runtime-helpers.mjs';

// ── Each host’s status ──────────────────────────────────────────────────────────────

test('#120: each host’s status reaches the state, at each change the manager emits, lastHeard alone too', () => {
  const { rt, store, hosts } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const gone = 'ho_gone';
  // From before a restart: replaced by what the manager says now, and dropped for a host that’s gone.
  store.emit('host.status', { id: h.id, status: { state: 'connected', failure: null, welcome: null, lastHeard: 1 } });
  store.emit('host.status', { id: gone, status: { state: 'connected', failure: null, welcome: null, lastHeard: 1 } });
  hosts.statuses.set(h.id, { state: 'disconnected', failure: null, welcome: null, lastHeard: 1 });
  rt.watchHosts();
  assert.deepEqual({ ...store.state.hostStatus }, { [h.id]: { state: 'disconnected', failure: null, welcome: null, lastHeard: 1 } });

  const events = [];
  store.subscribe((ev) => ev.type === 'host.status' && events.push(ev.data));
  const welcome = { version: 2, home: '/home/user', node: { path: '/usr/bin/node', version: 'v22.1.0' }, harnesses: [], problems: [], turns: [{}] };
  hosts.statuses.set(h.id, { state: 'connected', failure: null, welcome, lastHeard: 2 });
  hosts.emit('status', h.id, hosts.statuses.get(h.id));
  assert.deepEqual(events[0].status.welcome, { version: 2, home: '/home/user', node: welcome.node, harnesses: [], problems: [] }, 'not its turns');
  // The manager emits a change to lastHeard alone at most every HEARD_EVERY_MS (server/remote/hosts.mjs): each one
  // it emits reaches the page, and the same status again doesn’t.
  hosts.statuses.set(h.id, { state: 'connected', failure: null, welcome, lastHeard: 3 });
  hosts.emit('status', h.id, hosts.statuses.get(h.id));
  hosts.emit('status', h.id, hosts.statuses.get(h.id));
  assert.equal(events.length, 2, 'lastHeard alone is an event, once');
  assert.equal(events[1].status.lastHeard, 3);
  assert.equal(store.state.hostStatus[h.id].lastHeard, 3);

  // A failure, in words with its next step; an Error’s message is kept, which JSON alone would drop.
  const f = Object.assign(new Error('Sign in to host.example.com.'), { kind: 'sign-in', next: 'Run ssh host.example.com in a terminal.', retry: false });
  hosts.statuses.set(h.id, { state: 'failed', failure: f, welcome, lastHeard: 3 });
  hosts.emit('status', h.id, hosts.statuses.get(h.id));
  assert.deepEqual(store.state.hostStatus[h.id].failure, {
    kind: 'sign-in',
    message: 'Sign in to host.example.com.',
    next: 'Run ssh host.example.com in a terminal.',
    retry: false,
  });
  assert.deepEqual(rt.hostStatus(h.id), store.state.hostStatus[h.id]);

  // A host removed takes its status with it.
  store.emit('host', { id: h.id, removed: true });
  assert.deepEqual({ ...store.state.hostStatus }, {});
});

test('#120: without a host manager, status from before a restart is cleared and host actions say why they can’t run', async () => {
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(mock),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [] },
  });
  const h = rt.addHost({ name: 'host.example.com' });
  store.emit('host.status', { id: h.id, status: { state: 'connected', failure: null, welcome: null, lastHeard: 1 } });
  rt.watchHosts();
  assert.deepEqual({ ...store.state.hostStatus }, {});
  assert.equal(rt.hostStatus(h.id), null);
  await assert.rejects(rt.installHost(h.id), (e) => e.status === 503 && /wasn’t started with remote hosts/.test(e.message));
  assert.deepEqual(await rt.removeHost(h.id), { ok: true, stopped: 0 });
});

// ── Waking ──────────────────────────────────────────────────────────────────────────

test('#120 D2: a gap over two minutes between 30-second checks means this computer slept, and wakes the hosts', () => {
  const clock = fakeClock();
  const woke = [];
  const stop = watchWake((ms) => woke.push(ms), clock);
  assert.equal(clock.ms, WAKE_CHECK_MS);
  assert.equal(WAKE_CHECK_MS, 30_000);
  assert.equal(WAKE_GAP_MS, 120_000);
  clock.pass(30_000);
  clock.pass(45_000); // a busy event loop, not a sleep
  clock.pass(WAKE_GAP_MS); // exactly the gap isn’t a sleep either
  assert.deepEqual(woke, []);
  clock.pass(3 * 60 * 60_000); // a night’s sleep
  clock.pass(30_000);
  assert.deepEqual(woke, [3 * 60 * 60_000], 'once per wake');
  stop();
  assert.equal(clock.cleared, true);
});

test('#120 D2: a failing wake handler is logged, and the checks go on', () => {
  const clock = fakeClock();
  let n = 0;
  const errors = [];
  const was = console.error;
  console.error = (m) => errors.push(m);
  try {
    watchWake(() => {
      n++;
      throw new Error('boom');
    }, clock);
    clock.pass(10 * 60_000);
    clock.pass(10 * 60_000);
  } finally {
    console.error = was;
  }
  assert.equal(n, 2);
  assert.match(errors[0], /boom/);
});
