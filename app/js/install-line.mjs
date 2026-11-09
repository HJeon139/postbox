// The note at the top of the page when a backend isn’t installed (#320), moved from app/js/shell.mjs, which re-exports it.

import { installNote } from '/shared/agent-facts.mjs';
import { client } from './client.mjs';
import { h, icon } from './dom.mjs';

/** What isn’t installed, as the overview used to say (#320); null while every backend is there. */
export function installLine() {
  const lead = installNote(client.config ?? {});
  if (!lead) return null;
  return h(
    'div.callout.warn.install-note',
    icon('warn'),
    h(
      'div',
      h('p', lead),
      h(
        'p.small',
        'To run real agents, install Claude Code so ',
        h('code', 'claude --version'),
        ' works, or set ',
        h('code', 'POSTBOX_CLAUDE_BIN'),
        ' to where it is, then restart Postbox. The README’s “Run real agents” says more.',
      ),
    ),
  );
}
