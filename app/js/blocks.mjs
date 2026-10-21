// Catalog block renderers. Each takes a validated block and builds it with Postbox’s own DOM code, so
// nothing an agent sends becomes markup, a style or an attribute name. Answered blocks turn read-only
// and show what you chose. Drafts (selections, typed text, review comments) survive re-renders.

import { renderMarkdown } from '/shared/markdown.mjs';
import { mountApp } from './apps.mjs';
import { client } from './client.mjs';
import { h, icon, plural, timeOf, trusted } from './dom.mjs';

const drafts = new Map(); // item id → local, unsent input
const draft = (id, init) => {
  if (!drafts.has(id)) drafts.set(id, init());
  return drafts.get(id);
};
const md = (src, cls = '') => h(`div.md${cls}`, { html: trusted(renderMarkdown(src)) });
const KIND = {
  choice: 'Choice',
  form: 'Form',
  table: 'Table',
  progress: 'Progress',
  card: 'Card',
  confirm: 'Confirm',
  image: 'Image',
  code: 'Code',
  review: 'Review',
  app: 'App',
};

/**
 * @param {object} item  a transcript item of kind "block"
 * @param {{ act(action, values): Promise<any>, threadId: string }} ctx
 */
export function renderBlock(item, ctx) {
  if (!item.valid) return invalidBlock(item);
  const b = item.block;
  const r = RENDER[b.type];
  const node = r(b, item, ctx);
  node.classList.add('block');
  node.setAttribute('role', 'group');
  node.dataset.blockItem = item.id;
  return node;
}

function head(b, extra = [], kind = KIND[b.type]) {
  const id = `bt-${b.id}-${Math.random().toString(36).slice(2, 6)}`;
  return [h('div.block-head', h('span.title.grow', { id }, b.title ?? KIND[b.type]), h('span.kind', kind), ...extra), id];
}
const answeredNote = (item) =>
  h('span.answered-note', icon('check', 'i-sm'), `Answered at ${timeOf(item.answer.at)} · only a new block, or an update to it, can ask again`);
const errLine = (msg) => (msg ? h('span.err', { role: 'alert' }, icon('warn'), msg) : null);

async function submit(item, ctx, action, values, setError) {
  setError(null);
  try {
    await ctx.act(action, values);
    drafts.delete(item.id);
  } catch (e) {
    setError(e.message, e.fieldErrors);
  }
}

// ── Invalid blocks: fallback text plus the raw block ─────────────────────────────────────

function invalidBlock(item) {
  const raw = JSON.stringify(item.raw, null, 2) ?? String(item.raw);
  const why =
    item.reason === 'unknown-type'
      ? 'The block asked for a component this app’s catalog doesn’t have.'
      : item.reason === 'newer-version'
        ? 'The block is a newer version than this app reads.'
        : 'The block had a problem, so it isn’t shown.';
  return h(
    'div.block',
    { role: 'group' },
    h('div.block-head', icon('warn', ''), h('span.title.grow', item.raw?.title ?? 'A block'), h('span.kind', 'Can’t show this block')),
    h(
      'div.block-body',
      md(item.fallback),
      h('p.small.dim', `This is the agent’s plain-text version. ${why} ${item.errors.join(' ')}`),
      h('details.raw', h('summary', 'Show the raw block'), h('pre.mono', raw.slice(0, 20000))),
    ),
  );
}

// ── Components ──────────────────────────────────────────────────────────────────────────

const RENDER = {
  choice(b, item, ctx) {
    const d = draft(item.id, () => ({ selected: [], other: '', otherOn: false, error: null }));
    const done = item.answered;
    const chosen = done ? new Set(item.answer.values.selected) : new Set(d.selected);
    const [hd, titleId] = head(b, [], b.multiple ? 'Choice · several' : 'Choice');
    const node = h('div', { class: done ? 'answered' : '', 'aria-labelledby': titleId });
    const set = (fn) => {
      fn();
      rerender();
    };
    // A pick re-renders the block; focus goes back to the same option so the keyboard keeps its place.
    const rerender = () => {
      const n = node.contains(document.activeElement) ? document.activeElement.dataset.n : null;
      const next = renderBlock(item, ctx);
      node.replaceWith(next);
      if (n) next.querySelector(`.chip[data-n="${n}"]`)?.focus();
    };
    const chips = h('div.chips', { role: b.multiple ? 'group' : 'radiogroup', 'aria-labelledby': titleId });
    const opts = [...b.options, ...(b.other ? [{ id: '__other', label: b.other.label }] : [])];
    opts.forEach((o, i) => {
      const on = o.id === '__other' ? (done ? !!item.answer.values.other : d.otherOn) : chosen.has(o.id);
      chips.append(
        h(
          'button.chip',
          {
            type: 'button',
            disabled: done,
            class: on ? 'on' : '',
            role: b.multiple ? null : 'radio',
            'aria-checked': b.multiple ? null : String(on),
            'aria-pressed': b.multiple ? String(on) : null,
            dataset: { n: String(i + 1) },
            onclick: () =>
              set(() => {
                if (o.id === '__other') {
                  d.otherOn = !d.otherOn;
                  if (!b.multiple && d.otherOn) d.selected = [];
                  return;
                }
                if (b.multiple) d.selected = on ? d.selected.filter((x) => x !== o.id) : [...d.selected, o.id];
                else {
                  d.selected = [o.id];
                  d.otherOn = false;
                }
              }),
          },
          on ? icon('check') : null,
          o.label,
        ),
      );
    });
    const body = h('div.block-body', b.prompt ? md(b.prompt) : null, chips);
    if (b.other && (done ? item.answer.values.other : d.otherOn)) {
      const fid = `${item.id}-other`;
      body.append(
        h(
          'div.field',
          h('label.label', { for: fid }, b.other.label),
          h('input.input', {
            id: fid,
            value: done ? item.answer.values.other : d.other,
            placeholder: b.other.placeholder ?? '',
            disabled: done,
            oninput: (e) => {
              d.other = e.target.value;
            },
          }),
        ),
      );
    }
    if (done) body.append(answeredNote(item));
    node.append(hd, body);
    if (!done) {
      const n = d.selected.length + (d.otherOn && d.other.trim() ? 1 : d.otherOn ? 1 : 0);
      const label = b.submitLabel ?? (b.multiple ? (n ? `Send ${plural(n, 'choice')}` : 'Send choices') : 'Send choice');
      const err = h('span');
      const setError = (m) => {
        d.error = m;
        err.replaceChildren(errLine(m) ?? '');
      };
      setError(d.error);
      node.append(
        h(
          'div.block-foot',
          h(
            'button.btn.send',
            { type: 'button', onclick: () => submit(item, ctx, 'choose', { selected: d.selected, ...(d.otherOn ? { other: d.other } : {}) }, setError) },
            label,
          ),
          !b.multiple ? h('span.small.dim', `or press 1–${Math.min(9, opts.length)}`) : null,
          err,
        ),
      );
      chips.addEventListener('keydown', (e) => {
        const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!dir) return;
        const all = [...chips.querySelectorAll('.chip')];
        const i = all.indexOf(document.activeElement);
        if (i < 0) return;
        e.preventDefault();
        all[(i + dir + all.length) % all.length].focus();
      });
      node.addEventListener('keydown', (e) => {
        if (b.multiple || e.target.matches('input, textarea') || !/^[1-9]$/.test(e.key)) return;
        const btn = chips.querySelector(`[data-n="${e.key}"]`);
        if (btn) {
          e.preventDefault();
          btn.click();
        }
      });
    }
    return node;
  },

  form(b, item, ctx) {
    const d = draft(item.id, () => ({
      values: Object.fromEntries(b.fields.map((f) => [f.id, f.default ?? (f.kind === 'toggle' ? false : '')])),
      errors: {},
      error: null,
    }));
    const done = item.answered;
    const vals = done ? item.answer.values : d.values;
    const [hd, titleId] = head(b);
    const grid = h('div.form-grid');
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
            f.options.map((o) => h('option', { value: o.id, selected: v === o.id }, o.label)),
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
    const node = h(
      'div',
      { class: done ? 'answered' : '', 'aria-labelledby': titleId },
      hd,
      h('div.block-body', b.prompt ? md(b.prompt) : null, grid, done ? answeredNote(item) : null),
    );
    // submit() clears the error (one re-render) before it sets the new one, so replace the copy on screen now.
    const rerender = () => {
      const live = node.isConnected ? node : document.querySelector(`[data-block-item="${CSS.escape(item.id)}"]`);
      live?.replaceWith(renderBlock(item, ctx));
    };
    if (!done) {
      const setError = (m, fieldErrors) => {
        d.error = m;
        d.errors = fieldErrors ?? {};
        rerender();
        const first = Object.keys(d.errors)[0];
        if (first) document.getElementById(`${item.id}-${first}`)?.focus();
      };
      node.append(
        h(
          'div.block-foot',
          h('button.btn.send', { type: 'button', onclick: () => submit(item, ctx, 'submit', { ...d.values }, setError) }, b.submitLabel ?? 'Send form'),
          errLine(d.error),
        ),
      );
    }
    return node;
  },

  table(b, item, ctx) {
    const d = draft(item.id, () => ({ sort: null, dir: 1, expanded: false }));
    const [hd, titleId] = head(b, [
      h('span.small.dim', plural(b.rows.length, 'row')),
      h(
        'button.btn.icon.sm',
        {
          type: 'button',
          'aria-label': d.expanded ? 'Collapse table' : 'Expand table',
          'aria-pressed': String(d.expanded),
          onclick: () => {
            d.expanded = !d.expanded;
            node.replaceWith(renderBlock(item, ctx));
          },
        },
        icon('expand'),
      ),
    ]);
    let rows = b.rows;
    if (d.sort) {
      const col = b.columns.find((c) => c.id === d.sort);
      rows = [...rows].sort((x, y) => {
        const a = x.cells[d.sort],
          c = y.cells[d.sort];
        return (col.kind === 'number' ? (+a || 0) - (+c || 0) : String(a ?? '').localeCompare(String(c ?? ''))) * d.dir;
      });
    }
    const status = h('span.sr-only', { role: 'status' });
    const th = (c) => {
      const sortBtn = h(
        'button',
        {
          type: 'button',
          onclick: () => {
            d.dir = d.sort === c.id ? -d.dir : 1;
            d.sort = c.id;
            const n = renderBlock(item, ctx);
            node.replaceWith(n);
            n.querySelector('th[aria-sort] button')?.focus();
          },
        },
        c.label,
        icon(d.sort === c.id ? 'sortdown' : 'sort', 'i-sm'),
      );
      const label = c.sortable === false ? h('span', { style: { padding: '8px 12px', display: 'block' } }, c.label) : sortBtn;
      return h('th', { class: c.kind === 'number' ? 'num' : '', 'aria-sort': d.sort === c.id ? (d.dir > 0 ? 'ascending' : 'descending') : null }, label);
    };
    const tr = (r) => {
      const cells = b.columns.map((c) => h('td', { class: c.kind === 'number' ? 'num' : '' }, fmtCell(r.cells[c.id], c)));
      const actionCell = b.rowAction
        ? h(
            'td.act',
            h(
              'button.btn.sm.ghost',
              {
                type: 'button',
                onclick: () =>
                  ctx.act(b.rowAction.id, { rowId: r.id }).catch((e) => {
                    status.textContent = e.message;
                  }),
              },
              b.rowAction.label,
            ),
          )
        : null;
      return h('tr', cells, actionCell);
    };
    const table = h(
      'table.tbl',
      { 'aria-labelledby': titleId },
      h('thead', h('tr', b.columns.map(th), b.rowAction ? h('th', h('span.sr-only', 'Action')) : null)),
      h('tbody', rows.map(tr)),
    );
    const wrap = h(
      'div.tbl-wrap',
      { tabindex: '0', role: 'region', 'aria-label': `${b.title ?? 'Table'}, scrolls`, style: d.expanded ? { maxHeight: 'none' } : {} },
      table,
    );
    const node = h('div', { 'aria-labelledby': titleId }, hd, wrap, status);
    return node;
  },

  progress(b, _item) {
    const done = b.steps.filter((s) => s.state === 'done').length;
    const [hd, titleId] = head(b, [h('span.small.dim', `${done} of ${b.steps.length}`)]);
    const glyph = { done: 'g-done', running: 'g-running', pending: 'g-pending', failed: 'g-failed' };
    return h(
      'div',
      { 'aria-labelledby': titleId },
      hd,
      h(
        'div.block-body',
        h(
          'ol.progress',
          b.steps.map((s) =>
            h(
              'li',
              { dataset: { s: s.state } },
              h(`span.g.${glyph[s.state]}`, { role: 'img', 'aria-label': s.state[0].toUpperCase() + s.state.slice(1) }),
              h('span.t', s.label, s.detail ? (s.state === 'failed' ? h('span.err', s.detail) : h('span.dim.small', ` · ${s.detail}`)) : null),
              h('span.small.dim', s.duration ?? ''),
            ),
          ),
        ),
      ),
    );
  },

  card(b, _item, ctx) {
    const [hd, titleId] = head(b);
    const status = h('span');
    return h(
      'div',
      { 'aria-labelledby': titleId },
      hd,
      h(
        'div.block-body',
        b.body ? md(b.body) : null,
        b.facts?.length
          ? h(
              'dl.facts',
              b.facts.map((f) => [h('dt', f.label), h('dd', fmtCell(f.value))]),
            )
          : null,
      ),
      b.actions?.length
        ? h(
            'div.block-foot',
            b.actions.map((a) =>
              h('button.btn', { type: 'button', onclick: () => ctx.act(a.id, {}).catch((e) => status.replaceChildren(errLine(e.message))) }, a.label),
            ),
            status,
          )
        : null,
    );
  },

  confirm(b, item, ctx) {
    const done = item.answered;
    const [hd, titleId] = head(b);
    const err = h('span');
    const setError = (m) => err.replaceChildren(errLine(m) ?? '');
    const node = h(
      'div',
      { class: done ? 'answered' : '', 'aria-labelledby': titleId, style: done ? {} : { borderColor: 'var(--accent)' } },
      h(
        'div.block-head',
        done ? null : h('span.g.g-needs', { 'aria-hidden': 'true' }),
        h('span.title.grow', { id: titleId }, b.title ?? 'Confirm'),
        h('span.kind', 'Confirm'),
      ),
      h(
        'div.block-body',
        md(b.statement),
        done
          ? h(
              'span.answered-note',
              icon('check', 'i-sm'),
              item.answer.action === 'confirm' ? `Confirmed at ${timeOf(item.answer.at)}` : `Not confirmed · ${timeOf(item.answer.at)}`,
            )
          : null,
      ),
    );
    hd.remove();
    if (!done)
      node.append(
        h(
          'div.block-foot',
          h('button.btn', { type: 'button', onclick: () => submit(item, ctx, 'confirm', {}, setError) }, b.confirmLabel),
          h('button.btn', { type: 'button', onclick: () => submit(item, ctx, 'cancel', {}, setError) }, b.cancelLabel ?? 'Cancel'),
          err,
        ),
      );
    return node;
  },

  image(b) {
    const [hd, titleId] = head(b);
    return h(
      'div.img-block',
      { 'aria-labelledby': titleId },
      hd,
      h(
        'div.block-body',
        h(
          'figure',
          h('img', { src: b.src, alt: b.alt, width: b.width ?? null, height: b.height ?? null, loading: 'lazy', referrerpolicy: 'no-referrer' }),
          h('figcaption', b.caption ? `${b.caption} · ` : '', `From ${new URL(b.src).host}`),
        ),
      ),
    );
  },

  code(b) {
    const status = h('span.small.dim', { role: 'status' });
    const [hd, titleId] = head(
      b,
      [
        h(
          'button.btn.sm',
          {
            type: 'button',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(b.code);
                status.textContent = 'Copied';
              } catch {
                status.textContent = 'Couldn’t copy. Select the text instead.';
              }
              setTimeout(() => {
                status.textContent = '';
              }, 2000);
            },
          },
          icon('copy', 'i-sm'),
          'Copy',
        ),
        status,
      ],
      b.language ? `Code · ${b.language}` : 'Code',
    );
    const lines = b.code.split('\n');
    return h(
      'div',
      { 'aria-labelledby': titleId },
      hd,
      h(
        'div.code',
        h(
          'pre.mono',
          { tabindex: '0', 'aria-label': `${b.filename ?? 'Code'}, ${plural(lines.length, 'line')}` },
          lines.map((l, i) => [h('span.ln', { 'aria-hidden': 'true' }, String(i + 1)), l, i < lines.length - 1 ? '\n' : '']),
        ),
      ),
    );
  },

  review: renderReview,
  app(_b) {
    return h('div', h('div.block-body', h('p.dim', 'Apps appear in their own frame.')));
  },
};

function fmtCell(v, _col) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v.toLocaleString('en-US');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

// ── Review ──────────────────────────────────────────────────────────────────────────────
// Markdown and code are commented line by line; apps by the anchors they register. Comments stay
// drafts until you submit them all with a verdict. A revision shows as a diff, with each of your
// comments marked resolved or open.

function renderReview(b, item, ctx) {
  const d = draft(item.id, () => ({ comments: [], composing: null, verdict: 'request_changes', view: 'diff', error: null }));
  const rerender = () => {
    const n = renderBlock(item, ctx);
    node.replaceWith(n);
    return n;
  };
  const done = item.answered;
  const isDiff = !!b.previous && d.view === 'diff';
  const viewSeg = b.previous
    ? h(
        'span.seg',
        { role: 'radiogroup', 'aria-label': 'View' },
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(isDiff),
            onclick: () => {
              d.view = 'diff';
              rerender();
            },
          },
          `Diff v${(b.revision ?? 2) - 1} → v${b.revision ?? 2}`,
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(!isDiff),
            onclick: () => {
              d.view = 'plain';
              rerender();
            },
          },
          `v${b.revision ?? 2}`,
        ),
      )
    : h('span.small.dim', `v${b.revision ?? 1}`);
  const [hd, titleId] = head(b, [viewSeg], `Review · ${{ markdown: 'Markdown', code: 'Code', app: 'App' }[b.format]}`);
  hd.querySelector('.title').classList.add('mono');
  hd.querySelector('.title').style.fontSize = '13px';
  const node = h('div', { 'aria-labelledby': titleId }, hd);

  const threadsAt = (key) => (b.threads ?? []).filter((t) => (b.format === 'app' ? t.anchor === key : t.line === key));
  const draftsAt = (key) => d.comments.filter((c) => (b.format === 'app' ? c.anchor === key : c.line === key));
  const threadBox = (key) => {
    const parts = [];
    for (const t of threadsAt(key))
      parts.push(
        h(
          'div.rv-thread',
          { class: t.status === 'resolved' ? 'resolved' : '' },
          t.comments.map((c, i) =>
            h(
              'div.c',
              h(
                'span.meta',
                h('b', c.author),
                i === 0
                  ? h(
                      'span.status-tag',
                      { class: t.status === 'resolved' ? 'ok' : 'open' },
                      t.status === 'resolved' ? [icon('check', 'i-sm'), 'Resolved'] : 'Open',
                    )
                  : null,
              ),
              h('div', { html: trusted(renderMarkdown(c.text)) }),
            ),
          ),
        ),
      );
    for (const c of draftsAt(key))
      parts.push(
        h(
          'div.rv-thread',
          h(
            'div.c',
            h(
              'span.meta',
              h('b', 'You'),
              h('span.status-tag.draft', 'Draft'),
              done
                ? null
                : h(
                    'button.btn.sm.ghost',
                    {
                      type: 'button',
                      style: { marginLeft: 'auto' },
                      onclick: () => {
                        d.comments = d.comments.filter((x) => x !== c);
                        rerender();
                      },
                    },
                    'Delete',
                  ),
            ),
            h('div', c.text),
          ),
        ),
      );
    if (!done && d.composing === key) {
      const ta = h('textarea.textarea', {
        'aria-label': b.format === 'app' ? `Comment on ${key}` : `Comment on line ${key}`,
        style: { minHeight: '56px' },
        onkeydown: (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            add();
          }
          if (e.key === 'Escape') {
            d.composing = null;
            rerender();
          }
        },
      });
      const add = () => {
        const text = ta.value.trim();
        if (!text) return;
        d.comments.push(b.format === 'app' ? { anchor: key, text } : { line: key, text });
        d.composing = null;
        rerender();
      };
      parts.push(
        h(
          'div.rv-thread',
          h(
            'div.reply',
            { style: { flexDirection: 'column' } },
            ta,
            h(
              'div.row-flex',
              h('button.btn.sm.send', { type: 'button', onclick: add }, 'Add draft comment'),
              h(
                'button.btn.sm.ghost',
                {
                  type: 'button',
                  onclick: () => {
                    d.composing = null;
                    rerender();
                  },
                },
                'Cancel',
              ),
              h('span.small.dim', 'Ctrl+Enter adds it'),
            ),
          ),
        ),
      );
      queueMicrotask(() => ta.focus());
    }
    return parts;
  };

  if (b.format === 'app') {
    const appEl = h('div');
    const pins = h('div.rv-pins');
    const anchors = new Set(
      [...(b.threads ?? []).map((t) => t.anchor), ...d.comments.map((c) => c.anchor), ...(d.composing ? [d.composing] : [])].filter(Boolean),
    );
    for (const a of anchors) pins.append(h('div', h('span.small.dim', 'On ', h('b', a)), threadBox(a)));
    if (!anchors.size) pins.append(h('p.small.dim', done ? 'No comments.' : 'Click a highlighted part of the app to comment on it.'));
    mountApp(appEl, b.appId, {
      review: !done,
      onPin: (anchor) => {
        if (!done) {
          d.composing = anchor;
          rerender();
        }
      },
    });
    node.append(h('div.app-review-wrap', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } }, appEl, pins));
  } else {
    const lines = (b.content ?? '').split('\n');
    const doc = h('div.rv-doc', { class: b.format === 'code' ? 'code-doc code' : '', role: 'list', 'aria-label': 'Lines' });
    const rows = isDiff ? diffLines(b.previous.split('\n'), lines) : lines.map((t, i) => ({ t, kind: 'same', n: i + 1 }));
    for (const r of rows) {
      const key = r.kind === 'del' ? null : r.n;
      const marked = key !== null && (threadsAt(key).length || draftsAt(key).length);
      const heading = b.format === 'markdown' && /^#{1,6}\s/.test(r.t);
      const text = b.format === 'markdown' ? r.t.replace(/^#{1,6}\s+/, '') : r.t;
      doc.append(
        h(
          'div.rv-line',
          { class: [r.kind === 'add' ? 'add' : r.kind === 'del' ? 'del' : '', marked ? 'marked' : '', heading ? 'h' : ''].join(' '), role: 'listitem' },
          h(
            'span.g-ln',
            { 'aria-label': r.kind === 'del' ? `Removed line ${r.o}` : `Line ${r.n}` },
            !done && key !== null
              ? h(
                  'button.add-c',
                  {
                    type: 'button',
                    'aria-label': `Comment on line ${key}`,
                    onclick: () => {
                      d.composing = key;
                      rerender();
                    },
                  },
                  icon('plus', 'i-sm'),
                )
              : null,
            String(r.kind === 'del' ? r.o : r.n),
          ),
          h('span.tx', b.format === 'markdown' ? { html: trusted(inlineMd(text)) } : null, b.format === 'markdown' ? null : text || ' '),
        ),
      );
      if (key !== null) for (const p of threadBox(key)) doc.append(p);
    }
    node.append(doc);
  }

  if (done) {
    node.append(h('div.block-foot', h('span.answered-note', icon('check', 'i-sm'), `${item.answer.voice} · ${timeOf(item.answer.at)}`)));
  } else {
    const resolved = (b.threads ?? []).filter((t) => t.status === 'resolved').length;
    const verdicts = [
      ['comment', 'Comment'],
      ['approve', 'Approve'],
      ['request_changes', 'Request changes'],
    ];
    const err = h('span');
    const setError = (m) => {
      d.error = m;
      err.replaceChildren(errLine(m) ?? '');
    };
    setError(d.error);
    node.append(
      h(
        'div.block-foot.review-bar',
        h(
          'span.small',
          b.threads?.length ? h('b', `${resolved} of ${b.threads.length} resolved`) : null,
          b.threads?.length && d.comments.length ? ' · ' : '',
          d.comments.length ? h('b', plural(d.comments.length, 'draft comment')) : b.threads?.length ? '' : h('span.dim', 'No comments yet'),
        ),
        h('span.grow'),
        h(
          'span.seg',
          { role: 'radiogroup', 'aria-label': 'Verdict' },
          verdicts.map(([v, l]) =>
            h(
              'button',
              {
                type: 'button',
                role: 'radio',
                'aria-checked': String(d.verdict === v),
                onclick: () => {
                  d.verdict = v;
                  rerender();
                },
              },
              l,
            ),
          ),
        ),
        h(
          'button.btn.send',
          { type: 'button', onclick: () => submit(item, ctx, 'submit', { verdict: d.verdict, comments: d.comments }, setError) },
          'Submit review',
        ),
        err,
      ),
    );
  }
  return node;
}

/** Bold, italic and code inside a review line, without block structure. */
function inlineMd(t) {
  return renderMarkdown(t || ' ')
    .replace(/^<p>|<\/p>$/g, '')
    .replace(/^<h\d>|<\/h\d>$/g, '');
}

/** A line diff (longest common subsequence), good enough for documents up to a few thousand lines. */
export function diffLines(a, b) {
  const n = a.length,
    m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: b[j], kind: 'same', n: j + 1, o: i + 1 });
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      out.push({ t: a[i], kind: 'del', o: i + 1 });
      i++;
    } else {
      out.push({ t: b[j], kind: 'add', n: j + 1 });
      j++;
    }
  }
  while (i < n) {
    out.push({ t: a[i], kind: 'del', o: i + 1 });
    i++;
  }
  while (j < m) {
    out.push({ t: b[j], kind: 'add', n: j + 1 });
    j++;
  }
  // Group each run of removals before its additions, the way people read a diff.
  return out;
}

export { drafts };
export const hasDraft = (id) => drafts.has(id);
export const clientState = () => client.state;
