// Each backend’s quota in full, for Settings › Backends (#1496; designs/architecture/adapters.md, “Quota: each backend’s
// usage, in the composer”): the composer’s bars say a backend, its percent and its window, and a click on them opens
// this, with every window the backend reported, its limit, the share used, when it resets and when it was updated. It
// paints itself again as reports, hosts and the page’s state change, and each minute, as ages and resets move.

import { BACKEND_NAMES } from '/shared/agent-facts.mjs';
import { client } from './client.mjs';
import { h } from './dom.mjs';
import { onChangeWhileAlive, WeakElements } from './held-weakly.mjs';
import { age, resetTime } from './quota-words.mjs';
import { keepFocus } from './ui.mjs';

const S = () => client.state;
const nameOf = (/** @type {string} */ backend) => BACKEND_NAMES[backend] ?? backend;
const REPAINT_ON = new Set(['quota', 'host', 'load']);
const shown = new WeakElements();

/**
 * One window’s row: its name and limit, the share used (or that it reset), its reset, and when it was last updated, as
 * the bar reads it: the window’s own time, else its record’s. @param {any} w @param {any} q @param {number} now
 */
function windowRow(w, q, now) {
  const past = !!w.resetsAt && w.resetsAt <= now;
  return h(
    'tr',
    h('td', w.limit ? `${w.name} (${w.limitName ?? w.limit})` : w.name),
    h('td', past ? 'Reset' : `${Math.round(w.used * 100)}%`),
    h('td', w.resetsAt && !past ? resetTime(w.resetsAt, now) : ''),
    h('td', `${age(now - (w.seenAt ?? q.seenAt))} ago`),
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
          ['Window', 'Used', 'Resets', 'Updated'].map((t) => h('th', { scope: 'col' }, t)),
        ),
      ),
      h(
        'tbody',
        q.windows.map((w) => windowRow(w, q, now)),
      ),
    ),
  );
}

/** Every quota Postbox has a report of, then each backend here that reports none. @param {number} now */
function details(now) {
  const quotas = Object.values(S().quota ?? {}).sort((a, b) => nameOf(a.backend).localeCompare(nameOf(b.backend)));
  const reported = new Set(quotas.filter((q) => !q.host).map((q) => q.backend));
  const silent = (client.config.adapters ?? []).filter((b) => b !== 'mock' && !reported.has(b));
  return [...quotas.map((q) => quotaTable(q, now)), ...silent.map((b) => h('p.small.dim', `${nameOf(b)} reports no quota.`))];
}

/** Draws the tables again, keeping focus where it was. @param {HTMLElement} el */
const paint = (el) => keepFocus(el, () => el.replaceChildren(...details(Date.now())));

/** The Backends tab’s quotas, which keep themselves current while they’re open. */
export function quotaDetails() {
  const el = h('div.quota-details');
  paint(el);
  shown.add(el);
  onChangeWhileAlive(el, (live, change, off) => {
    if (!live.isConnected) return off();
    if (REPAINT_ON.has(change.type)) paint(live);
  });
  return el;
}

// Ages and resets move with the clock: each minute, the tables open say what’s true now.
setInterval(() => {
  for (const el of shown) if (el.isConnected) paint(el);
}, 60_000);
