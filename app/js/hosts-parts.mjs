// Small parts the Hosts tab (app/js/hosts.mjs) builds from: a next step’s `commands` as code, each with a Copy
// button, a labeled checkbox, and a field’s error shown in place.

import { h, icon } from './dom.mjs';
import { say, toast } from './ui.mjs';

/** Text with `commands` in it, the commands as code. @param {string} text */
export const withCode = (text) =>
  String(text ?? '')
    .split('`')
    .map((part, i) => (i % 2 ? h('code', part) : part));
/** The `commands` in a next step, to copy. @param {string} text */
export const commandsIn = (text) =>
  String(text ?? '')
    .split('`')
    .filter((_, i) => i % 2)
    .filter(Boolean);

/** A button that copies a command, saying so. @param {string} text */
function copyButton(text) {
  const label = h('span', 'Copy');
  return h(
    'button.btn.sm',
    {
      type: 'button',
      'aria-label': `Copy ${text}`,
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          label.textContent = 'Copied';
          say(`Copied ${text}`);
        } catch {
          toast({ title: 'Couldn’t copy it', text: `Select the command and copy it: ${text}` });
        }
        setTimeout(() => {
          label.textContent = 'Copy';
        }, 2000);
      },
    },
    icon('copy', 'i-sm'),
    label,
  );
}

/** A command to run in a terminal, with its Copy button. @param {string} cmd */
export const command = (cmd) =>
  h(
    'div.row-flex.wrap.ho-cmd',
    { style: { gap: '8px' } },
    h('code', { style: { overflowWrap: 'anywhere', padding: '4px 8px', background: 'var(--sunk)', borderRadius: '4px' } }, cmd),
    copyButton(cmd),
  );

/** A labeled checkbox with help text under it, as the persona sheet’s (sheets.mjs). */
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

/** Shows or clears a field’s error in place, beside its control. @param {HTMLElement | null} err @param {string} text */
export function showError(err, text) {
  if (!err) return;
  err.textContent = text;
  err.hidden = !text;
  const control = document.querySelector(`[aria-errormessage="${err.id}"]`);
  if (text) control?.setAttribute('aria-invalid', 'true');
  else control?.removeAttribute('aria-invalid');
}
