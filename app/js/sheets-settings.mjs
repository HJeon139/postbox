// Tabs of Settings (app/js/sheets.mjs, openSettings) that stand on their own: Backends, which says how real agents
// reach Postbox’s tools and what this computer has.

import { client } from './client.mjs';
import { h, plural } from './dom.mjs';

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
