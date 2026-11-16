// A turn its backend refused for quota (the owner’s decision on #442): the session stays failed, so nothing but the
// person wakes it, and records `quota`, with the reset time when the harness gave one, which the agents area shows
// (shared/agent-state.mjs). Its own scheduled wakes wait for the reset (Delivery’s canStart), and one info notice says
// the backend ran out, never one per agent: a turn of that backend that ends well lets the next run-out notify again.

import { BACKEND_NAMES } from '../shared/agent-facts.mjs';

/** The backend a session’s persona runs on. @param {any} rt @param {any} se @returns {string} */
const backendOf = (rt, se) => rt.s.personas[se.personaId]?.backend ?? 'mock';

/**
 * The session ran out of quota: the notice for its backend, once, and a wake at the reset, so a scheduled wake that
 * waited for it can start. Returns the session’s `quota`. @param {any} rt @param {any} se
 * @param {number | null} until  when the quota resets, in epoch ms, if the harness said @param {string} threadId
 */
export function outOfQuota(rt, se, until, threadId) {
  const backend = backendOf(rt, se);
  const noticed = rt.turnService.quotaNoticed;
  if (!noticed.has(backend)) {
    noticed.add(backend);
    const name = BACKEND_NAMES[backend] ?? backend;
    const when = until
      ? `at ${new Date(until).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}`
      : 'once its quota resets';
    rt.threads.notify('info', se, `${name} is out of quota`, `Its agents can work again ${when}, or when you send them a message.`, threadId);
  }
  if (until && until > Date.now()) {
    // Kept in rt.watchdogs, so close() clears it (server/runtime-close.mjs). setTimeout fires at once past its 32-bit
    // limit, about 24 days, so a later reset wakes then, and the wake finds the quota still out.
    const timer = setTimeout(
      () => {
        rt.watchdogs.delete(timer);
        rt.delivery.wake(se.id);
      },
      Math.min(until - Date.now(), 2 ** 31 - 1),
    );
    timer.unref?.();
    rt.watchdogs.add(timer);
  }
  return { until };
}

/** A turn of the session’s backend ended well: its next run-out notifies again. @param {any} rt @param {any} se */
export function quotaBack(rt, se) {
  rt.turnService.quotaNoticed.delete(backendOf(rt, se));
}
