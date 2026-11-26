// The rig for tests/remote-host-forget*.test.mjs: host-service.mjs’s hosts over a real store, and a fake manager
// whose links answer each message as the test says (#491).

import { EventEmitter } from 'node:events';
import { Store } from '../server/store.mjs';

/**
 * Hosts (host-service.mjs) over a real store with two hosts, and a fake manager: each host’s link, its state, and
 * what the daemon answers each message. answer(msg) is the reply, or null for none.
 * @param {{ answer?: (m: any) => any, connected?: string[], store?: any }} [o]
 */
export function rig({ answer = (m) => ({ type: 'forgotten', persona: m.persona }), connected = ['ho_a'], store = new Store(null) } = {}) {
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
    /** The host connects again: as in hosts.mjs, the host keeps its link, and link.mjs gives it a new welcome. @param {string} id */
    connect(id) {
      const l = linkOf(id);
      l.connected = true;
      l.welcome = {};
      manager.states.set(id, 'connected');
      manager.emit('status', id);
    },
  });
  return { store, manager, hosts: /** @type {any} */ ({ store, manager }) };
}

/** A link whose daemon answers each message with answer(msg). @param {(m: any) => any} answer */
function newLink(answer) {
  const l = Object.assign(new EventEmitter(), { connected: true, welcome: {}, sent: /** @type {any[]} */ ([]) });
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

export const settled = () => new Promise((r) => setImmediate(() => setImmediate(r)));
