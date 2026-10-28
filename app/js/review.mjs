// The review block’s renderer, moved out of app/js/blocks.mjs. blocks.mjs imports this module, so the helpers it
// shares with the other renderers come in as kit: draft, seen, renderBlock, head, staleNote, submit, errLine and
// outcomeLine.

import { LIST_ITEM, renderMarkdown, toPlainText } from '/shared/markdown.mjs';
import { diffLines, followLines, splitLines } from '/shared/review-diff.mjs';
import { groupReviewLines, rowUnit } from '/shared/review-lines.mjs';
import { enhanceMarkdown, mountApp } from './apps.mjs';
import { h, icon, plural, timeOf, trusted } from './dom.mjs';
import { newReviewDraft, startComment, stopComment } from './review-draft.mjs';
import { focusQuote, renderPreview } from './review-preview.mjs';
import { reviewersOf, threadBox as threadsFor } from './review-threads.mjs';
import { fullScreen, revisionOf, seg, setView, viewOf } from './review-view.mjs';
// ── Review ──────────────────────────────────────────────────────────────────────────────
// Markdown is read in Preview, and commented on by selection there or line by line in Lines (#179); code is
// commented line by line; apps by the anchors they register. Comments stay drafts until you submit them all with a
// verdict. A revision shows as a diff, with each of your comments marked resolved or open.

export function renderReview(b, item, ctx, kit) {
  const { draft, seen, renderBlock, head, staleNote, submit, errLine, outcomeLine } = kit;
  const d = draft(item.id, () => newReviewDraft(b.content));
  // Draft comments name lines of the text they were written on. If the agent changed it under them (#123), each
  // follows its line into the new text; one whose line changed or went moves to the next line, marked. One on a
  // selection follows its quote (#179).
  if (b.format !== 'app' && d.on !== b.content) {
    d.comments = followLines(d.comments, d.on, b.content);
    // An open comment box goes with its line, or its selection, too.
    if (d.composing !== null && typeof d.composing !== 'string') {
      const [c] = followLines([typeof d.composing === 'number' ? { line: d.composing } : d.composing], d.on, b.content);
      d.composing = typeof c.col === 'number' ? c : (c.line ?? null);
    }
    d.on = b.content;
  }
  const rerender = () => {
    const n = renderBlock(item, ctx);
    node.replaceWith(n);
    return n;
  };
  const compose = (key) => {
    startComment(d, key);
    rerender();
  };
  // Closing a comment box puts focus back where it was opened: the line, or the text selected in Preview.
  const closeComposer = (key) => {
    stopComment(d);
    const n = rerender();
    if (typeof key === 'object' && key) return focusQuote(n, key);
    /** @type {HTMLElement | null} */ (n.querySelector(`.g-mark[data-line="${CSS.escape(String(key))}"]`))?.focus();
  };
  const done = item.answered;
  // After an answer refused because the draft changed, the diff is from the text the person saw.
  const stale = done ? null : (seen.get(item.id)?.stale ?? null);
  const since = stale && b.format !== 'app' ? String(stale.block.content ?? '') : null;
  const before = since ?? b.previous;
  const hasDiff = since !== null || !!b.previous;
  const mode = viewOf(item, b, d, hasDiff);
  const isDiff = hasDiff && d.view === 'diff' && mode === 'lines';
  const views = [];
  if (b.format === 'markdown')
    views.push(
      seg(
        'View',
        [
          ['preview', 'Preview'],
          ['lines', 'Lines'],
        ],
        mode,
        (m) => {
          setView(item, b, d, /** @type {'preview' | 'lines'} */ (m));
          return rerender();
        },
      ),
    );
  if (hasDiff && mode === 'lines') {
    const diff = since !== null ? 'Changes since you looked' : `Diff v${revisionOf(item, b) - 1} → v${revisionOf(item, b)}`;
    const plain = since !== null ? 'Current' : `v${revisionOf(item, b)}`;
    views.push(
      seg(
        'Changes',
        [
          ['diff', diff],
          ['plain', plain],
        ],
        isDiff ? 'diff' : 'plain',
        (v) => {
          d.view = v;
          return rerender();
        },
      ),
    );
  } else views.push(h('span.small.dim', `v${revisionOf(item, b)}`));
  const full = b.format === 'app' ? null : fullScreen(item.id, rerender);
  const [hd, titleId] = head(b, [...views, full?.btn], `Review · ${{ markdown: 'Markdown', code: 'Code', app: 'App' }[b.format]}`);
  hd.querySelector('.title').classList.add('mono');
  hd.querySelector('.title').style.fontSize = '13px';
  // A review takes the transcript’s width (#179); box is what goes full screen.
  const box = h('div.rv-box', hd);
  const node = h('div.rv-wide', { 'aria-labelledby': titleId }, box);
  full?.fit(node, box, titleId);

  const threadsAt = (key) => (b.threads ?? []).filter((t) => (b.format === 'app' ? t.anchor === key : t.line === key));
  const draftsAt = (key) => d.comments.filter((c) => (b.format === 'app' ? c.anchor === key : c.line === key));
  const threadBox = (key) => threadsFor(key, { b, d, done, rerender, closeComposer });

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
          startComment(d, anchor);
          rerender();
        }
      },
    });
    box.append(h('div.app-review-wrap', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } }, appEl, pins));
  } else if (mode === 'preview') {
    const all = [...(b.threads ?? []), ...d.comments];
    // The lines with threads or drafts, and a line’s open comment box, which a revision can leave on a line (#123).
    const keys = [...new Set([...all.map((x) => x.line), d.composing].filter((n) => typeof n === 'number'))].sort((x, y) => x - y);
    const ranged = all.filter((x) => typeof x.col === 'number');
    // A click that selects nothing chooses its line: Lines, with that line’s comment box open.
    const pick = (line) => {
      setView(item, b, d, 'lines');
      compose(line);
    };
    box.append(renderPreview(b.content, { id: item.id, done, keys, composing: d.composing, ranged, threadBox, comment: compose, pick }));
  } else {
    const lines = splitLines(b.content);
    const doc = h('div.rv-doc', { class: b.format === 'code' ? 'code-doc code' : '', role: 'list', 'aria-label': 'Lines' });
    const rows = isDiff ? diffLines(splitLines(before), lines) : lines.map((t, i) => ({ t, kind: 'same', n: i + 1 }));
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
      const box = h('div.tx.md', { class: quoted(g.depth), html: trusted(renderMarkdown(g.source, { folds: false, pageOrigin: location.origin })) });
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
    // A Mermaid or math fence renders whole, with one comment target for its lines, unless a diff changed it (#179).
    const wholeFence = (g) => (g.lang === 'mermaid' || g.lang === 'math') && [...g.hidden, ...g.units.flatMap((u) => u.rows)].every((r) => r.kind === 'same');
    const fenceRow = (g) => {
      const rows = [g.hidden[0], ...g.units.flatMap((u) => u.rows), ...g.hidden.slice(1)];
      const u = { key: g.hidden[0].n, lines: rows.map((r) => r.n), kind: 'same', rows };
      const md = h('div.tx.md', { class: quoted(g.depth), html: trusted(renderMarkdown(rows.map((r) => r.t).join('\n'))) });
      return [
        h('div.rv-line.rv-block', { role: 'listitem', class: [unitClass(u), onLine(u) ? 'can-c' : ''].join(' '), onclick: onLine(u) }, gutter(u), md),
        threadsOf(u),
      ];
    };
    for (const g of groups) {
      if (g.type === 'line') doc.append(...lineRow(g.unit, g.depth).flat());
      else if (g.type === 'code' && wholeFence(g)) doc.append(...fenceRow(g).flat(2));
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
    box.append(doc);
    // Diagrams and math draw once the lines are on the page.
    queueMicrotask(() => enhanceMarkdown(doc));
  }

  if (done) {
    box.append(h('div.block-foot', h('span.answered-note', icon('check', 'i-sm'), `${item.answer.voice} · ${timeOf(item.answer.at)}`), outcomeLine(item)));
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
    box.append(
      h(
        'div.block-foot.review-bar',
        h(
          'span.small',
          b.threads?.length ? h('b', `${resolved} of ${b.threads.length} resolved`) : null,
          b.threads?.length && d.comments.length ? ' · ' : '',
          d.comments.length ? h('b', plural(d.comments.length, 'draft comment')) : b.threads?.length ? '' : h('span.dim', 'No comments yet'),
          reviewersOf(item, b),
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
          {
            type: 'button',
            onclick: () =>
              submit(
                item,
                ctx,
                'submit',
                // moved and gone are only for the person: the agent gets each comment where it is now.
                { verdict: d.verdict, comments: d.comments.map(({ moved: _m, gone: _g, ...c }) => c) },
                setError,
              ),
          },
          'Submit review',
        ),
        err,
      ),
    );
    const note = staleNote(
      item,
      since !== null
        ? 'This draft changed while you were answering. What changed since you looked is marked above, and your comments are kept. Check them, then submit again.'
        : 'This changed while you were answering. Your comments are kept: look it over, then submit again.',
    );
    if (note) box.lastElementChild?.before(note);
  }
  return node;
}

/** Bold, italic and code inside a review line, without block structure. A fold shows as its source. */
function inlineMd(t) {
  return renderMarkdown(t || ' ', { folds: false, pageOrigin: location.origin })
    .replace(/^<p>|<\/p>$/g, '')
    .replace(/^<h\d>|<\/h\d>$/g, '');
}
