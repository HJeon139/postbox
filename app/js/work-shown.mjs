// The apps and reviews in the Work pane: what the agents showed in the conversation that lasts, an app at its latest
// version and each review, newest first, from the work ledger’s publishes (#195, #1503). Each row leads back to it in the
// conversation, as full-screen Work’s “Shown in the conversation” does.

import { appsAndReviews, retiredApp } from '/shared/work-list.mjs';
import { h, icon } from './dom.mjs';
import { row, sec, short } from './work-pane-parts.mjs';
import { showItem } from './work-sections.mjs';

/**
 * The section, or null when the agents showed no app or review.
 * @param {string} convId @param {any} s  summarize()’s @param {Record<string, any>} apps  state.apps
 * @param {{ all: boolean, showAll: () => void }} opts  all: every one, not the first few
 */
export function shownSection(convId, s, apps, { all, showAll }) {
  const list = appsAndReviews(s.publishes);
  if (!list.length) return null;
  const make = (/** @type {any} */ p) =>
    row(
      `wc-shown-${p.id}`,
      () => showItem(convId, p),
      icon(p.what === 'app' ? 'spark' : 'list', 'i-sm'),
      h('span.wc-name', p.title),
      retiredApp(p.what === 'app' ? apps?.[p.blockId] : null) ? h('span.status-tag', 'Retired') : null,
      h('span.small.dim', `${p.what === 'app' ? `app v${p.version ?? 1}` : 'review'} · ${p.handle}`),
    );
  return sec('wc-shown', 'Apps and reviews', String(list.length), all ? h('ul.wc-list', list.map(make)) : short(list, make, showAll));
}
