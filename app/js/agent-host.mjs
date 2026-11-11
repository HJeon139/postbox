// An agent whose turns run on a host (#120), in the agents list (app/js/agents.mjs): the
// host and the connection in words, and the line that
// ages as the minutes pass. In the list the host is a short badge, since a whole SSH destination can fill the row.

import { badgeOf } from '/shared/host-badge.mjs';
import { h } from './dom.mjs';
import { connectionOf, hostLine, hostOf } from './remote.mjs';

/**
 * Repaints a minute apart while el is on the page, since “last heard from 2 min ago” ages while nothing changes.
 * @param {HTMLElement} el @param {() => void} paint @param {() => void} off  what else destroy undoes
 * @returns {() => void} destroy: stops listening, and the clock
 */
export function everyMinute(el, paint, off) {
  const tick = setInterval(() => el.isConnected && paint(), 60_000);
  return () => {
    off();
    clearInterval(tick);
  };
}

/**
 * Where it runs, in the agents list, when that’s a host: the host’s badge (its short name, or the start of its machine’s
 * name), and the connection in words only when it isn’t Connected. The badge’s tooltip, the words a screen reader
 * hears, and the agent’s panel keep the whole line: the destination, the connection and when Postbox last heard from it.
 * Null for an agent on this computer. @param {any} se
 */
export function hostBadge(se) {
  const host = hostOf(se);
  if (!host) return null;
  const line = /** @type {string} */ (hostLine(se));
  const connection = connectionOf(se, host);
  return h(
    'span.sub.host-line',
    h('span.host-badge.mono', { title: line, 'aria-hidden': 'true' }, badgeOf(host)),
    connection === 'Connected' ? null : h('span.host-state', { 'aria-hidden': 'true' }, ` ${connection}`),
    h('span.sr-only', line),
  );
}
