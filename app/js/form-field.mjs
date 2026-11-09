// One field of a form block: its label, its control, its help and its error. The form (blocks.mjs) keeps the
// draft and the submit; a field reads its value from the draft, or from the answer once it’s sent.

import { h, icon } from './dom.mjs';

/** Appends each of a form's fields to its grid. */
export function formFields(b, item, grid, { vals, d, done, rerender }) {
  for (const f of b.fields) {
    const id = `${item.id}-${f.id}`;
    const errId = `${id}-err`;
    const err = d.errors[f.id];
    const common = {
      id,
      disabled: done,
      'aria-invalid': err ? 'true' : null,
      'aria-describedby': [err ? errId : null, f.help ? `${id}-help` : null].filter(Boolean).join(' ') || null,
      required: !!f.required,
    };
    let control;
    const v = vals[f.id] ?? '';
    if (f.kind === 'toggle') {
      const on = !!vals[f.id];
      control = h(
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
    } else if (f.kind === 'select') {
      control = h(
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
    } else if (f.kind === 'longtext') {
      control = h(
        'textarea.textarea',
        {
          ...common,
          class: err ? 'invalid' : '',
          placeholder: f.placeholder ?? '',
          maxlength: f.maxLength ?? null,
          oninput: (e) => {
            d.values[f.id] = e.target.value;
            counter.textContent = `${e.target.value.length.toLocaleString('en-US')} / ${(f.maxLength ?? 20000).toLocaleString('en-US')}`;
          },
        },
        String(v),
      );
    } else {
      control = h('input.input', {
        ...common,
        class: err ? 'invalid' : '',
        value: String(v),
        type: f.kind === 'number' ? 'text' : f.kind === 'date' ? 'date' : 'text',
        inputmode: f.kind === 'number' ? 'decimal' : null,
        placeholder: f.placeholder ?? '',
        oninput: (e) => {
          d.values[f.id] = e.target.value;
        },
      });
    }
    const counter =
      f.kind === 'longtext'
        ? h(
            'span.small.dim',
            { style: { marginLeft: 'auto' } },
            `${String(v).length.toLocaleString('en-US')} / ${(f.maxLength ?? 20000).toLocaleString('en-US')}`,
          )
        : null;
    grid.append(
      h(
        'div.field',
        { class: f.kind === 'longtext' || f.kind === 'toggle' ? 'span' : '' },
        f.kind === 'toggle' ? null : h('label.label', { for: id }, f.label, f.required ? ' *' : ''),
        control,
        f.help ? h('span.help', { id: `${id}-help` }, f.help) : null,
        err ? h('span.err', { id: errId }, icon('warn'), err) : null,
        counter,
      ),
    );
  }
}
