// The commands a confirm runs when the person confirms (#852 slice 1a). They run with no second card, so each is
// drawn whole, as plain text in a box of its own that wraps: never through Markdown, never folded, never cut off.

import { h } from './dom.mjs';

/**
 * The “Runs when you confirm” section under a confirm’s statement, or null when it names no commands.
 * @param {string[] | undefined} commands  the confirm’s commands, as the catalog passed them
 */
export function commandsSection(commands) {
  if (!commands?.length) return null;
  return h(
    'div.confirm-cmds',
    { role: 'group', 'aria-label': 'Runs when you confirm' },
    h('div.confirm-cmds-head', 'Runs when you confirm'),
    commands.map((text) => h('pre.confirm-cmd', h('code', text))),
  );
}
