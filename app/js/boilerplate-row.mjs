// Settings › Personas’ “Start from a boilerplate” row: one chip per boilerplate, built in or saved, in the New agent
// sheet’s order, so a fresh install finds Gemini and GPT without opening New agent first. A chip opens the sheet with
// that boilerplate chosen; one whose backend isn’t on this computer is disabled with its reason, as in the sheet.
// Blank has no chip: the New agent button beside the row starts on it.

import { boilerplateUnavailable } from '/shared/agent-facts.mjs';
import { client } from './client.mjs';
import { h } from './dom.mjs';

/**
 * The row. Settings stays open under the sheet, so focus comes back to the chip when the sheet closes (#26), and
 * closes once the agent is created, so its new conversation shows.
 * @param {{ openNewAgent: (o: any) => void, closeSettings: () => void }} sheets
 */
export function boilerplateRow({ openNewAgent, closeSettings }) {
  const bps = Object.values(client.state.boilerplates).filter((b) => b.id !== 'bp-blank');
  return h(
    'div.field',
    h('span.label', { id: 'bp-row-label' }, 'Start from a boilerplate'),
    h(
      'div.chips',
      { role: 'group', 'aria-labelledby': 'bp-row-label' },
      bps.map((b) => {
        const why = boilerplateUnavailable(b, client.config);
        return h(
          'button.chip',
          {
            type: 'button',
            id: `bp-row-${b.id}`,
            disabled: Boolean(why),
            title: why,
            onclick: () => openNewAgent({ boilerplateId: b.id, onCreated: closeSettings }),
          },
          why ? `${b.name} (${why})` : b.name,
        );
      }),
    ),
  );
}
