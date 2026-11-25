// Settings › Personas: the list of personas, each with its host, what it does, its version and its Edit. Moved out of
// app/js/sheets.mjs, whose openSettings calls it with what Edit does.

import { hostMarker, mockMarker } from './agent-facts.mjs';
import { h } from './dom.mjs';

/** @param {any[]} list  the personas @param {(persona: any) => void} edit  opens one’s form */
export const personaRows = (list, edit) =>
  h(
    'ul.list-rows',
    list.map((p) =>
      h(
        'li.persona-row',
        h('b', p.handle),
        mockMarker(p),
        h('span.small.dim.grow', p.retired ? 'Retired' : p.description),
        hostMarker(p),
        h('span.small.dim', `v${p.version ?? 1}`),
        h('button.btn.sm', { type: 'button', id: `pe-edit-${p.id}`, 'aria-label': `Edit ${p.handle}`, onclick: () => edit(p) }, 'Edit'),
      ),
    ),
  );
