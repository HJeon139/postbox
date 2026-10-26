// Tabs of Settings (app/js/sheets.mjs, openSettings) that stand on their own: Appearance, light or dark, and
// Backends, which says how real agents reach Postbox’s tools and what this computer has.

import { api, client } from './client.mjs';
import { h, plural } from './dom.mjs';

const S = () => client.state;

/** @param {() => void} paint  repaints the tabs, once the choice is saved */
export const appearance = (paint) => {
  const pref = S().settings.theme ?? 'system';
  return [
    h(
      'div.field',
      h('span.label', 'Mode'),
      h(
        'div.seg',
        { role: 'radiogroup', 'aria-label': 'Mode' },
        [
          ['system', 'System'],
          ['light', 'Light'],
          ['dark', 'Dark'],
        ].map(([v, l]) =>
          h(
            'button',
            { type: 'button', role: 'radio', 'aria-checked': String(pref === v), onclick: () => api('/api/settings', { theme: v }, 'PUT').then(paint) },
            l,
          ),
        ),
      ),
    ),
    h('p.small.dim', 'System follows your computer’s setting. The choice is saved in Postbox, so it follows you to other browsers.'),
  ];
};

export const connect = () => [
  h(
    'p',
    'Real agents reach Postbox’s UI tools over MCP. Postbox connects each backend it runs, with a token for each turn, so only an agent turn Postbox started can call them.',
  ),
  h(
    'dl.facts',
    h('dt', 'Adapters'),
    h('dd', client.config.adapters.join(', ')),
    h('dt', 'Corpus'),
    h('dd', `${plural(client.config.corpus.passages, 'passage')} in ${plural(client.config.corpus.books.length, 'book')}`),
  ),
];
