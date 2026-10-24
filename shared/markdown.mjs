// A small, safe Markdown renderer. All text is escaped; raw HTML is shown as text, never rendered.
// The output contains only tags and attributes this file writes. Agent text only ever becomes element
// content or an escaped attribute value, never an attribute name, a tag name or a style.
//
// Supported: paragraphs (a single newline is a line break), # headings, - and 1. lists (nested by
// indentation), > quotes, ``` fences, ```mermaid diagrams, $$ math blocks (or $$…$$ on one line), $inline math$,
// LaTeX’s \[display\] and \(inline\) math, pipe tables,
// ---, `code`, **bold**, *italic*, ~~strikethrough~~, [links](https://…), ![images](https://…), bare https:// links,
// citation markers [1], term links [label](term:key), glossary auto-links and @mentions.
// While a reply is streaming, an unclosed fence is drawn as if it were closed.
//
// The one exception to "raw HTML is text": <details> starting a line, with an optional <summary>…</summary>
// right after it, closed by its </details>, folds its Markdown away (agents use it to hide an exercise's
// answer). The tags must be exactly these, with no attributes; anything else, or an unclosed tag, is text.

import { escapeHtml, glossaryRegex, inline, mentionRegex } from './markdown-inline.mjs';
import { displayMath } from './math.mjs';

export { escapeHtml };

// The block rules, shared with the review renderer's line grouping (review-lines.mjs).
export const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/;
export { MATH } from './math.mjs';
export const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
export const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
export const QUOTE = /^ {0,3}>\s?(.*)$/;
export const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
export const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
/** Whether a line closes a fence opened with `marker` (such as ``` or ~~~~). */
export const closesFence = (marker, line) => new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(line);

/**
 * @param {string} src
 * @param {{
 *   streaming?: boolean,
 *   citations?: number,          // how many sources the message has; [n] becomes a marker when 1 ≤ n ≤ citations
 *   citeId?: string,             // prefix for source anchors: #<citeId>-<n>
 *   glossary?: { key: string, term: string }[],
 *   mentions?: string[],         // handles without the @
 *   folds?: boolean,             // false shows <details> as text, as a review does
 *   pageOrigin?: string,         // the page’s origin, which Postbox’s own images move to (#180, #218)
 *   positions?: boolean,         // mark where each part came from in src, for a review’s comments (#179; see inline)
 * }} [opts]
 * @returns {string} HTML
 */
export function renderMarkdown(src, opts = {}) {
  // U+0000 stands in for a code span inside a run of text (see inline), so the text can't contain it.
  const lines = String(src ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\0/g, '\uFFFD')
    .split('\n');
  const ctx = { ...opts, src: opts.positions ? lines : null, glossaryRe: glossaryRegex(opts.glossary), mentionRe: mentionRegex(opts.mentions) };
  return blocks(lines, ctx, 0);
}

/**
 * Where text t of a line starts in the source, for inline’s marks (#179), or undefined when there are none. line is
 * source line n as this level of blocks has it: a quote’s marker or a list item’s indent only ever comes off its
 * front. from is where to look for t in it.
 * @param {any} ctx @param {number} n @param {string} line @param {string} t @param {number} [from]
 */
function at(ctx, n, line, t, from = 0) {
  if (!ctx.src || !t) return undefined;
  const o = ctx.src[n] ?? '';
  const c = o.trimEnd().length - line.trimEnd().length + line.indexOf(t, from);
  return o.startsWith(t, c) ? { n, c } : undefined;
}
/** The source lines a block spans, as data-sl to data-el (1-based), when the render marks positions. */
const lineMarks = (ctx, a, z) => (ctx.src ? ` data-sl="${a + 1}" data-el="${z + 1}"` : '');

/** @param {string[]} lines @param {any} ctx @param {number} base  the source line lines[0] is */
function blocks(lines, ctx, base) {
  const out = [];
  /** @type {number[]} */
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map((k) => inline(lines[k].trim(), ctx, at(ctx, base + k, lines[k], lines[k].trim()))).join('<br>')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const f = fenced(lines, i, fence, ctx, base);
      out.push(f.html);
      i = f.end;
      continue;
    }

    const display = displayMath(lines, i);
    if (display) {
      flush();
      out.push(`<div class="md-math" data-display="true"${lineMarks(ctx, base + i, base + display.end)}>${escapeHtml(display.tex)}</div>`);
      i = display.end;
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      flush();
      const level = Math.min(5, Math.max(3, h[1].length + 1));
      out.push(`<h${level}>${inline(h[2], ctx, at(ctx, base + i, line, h[2], line.indexOf('#') + h[1].length))}</h${level}>`);
      continue;
    }

    const fold = ctx.folds !== false && line.trimStart().startsWith('<details>') ? details(lines, i) : null;
    if (fold) {
      flush();
      const summary = fold.summary === null ? '' : `<summary>${inline(fold.summary.trim(), ctx)}</summary>`;
      out.push(`<details>${summary}${blocks(fold.body, { ...ctx, src: null }, 0)}</details>`);
      // Text after </details> on its line is read as a line of its own.
      if (fold.after.trim()) {
        out.push(blocks([fold.after, ...lines.slice(fold.end + 1)], ctx, base + fold.end));
        break;
      }
      i = fold.end;
      continue;
    }

    // "---", "***" and "- - -" are rules; "- item" is a list item, which RULE doesn't match.
    if (RULE.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const body = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) body.push(/** @type {RegExpMatchArray} */ (lines[i].match(QUOTE))[1]);
      i--;
      out.push(`<blockquote>${blocks(body, ctx, base + i - body.length + 1)}</blockquote>`);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flush();
      const body = [];
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim()) {
          // A blank line ends the list unless the next line continues it.
          const next = lines[i + 1];
          if (next !== undefined && (LIST_ITEM.test(next) || /^\s{2,}\S/.test(next))) {
            body.push('');
            continue;
          }
          break;
        }
        // A fold (an exercise's answer under its question, say) belongs to the item, blank lines and all.
        const fold = ctx.folds !== false && body.length && l.trimStart().startsWith('<details>') ? details(lines, i) : null;
        if (fold) {
          for (; i <= fold.end; i++) body.push(!lines[i].trim() ? '' : /^\s{2,}/.test(lines[i]) ? lines[i] : `  ${lines[i].trimStart()}`);
          i--;
          continue;
        }
        if (LIST_ITEM.test(l) || /^\s{2,}\S/.test(l) || body.length === 0) {
          body.push(l);
          continue;
        }
        // A plain line right after an item continues that item (lazy continuation).
        body.push('  ' + l.trim());
      }
      i--;
      out.push(list(body, ctx, base + i - body.length + 1));
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const rows = [line];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(lines[i]);
      i--;
      out.push(table(rows, ctx, base + i - rows.length));
      continue;
    }

    para.push(i);
  }
  flush();
  return out.join('');
}

/**
 * The fence that opens at lines[i], to its closing marker or, while a reply streams, the end: code, or a diagram once
 * it’s closed. end is the closing marker’s line.
 * @param {string[]} lines @param {number} i @param {RegExpMatchArray} fence @param {any} ctx @param {number} base
 */
function fenced(lines, i, [, marker, name], ctx, base) {
  const lang = name.toLowerCase();
  const body = [];
  let j = i + 1;
  for (; j < lines.length && !closesFence(marker, lines[j]); j++) body.push(lines[j]);
  const code = escapeHtml(body.join('\n'));
  const pos = lineMarks(ctx, base + i, base + Math.min(j, lines.length - 1));
  const html =
    lang === 'mermaid' && j < lines.length
      ? `<figure class="md-mermaid"${pos}><pre><code>${code}</code></pre></figure>`
      : `<pre class="md-code"${pos}><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${code}</code></pre>`;
  return { html, end: j };
}

/**
 * Finds the <details> that starts lines[i] and its matching </details>, counting nested ones and skipping
 * fences. Returns null when it isn't exactly that shape, so the caller shows it as text.
 * @param {string[]} lines
 * @param {number} i
 * @returns {{ summary: string | null, body: string[], after: string, end: number } | null}
 */
function details(lines, i) {
  let first = lines[i].trimStart().slice('<details>'.length);
  /** @type {string | null} */
  let summary = null;
  // The summary may follow on the same line or start the next one.
  let from = i;
  if (!first.trim() && lines[i + 1]?.trimStart().startsWith('<summary')) {
    from = i + 1;
    first = lines[i + 1];
  }
  if (first.trimStart().startsWith('<summary')) {
    // A summary with attributes (or a stray "<summaryx") leaves the whole block as text.
    if (!first.trimStart().startsWith('<summary>')) return null;
    const rest = first.trimStart().slice('<summary>'.length);
    const close = rest.indexOf('</summary>');
    if (close < 0) return null;
    summary = rest.slice(0, close);
    first = rest.slice(close + '</summary>'.length);
  }
  const body = [first];
  let depth = 1;
  /** @type {string | null} */
  let fence = null;
  for (let j = from; j < lines.length; j++) {
    const line = j === from ? first : lines[j];
    if (j > from) body.push(line);
    if (fence) {
      if (closesFence(fence, line)) fence = null;
      continue;
    }
    const opens = line.match(FENCE);
    if (opens && j > from) {
      fence = opens[1];
      continue;
    }
    // A tag inside `code` is text, so it neither opens nor closes.
    const masked = line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
    for (const tag of masked.matchAll(/<(\/?)details>/g)) {
      depth += tag[1] ? -1 : 1;
      if (depth === 0) {
        body[body.length - 1] = line.slice(0, tag.index);
        return { summary, body, after: line.slice((tag.index ?? 0) + tag[0].length), end: j };
      }
    }
  }
  return null;
}

/** @param {any[]} lines @param {any} ctx @param {number} n0  the source line lines[0] is */
function list(lines, ctx, n0) {
  const base = lines[0].match(LIST_ITEM)[1].length;
  const ordered = /\d/.test(lines[0].match(LIST_ITEM)[2]);
  const start = ordered ? parseInt(lines[0].match(LIST_ITEM)[2], 10) : 1;
  const items = [];
  // Where each item starts in lines: an item’s lines follow it, one for one.
  const starts = [];
  for (const [k, l] of lines.entries()) {
    const m = l.match(LIST_ITEM);
    if (m && m[1].length <= base + 1) {
      items.push([m[3]]);
      starts.push(k);
    } else items.at(-1)?.push(l.slice(Math.min(base + 2, l.length - l.trimStart().length)));
  }
  const tag = ordered ? 'ol' : 'ul';
  const lis = items.map(([first, ...rest], j) => {
    const nested = rest.filter((r) => r !== undefined);
    const n = n0 + starts[j];
    const inner = nested.length ? blocks([first, ...nested], ctx, n) : inline(first, ctx, at(ctx, n, lines[starts[j]], first));
    // A single-paragraph item renders without the <p> wrapper.
    return `<li>${inner.replace(/^<p>([\s\S]*?)<\/p>(?=<|$)/, '$1')}</li>`;
  });
  return `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${lis.join('')}</${tag}>`;
}

/** @param {string[]} rows  the header row and the body rows @param {any} ctx @param {number} n0  the header’s source line */
function table(rows, ctx, n0) {
  // Each cell’s text, and where it starts in its row.
  const cells = (row) => {
    const t = row.trimEnd();
    let k = t.length - t.trimStart().length + (t.trimStart().startsWith('|') ? 1 : 0);
    return t
      .slice(k, t.endsWith('|') ? -1 : undefined)
      .split(/(?<!\\)\|/)
      .map((part) => {
        const cell = { t: part.trim(), c: k + part.length - part.trimStart().length };
        k += part.length + 1;
        return cell;
      });
  };
  // With positions, inline reads the cell’s escaped pipes itself, in code spans too (cell), so its marks match.
  const cellCtx = ctx.src ? { ...ctx, cell: true } : ctx;
  const cell = (tag, c, row, n) => `<${tag}>${c ? inline(ctx.src ? c.t : c.t.replace(/\\\|/g, '|'), cellCtx, at(ctx, n, row, c.t, c.c)) : ''}</${tag}>`;
  const [head, ...body] = rows.map(cells);
  const th = head.map((c) => cell('th', c, rows[0], n0)).join('');
  const trs = body.map((r, j) => `<tr>${head.map((_, k) => cell('td', r[k], rows[j + 1], n0 + 2 + j)).join('')}</tr>`).join('');
  return `<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

/** Strips Markdown to plain text, for screen-reader announcements and short previews. */
export function toPlainText(src) {
  return String(src ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<\/?(details|summary)>/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^ {0,3}>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}
