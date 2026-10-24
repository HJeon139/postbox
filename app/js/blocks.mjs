// Catalog block renderers. Each takes a validated block and builds it with Postbox’s own DOM code, so
// nothing an agent sends becomes markup, a style or an attribute name. Answered blocks turn read-only
// and show what you chose. Drafts (selections, typed text, review comments) survive re-renders.

import './md-images.mjs';
import { ASKING } from '/shared/catalog.mjs';
import { renderMarkdown } from '/shared/markdown.mjs';
import { onPageOrigin } from '/shared/urls.mjs';
import { asDrawn, closing } from './block-close.mjs';
import { client } from './client.mjs';
import { codeBox, copyControls, showFilename } from './code-block.mjs';
import { h, icon, plural, timeOf, trusted } from './dom.mjs';
import { startProgressClock, tickProgress } from './progress-clock.mjs';
import { renderReview } from './review.mjs';

const drafts = new Map(); // item id → local, unsent input
const draft = (id, init) => {
  if (!drafts.has(id)) drafts.set(id, init());
  return drafts.get(id);
};

// What the person is answering (#123): the revision of each open choice, form, confirm or review as it was when
// this page first showed it. The answer says which revision it’s for, so one the agent replaced meanwhile is
// refused instead of landing on text they didn’t see. After a refusal (stale: what they saw before), the revision
// they answer is the first newer one the page draws, with the notice and diff; a later one is refused again.
/** @type {Map<string, { revision: number, block: any, after: number | null, stale: { block: any, fresh: boolean } | null }>} */
const seen = new Map();
function track(item) {
  if (!ASKING.has(item.block.type) || item.answered) return void seen.delete(item.id);
  const rev = item.revision ?? 1;
  const s = seen.get(item.id);
  if (!s) seen.set(item.id, { revision: rev, block: item.block, after: null, stale: null });
  else if (s.after !== null && rev > s.after) Object.assign(s, { revision: rev, block: item.block, after: null });
}
// The notice on a block whose answer was refused because it changed. It’s announced once, when it appears, and has
// an id so focus on it survives a re-render.
const staleNote = (item, text) => {
  const s = seen.get(item.id)?.stale;
  if (!s) return null;
  const note = h('div.callout.stale-note', { id: `${item.id}-stale`, role: s.fresh ? 'alert' : null, tabindex: '-1' }, icon('warn'), h('span', text));
  s.fresh = false;
  return note;
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
  track(item);
  const r = RENDER[b.type];
  const node = r(b, asDrawn(item), ctx);
  closing(node, item, (setError) => submit(item, ctx, 'dismiss', {}, setError));
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
// A result the agent reported on an answered choice, form, confirm or review (#94, #106), under your answer.
const outcomeLine = (item) => (item.answered && item.block.outcome ? h('div.outcome', icon('check', 'i-sm'), md(item.block.outcome)) : null);
const errLine = (msg) => (msg ? h('span.err', { role: 'alert' }, icon('warn'), msg) : null);

async function submit(item, ctx, action, values, setError) {
  setError(null);
  const s = seen.get(item.id);
  try {
    await ctx.act(action, values, s?.revision ?? item.revision ?? 1);
    drafts.delete(item.id);
    seen.delete(item.id);
  } catch (e) {
    if (e.code !== 'stale' || !s) return setError(e.message, e.fieldErrors);
    // It changed while they were answering: keep the draft, show what changed, and let them answer again.
    s.stale = { block: s.block, fresh: true };
    s.after = s.revision;
    const d = drafts.get(item.id);
    if (d && 'view' in d) d.view = 'diff';
    const live = document.querySelector(`[data-block-item="${CSS.escape(item.id)}"]`);
    if (!live) return;
    const next = renderBlock(item, ctx);
    live.replaceWith(next);
    // Focus goes to the notice, beside the button they used: pressing it again by reflex can’t answer text they
    // haven’t read, and Tab goes on to the buttons.
    /** @type {HTMLElement | null} */ (next.querySelector('.stale-note'))?.focus();
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
    // A pick the agent’s new version dropped (#123) isn’t shown, counted or sent.
    d.selected = d.selected.filter((id) => b.options.some((o) => o.id === id));
    if (!b.other) d.otherOn = false;
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
    if (done) body.append(answeredNote(item), outcomeLine(item) ?? '');
    else
      body.append(
        staleNote(item, 'This changed while you were answering. Your choice is kept where the new version still has it: check it, then send it again.') ?? '',
      );
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
            {
              type: 'button',
              onclick: () => submit(item, ctx, 'choose', { selected: d.selected, ...(d.otherOn ? { other: d.other } : {}) }, setError),
            },
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
    // A field the agent’s new version added (#123) starts from its default, as it would have.
    for (const f of b.fields) if (!Object.hasOwn(d.values, f.id)) d.values[f.id] = f.default ?? (f.kind === 'toggle' ? false : '');
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
      h(
        'div.block-body',
        b.prompt ? md(b.prompt) : null,
        grid,
        done
          ? answeredNote(item)
          : staleNote(item, 'This changed while you were answering. Your answers are kept: check them against the new version, then send again.'),
        outcomeLine(item),
      ),
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
          h(
            'button.btn.send',
            {
              type: 'button',
              // Only this version’s fields: one the agent removed meanwhile isn’t sent.
              onclick: () => submit(item, ctx, 'submit', Object.fromEntries(b.fields.map((f) => [f.id, d.values[f.id]])), setError),
            },
            b.submitLabel ?? 'Send form',
          ),
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
        done ? null : staleNote(item, 'This changed while you were answering. Read it again, then answer.'),
        outcomeLine(item),
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
          h('img', {
            src: onPageOrigin(b.src, location.origin),
            alt: b.alt,
            width: b.width ?? null,
            height: b.height ?? null,
            loading: 'lazy',
            referrerpolicy: 'no-referrer',
            // A failed image says so, in place of a broken-image icon (#180). The alt text stays as the description.
            onerror: (e) => e.target.replaceWith(h('p.err.img-failed', icon('warn'), `This image couldn’t load. It shows: ${b.alt}`)),
          }),
          h('figcaption', b.caption ? `${b.caption} · ` : '', `From ${new URL(b.src).host}`),
        ),
      ),
    );
  },

  code(b) {
    const [hd, titleId] = head(b, copyControls(b), b.language ? `Code · ${b.language}` : 'Code');
    showFilename(hd, b);
    return h('div', { 'aria-labelledby': titleId }, hd, codeBox(b));
  },

  review: (b, item, ctx) => renderReview(b, item, ctx, { draft, seen, renderBlock, head, staleNote, submit, errLine, outcomeLine }),
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

// ── Progress blocks: times that move ─────────────────────────────────────────────────────

const stateName = (s) => s[0].toUpperCase() + s.slice(1);

export { drafts };
export const hasDraft = (id) => drafts.has(id);
export const clientState = () => client.state;
