// A deleted persona’s memory on the hosts (server/remote/host-forget.mjs, #491): every host Postbox knows owes its
// removal, a connected host is sent it at once and one that connects later then, each `forgotten` settles one, and
// a daemon from before `forget` leaves it owed and isn’t asked again on that connection.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { oweForget, sendForgets, watchForgets } from '../server/remote/host-forget.mjs';
import { Store } from '../server/store.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

// What a daemon from before `forget` answers it, recorded from main’s daemon at bb315158 (an in-process daemon given
// the line, the way tests/fixtures/remote/models-before-1312.json was): it refuses a message it doesn’t carry.
const BEFORE_FORGET = JSON.parse(readFileSync(new URL('./fixtures/remote/forget-before-491.json', import.meta.url), 'utf8'));

/**
 * Hosts (host-service.mjs) over a real store with two hosts, and a fake manager: each host’s link, its state, and
 * what the daemon answers each message. answer(msg) is the reply, or null for none.
 * @param {{ answer?: (m: any) => any, connected?: string[], store?: any }} [o]
 */
function rig({ answer = (m) => ({ type: 'forgotten', persona: m.persona }), connected = ['ho_a'], store = new Store(null) } = {}) {
  for (const [id, name] of [
    ['ho_a', 'a.example'],
    ['ho_b', 'b.example'],
  ])
    store.emit('host', { id, name, settings: {}, createdAt: 1 });
  const manager = Object.assign(new EventEmitter(), { links: new Map(), states: new Map(), needs: /** @type {any[]} */ ([]) });
  const linkOf = (/** @type {string} */ id) => {
    if (!manager.links.has(id)) manager.links.set(id, newLink(answer));
    return manager.links.get(id);
  };
  for (const id of connected) manager.states.set(id, 'connected');
  Object.assign(manager, {
    status: (/** @type {string} */ id) => ({ state: manager.states.get(id) ?? 'disconnected' }),
    link: linkOf,
    need: (/** @type {string} */ id) => manager.needs.push(['need', id]),
    release: (/** @type {string} */ id) => manager.needs.push(['release', id]),
    /** The host connects, on a fresh link. @param {string} id */
    connect(id) {
      manager.links.set(id, newLink(answer));
      manager.states.set(id, 'connected');
      manager.emit('status', id);
    },
  });
  return { store, manager, hosts: /** @type {any} */ ({ store, manager }) };
}

/** A link whose daemon answers each message with answer(msg). @param {(m: any) => any} answer */
function newLink(answer) {
  const l = Object.assign(new EventEmitter(), { connected: true, sent: /** @type {any[]} */ ([]) });
  Object.assign(l, {
    send(/** @type {any} */ msg) {
      l.sent.push(msg);
      const reply = answer(msg);
      if (reply) setImmediate(() => l.emit('message', reply));
      return true;
    },
  });
  return /** @type {any} */ (l);
}

const settled = () => new Promise((r) => setImmediate(() => setImmediate(r)));

test('#491 a deleted persona is owed by every host; a connected one removes it at once, and one that connects later then', async () => {
  const { store, manager, hosts } = rig();
  watchForgets(hosts);
  oweForget(hosts, 'pe_gone');
  assert.deepEqual(store.state.hostForgets.ho_b, ['pe_gone'], 'owed by a host that isn’t connected');
  await settled();
  assert.deepEqual(manager.links.get('ho_a').sent, [{ type: 'forget', persona: 'pe_gone' }]);
  assert.equal(store.state.hostForgets.ho_a, undefined, 'settled once the host said forgotten');
  assert.deepEqual(manager.needs, [
    ['need', 'ho_a'],
    ['release', 'ho_a'],
  ]);
  assert.equal(manager.links.has('ho_b'), false, 'a host that’s off isn’t dialed for it');
  manager.connect('ho_b');
  await settled();
  assert.deepEqual(manager.links.get('ho_b').sent, [{ type: 'forget', persona: 'pe_gone' }]);
  assert.equal(store.state.hostForgets.ho_b, undefined);
});

test('#491 a daemon from before `forget` keeps it owed, says so once, and is asked again only on its next connection', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { store, manager, hosts } = rig({ answer: () => BEFORE_FORGET });
  watchForgets(hosts);
  oweForget(hosts, 'pe_gone');
  await settled();
  assert.deepEqual(store.state.hostForgets.ho_a, ['pe_gone'], 'still owed');
  assert.equal(errors.mock.callCount(), 1);
  assert.match(
    String(errors.mock.calls[0].arguments[0]),
    /a\.example runs a Postbox older than removing a deleted agent’s memory, so 1 deleted agent\(s\)’ memory stays there/,
  );
  // A status change on the same connection, such as its last-heard time, doesn’t send it again.
  manager.emit('status', 'ho_a');
  await settled();
  assert.equal(manager.links.get('ho_a').sent.length, 1);
  manager.connect('ho_a');
  await settled();
  assert.equal(manager.links.get('ho_a').sent.length, 1, 'a fresh connection is asked again');
});

test('#491 a link that closes before the answer leaves it owed', async () => {
  const { store, manager, hosts } = rig({ answer: () => null });
  watchForgets(hosts);
  oweForget(hosts, 'pe_gone');
  const l = manager.links.get('ho_a');
  l.connected = false;
  l.emit('state');
  await settled();
  assert.deepEqual(store.state.hostForgets.ho_a, ['pe_gone']);
  assert.deepEqual(manager.needs.at(-1), ['release', 'ho_a']);
});

test('#491 no answer within the wait leaves it owed and lets the host idle', async () => {
  const { store, manager, hosts } = rig({ answer: () => null });
  store.emit('host.forget', { id: 'ho_a', add: ['pe_gone'] });
  /** @type {(() => void) | null} */
  let fire = null;
  const sending = sendForgets(hosts, 'ho_a', { setTimer: (fn) => (fire = fn), clearTimer: () => {} });
  await settled();
  fire?.();
  await sending;
  assert.deepEqual(store.state.hostForgets.ho_a, ['pe_gone']);
  assert.deepEqual(manager.needs.at(-1), ['release', 'ho_a']);
  // The same connection isn’t asked again, so a host that never answers can idle; a fresh one is.
  watchForgets(hosts);
  manager.emit('status', 'ho_a');
  await settled();
  assert.equal(manager.links.get('ho_a').sent.length, 1);
  manager.connect('ho_a');
  await settled();
  assert.equal(manager.links.get('ho_a').sent.length, 1, 'sent on the fresh link');
});

test('#491 a persona deleted while a host’s send waits goes when that send ends, on the same connection', async () => {
  /** @type {any[]} */
  const waiting = [];
  const { store, manager, hosts } = rig({
    answer: (m) => {
      waiting.push(m);
      return null;
    },
  });
  watchForgets(hosts);
  oweForget(hosts, 'pe_one');
  await settled();
  oweForget(hosts, 'pe_two');
  await settled();
  const l = manager.links.get('ho_a');
  assert.deepEqual(
    l.sent.map((/** @type {any} */ m) => m.persona),
    ['pe_one'],
    'one send at a time',
  );
  l.emit('message', { type: 'forgotten', persona: 'pe_one' });
  await settled();
  assert.deepEqual(
    l.sent.map((/** @type {any} */ m) => m.persona),
    ['pe_one', 'pe_two'],
  );
  l.emit('message', { type: 'forgotten', persona: 'pe_two' });
  await settled();
  assert.equal(store.state.hostForgets.ho_a, undefined);
});

test('#491 a persona deleted behind a held commit is sent once the commit lands', async () => {
  const h = await heldStore();
  for (const [id, name] of [
    ['ho_a', 'a.example'],
    ['ho_b', 'b.example'],
  ])
    h.store.emit('host', { id, name, settings: {}, createdAt: 1 });
  await h.store.flush();
  const { manager, hosts } = rig({ store: h.store });
  watchForgets(hosts);
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  oweForget(hosts, 'pe_gone');
  await settled();
  assert.equal(manager.links.get('ho_a')?.sent.length ?? 0, 0, 'nothing owed yet, as far as anyone can read');
  h.release();
  await commit;
  await settled();
  assert.deepEqual(manager.links.get('ho_a').sent, [{ type: 'forget', persona: 'pe_gone' }]);
  await h.store.flush();
  await h.store.close();
});

test('#491 removing a host drops what it owed, and a host removed before the removal is owed owes nothing', () => {
  const { store, hosts } = rig({ connected: [] });
  oweForget(hosts, 'pe_gone');
  store.emit('host', { id: 'ho_b', removed: true });
  assert.equal(store.state.hostForgets.ho_b, undefined);
  assert.deepEqual(store.state.hostForgets.ho_a, ['pe_gone']);
  // As when the removal was held behind a commit and the owing came after it.
  store.emit('host.forget', { id: 'ho_b', add: ['pe_later'] });
  assert.equal(store.state.hostForgets.ho_b, undefined);
});

test('#491 a host that can’t remove it now says why, keeps it owed, and is asked again on its next connection', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  // As daemon-forget.mjs answers a memory/ that isn’t a real folder.
  const refusal = {
    type: 'error',
    code: 'internal',
    re: 'forget',
    message: '~/.postbox-remote/memory isn’t a folder, so the daemon removed nothing from it. Remove it on the host.',
  };
  const { store, manager, hosts } = rig({ answer: () => refusal });
  watchForgets(hosts);
  oweForget(hosts, 'pe_gone');
  await settled();
  assert.deepEqual(store.state.hostForgets.ho_a, ['pe_gone']);
  assert.match(
    String(errors.mock.calls[0]?.arguments[0]),
    /a\.example couldn’t remove a deleted agent’s memory: .*isn’t a folder.* Postbox asks again when it next connects\./,
  );
  manager.emit('status', 'ho_a');
  await settled();
  assert.equal(manager.links.get('ho_a').sent.length, 1, 'not asked again on that connection');
  manager.connect('ho_a');
  await settled();
  assert.deepEqual(manager.links.get('ho_a').sent, [{ type: 'forget', persona: 'pe_gone' }], 'asked again on the next');
});

test('#491 a forgotten for a persona owed but not asked on this send settles nothing', async () => {
  const { store, manager, hosts } = rig({ answer: () => null });
  watchForgets(hosts);
  oweForget(hosts, 'pe_gone');
  store.emit('host.forget', { id: 'ho_a', add: ['pe_other'] });
  await settled();
  const l = manager.links.get('ho_a');
  // pe_other was owed while pe_gone’s send waited, so it isn’t asked yet: a stray answer for it settles nothing.
  assert.deepEqual(
    l.sent.map((/** @type {any} */ m) => m.persona),
    ['pe_gone'],
  );
  l.emit('message', { type: 'forgotten', persona: 'pe_other' });
  await settled();
  assert.deepEqual(store.state.hostForgets.ho_a, ['pe_gone', 'pe_other']);
});
