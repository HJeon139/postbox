// A turn its backend refused for quota (the owner’s decision on #442): the session stays failed and records `quota`,
// with the reset time when the harness gave one, which the agents area shows (shared/agent-state.mjs). It doesn’t need
// the person, who can’t act on it before the reset, so no needs-you; one info notice says the quota ran out, never one
// per agent. A quota is a backend’s on the computer that runs it, since a host’s harness signs in to its own account
// (designs/architecture/remote-hosts.md; the `backend@host` key of designs/architecture/adapters.md), so every agent
// of that backend there is marked out of quota: none is woken into a turn that would fail the same way. Only the
// person’s own message tries again before the reset (Delivery’s canStart). A turn on that quota that ends well
// clears the mark on all of them, and lets the next run-out notify again; a turn that only starts clears nothing.

import { BACKEND_NAMES } from '../shared/agent-facts.mjs';
import { hostOf } from './remote/placement.mjs';

/** Whose quota a persona’s turns use: its backend, and the host it runs on, if any (`backend@host`). @param {any} persona */
function keyOf(persona) {
  const backend = persona?.backend ?? 'mock';
  const host = hostOf(persona);
  return host ? `${backend}@${host}` : backend;
}

/** Whose quota a session’s turns use (keyOf). @param {any} rt @param {any} se @returns {string} */
const quotaKey = (rt, se) => keyOf(rt.s.personas[se.personaId]);

/**
 * The sessions whose turns use one quota, as written, behind a held commit too, since their marks decide writes.
 * @param {any} rt @param {string} key @returns {any[]}
 */
const sessionsOn = (rt, key) => Object.values(rt.store.pending.sessions()).filter((se) => !se.retiredFork && quotaKey(rt, se) === key);

/** What the notice calls a quota: its backend, and its host by name. @param {any} rt @param {any} se */
function quotaName(rt, se) {
  const persona = rt.s.personas[se.personaId];
  const backend = persona?.backend ?? 'mock';
  const name = BACKEND_NAMES[backend] ?? backend;
  const host = hostOf(persona);
  return host ? `${name} on ${rt.s.hosts[host]?.name ?? 'its host'}` : name;
}

/**
 * The session ran out of quota: every agent on that quota is out of it, the notice for the quota, once, and a
 * wake at the reset. Returns the session’s `quota`, which its own failure records. @param {any} rt @param {any} se
 * @param {number | null} until  when the quota resets, in epoch ms, if the harness said @param {string} threadId
 */
export function outOfQuota(rt, se, until, threadId) {
  const key = quotaKey(rt, se);
  for (const other of sessionsOn(rt, key)) if (other.id !== se.id) rt.sessions.update(other.id, { quota: { until } });
  const noticed = rt.turnService.quotaNoticed;
  if (!noticed.has(key)) {
    noticed.add(key);
    const name = quotaName(rt, se);
    const text = until
      ? `Its agents can work again at ${new Date(until).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}, or when you send them a message.`
      : `${name} didn’t say when it resets, so Postbox doesn’t know when. Its agents try again when you send them a message.`;
    rt.threads.notify('info', se, `${name} is out of quota`, text, threadId);
  }
  armReset(rt, key, until);
  return { until };
}

/**
 * At the reset, the agents on that quota are woken, so a scheduled wake that waited for it can start. Kept in rt.watchdogs,
 * so close() clears it (server/runtime-close.mjs); a restart arms it again from the sessions (armQuotaResets).
 * @param {any} rt @param {string} key  whose quota (quotaKey) @param {number | null} until
 */
function armReset(rt, key, until) {
  if (!until || until <= Date.now()) return;
  // setTimeout fires at once past its 32-bit limit, about 24 days, so a later reset wakes then, and the wake finds
  // the quota still out.
  const timer = setTimeout(
    () => {
      rt.watchdogs.delete(timer);
      for (const se of sessionsOn(rt, key)) rt.delivery.wake(se.id);
    },
    Math.min(until - Date.now(), 2 ** 31 - 1),
  );
  timer.unref?.();
  rt.watchdogs.add(timer);
}

/** After a restart: a wake at each reset the sessions still wait for. @param {any} rt */
export function armQuotaResets(rt) {
  const resets = new Map();
  for (const se of Object.values(rt.s.sessions)) {
    const until = se.quota?.until;
    if (until && until > Date.now()) resets.set(`${quotaKey(rt, se)} ${until}`, [quotaKey(rt, se), until]);
  }
  for (const [key, until] of resets.values()) armReset(rt, key, until);
}

/**
 * A turn on the session’s quota ended well: the quota is back, so the agents on it are no longer out of it, and
 * its next run-out notifies again. @param {any} rt @param {any} se
 */
export function quotaBack(rt, se) {
  const key = quotaKey(rt, se);
  rt.turnService.quotaNoticed.delete(key);
  for (const other of sessionsOn(rt, key))
    if (other.quota) {
      rt.sessions.update(other.id, { quota: null });
      rt.delivery.wake(other.id);
    }
}

/**
 * A persona moved to another backend or computer: its agents’ turns use that quota now, so they leave the old one’s
 * mark and take the new one’s, if it’s out; one no longer out may start what waited. On persona.updated.
 * @param {any} rt @param {any} persona  as written @param {any} was  before the change
 */
export function quotaMoved(rt, persona, was) {
  const key = keyOf(persona);
  if (key === keyOf(was)) return;
  const mine = (/** @type {any} */ se) => se.personaId === persona.id;
  const there = sessionsOn(rt, key).find((se) => !mine(se) && se.quota)?.quota ?? null;
  for (const se of Object.values(rt.store.pending.sessions()))
    if (mine(se) && !se.retiredFork && (se.quota || there)) {
      rt.sessions.update(se.id, { quota: there });
      if (!there) rt.delivery.wake(se.id);
    }
}
