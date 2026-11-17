// Each backend’s usage of its quota, as its harness reports it during a turn (#442; designs/architecture/adapters.md,
// “Quota: each backend’s usage, in the composer”): kept in the state under the quota’s key (shared/quota-key.mjs), for
// the composer’s quota line. It only shows: whether agents are out of quota is the session’s `quota`, which a refused
// turn sets and a turn that ends well clears (turn-quota.mjs), never this record’s status.

import { quotaKeyOf } from '../shared/quota-key.mjs';

/** A report the same as the last one is written again only once the last is this old, so its age stays true. */
export const REWRITE_MS = 10 * 60_000;
const STATUSES = new Set(['ok', 'warning', 'out']);
const MAX_WINDOWS = 4;

/**
 * A harness’s report, checked and bounded: a status, and windows each with a name, the share used from 0 to 1, and when
 * it resets in epoch ms or null. Null when it holds no window worth a bar.
 * @param {any} r @returns {{ status: string, windows: { name: string, used: number, resetsAt: number | null }[] } | null}
 */
export function quotaReport(r) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.windows)) return null;
  const windows = r.windows
    .filter((w) => w && typeof w.name === 'string' && w.name && Number.isFinite(w.used) && w.used >= 0 && w.used <= 1)
    .slice(0, MAX_WINDOWS)
    .map((w) => ({
      name: w.name.slice(0, 12),
      used: w.used,
      resetsAt: Number.isFinite(w.resetsAt) && w.resetsAt > 0 ? Math.round(w.resetsAt) : null,
    }));
  if (!windows.length) return null;
  return { status: STATUSES.has(r.status) ? r.status : 'ok', windows };
}

/** What a reader of the bar would see differ: the status, and each window’s name, whole percent and reset minute. */
const shown = (/** @type {any} */ r) =>
  JSON.stringify([r.status, r.windows.map((w) => [w.name, Math.round(w.used * 100), w.resetsAt && Math.round(w.resetsAt / 60_000)])]);

/**
 * Keeps a session’s backend’s report, unless it shows what the last one did and that one is recent: Claude Code
 * reports with every turn, and the log needn’t grow with each.
 * @param {any} rt @param {any} se  the session whose turn reported @param {any} report @param {number} [now]
 */
export function recordQuota(rt, se, report, now = Date.now()) {
  const r = quotaReport(report);
  if (!r) return;
  const persona = rt.s.personas[se.personaId];
  const id = quotaKeyOf(persona);
  const last = rt.s.quota?.[id];
  if (last && shown(last) === shown(r) && now - last.seenAt < REWRITE_MS) return;
  const host = persona?.remote?.hostId ?? null;
  rt.store.emit('quota', { id, backend: persona?.backend ?? 'mock', host, ...r, seenAt: now });
}
