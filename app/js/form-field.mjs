// One field of a form block: its label, its control, its help and its error. The form (blocks.mjs) keeps the
// draft and the submit; a field reads its value from the draft, or from the answer once it’s sent.

import { numberRange } from '/shared/number-range.mjs';
import { h, icon } from './dom.mjs';

/**
 * @typedef {{ id: string, label: string, kind: string, required?: boolean, help?: string, placeholder?: string,
 *   min?: number, max?: number, maxLength?: number, options?: { id: string, label: string, description?: string }[] }} Field
 * @typedef {{ values: Record<string, unknown>, errors: Record<string, string> }} Draft
 * @typedef {{ itemId: string, vals: Record<string, unknown>, d: Draft, done: boolean, rerender: () => void }} FieldContext
 */

const charCount = (f, text) => `${text.length.toLocaleString('en-US')} / ${(f.maxLength ?? 20000).toLocaleString('en-US')}`;

/** @param {Field} f @param {FieldContext} at @param {string} id */
function toggle(f, { vals, d, done, rerender }, id) {
  const on = !!vals[f.id];
  return h(
    'button.toggle',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': String(on),
      disabled: done,
      id,
      onclick: () => {
        d.values[f.id] = !on;
        rerender();
      },
    },
    h('span.track'),
    f.label,
  );
}

/** @param {Field} f @param {Draft} d @param {Record<string, unknown>} common @param {unknown} v */
function select(f, d, common, v) {
  return h(
    'div.select-wrap',
    h(
      'select.select',
      {
        ...common,
        onchange: (e) => {
          d.values[f.id] = e.target.value;
        },
      },
      h('option', { value: '' }, 'Choose…'),
      f.options.map((o) => h('option', { value: o.id, selected: v === o.id }, o.description ? `${o.label} — ${o.description}` : o.label)),
    ),
    icon('down'),
  );
}

/** @param {Field} f @param {Draft} d @param {Record<string, unknown>} common @param {unknown} v @param {HTMLElement} counter */
function longtext(f, d, common, v, counter) {
  return h(
    'textarea.textarea',
    {
      ...common,
      class: common['aria-invalid'] ? 'invalid' : '',
      placeholder: f.placeholder ?? '',
      maxlength: f.maxLength ?? null,
      oninput: (e) => {
        d.values[f.id] = e.target.value;
        counter.textContent = charCount(f, e.target.value);
      },
    },
    String(v),
  );
}

/** Text, number and date fields. @param {Field} f @param {Draft} d @param {Record<string, unknown>} common @param {unknown} v */
function input(f, d, common, v) {
  return h('input.input', {
    ...common,
    class: common['aria-invalid'] ? 'invalid' : '',
    value: String(v),
    type: f.kind === 'date' ? 'date' : 'text',
    inputmode: f.kind === 'number' ? 'decimal' : null,
    placeholder: f.placeholder ?? '',
    oninput: (e) => {
      d.values[f.id] = e.target.value;
    },
  });
}

/** @param {Field} f @param {FieldContext} at */
export function formField(f, at) {
  const id = `${at.itemId}-${f.id}`;
  const errId = `${id}-err`;
  const err = at.d.errors[f.id];
  // A number field’s range shows before any submit, in the words its error uses (#822).
  const range = f.kind === 'number' ? numberRange(f).hint : '';
  const common = {
    id,
    disabled: at.done,
    'aria-invalid': err ? 'true' : null,
    'aria-describedby': [err ? errId : null, range ? `${id}-range` : null, f.help ? `${id}-help` : null].filter(Boolean).join(' ') || null,
    required: !!f.required,
  };
  const v = at.vals[f.id] ?? '';
  const counter = f.kind === 'longtext' ? h('span.small.dim', { style: { marginLeft: 'auto' } }, charCount(f, String(v))) : null;
  let control;
  if (f.kind === 'toggle') control = toggle(f, at, id);
  else if (f.kind === 'select') control = select(f, at.d, common, v);
  else if (counter) control = longtext(f, at.d, common, v, counter);
  else control = input(f, at.d, common, v);
  return h(
    'div.field',
    { class: f.kind === 'longtext' || f.kind === 'toggle' ? 'span' : '' },
    f.kind === 'toggle' ? null : h('label.label', { for: id }, f.label, f.required ? ' *' : ''),
    control,
    range ? h('span.help', { id: `${id}-range` }, range) : null,
    f.help ? h('span.help', { id: `${id}-help` }, f.help) : null,
    err ? h('span.err', { id: errId }, icon('warn'), err) : null,
    counter,
  );
}
