// A host’s short name, in its settings editor (app/js/hosts-editor.mjs): the badge the agents list shows for it in
// place of its SSH destination (shared/host-badge.mjs). Empty, the badge is made from the destination, and the field’s
// placeholder shows what that badge is.

import { badgeOf, checkShortName, SHORT_MAX } from '/shared/host-badge.mjs';
import { h } from './dom.mjs';
import { errEl } from './hosts-fields.mjs';
import { showError } from './hosts-parts.mjs';

/** @typedef {import('./hosts-fields.mjs').Ed} Ed */

/** The field, under the SSH destination. @param {Ed} ed */
export function shortField(ed) {
  const { p, d, fid } = ed;
  const id = fid('short');
  return h(
    'div.field',
    h('label.label', { for: id }, 'Short name'),
    h('input.input.mono', {
      id,
      value: d.short,
      placeholder: badgeOf({ name: d.name || ed.host.name }),
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-describedby': `${id}-help ${id}-err`,
      'aria-errormessage': `${id}-err`,
      'aria-invalid': p.errors.short ? 'true' : null,
      oninput: (e) => {
        d.short = e.target.value;
      },
      onchange: () => {
        const r = checkShortName(d.short);
        p.errors.short = r.ok ? '' : r.error;
        showError(document.getElementById(`${id}-err`), p.errors.short);
      },
    }),
    errEl(ed, 'short'),
    h('span.help', { id: `${id}-help` }, `Up to ${SHORT_MAX} characters, shown for this host in the agents list. Leave it empty to use the start of its name.`),
  );
}

/**
 * The short name to save: nothing when it didn’t change, else checked: { short }, or the error it’s refused with,
 * which goes under the field. @param {{ short: string }} d @param {any} host
 * @returns {{ patch: { short?: string }, error: string }}
 */
export function shortPatch(d, host) {
  // Unchanged, it isn’t checked or sent: one stored before #1052’s check refused hidden characters is kept (#1052).
  if (d.short.trim() === (host.short ?? '')) return { patch: {}, error: '' };
  const r = checkShortName(d.short);
  if (!r.ok) return { patch: {}, error: r.error };
  return { patch: { short: r.value }, error: '' };
}
