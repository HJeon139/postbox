// The fields of a host’s settings editor (app/js/hosts-editor.mjs), one kind each: a duration with its unit, a number,
// a checkbox, how turns detach, a command as an argument list, and a path on the host. Each field is checked as you
// leave it (hosts-settings.mjs, parse), and its error shows under it.

import { h, icon } from './dom.mjs';
import { checkField, showError } from './hosts-parts.mjs';
import { DETACH, parse, UNITS } from './hosts-settings.mjs';

/**
 * The editor a field is in: the panel, the host, the draft it edits, and its fields’ id for a setting.
 * @typedef {{ p: import('./hosts.mjs').Panel, host: any, d: import('./hosts.mjs').Draft, fid: (key: string) => string }} Ed
 * @typedef {import('./hosts-settings.mjs').Field} Field
 */

/** The error under a field, shown or hidden. @param {Ed} ed @param {string} key */
export const errEl = (ed, key) => h('span.err', { id: `${ed.fid(key)}-err`, hidden: !ed.p.errors[key] }, ed.p.errors[key] ?? '');

/** Checks one field as you leave it. @param {Ed} ed @param {Field} f */
const recheck = (ed, f) => {
  const r = parse(f, ed.d.v[f.key], ed.host.settings);
  ed.p.errors[f.key] = r.ok ? '' : r.error;
  showError(document.getElementById(`${ed.fid(f.key)}-err`), ed.p.errors[f.key]);
};

/** A setting’s field, by its kind. @param {Ed} ed @param {Field} f */
export function field(ed, f) {
  const cid = ed.fid(f.key);
  if (f.kind === 'check')
    return checkField({
      id: cid,
      label: f.label,
      help: f.help,
      on: ed.d.v[f.key] === true,
      onToggle: (on) => {
        ed.d.v[f.key] = on;
      },
    });
  if (f.kind === 'duration') return durationField(ed, f, cid);
  if (f.kind === 'number') return numberField(ed, f, cid);
  if (f.kind === 'detach') return detachField(ed, f, cid);
  if (f.kind === 'argv') return argvField(ed, f, cid);
  return pathField(ed, f, cid);
}

/** The attributes a text or number control shares: its help and error, and its value kept in the draft. @param {Ed} ed @param {Field} f @param {string} cid */
const control = (ed, f, cid) => ({
  'aria-errormessage': `${cid}-err`,
  'aria-invalid': ed.p.errors[f.key] ? 'true' : null,
  oninput: (/** @type {any} */ e) => {
    ed.d.v[f.key] = e.target.value;
  },
  onchange: () => recheck(ed, f),
});

/** A duration: a number, and its unit beside it. @param {Ed} ed @param {Field} f @param {string} cid */
function durationField(ed, f, cid) {
  const { d } = ed;
  return h(
    'div.field',
    h('label.label', { for: cid }, f.label),
    h(
      'div.row-flex',
      { style: { gap: '6px' } },
      h('input.input', {
        id: cid,
        type: 'number',
        min: '0',
        step: 'any',
        inputmode: 'decimal',
        value: d.v[f.key].n,
        style: { maxWidth: '120px' },
        'aria-describedby': `${cid}-help ${cid}-err`,
        ...control(ed, f, cid),
        oninput: (e) => {
          d.v[f.key] = { ...d.v[f.key], n: e.target.value };
        },
      }),
      h(
        'div.select-wrap',
        { style: { width: 'auto' } },
        h(
          'select.select',
          {
            id: `${cid}-unit`,
            'aria-label': `${f.label}, unit`,
            onchange: (e) => {
              d.v[f.key] = { ...d.v[f.key], unit: e.target.value };
              recheck(ed, f);
            },
          },
          UNITS.map(([u]) => h('option', { value: u, selected: d.v[f.key].unit === u }, u)),
        ),
        icon('down'),
      ),
    ),
    errEl(ed, f.key),
    h('span.help', { id: `${cid}-help` }, f.help),
  );
}

/** A number, in the unit its label names. @param {Ed} ed @param {Field} f @param {string} cid */
const numberField = (ed, f, cid) =>
  h(
    'div.field',
    h('label.label', { for: cid }, f.unit ? `${f.label} (${f.unit})` : f.label),
    h('input.input', {
      id: cid,
      type: 'number',
      min: '0',
      step: 'any',
      inputmode: 'decimal',
      value: ed.d.v[f.key],
      style: { maxWidth: '120px' },
      'aria-describedby': `${cid}-help ${cid}-err`,
      ...control(ed, f, cid),
    }),
    errEl(ed, f.key),
    h('span.help', { id: `${cid}-help` }, f.help),
  );

/** How turns detach: one of DETACH. @param {Ed} ed @param {Field} f @param {string} cid */
const detachField = (ed, f, cid) =>
  h(
    'div.field.span',
    h('label.label', { for: cid }, f.label),
    h(
      'div.select-wrap',
      h(
        'select.select',
        {
          id: cid,
          'aria-describedby': `${cid}-help`,
          onchange: (e) => {
            ed.d.v[f.key] = e.target.value;
          },
        },
        DETACH.map(([v, label]) => h('option', { value: v, selected: ed.d.v[f.key] === v }, label)),
      ),
      icon('down'),
    ),
    h('span.help', { id: `${cid}-help` }, f.help),
  );

/** A command as an argument list, one argument per line. @param {Ed} ed @param {Field} f @param {string} cid */
const argvField = (ed, f, cid) =>
  h(
    'div.field.span',
    h('label.label', { for: cid }, f.label),
    h('textarea.textarea.mono', {
      id: cid,
      rows: '3',
      spellcheck: 'false',
      placeholder: 'klist\n-s',
      value: ed.d.v[f.key],
      'aria-describedby': `${cid}-help ${cid}-err`,
      ...control(ed, f, cid),
    }),
    errEl(ed, f.key),
    h('span.help', { id: `${cid}-help` }, f.help),
  );

/** A path on the host, with the Programs group’s help. @param {Ed} ed @param {Field} f @param {string} cid */
const pathField = (ed, f, cid) =>
  h(
    'div.field.span',
    h('label.label', { for: cid }, f.label),
    h('input.input.mono', {
      id: cid,
      value: ed.d.v[f.key],
      placeholder: 'Found on the host',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-describedby': `ho-${ed.host.id}-programs-help ${cid}-err`,
      ...control(ed, f, cid),
    }),
    errEl(ed, f.key),
  );
