// What #508’s benches share (tools/bench-key-frame.mjs and the server’s): a free port, a whole-number option, and the
// room a bench seeds the big room into, as the page would have started it.

import { createServer } from 'node:net';
import { Store } from '../server/store.mjs';

export const THREAD = 'th_keyframe';
export const AGENTS = ['researcher', 'critic', 'developer'];

/** A port nothing listens on, from the system. @returns {Promise<number>} */
export const freePort = () =>
  new Promise((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
      s.close(() => ok(port));
    });
  });

/**
 * A whole number of at least one from an option, written in digits, or an error that names it. Number() alone took
 * “1e3” and “0x10”, and an empty value as 0.
 * @param {string} name  @param {string} raw
 */
export function count(name, raw) {
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`--${name} takes a whole number of at least 1, not “${raw}”.`);
  return Number(raw);
}

/** The room as the page would have started it: a project, its three agents, and a room with their sessions. */
export async function startRoom(data) {
  const store = await new Store(data).load();
  store.emit('project', { id: 'pr_keyframe', name: 'Key to frame', folder: data });
  const members = AGENTS.map((handle) => `se_${handle}`);
  for (const handle of AGENTS) store.emit('persona', { id: `pe_${handle}`, handle, backend: 'mock', model: 'mock' });
  store.emit('thread', { id: THREAD, projectId: 'pr_keyframe', kind: 'room', title: 'The release, in a long room', members });
  for (const handle of AGENTS) store.emit('session', { id: `se_${handle}`, threadId: THREAD, handle, personaId: `pe_${handle}` });
  await store.close();
}
