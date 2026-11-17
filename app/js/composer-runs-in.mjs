// The `!` hint’s “Runs in <folder>” (#67), on the composer’s one clipped row (#1437). A long folder is cut in the
// middle, not at its end: its last part says where the command runs, and a phone has no tooltip to show the rest.

import { h } from './dom.mjs';

/**
 * @param {string} folder  where the command runs
 * @param {any} here  what notOnHost says (composer-host.mjs), or null
 */
export function runsIn(folder, here) {
  const cut = folder.replace(/\/+$/, '').lastIndexOf('/');
  const head = cut > 0 ? folder.slice(0, cut) : '';
  const tail = cut > 0 ? folder.slice(cut) : folder;
  return h(
    'span.runs-in',
    h('span', 'Runs in '),
    head ? h('span.mono.folder-head', head) : null,
    h('span.mono.folder-tail', tail),
    here ? h('span', here) : null,
    h('span.runs-in-rest', ' as you, with Enter. The agents read it and its output on their next turn.'),
  );
}
