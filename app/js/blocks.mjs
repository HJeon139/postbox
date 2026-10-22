// Catalog block renderers. Each takes a validated block and builds it with Postbox’s own DOM code, so
// nothing an agent sends becomes markup, a style or an attribute name. Answered blocks turn read-only
// and show what you chose. Drafts (selections, typed text, review comments) survive re-renders.

import { LIST_ITEM, renderMarkdown, toPlainText } from '/shared/markdown.mjs';
import { groupReviewLines, rowUnit } from '/shared/review-lines.mjs';
import { formatDuration } from '/shared/text.mjs';
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

  progress(b, item) {
    const done = b.steps.filter((s) => s.state === 'done').length;
    const updated = h('span.small.dim', { dataset: { since: String(item.updatedAt ?? item.at), sinceKind: 'updated' } });
    const [hd, titleId] = head(b, [h('span.small.dim', `${done} of ${b.steps.length}`), updated]);
    const glyph = { done: 'g-done', running: 'g-running', pending: 'g-pending', failed: 'g-failed', stalled: 'g-stalled' };
    const node = h(
      'div',
      { 'aria-labelledby': titleId, dataset: { progress: item.sessionId ?? '', updatedAt: String(item.updatedAt ?? item.at) } },
      hd,
      h(
        'div.block-body',
        h(
          'ol.progress',
          b.steps.map((s) => {
            // How far along: “2 of 4 papers”, or a percent, with a thin bar.
            const pct = s.progress ? (s.progress.done / s.progress.total) * 100 : s.percent;
            const count = s.progress
              ? `${s.progress.done.toLocaleString('en-US')} of ${s.progress.total.toLocaleString('en-US')}${s.progress.unit ? ` ${s.progress.unit}` : ''}`
              : typeof s.percent === 'number'
                ? `${s.percent}%`
                : null;
            const started = item.stepTimes?.[s.id]?.startedAt ?? item.at;
            return h(
              'li',
              { dataset: { s: s.state } },
              h(`span.g.${glyph[s.state] ?? 'g-pending'}`, { role: 'img', 'aria-label': stateName(s.state) }),
              h(
                'span.t',
                s.label,
                s.detail ? (s.state === 'failed' ? h('span.err', s.detail) : h('span.dim.small', ` · ${s.detail}`)) : null,
                count || s.eta
                  ? h('span.p-count.small.dim', [count, s.eta && s.state === 'running' ? `${s.eta} left` : null].filter(Boolean).join(' · '))
                  : null,
                typeof pct === 'number'
                  ? h('span.bar.p-bar', { 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.max(0, Math.min(100, pct))}%` } }))
                  : null,
              ),
              // A running step shows how long it’s been going, live; a finished one, how long it took.
              s.state === 'running' || s.state === 'stalled'
                ? h('span.small.dim', { dataset: { since: String(started), sinceKind: s.state } })
                : h('span.small.dim', s.duration ?? ''),
            );
          }),
        ),
      ),
    );
    tickProgress(node);
    startProgressClock();
    return node;
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
  const compose = (key) => {
    d.composing = key;
    rerender();
  };
  // Closing a comment box puts focus back on the line it was for, so the keyboard keeps its place.
  const closeComposer = (key) => {
    d.composing = null;
    rerender()
      .querySelector(`.g-mark[data-line="${CSS.escape(String(key))}"]`)
      ?.focus();
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
          if (e.key === 'Escape') closeComposer(key);
        },
      });
      const add = () => {
        const text = ta.value.trim();
        if (!text) return;
        d.comments.push(b.format === 'app' ? { anchor: key, text } : { line: key, text });
        closeComposer(key);
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
                  onclick: () => closeComposer(key),
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
    const split = (src) => String(src ?? '').split(/\r\n?|\n/);
    const lines = split(b.content);
    const doc = h('div.rv-doc', { class: b.format === 'code' ? 'code-doc code' : '', role: 'list', 'aria-label': 'Lines' });
    const rows = isDiff ? diffLines(split(b.previous), lines) : lines.map((t, i) => ({ t, kind: 'same', n: i + 1 }));
    // Markdown renders by block (a table, list or fence as a whole), with a target per line inside it.
    const groups = b.format === 'markdown' ? groupReviewLines(rows) : rows.map((r) => ({ type: 'line', depth: 0, unit: rowUnit(r) }));
    const marked = (u) => u.lines.some((k) => threadsAt(k).length || draftsAt(k).length);
    const unitClass = (u) => [u.kind === 'same' ? '' : u.kind, marked(u) ? 'marked' : ''].join(' ');
    // The line is the comment target: clicking it, or its gutter mark (the button keyboards and screen
    // readers reach), opens its comment box. A click on a link or a thread inside it does its own thing.
    const gutter = (u, cls = '') => {
      const n = String(u.key ?? u.rows[0].o);
      if (done || u.key === null) return h(`span.g-ln${cls}`, h('span.sr-only', u.key === null ? 'Removed line ' : 'Line '), n);
      return h(
        `span.g-ln${cls}`,
        h(
          'button.g-mark',
          { type: 'button', 'aria-label': `Comment on line ${u.key}`, dataset: { line: n }, onclick: () => compose(u.key) },
          n,
          h('span.dot', { 'aria-hidden': 'true' }),
        ),
      );
    };
    const onLine = (u, el = null) =>
      done || u.key === null
        ? null
        : (e) => {
            if (el && e.target.closest('.rv-u') !== el) return;
            if (e.target.closest('a, button, textarea, input, summary, .term, .rv-thread') || getSelection()?.toString()) return;
            compose(u.key);
          };
    const threadsOf = (u) => u.lines.flatMap((k) => threadBox(k));
    const quoted = (depth) => (depth ? `quote q${Math.min(depth, 3)}` : '');
    // code: a line of a fence, drawn as part of one code box ('first' carries the language label).
    // raw: a line shown as its source, such as a changed fence marker or delimiter row in a diff.
    const lineRow = (u, depth, { code = null, raw = false } = {}) => {
      const t = u.rows[0].t;
      const heading = !code && !raw && b.format === 'markdown' && /^#{1,6}\s/.test(t);
      const text = heading ? t.replace(/^#{1,6}\s+/, '') : t;
      const plain = b.format !== 'markdown' || code || raw;
      return [
        h(
          'div.rv-line',
          {
            class: [
              unitClass(u),
              heading ? 'h' : '',
              code ? `code ${code.first ? 'code-first' : ''} ${code.last ? 'code-last' : ''}` : '',
              quoted(depth),
              onLine(u) ? 'can-c' : '',
            ].join(' '),
            role: 'listitem',
            onclick: onLine(u),
          },
          gutter(u),
          h(
            'span.tx',
            plain ? null : { html: trusted(inlineMd(text)) },
            code?.first && code.lang ? h('span.code-lang', code.lang) : null,
            plain ? text || ' ' : null,
          ),
        ),
        threadsOf(u),
      ];
    };
    // A hidden line (a delimiter row, a fence marker) that a diff changed shows as its source, so the
    // change is visible; an unchanged one shows only its threads.
    const hiddenRows = (rs, depth) =>
      rs.map((r) => (r.kind === 'same' ? (r.n === undefined ? [] : threadBox(r.n)) : lineRow(rowUnit(r), depth, { raw: true })));
    // Text to tell one list item from another: what renders, without Markdown or punctuation.
    const words = (s) => s.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
    const itemWords = (u) => words(toPlainText(u.rows[0].t.replace(/^(\s*>)+/, '').match(LIST_ITEM)?.[3] ?? '')).slice(0, 12);
    // A table or list renders whole. Each row or item gets its own gutter, positioned in the gutter
    // column, and its threads right after it. If the rendered rows or items don't match the targets,
    // the block is drawn line by line, as before.
    const blockRows = (g) => {
      const box = h('div.tx.md', { class: quoted(g.depth), html: trusted(renderMarkdown(g.source, { folds: false })) });
      const els = [...box.querySelectorAll(g.type === 'table' ? 'tr' : 'li')];
      const matches =
        els.length === g.units.length && (g.type === 'table' || g.units.every((u, i) => words(els[i].textContent ?? '').startsWith(itemWords(u))));
      if (!matches) return g.rows.map((r) => lineRow(rowUnit(r), g.depth));
      const cols = box.querySelector('tr')?.children.length ?? 1;
      g.units.forEach((u, i) => {
        const el = els[i];
        el.className = ['rv-u', unitClass(u), onLine(u) ? 'can-c' : ''].join(' ').trim();
        const click = onLine(u, el);
        if (click) el.addEventListener('click', click);
        // A table row's gutter goes in a cell of its own, so it isn't part of a column header's name.
        if (g.type === 'table') el.prepend(h('td.rv-gut', gutter(u, '.g-abs')));
        else el.prepend(gutter(u, '.g-abs'));
        const threads = threadsOf(u);
        if (!threads.length) return;
        if (g.type === 'table') el.after(h('tr.rv-thread-row', h('td.rv-gut'), h('td', { colspan: String(cols) }, threads)));
        else el.append(...threads);
      });
      return [h('div.rv-line.rv-block', { role: 'listitem' }, h('span.g-ln', { 'aria-hidden': 'true' }), box), hiddenRows(g.hidden, g.depth).flat()];
    };
    for (const g of groups) {
      if (g.type === 'line') doc.append(...lineRow(g.unit, g.depth).flat());
      else if (g.type === 'code') {
        const [open, ...close] = g.hidden;
        doc.append(...hiddenRows([open], g.depth).flat(2));
        g.units.forEach((u, i) => {
          const code = { first: i === 0, last: i === g.units.length - 1, lang: g.lang === 'math' ? '' : g.lang };
          doc.append(...lineRow(u, g.depth, { code }).flat());
        });
        doc.append(...hiddenRows(close, g.depth).flat(2));
      } else doc.append(...blockRows(g).flat(2));
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

/** Bold, italic and code inside a review line, without block structure. A fold shows as its source. */
function inlineMd(t) {
  return renderMarkdown(t || ' ', { folds: false })
    .replace(/^<p>|<\/p>$/g, '')
    .replace(/^<h\d>|<\/h\d>$/g, '');
}

/** A line diff (longest common subsequence), good enough for documents up to a few thousand lines. */
// ── Progress blocks: times that move ─────────────────────────────────────────────────────

const stateName = (s) => s[0].toUpperCase() + s.slice(1);
/** A step still marked running looks stalled when its agent has stopped working and the block hasn’t moved for a minute. */
const STALE_MS = 60000;
const WORKING = new Set(['think', 'gen', 'tool']);

/** Brings a progress block’s times up to date: “Updated 40 s ago”, live elapsed times, and stalled steps. */
function tickProgress(node) {
  const now = Date.now();
  const se = client.state.sessions[node.dataset.progress];
  const idle = !se || !WORKING.has(se.state);
  const stale = idle && now - Number(node.dataset.updatedAt) > STALE_MS;
  for (const el of node.querySelectorAll('[data-since]')) {
    const ms = Math.max(1000, now - Number(el.dataset.since));
    const li = el.closest('li');
    if (el.dataset.sinceKind === 'updated') el.textContent = ms < 5000 ? 'Updated just now' : `Updated ${formatDuration(ms)} ago`;
    else if (el.dataset.sinceKind === 'stalled' || stale)
      el.textContent = `No update for ${formatDuration(Math.max(1000, now - Number(node.dataset.updatedAt)))}`;
    else el.textContent = formatDuration(ms);
    if (li && el.dataset.sinceKind === 'running') {
      li.classList.toggle('stale', stale);
      li.querySelector('.g')?.setAttribute('aria-label', stale ? 'Stalled' : 'Running');
    }
  }
}

let progressClock = 0;
function startProgressClock() {
  if (progressClock) return;
  progressClock = setInterval(() => {
    const blocks = document.querySelectorAll('[data-progress]');
    for (const node of blocks) tickProgress(/** @type {HTMLElement} */ (node));
    if (!blocks.length) {
      clearInterval(progressClock);
      progressClock = 0;
    }
  }, 1000);
}

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
