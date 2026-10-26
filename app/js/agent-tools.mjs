// A tool as a switch in an agent’s quick panel (app/js/agents.mjs): on the persona, so in every conversation it’s in.
// On means not denied; the permission mode still decides.

import { api, client } from './client.mjs';
import { h } from './dom.mjs';

const S = () => client.state;

/** A tool as a switch, on the persona: on means not denied; the permission mode still decides (TOOL_RULES). */
export function toolSwitch(se, p, id, name, off, done, failed) {
  const on = (p.tools ?? []).includes(id);
  const helpId = `qp-tool-${id.replace(/\W/g, '-')}`;
  return h(
    'div.qp-tool',
    h(
      'button.qp-switch',
      {
        type: 'button',
        role: 'switch',
        'aria-checked': String(on),
        'aria-label': `${name}, for @${se.handle} everywhere`,
        'aria-describedby': helpId,
        onclick: () => {
          // From the persona as it is now, not as it was when the panel painted: another switch may have changed it.
          const now = S().personas[se.personaId]?.tools ?? [];
          const was = now.includes(id);
          const tools = was ? now.filter((x) => x !== id) : [...now, id];
          api(`/api/personas/${se.personaId}`, { tools }, 'PATCH').then(
            () => done(`${name}: ${was ? 'off' : 'on'} for @${se.handle} in every conversation, from their next turns.`),
            failed,
          );
        },
      },
      h('span.track', { 'aria-hidden': 'true' }),
      h('span', name),
      h('span.dim.small', { 'aria-hidden': 'true' }, on ? 'On' : 'Off'),
    ),
    h('span.help', { id: helpId }, off),
  );
}
