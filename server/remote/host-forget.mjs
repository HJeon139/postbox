// A deleted persona’s memory on the hosts (#491). Claude Code keeps a persona’s auto memory on a host in
// ~/.postbox-remote/memory/<persona id> (setup.mjs’s memoryFolder), which only that host’s daemon can remove. Postbox
// keeps no record of which hosts a persona ran on, so deleting one owes a removal to every host it knows
// (`hostForgets`, shared/state-hosts.mjs), and each host is sent its removals (`forget`, answered by `forgotten`) when
// it next connects, or at once if it’s connected. A removal stays owed until the host says it’s done, so a host
// that’s off now gets it later.
//
// One host serves more than one Postbox in turn (a hello’s takeover, #759’s relay), and each keeps its own persona
// ids, so a host removes only the folder it’s named, never every folder a list leaves out.
//
// A daemon older than `forget` refuses it as a message it doesn’t carry (tests/fixtures/remote/forget-before-491.json):
// its removals stay owed until the host runs this version, and the server log says so, once per connection.

import { message, refusesType } from '../../shared/remote-protocol.mjs';

/** How long Postbox waits for a host to answer its removals before it lets the host idle again. */
export const FORGET_WAIT_MS = 30_000;

/** @typedef {import('./host-service.mjs').Hosts} Hosts */

/** Per Hosts, the hosts whose removals are being sent now. @type {WeakMap<Hosts, Set<string>>} */
const sending = new WeakMap();
/** Per link, the connection (its welcome) not asked again: one that refused `forget` (an older daemon), couldn’t do
 * it, or didn’t answer within the wait, so a host that never answers can still idle. Keyed on the welcome, not the
 * link, because a host keeps one link across its connections (hosts.mjs) and link.mjs sets a new welcome at each. */
const done = new WeakMap();
/** @param {any} l */
const isDone = (l) => done.has(l) && done.get(l) === l.welcome;
/** @param {any} l */
const markDone = (l) => done.set(l, l.welcome);

/**
 * A persona was deleted: every host owes its memory’s removal (a host removed meanwhile owes nothing: the reducer
 * drops it). watchForgets sends it to a connected host once the store has applied it, after any held commit.
 * @param {Hosts} hosts @param {string} personaId
 */
export function oweForget(hosts, personaId) {
  for (const id of Object.keys(hosts.store.state.hosts ?? {})) hosts.store.emit('host.forget', { id, add: [personaId] });
}

/** Each host is sent what it owes when it connects, and a connected one as soon as it owes more. @param {Hosts} hosts */
export function watchForgets(hosts) {
  const ifConnected = (/** @type {string} */ hostId) => {
    if (hosts.manager?.status(hostId)?.state === 'connected') void sendForgets(hosts, hostId);
  };
  hosts.manager?.on('status', ifConnected);
  hosts.store.subscribe((/** @type {any} */ ev) => ev.type === 'host.forget' && ev.data?.add?.length && ifConnected(ev.data.id));
}

/**
 * Sends a host every removal it owes, and drops each it answers. Keeps the host connected while it waits, up to waitMs.
 * @param {Hosts} hosts @param {string} hostId
 * @param {{ waitMs?: number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void }} [o]
 */
export async function sendForgets(
  hosts,
  hostId,
  { waitMs = FORGET_WAIT_MS, setTimer = (fn, ms) => setTimeout(fn, ms).unref(), clearTimer = clearTimeout } = {},
) {
  const owed = hosts.store.state.hostForgets?.[hostId] ?? [];
  const busy = sending.get(hosts) ?? new Set();
  sending.set(hosts, busy);
  if (!owed.length || busy.has(hostId) || !hosts.manager) return;
  let l;
  try {
    l = hosts.manager.link(hostId);
  } catch {
    return;
  }
  if (isDone(l)) return;
  busy.add(hostId);
  const why = Symbol('forget');
  hosts.manager.need(hostId, why);
  try {
    await answers(hosts, hostId, l, new Set(owed), { waitMs, setTimer, clearTimer });
  } finally {
    hosts.manager.release(hostId, why);
    busy.delete(hostId);
  }
  // Owed while this send waited: sent now, on the same connection.
  const more = (hosts.store.state.hostForgets?.[hostId] ?? []).some((p) => !owed.includes(p));
  if (more && !isDone(l)) await sendForgets(hosts, hostId, { waitMs, setTimer, clearTimer });
}

/**
 * Sends each removal on the link and waits for the answers: each `forgotten` drops its removal. A refusal naming its
 * persona keeps only that one owed and the wait goes on for the rest (#1683); one naming none, or the link’s close,
 * ends the wait with the rest still owed. Either refusal leaves the next ask to the next connection.
 * @param {Hosts} hosts @param {string} hostId @param {any} l @param {Set<string>} left
 * @param {{ waitMs: number, setTimer: (fn: () => void, ms: number) => any, clearTimer: (t: any) => void }} o
 */
function answers(hosts, hostId, l, left, { waitMs, setTimer, clearTimer }) {
  return new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      if (timer) clearTimer(timer);
      l.off('message', onMessage);
      l.off('state', onState);
      resolve(undefined);
    };
    const onMessage = (/** @type {any} */ msg) => {
      if (msg.type === 'forgotten' && left.delete(msg.persona)) {
        hosts.store.emit('host.forget', { id: hostId, drop: [msg.persona] });
        if (!left.size) finish();
      } else if (refusesType(msg, 'forget')) {
        markDone(l);
        console.error(
          `${nameOf(hosts, hostId)} runs a Postbox older than removing a deleted agent’s memory, so ${left.size} deleted agent(s)’ memory stays there until it runs this version: ${msg.message}`,
        );
        finish();
      } else if (msg.type === 'error' && msg.re === 'forget' && typeof msg.persona === 'string') {
        // One persona’s removal refused (#1683): it stays owed until the next connection, as any refusal does, and the
        // others’ answers on this one are still read.
        if (!left.delete(msg.persona)) return;
        markDone(l);
        console.error(
          `${nameOf(hosts, hostId)} couldn’t remove the memory of a deleted agent (${msg.persona}): ${msg.message} Postbox asks again when it next connects.`,
        );
        if (!left.size) finish();
      } else if (msg.type === 'error' && msg.re === 'forget') {
        // A refusal naming no persona, from a daemon before #1683: nothing says which, so this connection stops here.
        markDone(l);
        console.error(`${nameOf(hosts, hostId)} couldn’t remove a deleted agent’s memory: ${msg.message} Postbox asks again when it next connects.`);
        finish();
      }
    };
    const onState = () => !l.connected && finish();
    l.on('message', onMessage);
    l.on('state', onState);
    timer = setTimer(() => {
      markDone(l);
      finish();
    }, waitMs);
    for (const persona of left) if (!l.send(message('postbox-to-daemon', 'forget', { persona }))) return finish();
  });
}

/** @param {Hosts} hosts @param {string} hostId */
const nameOf = (hosts, hostId) => hosts.store.state.hosts?.[hostId]?.name ?? 'A host';
