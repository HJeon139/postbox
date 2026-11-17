// A turn its backend refused for quota (the owner’s decision on #442): the session stays failed and records `quota`,
// with the reset time when the harness gave one, which the agents area shows (shared/agent-state.mjs). It doesn’t need
// the person, who can’t act on it before the reset, so no needs-you; one info notice says the backend ran out, never
// one per agent. The quota is the backend’s, so every agent on it is marked out of quota: none is woken into a turn
// that would fail the same way. Only the person’s own message tries again before the reset (Delivery’s canStart),
// and a turn of that backend that ends well clears the mark on all of them, and lets the next run-out notify again.

import { BACKEND_NAMES } from '../shared/agent-facts.mjs';

/** The backend a session’s persona runs on. @param {any} rt @param {any} se @returns {string} */
const backendOf = (rt, se) => rt.s.personas[se.personaId]?.backend ?? 'mock';

/** The sessions of a backend’s agents. @param {any} rt @param {string} backend @returns {any[]} */
const sessionsOn = (rt, backend) => Object.values(rt.s.sessions).filter((se) => !se.retiredFork && backendOf(rt, se) === backend);

/**
 * The session ran out of quota: every agent on its backend is out of quota, the notice for the backend, once, and a
 * wake at the reset. Returns the session’s `quota`, which its own failure records. @param {any} rt @param {any} se
 * @param {number | null} until  when the quota resets, in epoch ms, if the harness said @param {string} threadId
 */
export function outOfQuota(rt, se, until, threadId) {
  const backend = backendOf(rt, se);
  for (const other of sessionsOn(rt, backend)) if (other.id !== se.id) rt.sessions.update(other.id, { quota: { until } });
  const noticed = rt.turnService.quotaNoticed;
  if (!noticed.has(backend)) {
    noticed.add(backend);
    const name = BACKEND_NAMES[backend] ?? backend;
    const text = until
      ? `Its agents can work again at ${new Date(until).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}, or when you send them a message.`
      : `${name} didn’t say when it resets, so Postbox doesn’t know when. Its agents try again when you send them a message.`;
    rt.threads.notify('info', se, `${name} is out of quota`, text, threadId);
  }
  armReset(rt, backend, until);
  return { until };
}

/**
 * At the reset, the backend’s agents are woken, so a scheduled wake that waited for it can start. Kept in rt.watchdogs,
 * so close() clears it (server/runtime-close.mjs); a restart arms it again from the sessions (armQuotaResets).
 * @param {any} rt @param {string} backend @param {number | null} until
 */
function armReset(rt, backend, until) {
  if (!until || until <= Date.now()) return;
  // setTimeout fires at once past its 32-bit limit, about 24 days, so a later reset wakes then, and the wake finds
  // the quota still out.
  const timer = setTimeout(
    () => {
      rt.watchdogs.delete(timer);
      for (const se of sessionsOn(rt, backend)) rt.delivery.wake(se.id);
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
    if (until && until > Date.now()) resets.set(`${backendOf(rt, se)} ${until}`, [backendOf(rt, se), until]);
  }
  for (const [backend, until] of resets.values()) armReset(rt, backend, until);
}

/**
 * A turn of the session’s backend ended well: the quota is back, so the backend’s agents are no longer out of it, and
 * its next run-out notifies again. @param {any} rt @param {any} se
 */
export function quotaBack(rt, se) {
  const backend = backendOf(rt, se);
  rt.turnService.quotaNoticed.delete(backend);
  for (const other of sessionsOn(rt, backend))
    if (other.quota) {
      rt.sessions.update(other.id, { quota: null });
      rt.delivery.wake(other.id);
    }
}
