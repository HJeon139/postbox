// How a host recovers from a host-mode fault (#120; tools/uat/hosts-watch.mjs does the faults): its status after
// the fault, from Postbox’s event stream as each change came (tools/uat/history.mjs, hostStates) and from reads of
// the state. A drop and its reconnect can both fall between two reads, so the events are what show it; a host that
// never read anything but Connected wasn’t cut off at all (an ssh that wasn’t its connection, say), and its fault
// shows nothing about recovering (recovered null, unseen).

import { sleep } from '../cdp.mjs';

const BUSY = new Set(['think', 'tool', 'gen']);
const RECOVER_MS = 180_000;
// The states that show the host lost its connection. An unread state (“unknown”: a read that failed, or no status)
// shows nothing either way.
const LOST = new Set(['reconnecting', 'disconnected', 'failed', 'not-installed']);
const sessionsOf = (st, handle) => Object.values(st?.sessions ?? {}).filter((se) => se?.handle === handle);

/** @typedef {{ state: string, ms: number, failure: string|null }} Seen */

/** The states in the order they came, each once in a row. @param {Seen[]} seen */
const inOrder = (seen) => [...seen].sort((a, b) => a.ms - b.ms).filter((s, i, all) => i === 0 || all[i - 1].state !== s.state);

/**
 * Follows a host’s status after a fault until it reads Connected again having been cut off (recovered), fails, or 3
 * minutes pass. A host nothing needs may stay disconnected, and one never cut off shows nothing: neither is judged
 * (recovered null).
 * @param {import('./hosts-run.mjs').HostRun} hr @param {import('./hosts-run.mjs').RunHost} h @param {number} at
 * @param {{ wait?: (ms: number) => Promise<unknown>, now?: () => number }} [o]
 * @returns {Promise<{ states: Seen[], recovered: boolean|null, unseen?: boolean }>}
 */
export async function recovery(hr, h, at, { wait = sleep, now = Date.now } = {}) {
  /** @type {Seen[]} */
  const seen = [];
  let down = false;
  const note = (/** @type {string} */ state, /** @type {number} */ ms, failure = null) => {
    seen.push({ state, ms, failure });
    if (LOST.has(state)) down = true;
  };
  const done = (/** @type {boolean|null} */ recovered, extra = {}) => ({ states: inOrder(seen), recovered, ...extra });
  let heard = 0;
  for (const end = at + RECOVER_MS; now() < end; await wait(250)) {
    const events = (hr.hostStates?.() ?? []).filter((e) => e.id === h.id && e.at >= at);
    for (const e of events.slice(heard)) note(e.state ?? 'unknown', e.at - at);
    heard = events.length;
    const st = (await hr.api('/api/state').catch(() => ({})))?.state;
    const s = st?.hostStatus?.[/** @type {string} */ (h.id)];
    const state = s?.state ?? 'unknown';
    note(state, now() - at, s?.failure?.message ?? null);
    if (state === 'connected' && down) return done(true);
    if (state === 'connected' && now() - at > 5000) return done(null, { unseen: true });
    if (state === 'failed') return done(false);
    const needed = Object.entries(hr.placement).some(
      ([handle, w]) => w === h.label && sessionsOf(st, handle).some((se) => BUSY.has(se.state) || se.state === 'needs'),
    );
    if (state === 'disconnected' && !needed && now() - at > 20_000) return done(null);
  }
  return done(false);
}

/** How a recovery reads, for the tester and the record. */
export const says = (label, { states, recovered, unseen = false }, rows) =>
  `${label} read ${states.map((s) => `${s.state} at ${(s.ms / 1000).toFixed(1)} s${s.failure ? ` (“${s.failure}”)` : ''}`).join(', then ') || 'nothing'}${unseen ? '; it never read anything but Connected, so the fault didn’t cut it off, and shows nothing about recovering' : recovered === null ? '; nothing needed it, so it stayed disconnected' : recovered ? '' : '; it didn’t read Connected again in 3 minutes'}.${rows.length ? ` The sidebar: ${rows.map((r) => `“${r}”`).join('; ')}.` : ''}`;
