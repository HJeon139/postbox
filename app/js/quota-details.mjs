// Each backend’s quota in full, for Settings › Backends (#1496; designs/architecture/adapters.md, “Quota: each backend’s
// usage, in the composer”): the composer’s bars say a backend, its percent and its window, and a click on them opens
// this, with every window the backend reported, its limit, the share used, when it resets and how long ago it was read.

import { BACKEND_NAMES } from '/shared/agent-facts.mjs';
import { client } from './client.mjs';
import { h } from './dom.mjs';
import { age, resetTime } from './quota-words.mjs';

const S = () => client.state;
const nameOf = (/** @type {string} */ backend) => BACKEND_NAMES[backend] ?? backend;

/** One window’s row: its name and limit, the share used (or that it reset), its reset, and its age. @param {any} w @param {number} now */
function windowRow(w, now) {
  const past = !!w.resetsAt && w.resetsAt <= now;
  return h(
    'tr',
    h('td', w.limit ? `${w.name} (${w.limitName ?? w.limit})` : w.name),
    h('td', past ? 'Reset' : `${Math.round(w.used * 100)}%`),
    h('td', w.resetsAt && !past ? resetTime(w.resetsAt, now) : ''),
    h('td', `${age(now - (w.seenAt ?? now))} ago`),
  );
}

/** One quota’s table, named for its backend, and its host if it runs on one. @param {any} q @param {number} now */
function quotaTable(q, now) {
  const host = q.host ? ` on ${S().hosts?.[q.host]?.name ?? 'a removed host'}` : '';
  const name = `${nameOf(q.backend)}${host}`;
  return h(
    'section.quota-detail',
    h('h3', name),
    h(
      'table.tbl.quota-table',
      { 'aria-label': `${name} quota` },
      h(
        'thead',
        h(
          'tr',
          ['Window', 'Used', 'Resets', 'Read'].map((t) => h('th', { scope: 'col' }, t)),
        ),
      ),
      h(
        'tbody',
        q.windows.map((w) => windowRow(w, now)),
      ),
    ),
  );
}

/** Every quota Postbox has a report of, then each backend here that reports none. */
export function quotaDetails(now = Date.now()) {
  const quotas = Object.values(S().quota ?? {}).sort((a, b) => nameOf(a.backend).localeCompare(nameOf(b.backend)));
  const reported = new Set(quotas.filter((q) => !q.host).map((q) => q.backend));
  const silent = (client.config.adapters ?? []).filter((b) => b !== 'mock' && !reported.has(b));
  return [...quotas.map((q) => quotaTable(q, now)), ...silent.map((b) => h('p.small.dim', `${nameOf(b)} reports no quota.`))];
}
