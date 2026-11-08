// A labeled checkbox with help under it, for the switches in the new agent and persona sheets (app/js/sheets.mjs).

import { h } from './dom.mjs';

/**
 * A labeled checkbox with help text under it, in the sheet’s .check style. Space or Enter toggles it.
 * @param {{ id: string, label: string, help: string, on: boolean, onToggle: (on: boolean) => void }} opts
 */
export function checkField({ id, label, help, on, onToggle }) {
  return h(
    'div.field.span',
    h(
      'span.check',
      {
        id,
        role: 'checkbox',
        tabindex: '0',
        'aria-checked': String(on),
        'aria-describedby': `${id}-help`,
        style: { alignSelf: 'flex-start' },
        onclick: (e) => {
          on = !on;
          e.currentTarget.setAttribute('aria-checked', String(on));
          onToggle(on);
        },
        onkeydown: (e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.click();
          }
        },
      },
      h('span.box'),
      h('span', label),
    ),
    h('span.help', { id: `${id}-help` }, help),
  );
}
